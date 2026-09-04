"""Transporte MQTT/TLS para conversar con el validador desde el RPi."""

from __future__ import annotations

import hashlib
import json
import re
import ssl
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from pathlib import Path
from threading import BoundedSemaphore, Event, Lock, Thread
from time import monotonic
from typing import Any, Callable, Mapping

from .application import FuelEdgeApplication
from .rfid import RfidProof
from .validator_link import (
    CredentialPresenceUpdate,
    EquipmentPresenceUpdate,
    MAX_MESSAGE_BYTES,
    ValidatorDecision,
    ValidatorMessageCodec,
    ValidatorPresentation,
    ValidatorProtocolError,
    ValidatorTransportError,
)


_TOPIC_SEGMENT = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$")
_REGISTRY_GENERATION = re.compile(r"^[0-9a-f]{64}$")
MAX_EQUIPMENT_REGISTRY_ENTRIES = 32
MAX_EQUIPMENT_REGISTRY_MESSAGE_BYTES = 8192
MAX_MQTT_PUBLISH_TIMEOUT_SECONDS = 5.0
DEFAULT_RUNTIME_PENDING_TASKS = 32


@dataclass(frozen=True, slots=True)
class MqttTlsConfig:
    host: str
    site_id: str
    module_id: str
    ca_certificate: Path
    client_certificate: Path
    client_key: Path
    port: int = 8883
    keepalive_seconds: int = 30
    connect_timeout_seconds: float = 10.0
    publish_timeout_seconds: float = MAX_MQTT_PUBLISH_TIMEOUT_SECONDS

    def __post_init__(self) -> None:
        if not self.host.strip():
            raise ValueError("host MQTT no puede estar vacío")
        for value, name in (
            (self.site_id, "site_id"),
            (self.module_id, "module_id"),
        ):
            if not _TOPIC_SEGMENT.fullmatch(value):
                raise ValueError(f"{name} inválido para tópico MQTT")
        if not 1 <= self.port <= 65535:
            raise ValueError("puerto MQTT inválido")
        if self.keepalive_seconds <= 0:
            raise ValueError("keepalive_seconds debe ser positivo")
        if self.connect_timeout_seconds <= 0 or self.publish_timeout_seconds <= 0:
            raise ValueError("timeouts MQTT deben ser positivos")
        if self.publish_timeout_seconds > MAX_MQTT_PUBLISH_TIMEOUT_SECONDS:
            raise ValueError(
                "publish_timeout_seconds excede el presupuesto del watchdog"
            )

    @property
    def topic_root(self) -> str:
        return f"fuel-edge/v1/{self.site_id}/{self.module_id}/validators"


@dataclass(slots=True)
class _PendingProof:
    event: Event = field(default_factory=Event)
    proof: RfidProof | None = None
    received: bool = False
    error: Exception | None = None


