"""Enrolamiento Wi-Fi local y autenticado de módulos XIAO."""

from __future__ import annotations

import argparse
import asyncio
from collections import OrderedDict
from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime, timezone
import hashlib
import hmac
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import secrets
import stat
from threading import Event, Lock, Thread
import time
import tomllib
from typing import Any
from urllib.error import HTTPError
from urllib.request import Request, urlopen

from .config import load_config
from .web_sync import read_web_sensor_key


SERVICE_UUID = "e0f10001-7c61-4a9c-9f54-6f2f30c8d001"
IDENTITY_UUID = "e0f10002-7c61-4a9c-9f54-6f2f30c8d001"
CHALLENGE_UUID = "e0f10003-7c61-4a9c-9f54-6f2f30c8d001"
RESPONSE_UUID = "e0f10004-7c61-4a9c-9f54-6f2f30c8d001"
CLAIM_UUID = "e0f10006-7c61-4a9c-9f54-6f2f30c8d001"
PROTOCOL_VERSION = 4
ADVERTISEMENT_COMPANY_ID = 0x4546
ADVERTISEMENT_FLAG_CONFIGURED = 1 << 0
ADVERTISEMENT_FLAG_ENROLLMENT_READY = 1 << 2
AUTH_DOMAIN = b"fuel-edge/equipment/v1\x00"
CLAIM_DOMAIN = b"fuel-edge/equipment/claim/v1\x00"
BLE_CHALLENGE_BYTES = 32
BLE_MODULE_NONCE_BYTES = 32
BLE_RESPONSE_TAG_BYTES = 32
BLE_RESPONSE_BYTES = BLE_MODULE_NONCE_BYTES + BLE_RESPONSE_TAG_BYTES
DEFAULT_REGISTRY = Path("/etc/fuel-edge/equipment-registry.toml")
WIFI_PROTOCOL_VERSION = 2
WIFI_SERVER_DOMAIN = b"fuel-edge/equipment/wifi/server/v2\x00"
WIFI_CLIENT_DOMAIN = b"fuel-edge/equipment/wifi/client/v2\x00"
WIFI_RESPONSE_DOMAIN = b"fuel-edge/equipment/wifi/response/v2\x00"
WIFI_RECEIPT_DOMAIN = b"fuel-edge/equipment/wifi/receipt/v2\x00"
MAX_WIFI_REQUEST_BYTES = 8192
MAX_WIFI_PAYLOAD_BYTES = 4096
MAX_WIFI_CLAIM_BYTES = 256
MAX_WIFI_IDENTIFIER_BYTES = 63
WIFI_NONCE_BYTES = 32
WIFI_PROOF_BYTES = 32
WIFI_CHALLENGE_TTL_SECONDS = 30
MAX_WIFI_CHALLENGE_TTL_SECONDS = 120
MAX_WIFI_CHALLENGES = 256
MAX_WIFI_CHALLENGES_PER_MODULE = 4


@dataclass(frozen=True, slots=True)
class ModuleCredential:
    module_id: str
    secret: bytes
    active: bool = True


@dataclass(frozen=True, slots=True)
class EquipmentIdentity:
    module_id: str
    equipment_id: str
    site_id: str
    device_name: str
    firmware: str
    claimed: bool


@dataclass(frozen=True, slots=True)
class _WifiChallenge:
    module_id: str
    client_nonce: bytes
    server_nonce: bytes
    action: str
    expires_at: float


def load_equipment_registry(path: Path) -> dict[str, ModuleCredential]:
    if path.is_symlink() or not path.is_file():
        raise PermissionError("equipment-registry.toml debe ser un archivo regular")
    mode = stat.S_IMODE(path.stat().st_mode)
    if mode & 0o077:
        raise PermissionError("equipment-registry.toml debe tener permisos 0600")
    with path.open("rb") as source:
        raw = tomllib.load(source)
    modules = raw.get("modules", [])
    if not isinstance(modules, list):
        raise ValueError("equipment-registry.toml debe contener [[modules]]")
    result: dict[str, ModuleCredential] = {}
    for item in modules:
        if not isinstance(item, dict):
            raise ValueError("cada módulo del registro debe ser una tabla")
        module_id = _wifi_identifier(item.get("module_id"))
        try:
            secret = bytes.fromhex(str(item.get("secret_hex", "")))
        except ValueError as error:
            raise ValueError(f"secret_hex inválido para {module_id or 'módulo'}") from error
        if not module_id or len(secret) != 32 or module_id in result:
            raise ValueError("el registro contiene un módulo inválido o duplicado")
        active = item.get("active", True)
        if not isinstance(active, bool):
            raise ValueError(f"active debe ser boolean para {module_id}")
        result[module_id] = ModuleCredential(module_id, secret, active)
    return result


def remove_equipment_registry_module(path: Path, module_id: str) -> bool:
    """Quita un MIM del registro protegido mediante reemplazo atómico."""

    module = _wifi_identifier(module_id)
    if not module or module != module_id:
        raise ValueError("module_id inválido para baja")
    credentials = load_equipment_registry(path)
    if module not in credentials:
        return False
    del credentials[module]
    rows = [
        "# Registro protegido de identidades MIM autorizadas.",
        "# Las bajas definitivas desde la web se aplican de forma atómica.",
    ]
    for credential in sorted(credentials.values(), key=lambda item: item.module_id):
        rows.extend((
            "",
            "[[modules]]",
            f"module_id = {json.dumps(credential.module_id)}",
            f"secret_hex = {json.dumps(credential.secret.hex())}",
            f"active = {'true' if credential.active else 'false'}",
        ))
    contents = "\n".join(rows) + "\n"
    temporary = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    try:
        descriptor = os.open(
            temporary,
            os.O_WRONLY | os.O_CREAT | os.O_EXCL,
            0o600,
        )
        with os.fdopen(descriptor, "w", encoding="utf-8") as target:
            target.write(contents)
            target.flush()
            os.fsync(target.fileno())
        os.replace(temporary, path)
        os.chmod(path, 0o600)
    finally:
        try:
            temporary.unlink()
        except FileNotFoundError:
            pass
    return True


