"""Entrega y activación segura de firmware OTA para el validador local."""

from __future__ import annotations

import argparse
from datetime import datetime, timezone
import hashlib
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import re
import shutil
import ssl
import sys
from threading import Event
import tempfile
import time
from typing import Any

from .config import load_config


DEFAULT_CONFIG = Path("/etc/fuel-edge/config.toml")
DEFAULT_OTA_ROOT = Path("/var/lib/fuel-edge/validator-ota")
DEFAULT_SERVER_CERT = Path("/etc/mosquitto/tls/broker.crt")
DEFAULT_SERVER_KEY = Path("/etc/mosquitto/tls/broker.key")
DEFAULT_CLIENT_CA = Path("/etc/mosquitto/tls/ca.crt")
MAXIMUM_IMAGE_BYTES = 3 * 1024 * 1024
VERSION = re.compile(r"^[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}$")
IDENTIFIER = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$")


class _FirmwareServer(ThreadingHTTPServer):
    ota_root: Path
    validator_id: str


class _FirmwareHandler(BaseHTTPRequestHandler):
    server_version = "FuelValidatorOTA/1"

    def do_GET(self) -> None:  # noqa: N802 - nombre definido por BaseHTTPRequestHandler
        server = self.server
        if not isinstance(server, _FirmwareServer):
            self.send_error(HTTPStatus.INTERNAL_SERVER_ERROR)
            return
        expected = f"/{server.validator_id}/firmware.bin"
        if self.path != expected:
            self.send_error(HTTPStatus.NOT_FOUND)
            return
        firmware = server.ota_root / server.validator_id / "firmware.bin"
        if firmware.is_symlink() or not firmware.is_file():
            self.send_error(HTTPStatus.NOT_FOUND)
            return
        size = firmware.stat().st_size
        if not 1 <= size <= MAXIMUM_IMAGE_BYTES:
            self.send_error(HTTPStatus.NOT_FOUND)
            return
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", "application/octet-stream")
        self.send_header("Content-Length", str(size))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        with firmware.open("rb") as source:
            shutil.copyfileobj(source, self.wfile, length=64 * 1024)

    def log_message(self, format: str, *args: object) -> None:
        print(json.dumps({
            "component": "validator_ota_server",
            "client": self.client_address[0],
            "message": format % args,
        }), flush=True)


def serve(
    *,
    ota_root: Path,
    validator_id: str,
    bind: str,
    port: int,
    server_certificate: Path,
    server_key: Path,
    client_ca: Path,
) -> None:
    _validate_identifier(validator_id, "validator_id")
    for path, name in (
        (server_certificate, "certificado servidor"),
        (server_key, "clave servidor"),
        (client_ca, "CA clientes"),
    ):
        if path.is_symlink() or not path.is_file():
            raise FileNotFoundError(f"{name} OTA no disponible: {path}")
    server = _FirmwareServer((bind, port), _FirmwareHandler)
    server.ota_root = ota_root
    server.validator_id = validator_id
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    context.minimum_version = ssl.TLSVersion.TLSv1_2
    context.load_cert_chain(server_certificate, server_key)
    context.load_verify_locations(cafile=client_ca)
    context.verify_mode = ssl.CERT_REQUIRED
    server.socket = context.wrap_socket(server.socket, server_side=True)
    print(json.dumps({
        "component": "validator_ota_server",
        "status": "ready",
        "bind": bind,
        "port": port,
        "validator_id": validator_id,
    }), flush=True)
    server.serve_forever(poll_interval=0.5)