class MqttValidatorTransport:
    """Implementa RPC correlacionado sobre MQTT QoS 1 y TLS mutuo."""

    def __init__(
        self,
        config: MqttTlsConfig,
        *,
        client: Any | None = None,
    ) -> None:
        self.config = config
        self._client = client or self._build_client()
        self._ready = Event()
        self._lock = Lock()
        self._pending: dict[tuple[str, str], _PendingProof] = {}
        self._pending_retained: dict[
            str, tuple[tuple[bytes, bool], ...]
        ] = {}
        self._presentation_handler: Callable[[ValidatorPresentation], None] | None = None
        self._equipment_handler: Callable[[EquipmentPresenceUpdate], None] | None = None
        self._credential_handler: Callable[[CredentialPresenceUpdate], None] | None = None
        self._config_status_handler: Callable[[str, int, int], None] | None = None
        self._hardware_status_handler: Callable[[str, bool, int], None] | None = None
        self._equipment_registry_status_handler: (
            Callable[[str, str, int, int, bool], None] | None
        ) = None
        self._disconnect_handler: Callable[[], None] | None = None
        self._error_handler: Callable[[Exception], None] | None = None
        self._subscribe_mid: int | None = None
        self._started = False
        self._lifecycle_generation = 0
        self._recovery_lock = Lock()
        self._recovery_thread: Thread | None = None
        self._recovery_cancel: Event | None = None
        self._client.on_connect = self._on_connect
        self._client.on_subscribe = self._on_subscribe
        self._client.on_disconnect = self._on_disconnect
        self._client.on_message = self._on_message

    def _build_client(self) -> Any:
        try:
            import paho.mqtt.client as mqtt
        except ImportError as exc:
            raise ValidatorTransportError(
                "paho-mqtt no está instalado; instale la dependencia mqtt"
            ) from exc

        client = mqtt.Client(
            callback_api_version=mqtt.CallbackAPIVersion.VERSION2,
            client_id=f"fuel-edge-{self.config.module_id}",
            clean_session=False,
            protocol=mqtt.MQTTv311,
        )
        client.tls_set(
            ca_certs=str(self.config.ca_certificate),
            certfile=str(self.config.client_certificate),
            keyfile=str(self.config.client_key),
            cert_reqs=ssl.CERT_REQUIRED,
            tls_version=ssl.PROTOCOL_TLS_CLIENT,
        )
        client.tls_insecure_set(False)
        status_topic = f"{self.config.topic_root}/rpi/status"
        client.will_set(
            status_topic,
            json.dumps({"online": False}, separators=(",", ":")),
            qos=1,
            retain=True,
        )
        return client

    def set_presentation_handler(
        self, handler: Callable[[ValidatorPresentation], None]
    ) -> None:
        self._presentation_handler = handler

    def set_equipment_handler(
        self, handler: Callable[[EquipmentPresenceUpdate], None]
    ) -> None:
        self._equipment_handler = handler

    def set_credential_handler(
        self, handler: Callable[[CredentialPresenceUpdate], None]
    ) -> None:
        self._credential_handler = handler

    def set_config_status_handler(
        self, handler: Callable[[str, int, int], None]
    ) -> None:
        self._config_status_handler = handler

    def set_hardware_status_handler(
        self, handler: Callable[[str, bool, int], None]
    ) -> None:
        self._hardware_status_handler = handler

    def set_equipment_registry_status_handler(
        self, handler: Callable[[str, str, int, int, bool], None]
    ) -> None:
        self._equipment_registry_status_handler = handler

    def set_disconnect_handler(self, handler: Callable[[], None]) -> None:
        self._disconnect_handler = handler

    def set_error_handler(self, handler: Callable[[Exception], None]) -> None:
        """Reporta fallas internas sin permitir que maten el hilo de Paho."""

        self._error_handler = handler

    def start(self) -> None:
        with self._recovery_lock:
            if self._started:
                return
            self._started = True
            self._lifecycle_generation += 1
        try:
            reconnect_delay_set = getattr(self._client, "reconnect_delay_set", None)
            if callable(reconnect_delay_set):
                reconnect_delay_set(min_delay=1, max_delay=10)
            connect_async = getattr(self._client, "connect_async", None)
            if callable(connect_async):
                # Paho mantiene este intento en su hilo de red. Así la Raspberry
                # arranca segura y sigue buscando el broker/validador aunque todavía
                # no estén disponibles, sin reiniciar el resto del controlador.
                rc = connect_async(
                    self.config.host,
                    self.config.port,
                    self.config.keepalive_seconds,
                )
                # Paho 1.x retorna None y Paho 2.x retorna MQTT_ERR_SUCCESS (0).
                if rc not in (None, 0):
                    raise ValidatorTransportError(
                        f"MQTT connect_async falló: rc={rc}"
                    )
                loop_rc = self._client.loop_start()
                if loop_rc not in (None, 0):
                    raise ValidatorTransportError(
                        f"MQTT loop_start falló: rc={loop_rc}"
                    )
                return
            # Compatibilidad con clientes inyectados y versiones sin connect_async.
            rc = self._client.connect(
                self.config.host,
                self.config.port,
                self.config.keepalive_seconds,
            )
            if rc != 0:
                raise ValidatorTransportError(f"MQTT connect falló: rc={rc}")
            loop_rc = self._client.loop_start()
            if loop_rc not in (None, 0):
                raise ValidatorTransportError(
                    f"MQTT loop_start falló: rc={loop_rc}"
                )
            if not self._ready.wait(self.config.connect_timeout_seconds):
                raise ValidatorTransportError(
                    "MQTT no confirmó conexión y suscripciones"
                )
        except Exception as exc:
            error = _transport_error("no se pudo iniciar el transporte MQTT", exc)
            self._abort_start(error)
            raise error

    def close(self) -> None:
        with self._recovery_lock:
            if not self._started:
                return
            self._started = False
            self._lifecycle_generation += 1
            if self._recovery_cancel is not None:
                self._recovery_cancel.set()
        errors: list[Exception] = []
        try:
            self._publish_status(False)
        except Exception as exc:
            errors.append(_transport_error("no se pudo publicar estado MQTT final", exc))
        try:
            self._client.disconnect()
        except Exception as exc:
            errors.append(_transport_error("falló la desconexión MQTT", exc))
        try:
            self._client.loop_stop()
        except Exception as exc:
            errors.append(_transport_error("falló la detención del loop MQTT", exc))
        finally:
            self._ready.clear()
            self._fail_pending(ValidatorTransportError("transporte MQTT cerrado"))
        for error in errors:
            self._report_error(error)

    def exchange_proof(
        self,
        validator_id: str,
        session_id: str,
        challenge: bytes,
        timeout_seconds: float,
        *,
        purpose: str = "authorization",
    ) -> RfidProof | None:
        if not self._ready.is_set():
            raise ValidatorTransportError("MQTT no está listo")
        key = (validator_id, session_id)
        pending = _PendingProof()
        with self._lock:
            if key in self._pending:
                raise ValidatorTransportError("sesión RFID duplicada")
            self._pending[key] = pending
        try:
            payload = ValidatorMessageCodec.encode_challenge(
                validator_id, session_id, challenge, purpose=purpose
            )
            self._publish_qos1(self._topic(validator_id, "challenge"), payload)
            if not pending.event.wait(timeout_seconds):
                raise ValidatorTransportError("timeout esperando prueba RFID")
            if pending.error is not None:
                raise ValidatorTransportError("falló la espera de prueba RFID") from pending.error
            if not pending.received:
                raise ValidatorTransportError("respuesta RFID incompleta")
            return pending.proof
        finally:
            with self._lock:
                self._pending.pop(key, None)

    def publish_decision(self, decision: ValidatorDecision) -> None:
        if not self._ready.is_set():
            raise ValidatorTransportError("MQTT no está listo")
        payload = ValidatorMessageCodec.encode_decision(decision)
        self._publish_qos1(
            self._topic(decision.validator_id, "decision"), payload
        )

    def publish_runtime_config(
        self, validator_id: str, rssi_threshold: int, revision: int
    ) -> None:
        if not -100 <= rssi_threshold <= -35 or revision < 1:
            raise ValueError("configuración Bluetooth inválida")
        payload = json.dumps({
            "version": 1,
            "type": "validator.config",
            "validator_id": validator_id,
            "ble_rssi_threshold": rssi_threshold,
            "revision": revision,
        }, separators=(",", ":"), sort_keys=True).encode("utf-8")
        self._publish_retained_or_queue(
            self._topic(validator_id, "config"), payload
        )

    def publish_enrollment_window(self, validator_id: str, active: bool) -> None:
        """Avisa al validador que la próxima presentación es sólo para NFC."""

        payload = json.dumps({
            "version": 1,
            "type": "validator.enrollment.window",
            "validator_id": validator_id,
            "active": active,
        }, separators=(",", ":"), sort_keys=True).encode("utf-8")
        topic = self._topic(validator_id, "enrollment")
        if active:
            self._publish_retained_or_queue(topic, payload)
            return

        # Un cierre no necesita quedar retenido: el firmware arranca cerrado.
        # Borrar primero el valor retenido evita sumar un cuarto mensaje al
        # arranque de validadores 0.4.0, cuyo inbox MQTT era más pequeño. El
        # mensaje no retenido posterior cierra de inmediato una ventana que ya
        # esté abierta en un validador conectado.
        self._publish_state_or_queue(
            topic,
            ((b"", True), (payload, False)),
        )

    def publish_equipment_registry(
        self, validator_id: str, entries: Mapping[str, bytes]
    ) -> str:
        """Distribuye todas las claves activas como una instantánea autoritativa.

        El tópico es retenido, usa QoS 1 y sólo puede ser escrito por el
        certificado de la Raspberry según la ACL del broker local.
        """

        validated = _validated_equipment_registry(entries)
        generation = _equipment_registry_generation(validated)
        payload = json.dumps(
            {
                "version": 1,
                "type": "validator.equipment.registry",
                "validator_id": validator_id,
                "generation": generation,
                "modules": [
                    {"module_id": module_id, "secret_hex": secret.hex()}
                    for module_id, secret in validated
                ],
            },
            separators=(",", ":"),
            sort_keys=True,
        ).encode("utf-8")
        if len(payload) > MAX_EQUIPMENT_REGISTRY_MESSAGE_BYTES:
            raise ValueError("el registro MIM excede el tamaño MQTT permitido")
        self._publish_retained_or_queue(
            self._topic(validator_id, "registry"), payload
        )
        return generation

    def _on_connect(
        self,
        client: Any,
        userdata: Any,
        flags: Any,
        reason_code: Any,
        properties: Any,
    ) -> None:
        try:
            if reason_code != 0:
                raise ValidatorTransportError(
                    f"broker rechazó conexión: {reason_code}"
                )
            subscriptions = [
                (f"{self.config.topic_root}/+/proof", 1),
                (f"{self.config.topic_root}/+/presentation", 1),
                (f"{self.config.topic_root}/+/equipment", 1),
                (f"{self.config.topic_root}/+/credential", 1),
                (f"{self.config.topic_root}/+/config/status", 1),
                (f"{self.config.topic_root}/+/registry/status", 1),
            ]
            rc, mid = client.subscribe(subscriptions)
            if rc != 0:
                raise ValidatorTransportError(
                    f"suscripción MQTT falló: rc={rc}"
                )
            self._subscribe_mid = mid
        except Exception as exc:
            self._fail_callback("falló el callback MQTT de conexión", exc)

    def _on_subscribe(
        self,
        client: Any,
        userdata: Any,
        mid: int,
        reason_codes: Any,
        properties: Any,
    ) -> None:
        try:
            if mid != self._subscribe_mid:
                return
            if any(_mqtt_reason_failed(code) for code in reason_codes):
                raise ValidatorTransportError("broker rechazó suscripción")
            self._ready.set()
            # Este callback corre en el hilo de red; no debe esperar su propio PUBACK.
            self._publish_status(True, wait=False)
            self._flush_pending_retained()
        except Exception as exc:
            self._fail_callback("falló el callback MQTT de suscripción", exc)

    def _on_disconnect(
        self,
        client: Any,
        userdata: Any,
        disconnect_flags: Any,
        reason_code: Any,
        properties: Any,
    ) -> None:
        self._ready.clear()
        # Despertar primero a exchange_proof es esencial: process_presentation
        # mantiene el lock de la aplicación mientras espera la prueba. Si el
        # handler de desconexión intenta tomar ese lock antes de liberar la
        # espera, el worker y el hilo de red quedan bloqueados entre sí.
        try:
            self._fail_pending(ValidatorTransportError("MQTT desconectado"))
        except Exception as exc:
            self._report_error(
                _transport_error("falló la cancelación de RPC MQTT", exc)
            )
        if self._disconnect_handler is not None:
            self._invoke_handler(
                self._disconnect_handler,
                context="falló el handler de desconexión MQTT",
            )

    def _on_message(self, client: Any, userdata: Any, message: Any) -> None:
        try:
            payload = bytes(message.payload)
            if not payload or len(payload) > MAX_MESSAGE_BYTES:
                return
            parsed = self._parse_topic(str(message.topic))
            if parsed is None:
                return
            topic_validator, kind = parsed
            if kind == "proof":
                validator_id, session_id, proof = ValidatorMessageCodec.decode_proof(
                    payload
                )
                if validator_id != topic_validator:
                    raise ValidatorProtocolError("validator_id no coincide con tópico")
                key = (validator_id, session_id)
                with self._lock:
                    pending = self._pending.get(key)
                    if pending is None:
                        return
                    pending.proof = proof
                    pending.received = True
                    pending.event.set()
                return
            if kind == "presentation":
                presentation = ValidatorMessageCodec.decode_presentation(payload)
                if presentation.validator_id != topic_validator:
                    raise ValidatorProtocolError("validator_id no coincide con tópico")
                if self._presentation_handler is not None:
                    self._invoke_handler(
                        self._presentation_handler,
                        presentation,
                        context="falló el handler de presentación MQTT",
                    )
                return
            if kind == "equipment":
                update = ValidatorMessageCodec.decode_equipment_presence(payload)
                if update.validator_id != topic_validator:
                    raise ValidatorProtocolError("validator_id no coincide con tópico")
                if self._equipment_handler is not None:
                    self._invoke_handler(
                        self._equipment_handler,
                        update,
                        context="falló el handler de presencia BLE MQTT",
                    )
                return
            if kind == "credential":
                update = ValidatorMessageCodec.decode_credential_presence(payload)
                if update.validator_id != topic_validator:
                    raise ValidatorProtocolError("validator_id no coincide con tópico")
                if self._credential_handler is not None:
                    self._invoke_handler(
                        self._credential_handler,
                        update,
                        context="falló el handler de presencia RFID MQTT",
                    )
                return
            if kind == "config/status":
                data = json.loads(payload.decode("utf-8"))
                if not isinstance(data, dict) or data.get("version") != 1 or data.get("type") != "validator.config.status":
                    raise ValidatorProtocolError("estado de configuración inválido")
                validator_id = data.get("validator_id")
                threshold = data.get("ble_rssi_threshold")
                revision = data.get("revision")
                if validator_id != topic_validator or not isinstance(threshold, int) or not -100 <= threshold <= -35 or not isinstance(revision, int) or revision < 1:
                    raise ValidatorProtocolError("confirmación de configuración inválida")
                if self._config_status_handler is not None:
                    self._invoke_handler(
                        self._config_status_handler,
                        validator_id,
                        threshold,
                        revision,
                        context="falló el handler de configuración MQTT",
                    )
                nfc_ready = data.get("rfid_ready")
                rfid_version = data.get("rfid_version")
                if (
                    isinstance(nfc_ready, bool)
                    and isinstance(rfid_version, int)
                    and 0 <= rfid_version <= 255
                    and self._hardware_status_handler is not None
                ):
                    self._invoke_handler(
                        self._hardware_status_handler,
                        validator_id,
                        nfc_ready,
                        rfid_version,
                        context="falló el handler de hardware MQTT",
                    )
                return
            if kind == "registry/status":
                data = json.loads(payload.decode("utf-8"))
                if (
                    not isinstance(data, dict)
                    or data.get("version") != 1
                    or data.get("type") != "validator.equipment.registry.status"
                ):
                    raise ValidatorProtocolError("acuse de registro MIM inválido")
                validator_id = data.get("validator_id")
                generation = data.get("generation")
                module_count = data.get("module_count")
                capacity = data.get("capacity")
                persisted = data.get("persisted")
                if (
                    validator_id != topic_validator
                    or not isinstance(generation, str)
                    or not _REGISTRY_GENERATION.fullmatch(generation)
                    or not isinstance(module_count, int)
                    or isinstance(module_count, bool)
                    or not 0 <= module_count <= MAX_EQUIPMENT_REGISTRY_ENTRIES
                    or not isinstance(capacity, int)
                    or isinstance(capacity, bool)
                    or capacity < MAX_EQUIPMENT_REGISTRY_ENTRIES
                    or persisted is not True
                ):
                    raise ValidatorProtocolError("acuse de registro MIM incompleto")
                if self._equipment_registry_status_handler is not None:
                    self._invoke_handler(
                        self._equipment_registry_status_handler,
                        validator_id,
                        generation,
                        module_count,
                        capacity,
                        persisted,
                        context="falló el handler de registro MIM MQTT",
                    )
        except (ValidatorProtocolError, ValueError):
            return
        except Exception as exc:
            self._report_error(
                _transport_error("falló el callback de mensaje MQTT", exc)
            )

    def _publish_status(self, online: bool, *, wait: bool = True) -> None:
        payload = json.dumps(
            {"online": online}, separators=(",", ":"), sort_keys=True
        ).encode("utf-8")
        self._publish_qos1(
            f"{self.config.topic_root}/rpi/status",
            payload,
            retain=True,
            wait=wait,
        )

    def _publish_retained_or_queue(self, topic: str, payload: bytes) -> None:
        """Publica el último estado o lo conserva hasta completar MQTT."""

        self._publish_state_or_queue(topic, ((payload, True),))

    def _publish_state_or_queue(
        self,
        topic: str,
        publications: tuple[tuple[bytes, bool], ...],
    ) -> None:
        """Publica el estado final o conserva su secuencia MQTT completa."""

        with self._lock:
            if not self._ready.is_set():
                self._pending_retained[topic] = publications
                return
        try:
            for payload, retain in publications:
                self._publish_qos1(topic, payload, retain=retain)
        except ValidatorTransportError:
            # La conexión puede caer entre comprobar _ready y publicar. Conservar
            # sólo el valor más reciente evita perder una apertura/cierre de
            # enrolamiento y evita reproducir configuraciones obsoletas.
            with self._lock:
                self._pending_retained[topic] = publications
            raise

    def _flush_pending_retained(self) -> None:
        with self._lock:
            pending = tuple(self._pending_retained.items())
            self._pending_retained.clear()
        for index, (topic, publications) in enumerate(pending):
            try:
                for payload, retain in publications:
                    self._publish_qos1(
                        topic, payload, retain=retain, wait=False
                    )
            except ValidatorTransportError:
                with self._lock:
                    for queued_topic, queued_publications in pending[index:]:
                        self._pending_retained[queued_topic] = queued_publications
                raise

    def _publish_qos1(
        self,
        topic: str,
        payload: bytes,
        *,
        retain: bool = False,
        wait: bool = True,
    ) -> None:
        try:
            info = self._client.publish(topic, payload, qos=1, retain=retain)
            rc = info.rc
        except Exception as exc:
            raise ValidatorTransportError("cliente MQTT no pudo publicar") from exc
        if rc != 0:
            raise ValidatorTransportError(f"publicación MQTT falló: rc={rc}")
        if not wait:
            return
        try:
            info.wait_for_publish(timeout=self.config.publish_timeout_seconds)
            if hasattr(info, "is_published") and not info.is_published():
                raise ValidatorTransportError("timeout confirmando publicación MQTT")
        except ValidatorTransportError:
            raise
        except Exception as exc:
            raise ValidatorTransportError("publicación MQTT no confirmada") from exc

    def _topic(self, validator_id: str, suffix: str) -> str:
        if not _TOPIC_SEGMENT.fullmatch(validator_id):
            raise ValidatorTransportError("validator_id inválido para tópico")
        return f"{self.config.topic_root}/{validator_id}/{suffix}"

    def _parse_topic(self, topic: str) -> tuple[str, str] | None:
        prefix = f"{self.config.topic_root}/"
        if not topic.startswith(prefix):
            return None
        parts = topic[len(prefix) :].split("/")
        if len(parts) == 3 and parts[1:] in (
            ["config", "status"],
            ["registry", "status"],
        ):
            kind = "/".join(parts[1:])
        elif len(parts) == 2 and parts[1] in {
            "proof", "presentation", "equipment", "credential"
        }:
            kind = parts[1]
        else:
            return None
        if not _TOPIC_SEGMENT.fullmatch(parts[0]):
            return None
        return parts[0], kind

    def _fail_pending(self, error: Exception) -> None:
        with self._lock:
            for pending in self._pending.values():
                pending.error = error
                pending.event.set()

    def _fail_callback(self, context: str, error: Exception) -> None:
        transport_error = _transport_error(context, error)
        self._ready.clear()
        self._fail_pending(transport_error)
        self._report_error(transport_error)
        self._request_recovery()

    def _request_recovery(self) -> None:
        """Fuerza una nueva sesión MQTT sin bloquear el callback de Paho."""

        with self._recovery_lock:
            if not self._started:
                return
            if self._recovery_thread is not None and self._recovery_thread.is_alive():
                if self._recovery_cancel is None or not self._recovery_cancel.is_set():
                    return
            cancel = Event()
            generation = self._lifecycle_generation
            recovery = Thread(
                target=self._recover_connection,
                args=(generation, cancel),
                name="fuel-edge-mqtt-recovery",
                daemon=True,
            )
            self._recovery_cancel = cancel
            self._recovery_thread = recovery
            recovery.start()

    def _recover_connection(self, generation: int, cancel: Event) -> None:
        """Reintenta con backoff; ``reconnect`` puede bloquear sólo este daemon."""

        try:
            # Ceder el hilo permite que el callback que solicitó la recuperación
            # termine antes de que Paho cierre y reemplace su socket.
            if cancel.wait(0.01) or not self._recovery_is_active(generation):
                return
            if self._disconnect_handler is not None:
                self._invoke_handler(
                    self._disconnect_handler,
                    context="falló el fail-safe previo a reconexión MQTT",
                )

            delay = 0.0
            while self._recovery_is_active(generation) and not cancel.is_set():
                if self._ready.is_set():
                    return
                if delay and cancel.wait(delay):
                    return
                try:
                    reconnect = getattr(self._client, "reconnect", None)
                    if not callable(reconnect):
                        raise ValidatorTransportError(
                            "cliente MQTT no permite reconexión explícita"
                        )
                    rc = reconnect()
                    if rc not in (None, 0):
                        raise ValidatorTransportError(
                            f"reconexión MQTT falló: rc={rc}"
                        )
                except Exception as exc:
                    self._report_error(
                        _transport_error("falló la recuperación MQTT", exc)
                    )
                else:
                    if self._wait_ready_or_cancel(generation, cancel):
                        return
                    self._report_error(
                        ValidatorTransportError(
                            "MQTT reconectó sin confirmar suscripciones"
                        )
                    )
                delay = 1.0 if delay == 0.0 else min(10.0, delay * 2.0)
        finally:
            with self._recovery_lock:
                if self._recovery_cancel is cancel:
                    self._recovery_cancel = None
                    self._recovery_thread = None

    def _wait_ready_or_cancel(self, generation: int, cancel: Event) -> bool:
        deadline = monotonic() + self.config.connect_timeout_seconds
        while self._recovery_is_active(generation) and not cancel.is_set():
            remaining = deadline - monotonic()
            if remaining <= 0:
                return False
            if self._ready.wait(min(0.2, remaining)):
                return True
        return False

    def _recovery_is_active(self, generation: int) -> bool:
        with self._recovery_lock:
            return self._started and self._lifecycle_generation == generation

    def _abort_start(self, error: ValidatorTransportError) -> None:
        """Revierte un arranque parcial para que el mismo objeto pueda reintentar."""

        self._ready.clear()
        with self._recovery_lock:
            self._started = False
            self._lifecycle_generation += 1
            if self._recovery_cancel is not None:
                self._recovery_cancel.set()
        self._fail_pending(error)
        for method_name, context in (
            ("disconnect", "falló la limpieza de conexión MQTT parcial"),
            ("loop_stop", "falló la limpieza del loop MQTT parcial"),
        ):
            operation = getattr(self._client, method_name, None)
            if not callable(operation):
                continue
            try:
                operation()
            except Exception as exc:
                self._report_error(_transport_error(context, exc))

    def _invoke_handler(
        self,
        handler: Callable[..., None],
        *args: object,
        context: str,
    ) -> None:
        try:
            handler(*args)
        except Exception as exc:
            self._report_error(_transport_error(context, exc))

    def _report_error(self, error: Exception) -> None:
        if self._error_handler is None:
            return
        try:
            self._error_handler(error)
        except Exception:
            # El observador es diagnóstico: nunca forma parte de la cadena de
            # control ni puede terminar el loop de red.
            pass