def parse_identity(payload: bytes) -> EquipmentIdentity:
    if len(payload) > 1024:
        raise ValueError("identidad BLE demasiado grande")
    value = json.loads(payload.decode("utf-8"))
    if not isinstance(value, dict) or value.get("version") != PROTOCOL_VERSION:
        raise ValueError("versión BLE no compatible")
    module_id = _identifier(value.get("module_id"))
    equipment_id = _optional_identifier(value.get("equipment_id"))
    site_id = _optional_identifier(value.get("site_id"))
    firmware = str(value.get("firmware", "")).strip()[:32]
    device_name = str(value.get("device_name", "")).strip()[:63]
    claimed = value.get("claimed") is True
    if not module_id or not firmware:
        raise ValueError("identidad BLE incompleta")
    if claimed and (not equipment_id or not site_id or len(device_name) < 3):
        raise ValueError("módulo marcado como enrolado sin asignación válida")
    return EquipmentIdentity(
        module_id, equipment_id, site_id, device_name, firmware, claimed
    )


def expected_auth_response(
    credential: ModuleCredential,
    identity: EquipmentIdentity,
    challenge: bytes,
    module_nonce: bytes,
) -> bytes:
    """Construye la respuesta BLE v4 completa: module nonce seguido del tag."""

    if (
        not isinstance(challenge, bytes)
        or len(challenge) != BLE_CHALLENGE_BYTES
        or not isinstance(module_nonce, bytes)
        or len(module_nonce) != BLE_MODULE_NONCE_BYTES
    ):
        raise ValueError("los nonces BLE deben tener 32 bytes")
    if (
        credential.module_id != identity.module_id
        or not isinstance(credential.secret, bytes)
        or len(credential.secret) != BLE_RESPONSE_TAG_BYTES
    ):
        raise ValueError("credencial BLE inválida")
    message = (
        AUTH_DOMAIN
        + identity.module_id.encode("utf-8")
        + b"\x00"
        + identity.equipment_id.encode("utf-8")
        + b"\x00"
        + challenge
        + module_nonce
    )
    tag = hmac.new(credential.secret, message, hashlib.sha256).digest()
    return module_nonce + tag


def build_claim_packet(credential: ModuleCredential, *, site_id: str, equipment_id: str, name: str, nonce: bytes | None = None) -> bytes:
    site = _identifier(site_id)
    equipment = _identifier(equipment_id)
    label = name.strip()
    nonce_value = nonce if nonce is not None else secrets.token_bytes(16)
    encoded = [site.encode(), equipment.encode(), label.encode("utf-8")]
    if not site or not equipment or not 3 <= len(encoded[2]) <= 63 or len(nonce_value) != 16:
        raise ValueError("asignación BLE inválida")
    if any(len(value) > 63 for value in encoded):
        raise ValueError("la asignación BLE excede 63 bytes")
    message = CLAIM_DOMAIN + credential.module_id.encode() + b"\x00" + nonce_value + encoded[0] + b"\x00" + encoded[1] + b"\x00" + encoded[2]
    tag = hmac.new(credential.secret, message, hashlib.sha256).digest()
    packet = bytes([PROTOCOL_VERSION]) + nonce_value
    for value in encoded:
        packet += bytes([len(value)]) + value
    return packet + tag