def stage(
    firmware: Path,
    *,
    firmware_version: str,
    config_path: Path,
    ota_root: Path,
    wait_seconds: float,
) -> dict[str, Any]:
    if not VERSION.fullmatch(firmware_version):
        raise ValueError("--version debe usar major.minor.patch")
    if firmware.is_symlink() or not firmware.is_file():
        raise FileNotFoundError("el firmware debe ser un archivo regular")
    size = firmware.stat().st_size
    if not 1 <= size <= MAXIMUM_IMAGE_BYTES:
        raise ValueError("el firmware excede la partición OTA permitida")
    with firmware.open("rb") as source:
        if source.read(1) != b"\xe9":
            raise ValueError("el archivo no es una imagen ESP32 válida")
        source.seek(0)
        digest = hashlib.file_digest(source, "sha256").hexdigest()

    config = load_config(config_path)
    validator = config.validator
    if not validator.enabled or validator.validator_id is None or validator.mqtt is None:
        raise ValueError("el validador MQTT debe estar habilitado")
    validator_id = _validate_identifier(validator.validator_id, "validator_id")
    target_directory = ota_root / validator_id
    target_directory.mkdir(parents=True, exist_ok=True, mode=0o750)
    destination = target_directory / "firmware.bin"
    temporary_name: str | None = None
    try:
        with tempfile.NamedTemporaryFile(
            dir=target_directory, prefix=".firmware-", delete=False
        ) as temporary, firmware.open("rb") as source:
            temporary_name = temporary.name
            shutil.copyfileobj(source, temporary, length=64 * 1024)
            temporary.flush()
            os.fsync(temporary.fileno())
        os.chmod(temporary_name, 0o640)
        os.replace(temporary_name, destination)
        temporary_name = None
    finally:
        if temporary_name is not None:
            Path(temporary_name).unlink(missing_ok=True)

    import paho.mqtt.client as mqtt

    nonce = os.urandom(16).hex()
    root = (
        f"fuel-edge/v1/{config.identity.site_id}/{config.identity.module_id}"
        f"/validators/{validator_id}"
    )
    command_topic = f"{root}/ota/command"
    status_topic = f"{root}/ota/status"
    payload = json.dumps({
        "version": 1,
        "type": "validator.ota.command",
        "validator_id": validator_id,
        "firmware": firmware_version,
        "url": f"https://10.42.0.1:8443/{validator_id}/firmware.bin",
        "sha256": digest,
        "size": size,
        "nonce": nonce,
        "created_at": datetime.now(timezone.utc).isoformat(),
    }, separators=(",", ":"), sort_keys=True).encode("utf-8")

    connected = Event()
    completed = Event()
    replay_requested = Event()
    result: dict[str, Any] = {}
    correlated_progress = False
    client = mqtt.Client(
        callback_api_version=mqtt.CallbackAPIVersion.VERSION2,
        client_id=f"fuel-edge-ota-{config.identity.module_id}",
        clean_session=True,
        protocol=mqtt.MQTTv311,
    )
    mqtt_config = validator.mqtt
    client.tls_set(
        ca_certs=str(mqtt_config.ca_certificate),
        certfile=str(mqtt_config.client_certificate),
        keyfile=str(mqtt_config.client_key),
        cert_reqs=ssl.CERT_REQUIRED,
        tls_version=ssl.PROTOCOL_TLS_CLIENT,
    )

    def on_connect(
        client: Any, userdata: Any, flags: Any, reason_code: Any, properties: Any
    ) -> None:
        if reason_code == 0:
            client.subscribe(status_topic, qos=1)
            connected.set()

    def on_message(client: Any, userdata: Any, message: Any) -> None:
        nonlocal correlated_progress
        if completed.is_set():
            return
        try:
            status = json.loads(bytes(message.payload))
        except (UnicodeDecodeError, json.JSONDecodeError):
            return
        if (
            not isinstance(status, dict)
            or status.get("version") != 1
            or status.get("type") != "validator.ota.status"
            or status.get("validator_id") != validator_id
        ):
            return
        state = status.get("state")
        current_is_target = status.get("current_firmware") == firmware_version
        target_is_expected = status.get("target_firmware") == firmware_version
        rollback_is_clear = status.get("rollback_pending") is False
        if status.get("nonce") != nonce:
            # Un `ready` sin nonce es el primer estado que puede publicar la
            # imagen recién arrancada. Nunca se acepta por sí solo: si ya hubo
            # progreso autenticado por el nonce fresco completa la correlación;
            # si no, sólo provoca la republicación del mismo desafío.
            if state == "ready" and current_is_target and rollback_is_clear:
                if correlated_progress:
                    result.update(status)
                    result["nonce"] = nonce
                    result["correlation"] = "nonce_progress_then_boot_status"
                    result["success"] = True
                    completed.set()
                else:
                    replay_requested.set()
            return

        if target_is_expected:
            correlated_progress = True
        if (
            state in {"healthy", "current"}
            and current_is_target
            and target_is_expected
            and rollback_is_clear
        ):
            result.update(status)
            result["success"] = True
            completed.set()
        elif state in {"failed", "rejected", "rolled_back"}:
            result.update(status)
            result["success"] = False
            completed.set()

    client.on_connect = on_connect
    client.on_message = on_message
    client.connect(mqtt_config.host, mqtt_config.port, 30)
    client.loop_start()
    command_queued = False

    def publish_command() -> None:
        nonlocal command_queued
        publication = client.publish(command_topic, payload, qos=1, retain=True)
        if publication.rc != mqtt.MQTT_ERR_SUCCESS:
            raise RuntimeError(
                f"MQTT rechazó la orden OTA con código {publication.rc}"
            )
        # Es sticky: si un replay posterior falla, la primera orden retenida
        # igualmente debe eliminarse en finally.
        command_queued = True
        publication.wait_for_publish(timeout=5)
        if not publication.is_published():
            raise TimeoutError("MQTT no confirmó la orden OTA")

    try:
        if not connected.wait(10):
            raise TimeoutError("MQTT no conectó para iniciar OTA")
        publish_command()
        # Un reinicio corta la conexión del validador justo después de que
        # confirma la imagen. Si al volver sólo anuncia `ready`, repetir el
        # manifiesto retenido le permite contestar `current` con el mismo nonce.
        # Se limita el replay para que un emisor defectuoso no genere un bucle.
        replay_count = 0
        deadline = max(0.0, wait_seconds)
        expires_at = time.monotonic() + deadline
        while not completed.is_set():
            remaining = expires_at - time.monotonic()
            if remaining <= 0:
                break
            if not replay_requested.wait(remaining):
                break
            replay_requested.clear()
            if completed.is_set():
                break
            if replay_count < 3:
                publish_command()
                replay_count += 1
        if not completed.is_set():
            raise TimeoutError("el validador no confirmó el firmware OTA")
        if result.get("success") is not True:
            raise RuntimeError(
                f"OTA rechazada: {result.get('state', 'desconocido')} "
                f"{result.get('detail', '')}"
            )
        return result
    finally:
        primary_error = sys.exc_info()[1]
        secondary_errors: list[tuple[str, Exception]] = []
        if command_queued:
            try:
                deletion = client.publish(
                    command_topic, payload=b"", qos=1, retain=True
                )
                if deletion.rc != mqtt.MQTT_ERR_SUCCESS:
                    raise RuntimeError(
                        "MQTT rechazó la limpieza de la orden OTA retenida "
                        f"con código {deletion.rc}"
                    )
                deletion.wait_for_publish(timeout=5)
                if not deletion.is_published():
                    raise TimeoutError(
                        "MQTT no confirmó la limpieza de la orden OTA retenida"
                    )
            except Exception as error:  # la OTA original conserva precedencia
                secondary_errors.append(("limpieza del comando OTA retenido", error))
        try:
            client.disconnect()
        except Exception as error:
            secondary_errors.append(("desconexión del cliente MQTT", error))
        try:
            client.loop_stop()
        except Exception as error:
            secondary_errors.append(("detención del loop MQTT", error))
        if secondary_errors:
            if primary_error is not None:
                for operation, error in secondary_errors:
                    primary_error.add_note(
                        f"Además falló {operation}: "
                        f"{type(error).__name__}: {error}"
                    )
            else:
                operation, secondary_error = secondary_errors[0]
                secondary_error.add_note(f"Falló durante {operation}.")
                for extra_operation, extra_error in secondary_errors[1:]:
                    secondary_error.add_note(
                        f"Además falló {extra_operation}: "
                        f"{type(extra_error).__name__}: {extra_error}"
                    )
                raise secondary_error