def _mqtt_reason_failed(reason: Any) -> bool:
    if hasattr(reason, "is_failure"):
        return bool(reason.is_failure)
    try:
        return int(reason) >= 128
    except (TypeError, ValueError):
        return True


def _transport_error(message: str, cause: Exception) -> ValidatorTransportError:
    if isinstance(cause, ValidatorTransportError):
        return cause
    error = ValidatorTransportError(message)
    error.__cause__ = cause
    return error


def _validated_equipment_registry(
    entries: Mapping[str, bytes],
) -> list[tuple[str, bytes]]:
    if len(entries) > MAX_EQUIPMENT_REGISTRY_ENTRIES:
        raise ValueError(
            f"el validador admite hasta {MAX_EQUIPMENT_REGISTRY_ENTRIES} MIM activos"
        )
    validated: list[tuple[str, bytes]] = []
    for module_id, secret in sorted(entries.items()):
        if not _TOPIC_SEGMENT.fullmatch(module_id):
            raise ValueError(f"module_id inválido en registro MIM: {module_id!r}")
        if not isinstance(secret, bytes) or len(secret) != 32:
            raise ValueError(f"clave inválida para {module_id}")
        validated.append((module_id, secret))
    return validated


def _equipment_registry_generation(entries: list[tuple[str, bytes]]) -> str:
    digest = hashlib.sha256()
    for module_id, secret in entries:
        digest.update(module_id.encode("ascii"))
        digest.update(b"\x00")
        digest.update(secret)
    return digest.hexdigest()