class EnrollmentWebClient:
    def __init__(self, base_url: str, sensor_key: str, timeout: float) -> None:
        self.base_url = base_url.rstrip("/")
        self.sensor_key = sensor_key
        self.timeout = timeout

    async def sighting(self, identity: EquipmentIdentity, site_id: str, rssi: int) -> None:
        await asyncio.to_thread(self.sighting_sync, identity, site_id, rssi)

    def sighting_sync(self, identity: EquipmentIdentity, site_id: str, rssi: int) -> None:
        self._request("/api/equipment-enrollment/sightings", {
            "moduleId": identity.module_id,
            "siteId": site_id,
            "deviceName": identity.device_name or None,
            "equipmentId": identity.equipment_id or None,
            "firmware": identity.firmware,
            "rssi": rssi,
            "claimed": identity.claimed,
            "occurredAt": datetime.now(timezone.utc).isoformat(),
        })

    async def next_command(self, module_id: str) -> dict[str, Any] | None:
        return await asyncio.to_thread(self.next_command_sync, module_id)

    def next_command_sync(self, module_id: str) -> dict[str, Any] | None:
        response = self._request("/api/equipment-enrollment/commands/next", {"moduleId": module_id})
        command = response.get("command")
        return command if isinstance(command, dict) else None

    async def result(
        self, command_id: str, *, success: bool, error: str | None = None
    ) -> None:
        await asyncio.to_thread(
            self.result_sync,
            command_id,
            success=success,
            error=error,
        )

    def result_sync(
        self, command_id: str, *, success: bool, error: str | None = None
    ) -> None:
        self._request(f"/api/equipment-enrollment/commands/{command_id}/result", {
            "success": success, "error": error,
        })

    async def next_scan(self) -> dict[str, Any] | None:
        response = await asyncio.to_thread(self._request, "/api/equipment-enrollment/scan/next", {})
        scan = response.get("scan")
        return scan if isinstance(scan, dict) else None

    def next_registry_removal_sync(self) -> dict[str, Any] | None:
        response = self._request("/api/equipment-enrollment/removals/next", {})
        command = response.get("command")
        return command if isinstance(command, dict) else None

    def registry_removal_result_sync(
        self,
        command_id: str,
        *,
        success: bool,
        error: str | None = None,
    ) -> None:
        self._request(
            f"/api/equipment-enrollment/removals/{command_id}/result",
            {"success": success, "error": error},
        )

    async def scan_result(
        self,
        scan_id: str,
        *,
        success: bool,
        discovered: int,
        verified: int,
        error: str | None = None,
    ) -> None:
        await asyncio.to_thread(self._request, f"/api/equipment-enrollment/scan/{scan_id}/result", {
            "success": success,
            "discovered": discovered,
            "verified": verified,
            "error": error,
        })

    def _request(self, path: str, payload: dict[str, object]) -> dict[str, Any]:
        data = json.dumps(payload, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
        request = Request(f"{self.base_url}{path}", data=data, method="POST", headers={
            "Content-Type": "application/json",
            "X-Edge-Sensor-Key": self.sensor_key,
            "User-Agent": "fuel-equipment-enrollment/0.1",
        })
        with urlopen(request, timeout=self.timeout) as response:
            body = response.read(32 * 1024)
            return json.loads(body) if body else {}


class EquipmentRegistryRemovalCoordinator:
    """Consume bajas web y retira el MIM de Raspberry y del validador."""

    def __init__(
        self,
        web: EnrollmentWebClient,
        registry_path: Path,
        *,
        poll_seconds: float = 1.0,
        on_change: Callable[[], None] | None = None,
        on_error: Callable[[BaseException], None] | None = None,
    ) -> None:
        if poll_seconds <= 0:
            raise ValueError("poll_seconds debe ser positivo")
        self.web = web
        self.registry_path = registry_path
        self.poll_seconds = poll_seconds
        self._on_change = on_change
        self._on_error = on_error
        self._stop = Event()
        self._thread: Thread | None = None

    def start(self) -> None:
        if self._thread is not None:
            raise RuntimeError("la sincronización de bajas MIM ya está iniciada")
        self._thread = Thread(
            target=self._run,
            name="fuel-edge-equipment-registry-removals",
            daemon=True,
        )
        self._thread.start()

    def close(self, timeout: float = 5.0) -> None:
        self._stop.set()
        if self._thread is not None:
            self._thread.join(timeout)
            if self._thread.is_alive():
                raise RuntimeError("la sincronización de bajas MIM no se detuvo a tiempo")
            self._thread = None

    def refresh(self) -> bool:
        command = self.web.next_registry_removal_sync()
        if command is None:
            return False
        command_id = _wifi_identifier(command.get("id"))
        module_id = _wifi_identifier(command.get("moduleId"))
        if not command_id or not module_id:
            raise ValueError("orden de baja MIM inválida")
        try:
            removed = remove_equipment_registry_module(
                self.registry_path, module_id
            )
            if self._on_change is not None:
                # Se fuerza también cuando la entrada ya no estaba: así una
                # orden repetida vuelve a publicar la lista autoritativa.
                self._on_change()
            self.web.registry_removal_result_sync(command_id, success=True)
            return removed
        except Exception as error:
            try:
                self.web.registry_removal_result_sync(
                    command_id,
                    success=False,
                    error=str(error)[:200],
                )
            except Exception as report_error:
                if self._on_error is not None:
                    self._on_error(report_error)
            raise

    def _run(self) -> None:
        while not self._stop.is_set():
            try:
                self.refresh()
            except (HTTPError, OSError, PermissionError, RuntimeError, TypeError, ValueError) as error:
                if self._on_error is not None:
                    self._on_error(error)
            if self._stop.wait(self.poll_seconds):
                break

def _wifi_action(value: object) -> str:
    if not isinstance(value, str) or value not in {"status", "confirm"}:
        raise ValueError("acción Wi-Fi inválida")
    return value


def _wifi_identifier(value: object) -> str:
    if (
        not isinstance(value, str)
        or not value
        or not value.isascii()
        or len(value.encode("ascii")) > MAX_WIFI_IDENTIFIER_BYTES
        or not value[0].isalnum()
        or not all(
            character.isalnum() or character in "._-" for character in value
        )
    ):
        return ""
    return value


def _wifi_display_name(value: object) -> str:
    if not isinstance(value, str):
        return ""
    label = value.strip()
    try:
        encoded = label.encode("utf-8")
    except UnicodeEncodeError:
        return ""
    if (
        not 3 <= len(encoded) <= MAX_WIFI_IDENTIFIER_BYTES
        or any(
            ord(character) < 0x20 or character in "\x7f<>"
            for character in label
        )
    ):
        return ""
    return label


def _wifi_module_bytes(credential: ModuleCredential) -> bytes:
    if (
        _wifi_identifier(credential.module_id) != credential.module_id
        or not isinstance(credential.secret, bytes)
        or len(credential.secret) != 32
    ):
        raise ValueError("credencial de MIM inválida")
    return credential.module_id.encode("ascii")


def _wifi_nonce_pair(client_nonce: bytes, server_nonce: bytes) -> None:
    if (
        not isinstance(client_nonce, bytes)
        or not isinstance(server_nonce, bytes)
        or len(client_nonce) != WIFI_NONCE_BYTES
        or len(server_nonce) != WIFI_NONCE_BYTES
    ):
        raise ValueError("los nonces Wi-Fi deben tener 32 bytes")


def _wifi_payload_bytes(payload: object) -> bytes:
    if not isinstance(payload, str):
        raise ValueError("payload Wi-Fi inválido")
    try:
        encoded = payload.encode("utf-8")
    except UnicodeEncodeError as error:
        raise ValueError("payload Wi-Fi inválido") from error
    if not encoded or len(encoded) > MAX_WIFI_PAYLOAD_BYTES:
        raise ValueError("payload Wi-Fi inválido")
    return encoded


def _wifi_ttl(value: object) -> int:
    if (
        isinstance(value, bool)
        or not isinstance(value, int)
        or not 1 <= value <= MAX_WIFI_CHALLENGE_TTL_SECONDS
    ):
        raise ValueError("TTL de desafío Wi-Fi inválido")
    return value


def _wifi_frame(value: bytes) -> bytes:
    """Codifica un campo sin ambigüedad para los HMAC Wi-Fi v2."""

    return len(value).to_bytes(4, "big") + value


def wifi_server_proof(
    credential: ModuleCredential,
    client_nonce: bytes,
    server_nonce: bytes,
    action: str,
    expires_in_seconds: int,
) -> bytes:
    """Autentica el desafío, incluida la acción y su vigencia anunciada."""

    _wifi_nonce_pair(client_nonce, server_nonce)
    action_value = _wifi_action(action)
    ttl = _wifi_ttl(expires_in_seconds)
    message = (
        WIFI_SERVER_DOMAIN
        + _wifi_module_bytes(credential)
        + b"\x00"
        + client_nonce
        + server_nonce
        + action_value.encode("ascii")
        + b"\x00"
        + ttl.to_bytes(4, "big")
    )
    return hmac.new(credential.secret, message, hashlib.sha256).digest()


def wifi_client_proof(
    credential: ModuleCredential,
    client_nonce: bytes,
    server_nonce: bytes,
    action: str,
    payload: str,
) -> bytes:
    _wifi_nonce_pair(client_nonce, server_nonce)
    action_value = _wifi_action(action)
    payload_bytes = _wifi_payload_bytes(payload)
    message = (
        WIFI_CLIENT_DOMAIN
        + _wifi_module_bytes(credential)
        + b"\x00"
        + client_nonce
        + server_nonce
        + action_value.encode("ascii")
        + b"\x00"
        + payload_bytes
    )
    return hmac.new(credential.secret, message, hashlib.sha256).digest()


def wifi_response_proof(
    credential: ModuleCredential,
    client_nonce: bytes,
    server_nonce: bytes,
    action: str,
    payload: str,
    state: str,
    *,
    command_id: str = "",
    claim: bytes = b"",
) -> bytes:
    """Firma una respuesta y todo el contexto que le da significado.

    Los campos variables usan una longitud uint32 big-endian para impedir que
    separadores presentes en el JSON o en el claim produzcan transcripciones
    equivalentes.
    """

    _wifi_nonce_pair(client_nonce, server_nonce)
    action_value = _wifi_action(action)
    payload_bytes = _wifi_payload_bytes(payload)
    if not isinstance(state, str) or state not in {
        "pending",
        "claim",
        "confirmed",
    }:
        raise ValueError("estado Wi-Fi inválido")
    if not isinstance(command_id, str):
        raise ValueError("respuesta Wi-Fi incoherente")
    command = _wifi_identifier(command_id)
    if not isinstance(claim, bytes) or len(claim) > MAX_WIFI_CLAIM_BYTES:
        raise ValueError("claim Wi-Fi inválido")
    if state == "pending":
        valid_shape = action_value == "status" and not command_id and not claim
    elif state == "claim":
        valid_shape = action_value == "status" and bool(command) and bool(claim)
    else:
        valid_shape = action_value == "confirm" and bool(command) and not claim
    if not valid_shape or (command_id and command != command_id):
        raise ValueError("respuesta Wi-Fi incoherente")
    fields = (
        _wifi_module_bytes(credential),
        client_nonce,
        server_nonce,
        action_value.encode("ascii"),
        payload_bytes,
        state.encode("ascii"),
        command.encode("ascii"),
        claim,
    )
    message = WIFI_RESPONSE_DOMAIN + b"".join(
        _wifi_frame(field) for field in fields
    )
    return hmac.new(credential.secret, message, hashlib.sha256).digest()


def wifi_claim_receipt(
    credential: ModuleCredential, command_id: str, claim_digest: bytes
) -> bytes:
    command = _wifi_identifier(command_id)
    if (
        not isinstance(command_id, str)
        or command != command_id
        or not isinstance(claim_digest, bytes)
        or len(claim_digest) != 32
    ):
        raise ValueError("orden Wi-Fi inválida")
    message = (
        WIFI_RECEIPT_DOMAIN
        + _wifi_module_bytes(credential)
        + b"\x00"
        + command.encode()
        + claim_digest
    )
    return hmac.new(credential.secret, message, hashlib.sha256).digest()


class WifiEnrollmentCoordinator:
    """Procesa peticiones locales; ninguna clave abandona Raspberry o MIM."""

    def __init__(
        self,
        site_id: str,
        credentials: dict[str, ModuleCredential],
        web: EnrollmentWebClient,
        registry_path: Path | None = None,
        *,
        challenge_ttl_seconds: int = WIFI_CHALLENGE_TTL_SECONDS,
        max_challenges: int = MAX_WIFI_CHALLENGES,
        max_challenges_per_module: int = MAX_WIFI_CHALLENGES_PER_MODULE,
        clock: Callable[[], float] | None = None,
    ) -> None:
        if (
            isinstance(max_challenges, bool)
            or not isinstance(max_challenges, int)
            or not 1 <= max_challenges <= 4096
            or isinstance(max_challenges_per_module, bool)
            or not isinstance(max_challenges_per_module, int)
            or not 1 <= max_challenges_per_module <= max_challenges
        ):
            raise ValueError("límite de desafíos Wi-Fi inválido")
        self.site_id = site_id
        self.credentials = credentials
        self.web = web
        self.registry_path = registry_path
        self._registry_mtime_ns: int | None = None
        self.challenge_ttl_seconds = _wifi_ttl(challenge_ttl_seconds)
        self.max_challenges = max_challenges
        self.max_challenges_per_module = max_challenges_per_module
        self._clock = clock or time.monotonic
        self._challenge_lock = Lock()
        self._challenges: OrderedDict[
            tuple[str, bytes, bytes], _WifiChallenge
        ] = OrderedDict()

    def challenge(self, request: dict[str, Any]) -> dict[str, Any]:
        if request.get("version") != WIFI_PROTOCOL_VERSION:
            raise ValueError("versión de enrolamiento Wi-Fi incompatible")
        credential = self._credential(request.get("moduleId"))
        action = _wifi_action(request.get("action"))
        client_nonce = _hex_bytes(request.get("clientNonce"), WIFI_NONCE_BYTES)
        server_nonce = secrets.token_bytes(WIFI_NONCE_BYTES)
        proof = wifi_server_proof(
            credential,
            client_nonce,
            server_nonce,
            action,
            self.challenge_ttl_seconds,
        )
        challenge = _WifiChallenge(
            module_id=credential.module_id,
            client_nonce=client_nonce,
            server_nonce=server_nonce,
            action=action,
            expires_at=self._clock() + self.challenge_ttl_seconds,
        )
        self._store_challenge(challenge)
        return {
            "version": WIFI_PROTOCOL_VERSION,
            "action": action,
            "serverNonce": server_nonce.hex(),
            "expiresInSeconds": self.challenge_ttl_seconds,
            "serverProof": proof.hex(),
        }

    def authenticated(self, action: str, request: dict[str, Any]) -> dict[str, Any]:
        action_value = _wifi_action(action)
        if request.get("version") != WIFI_PROTOCOL_VERSION:
            raise ValueError("versión de enrolamiento Wi-Fi incompatible")
        credential = self._credential(request.get("moduleId"))
        client_nonce = _hex_bytes(request.get("clientNonce"), WIFI_NONCE_BYTES)
        server_nonce = _hex_bytes(request.get("serverNonce"), WIFI_NONCE_BYTES)
        payload = request.get("payload")
        if not isinstance(payload, str):
            raise ValueError("payload Wi-Fi inválido")
        _wifi_payload_bytes(payload)
        supplied = _hex_bytes(request.get("clientProof"), WIFI_PROOF_BYTES)
        expected = wifi_client_proof(
            credential, client_nonce, server_nonce, action_value, payload
        )
        if not hmac.compare_digest(supplied, expected):
            raise PermissionError("la identidad criptográfica Wi-Fi no coincide")
        # El pop ocurre bajo lock antes de parsear o producir efectos externos:
        # dos hilos con el mismo request nunca pueden ejecutar la orden ambos.
        self._consume_challenge(
            credential.module_id, client_nonce, server_nonce, action_value
        )
        try:
            body = json.loads(payload)
        except (json.JSONDecodeError, RecursionError) as error:
            raise ValueError("payload Wi-Fi no es JSON") from error
        if not isinstance(body, dict):
            raise ValueError("payload Wi-Fi inválido")
        if action_value == "status":
            response = self._status(credential, body)
        else:
            response = self._confirm(credential, body)
        state = str(response["state"])
        command_id = str(response.get("commandId", ""))
        claim = (
            bytes.fromhex(str(response["claim"])) if state == "claim" else b""
        )
        response["serverProof"] = wifi_response_proof(
            credential,
            client_nonce,
            server_nonce,
            action_value,
            payload,
            state,
            command_id=command_id,
            claim=claim,
        ).hex()
        return response

    def _store_challenge(self, challenge: _WifiChallenge) -> None:
        key = (
            challenge.module_id,
            challenge.client_nonce,
            challenge.server_nonce,
        )
        with self._challenge_lock:
            self._purge_expired_challenges(self._clock())
            # Reutilizar el mismo nonce de cliente invalida el desafío previo.
            # Esto acota además el daño de un generador de nonces defectuoso.
            for stored_key, stored in tuple(self._challenges.items()):
                if (
                    stored.module_id == challenge.module_id
                    and stored.client_nonce == challenge.client_nonce
                ):
                    self._challenges.pop(stored_key, None)
            same_module = [
                stored_key
                for stored_key, stored in self._challenges.items()
                if stored.module_id == challenge.module_id
            ]
            while len(same_module) >= self.max_challenges_per_module:
                self._challenges.pop(same_module.pop(0), None)
            while len(self._challenges) >= self.max_challenges:
                self._challenges.popitem(last=False)
            self._challenges[key] = challenge

    def _consume_challenge(
        self,
        module_id: str,
        client_nonce: bytes,
        server_nonce: bytes,
        action: str,
    ) -> None:
        key = (module_id, client_nonce, server_nonce)
        with self._challenge_lock:
            self._purge_expired_challenges(self._clock())
            challenge = self._challenges.pop(key, None)
            if challenge is None or challenge.action != action:
                raise PermissionError("desafío Wi-Fi vencido, usado o inválido")

    def _purge_expired_challenges(self, now: float) -> None:
        for key, challenge in tuple(self._challenges.items()):
            if challenge.expires_at <= now:
                self._challenges.pop(key, None)

    def _status(
        self, credential: ModuleCredential, body: dict[str, Any]
    ) -> dict[str, Any]:
        firmware_value = body.get("firmware")
        firmware = firmware_value.strip() if isinstance(firmware_value, str) else ""
        try:
            firmware_size = len(firmware.encode("utf-8"))
        except UnicodeEncodeError:
            firmware_size = MAX_WIFI_IDENTIFIER_BYTES + 1
        ble_protocol = body.get("bleProtocol")
        rssi = body.get("rssi")
        if (
            not firmware
            or firmware_size > 32
            or isinstance(ble_protocol, bool)
            or ble_protocol != PROTOCOL_VERSION
            or isinstance(rssi, bool)
            or not isinstance(rssi, int)
            or not -127 <= rssi <= 20
        ):
            raise ValueError("estado del MIM inválido")
        identity = EquipmentIdentity(
            credential.module_id, "", "", "", firmware, False
        )
        self.web.sighting_sync(identity, self.site_id, rssi)
        command = self.web.next_command_sync(credential.module_id)
        if command is None:
            return {"version": WIFI_PROTOCOL_VERSION, "state": "pending"}
        command_id = _wifi_identifier(command.get("id"))
        site_id = _wifi_identifier(self.site_id)
        equipment_id = _wifi_identifier(command.get("equipmentId"))
        name = _wifi_display_name(command.get("name"))
        if (
            command.get("siteId") != self.site_id
            or not command_id
            or not site_id
            or not equipment_id
            or not name
        ):
            raise ValueError("orden Wi-Fi inválida o de otro campo")
        packet = build_claim_packet(
            credential,
            site_id=site_id,
            equipment_id=equipment_id,
            name=name,
        )
        if len(packet) > MAX_WIFI_CLAIM_BYTES:
            raise ValueError("claim Wi-Fi demasiado grande")
        claim_digest = hashlib.sha256(packet).digest()
        return {
            "version": WIFI_PROTOCOL_VERSION,
            "state": "claim",
            "commandId": command_id,
            "claim": packet.hex(),
            "claimHash": claim_digest.hex(),
            "receipt": wifi_claim_receipt(
                credential, command_id, claim_digest
            ).hex(),
        }

    def _confirm(
        self, credential: ModuleCredential, body: dict[str, Any]
    ) -> dict[str, Any]:
        command_id = _wifi_identifier(body.get("commandId"))
        claim_digest = _hex_bytes(body.get("claimHash"), 32)
        supplied_receipt = _hex_bytes(body.get("receipt"), 32)
        if (
            not command_id
            or not hmac.compare_digest(
                supplied_receipt,
                wifi_claim_receipt(credential, command_id, claim_digest),
            )
        ):
            raise PermissionError("confirmación Wi-Fi inválida")
        self.web.result_sync(command_id, success=True)
        return {
            "version": WIFI_PROTOCOL_VERSION,
            "state": "confirmed",
            "commandId": command_id,
        }

    def _credential(self, module_id: object) -> ModuleCredential:
        self._reload_registry_if_changed()
        module = _wifi_identifier(module_id)
        credential = self.credentials.get(module)
        if credential is None or not credential.active:
            raise PermissionError("MIM no registrado o desactivado")
        return credential

    def _reload_registry_if_changed(self) -> None:
        if self.registry_path is None:
            return
        modified = self.registry_path.stat().st_mtime_ns
        if modified == self._registry_mtime_ns:
            return
        self.credentials = load_equipment_registry(self.registry_path)
        self._registry_mtime_ns = modified
        print(json.dumps({
            "component": "equipment_enrollment",
            "status": "registry_reloaded",
            "modules": len(self.credentials),
        }), flush=True)


def _hex_bytes(value: object, size: int) -> bytes:
    if not isinstance(value, str) or len(value) != size * 2:
        raise ValueError("valor hexadecimal Wi-Fi inválido")
    try:
        decoded = bytes.fromhex(value)
    except ValueError as error:
        raise ValueError("valor hexadecimal Wi-Fi inválido") from error
    if len(decoded) != size:
        raise ValueError("valor hexadecimal Wi-Fi inválido")
    return decoded


def make_wifi_enrollment_handler(
    coordinator: WifiEnrollmentCoordinator,
) -> type[BaseHTTPRequestHandler]:
    class WifiEnrollmentHandler(BaseHTTPRequestHandler):
        server_version = "FuelEquipmentEnrollment/2"

        def do_POST(self) -> None:  # noqa: N802 - API de BaseHTTPRequestHandler
            if self.path not in {
                "/v1/enrollment/challenge",
                "/v1/enrollment/status",
                "/v1/enrollment/confirm",
                "/v2/enrollment/challenge",
                "/v2/enrollment/status",
                "/v2/enrollment/confirm",
            }:
                self._reply(404, {"error": "ruta no encontrada"})
                return
            try:
                length = int(self.headers.get("Content-Length", "0"))
                if length <= 0 or length > MAX_WIFI_REQUEST_BYTES:
                    raise ValueError("tamaño de petición inválido")
                request = json.loads(self.rfile.read(length))
                if not isinstance(request, dict):
                    raise ValueError("petición Wi-Fi inválida")
                if self.path.endswith("/challenge"):
                    response = coordinator.challenge(request)
                elif self.path.endswith("/status"):
                    response = coordinator.authenticated("status", request)
                else:
                    response = coordinator.authenticated("confirm", request)
                self._reply(200, response)
            except PermissionError as error:
                self._reply(403, {"error": str(error)})
            except (ValueError, UnicodeError, json.JSONDecodeError) as error:
                self._reply(400, {"error": str(error)})
            except Exception as error:
                print(json.dumps({
                    "component": "equipment_enrollment",
                    "client": self.client_address[0],
                    "error": type(error).__name__,
                    "detail": str(error)[:200],
                }), flush=True)
                self._reply(503, {"error": "servicio de enrolamiento no disponible"})

        def _reply(self, status: int, payload: dict[str, Any]) -> None:
            body = json.dumps(payload, separators=(",", ":")).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, format: str, *args: object) -> None:
            return

    return WifiEnrollmentHandler