def _validate_identifier(value: str, name: str) -> str:
    if not IDENTIFIER.fullmatch(value):
        raise ValueError(f"{name} inválido")
    return value


def main() -> None:
    parser = argparse.ArgumentParser(description="OTA seguro del validador")
    commands = parser.add_subparsers(dest="command", required=True)
    server = commands.add_parser("serve", help="servir firmware por HTTPS/mTLS")
    server.add_argument("--root", type=Path, default=DEFAULT_OTA_ROOT)
    server.add_argument("--validator-id", default="validator-01")
    server.add_argument("--bind", default="10.42.0.1")
    server.add_argument("--port", type=int, default=8443)
    server.add_argument("--cert", type=Path, default=DEFAULT_SERVER_CERT)
    server.add_argument("--key", type=Path, default=DEFAULT_SERVER_KEY)
    server.add_argument("--client-ca", type=Path, default=DEFAULT_CLIENT_CA)
    publish = commands.add_parser("stage", help="preparar, ordenar y verificar OTA")
    publish.add_argument("firmware", type=Path)
    publish.add_argument("--version", required=True)
    publish.add_argument("--config", type=Path, default=DEFAULT_CONFIG)
    publish.add_argument("--root", type=Path, default=DEFAULT_OTA_ROOT)
    publish.add_argument("--wait-seconds", type=float, default=180.0)
    args = parser.parse_args()
    if args.command == "serve":
        serve(
            ota_root=args.root,
            validator_id=args.validator_id,
            bind=args.bind,
            port=args.port,
            server_certificate=args.cert,
            server_key=args.key,
            client_ca=args.client_ca,
        )
        return
    result = stage(
        args.firmware,
        firmware_version=args.version,
        config_path=args.config,
        ota_root=args.root,
        wait_seconds=args.wait_seconds,
    )
    print(json.dumps(result, sort_keys=True))


if __name__ == "__main__":
    main()