@dataclass(slots=True)
class EquipmentRegistryDistributor:
    """Detecta cambios del registro protegido y los entrega al validador."""

    registry_path: Path
    transport: MqttValidatorTransport
    validator_id: str
    on_status: Callable[[str, int, int], None] | None = None
    republish_seconds: float = 30.0
    _published_generation: str | None = field(default=None, init=False)
    _published_module_count: int = field(default=0, init=False)
    _last_published_at: float = field(default=0.0, init=False)
    confirmed_generation: str | None = field(default=None, init=False)
    confirmed_module_count: int = field(default=0, init=False)

    def sync_if_changed(self, *, force: bool = False) -> str | None:
        from .equipment_enrollment import load_equipment_registry

        credentials = load_equipment_registry(self.registry_path)
        entries = {
            module_id: credential.secret
            for module_id, credential in credentials.items()
            if credential.active
        }
        validated = _validated_equipment_registry(entries)
        generation = _equipment_registry_generation(validated)
        if (
            not force
            and generation == self._published_generation
            and (
                generation == self.confirmed_generation
                or monotonic() - self._last_published_at < self.republish_seconds
            )
        ):
            return None
        published = self.transport.publish_equipment_registry(
            self.validator_id, entries
        )
        self._published_generation = published
        self._published_module_count = len(validated)
        self._last_published_at = monotonic()
        return published

    def handle_status(
        self,
        validator_id: str,
        generation: str,
        module_count: int,
        capacity: int,
        persisted: bool,
    ) -> None:
        if (
            validator_id != self.validator_id
            or not persisted
            or generation != self._published_generation
            or module_count != self._published_module_count
        ):
            return
        self.confirmed_generation = generation
        self.confirmed_module_count = module_count
        if self.on_status is not None:
            self.on_status(generation, module_count, capacity)