class BleEnrollmentRuntime:
    def __init__(
        self,
        site_id: str,
        credentials: dict[str, ModuleCredential],
        web: EnrollmentWebClient,
        scan_seconds: float = 4.0,
        max_connections: int = 4,
        claimed_refresh_seconds: float = 30.0,
        registry_path: Path | None = None,
    ) -> None:
        self.site_id = site_id
        self.credentials = credentials
        self.web = web
        self.scan_seconds = scan_seconds
        self.max_connections = max_connections
        self.claimed_refresh_seconds = claimed_refresh_seconds
        self.registry_path = registry_path
        self._registry_mtime_ns: int | None = None
        self._known_claimed: dict[str, bool] = {}
        self._last_verified: dict[str, float] = {}

    async def run_forever(self) -> None:
        while True:
            self._reload_registry_if_changed()
            manual_scan: dict[str, Any] | None = None
            try:
                manual_scan = await self.web.next_scan()
            except Exception as error:
                self._log_error("scan_request", error)
            duration = self.scan_seconds
            if manual_scan is not None:
                try:
                    duration = max(duration, min(60.0, float(manual_scan.get("durationSeconds", 25))))
                except (TypeError, ValueError):
                    duration = max(duration, 25.0)
            discovered = 0
            verified = 0
            try:
                discovered, verified = await self.scan_once(duration)
                if manual_scan is not None:
                    await self.web.scan_result(
                        str(manual_scan.get("id", "")),
                        success=True,
                        discovered=discovered,
                        verified=verified,
                    )
            except Exception as error:
                self._log_error("scan_cycle", error)
                if manual_scan is not None:
                    try:
                        await self.web.scan_result(
                            str(manual_scan.get("id", "")),
                            success=False,
                            discovered=discovered,
                            verified=verified,
                            error=str(error)[:200],
                        )
                    except Exception as report_error:
                        self._log_error("scan_result", report_error)
            await asyncio.sleep(1)

    def _reload_registry_if_changed(self) -> None:
        if self.registry_path is None:
            return
        try:
            modified = self.registry_path.stat().st_mtime_ns
            if modified == self._registry_mtime_ns:
                return
            refreshed = load_equipment_registry(self.registry_path)
        except Exception as error:
            self._log_error("registry_reload", error)
            return
        self.credentials = refreshed
        self._registry_mtime_ns = modified
        print(json.dumps({
            "component": "equipment_enrollment",
            "status": "registry_reloaded",
            "modules": len(refreshed),
        }), flush=True)

    async def scan_once(self, duration: float) -> tuple[int, int]:
        """Escanea en ventanas cortas y conecta todos los XIAO vistos en paralelo.

        Un MIM asignado anuncia cuatro segundos antes de dormir; uno nuevo
        permanece despierto. Conectar sólo después de un escaneo largo hacía
        que el anuncio del primero ya hubiese terminado.
        """
        from bleak import BleakScanner

        loop = asyncio.get_running_loop()
        deadline = loop.time() + max(1.0, duration)
        discovered_addresses: set[str] = set()
        verified_addresses: set[str] = set()
        verified_modules: set[str] = set()
        last_attempt: dict[str, float] = {}
        semaphore = asyncio.Semaphore(self.max_connections)
        while loop.time() < deadline:
            seen: dict[str, tuple[Any, Any]] = {}
            scanner = BleakScanner(lambda device, advertisement: seen.__setitem__(device.address, (device, advertisement)))
            await scanner.start()
            try:
                await asyncio.sleep(min(0.6, max(0.1, deadline - loop.time())))
            finally:
                await scanner.stop()
            now = loop.time()
            candidates: list[tuple[int, Any, int]] = []
            for address, (device, advertisement) in seen.items():
                flags = _equipment_advertisement_flags(advertisement.manufacturer_data)
                if flags is None:
                    continue
                discovered_addresses.add(address)
                enrollment_ready = bool(flags & ADVERTISEMENT_FLAG_ENROLLMENT_READY)
                if enrollment_ready:
                    # Un reset de fábrica debe vencer cualquier caché local.
                    self._known_claimed[address] = False
                elif (
                    self._known_claimed.get(address) is True
                    and now - self._last_verified.get(address, -self.claimed_refresh_seconds)
                    < self.claimed_refresh_seconds
                ):
                    continue
                if address in verified_addresses or now - last_attempt.get(address, -10.0) < 3.0:
                    continue
                last_attempt[address] = now
                # Los MIM nuevos siempre se atienden antes que los ya asignados.
                priority = 0 if enrollment_ready else 1
                candidates.append((priority, device, int(advertisement.rssi)))
            if candidates:
                candidates.sort(key=lambda item: (item[0], -item[2]))
                results = await asyncio.gather(*(
                    self._inspect_guarded(device, rssi, semaphore)
                    for _priority, device, rssi in candidates
                ))
                verified_addresses.update(address for address, module_id in results if module_id)
                verified_modules.update(module_id for _address, module_id in results if module_id)
        return len(discovered_addresses), len(verified_modules)

    async def _inspect_guarded(self, device: Any, rssi: int, semaphore: asyncio.Semaphore) -> tuple[str, str | None]:
        try:
            async with semaphore:
                return device.address, await self._inspect(device, rssi)
        # A single radio/DBus failure must not stop discovery for the other
        # tractors. asyncio cancellation remains outside this Exception guard.
        except Exception as error:
            self._log_error(device.address, error)
            return device.address, None

    async def _inspect(self, device: Any, rssi: int) -> str | None:
        from bleak import BleakClient
        async with BleakClient(device, timeout=8.0) as client:
            identity = parse_identity(bytes(await client.read_gatt_char(IDENTITY_UUID)))
            credential = self.credentials.get(identity.module_id)
            if credential is None or not credential.active:
                return None
            challenge = secrets.token_bytes(BLE_CHALLENGE_BYTES)
            await client.write_gatt_char(CHALLENGE_UUID, challenge, response=True)
            response = bytes(await client.read_gatt_char(RESPONSE_UUID))
            if len(response) != BLE_RESPONSE_BYTES:
                raise ValueError("respuesta criptográfica BLE inválida")
            module_nonce = response[:BLE_MODULE_NONCE_BYTES]
            expected = expected_auth_response(
                credential, identity, challenge, module_nonce
            )
            if not hmac.compare_digest(response, expected):
                raise ValueError("la identidad criptográfica BLE no coincide")
            await self.web.sighting(identity, self.site_id, rssi)
            self._known_claimed[device.address] = identity.claimed
            self._last_verified[device.address] = asyncio.get_running_loop().time()
            command = await self.web.next_command(identity.module_id)
            if command is None:
                return identity.module_id
            command_id = str(command.get("id", ""))
            try:
                if command.get("siteId") != self.site_id:
                    raise ValueError("la orden pertenece a otro campo")
                packet = build_claim_packet(
                    credential,
                    site_id=self.site_id,
                    equipment_id=str(command.get("equipmentId", "")),
                    name=str(command.get("name", "")),
                )
                await client.write_gatt_char(CLAIM_UUID, packet, response=True)
                await asyncio.sleep(0.25)
                updated = parse_identity(bytes(await client.read_gatt_char(IDENTITY_UUID)))
                if not updated.claimed or updated.site_id != self.site_id or updated.equipment_id != command.get("equipmentId") or updated.device_name != command.get("name"):
                    raise ValueError("el XIAO no confirmó la asignación")
                await self.web.result(command_id, success=True)
                self._known_claimed[device.address] = True
                self._last_verified[device.address] = asyncio.get_running_loop().time()
            except Exception as error:
                await self.web.result(command_id, success=False, error=str(error)[:200])
            return identity.module_id

    @staticmethod
    def _log_error(device: str, error: Exception) -> None:
        print(json.dumps({
            "component": "equipment_enrollment",
            "device": device,
            "error": type(error).__name__,
            "detail": str(error)[:200],
        }), flush=True)