@dataclass(slots=True)
class MqttValidatorRuntime:
    """Despacha presentaciones sin bloquear el hilo de red de Paho."""

    application: FuelEdgeApplication
    transport: MqttValidatorTransport
    on_error: Callable[[Exception], None] | None = None
    max_pending_tasks: int = DEFAULT_RUNTIME_PENDING_TASKS
    _executor: ThreadPoolExecutor = field(init=False)
    _admission: BoundedSemaphore = field(init=False)
    _failsafe_event: Event = field(default_factory=Event, init=False)
    _failsafe_stop: Event = field(default_factory=Event, init=False)
    _failsafe_thread: Thread = field(init=False)
    _lifecycle_lock: Lock = field(default_factory=Lock, init=False)
    _closed: bool = field(default=False, init=False)

    def __post_init__(self) -> None:
        if self.max_pending_tasks < 1:
            raise ValueError("max_pending_tasks debe ser positivo")
        self._executor = ThreadPoolExecutor(
            max_workers=1, thread_name_prefix="fuel-edge-validator"
        )
        self._admission = BoundedSemaphore(self.max_pending_tasks)
        self._failsafe_thread = Thread(
            target=self._run_failsafe,
            name="fuel-edge-validator-failsafe",
            daemon=True,
        )
        self._failsafe_thread.start()
        self.transport.set_presentation_handler(self._enqueue)
        self.transport.set_equipment_handler(self._enqueue_equipment)
        self.transport.set_credential_handler(self._enqueue_credential)
        self.transport.set_error_handler(self._report_error)

    def start(self) -> None:
        self.transport.start()

    def close(self) -> None:
        with self._lifecycle_lock:
            if self._closed:
                return
            self._closed = True
        try:
            self.transport.close()
        except Exception as exc:
            self._report_error(exc)
        self._failsafe_stop.set()
        self._failsafe_event.set()
        try:
            self._executor.shutdown(wait=True, cancel_futures=True)
        except Exception as exc:
            self._report_error(exc)
        self._failsafe_thread.join(1.0)
        if self._failsafe_thread.is_alive():
            self._report_error(
                ValidatorTransportError("el fail-safe del validador no se detuvo")
            )

    def _enqueue(self, presentation: ValidatorPresentation) -> None:
        self._submit(self._process, presentation)

    def _process(self, presentation: ValidatorPresentation) -> None:
        try:
            self.application.process_presentation(presentation)
        except Exception as exc:
            self._report_error(exc)

    def _enqueue_equipment(self, update: EquipmentPresenceUpdate) -> None:
        self._submit(self._process_equipment, update, fail_safe_on_reject=True)

    def _process_equipment(self, update: EquipmentPresenceUpdate) -> None:
        try:
            self.application.process_equipment_presence(update)
        except Exception as exc:
            self._report_error(exc)

    def _enqueue_credential(self, update: CredentialPresenceUpdate) -> None:
        self._submit(self._process_credential, update, fail_safe_on_reject=True)

    def _process_credential(self, update: CredentialPresenceUpdate) -> None:
        try:
            self.application.process_credential_presence(update)
        except Exception as exc:
            self._report_error(exc)

    def _submit(
        self,
        operation: Callable[..., None],
        *args: object,
        fail_safe_on_reject: bool = False,
    ) -> None:
        error: Exception | None = None
        rejected = False
        with self._lifecycle_lock:
            if self._closed:
                return
            if not self._admission.acquire(blocking=False):
                rejected = True
            else:
                try:
                    self._executor.submit(self._run_admitted, operation, args)
                except Exception as exc:
                    self._admission.release()
                    error = exc
        if rejected:
            error = ValidatorTransportError(
                "cola del validador saturada; mensaje rechazado"
            )
            if fail_safe_on_reject:
                # Un Event coalesce cualquier ráfaga en una sola orden de corte;
                # no crea otra cola ni bloquea el hilo de red de Paho.
                self._failsafe_event.set()
        if error is not None:
            self._report_error(error)

    def _run_admitted(
        self, operation: Callable[..., None], args: tuple[object, ...]
    ) -> None:
        try:
            operation(*args)
        finally:
            self._admission.release()

    def _run_failsafe(self) -> None:
        while not self._failsafe_stop.is_set():
            self._failsafe_event.wait()
            self._failsafe_event.clear()
            if self._failsafe_stop.is_set():
                return
            try:
                self.application.process_validator_disconnect()
            except Exception as exc:
                self._report_error(exc)

    def _report_error(self, error: Exception) -> None:
        if self.on_error is None:
            return
        try:
            self.on_error(error)
        except Exception:
            # Un logger/observador defectuoso no invalida el worker de control.
            pass