def _equipment_advertisement_flags(data: dict[int, bytes]) -> int | None:
    value = data.get(ADVERTISEMENT_COMPANY_ID)
    if value is None or len(value) < 2 or value[0] != PROTOCOL_VERSION:
        return None
    return int(value[1])


def _equipment_advertisement(data: dict[int, bytes]) -> bool:
    return _equipment_advertisement_flags(data) is not None


def _identifier(value: object) -> str:
    return _wifi_identifier(value)


def _optional_identifier(value: object) -> str:
    return "" if value in (None, "") else _identifier(value)


def main() -> None:
    parser = argparse.ArgumentParser(description="Enrolamiento Wi-Fi de módulos XIAO")
    parser.add_argument("--config", type=Path, default=Path("/etc/fuel-edge/config.toml"))
    parser.add_argument("--registry", type=Path, default=DEFAULT_REGISTRY)
    parser.add_argument("--bind", default="10.42.0.1")
    parser.add_argument("--port", type=int, default=8788)
    args = parser.parse_args()
    if not 1 <= args.port <= 65535:
        raise ValueError("puerto Wi-Fi inválido")
    config = load_config(args.config)
    if not config.web_sync.enabled:
        raise ValueError("web_sync debe estar activo para enrolar equipos")
    credentials = load_equipment_registry(args.registry)
    sensor_key = read_web_sensor_key(config.web_sync.sensor_key_path)
    web = EnrollmentWebClient(config.web_sync.base_url, sensor_key, config.web_sync.request_timeout_seconds)
    coordinator = WifiEnrollmentCoordinator(
        config.identity.site_id,
        credentials,
        web,
        registry_path=args.registry,
    )
    server = ThreadingHTTPServer(
        (args.bind, args.port), make_wifi_enrollment_handler(coordinator)
    )
    print(json.dumps({
        "component": "equipment_enrollment",
        "status": "wifi_ready",
        "bind": args.bind,
        "port": args.port,
        "modules": len(credentials),
    }), flush=True)
    try:
        server.serve_forever(poll_interval=0.5)
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
