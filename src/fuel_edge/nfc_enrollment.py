"""Enrolamiento NFC coordinado por la web local y ejecutado por el RPi."""

from __future__ import annotations

from dataclasses import dataclass
import hmac
import json
import os
from pathlib import Path
import re
import secrets
import stat
from threading import Event, Lock, Thread
from time import monotonic
from typing import Callable
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

from .config import WebSyncConfig
from .rfid import MemoryCredentialRepository, RfidCredential, build_rfid_response
from .validator_link import ValidatorDecision, ValidatorPresentation, ValidatorTransport


_ENROLLED_CREDENTIAL_ID = re.compile(r"^nfc-[a-f0-9]{8,20}$")
_EXPECTED_OPERATION_ERRORS = (
    HTTPError,
    URLError,
    OSError,
    RuntimeError,
    TimeoutError,
    TypeError,
    ValueError,
)


@dataclass(frozen=True, slots=True)
class NfcEnrollmentCommand:
    command_id: str
    operator_id: str | None
    purpose: str = "enrollment"
    is_master: bool = False
    deactivated_credential_ids: tuple[str, ...] = ()
    # None identifica a una versión web anterior que aún no informa el estado
    # autoritativo; en ese caso se conserva el bloqueo local por compatibilidad.
    unavailable_credential_ids: tuple[str, ...] | None = None
    operator_active: bool = True

    def __post_init__(self) -> None:
        if self.purpose not in {"enrollment", "identification"}:
            raise ValueError("propósito NFC inválido")
        if self.purpose == "enrollment" and not self.operator_id:
            raise ValueError("el enrolamiento NFC requiere un operador")
        if self.purpose == "identification" and (
            self.is_master
            or self.deactivated_credential_ids
            or self.unavailable_credential_ids
        ):
            raise ValueError("la identificación NFC no puede cambiar credenciales")


@dataclass(frozen=True, slots=True)
class NfcCredentialSnapshotEntry:
    credential_id: str
    operator_id: str | None
    credential_active: bool
    operator_active: bool
    is_master: bool


class NfcEnrollmentWebClient:
    def __init__(self, config: WebSyncConfig, sensor_key: str) -> None:
        self._base_url = config.base_url
        self._sensor_key = sensor_key
        self._timeout = config.request_timeout_seconds
        self._credential_snapshot: tuple[NfcCredentialSnapshotEntry, ...] | None = None

    def next_command(self) -> NfcEnrollmentCommand | None:
        body = self._request("/api/nfc-enrollment/commands/next", {})
        identification_command = body.get("identificationCommand")
        if "identificationCommand" not in body:
            # Compatibilidad durante un despliegue escalonado: la versión nueva
            # consolida ambos sondeos en una sola petición.
            identification_command = self._request(
                "/api/nfc-identification/commands/next", {}
            ).get("command")
        self._credential_snapshot = self._parse_credential_snapshot(
            body.get("credentials")
        )
        if identification_command is not None:
            if not isinstance(identification_command, dict):
                raise ValueError("comando de identificación NFC inválido")
            command_id = identification_command.get("id")
            if not isinstance(command_id, str) or not command_id:
                raise ValueError("id de identificación NFC inválido")
            return NfcEnrollmentCommand(command_id, None, "identification")
        command = body.get("command")
        if command is None:
            return None
        if not isinstance(command, dict):
            raise ValueError("comando de enrolamiento NFC inválido")
        command_id = command.get("id")
        operator_id = command.get("operatorId")
        is_master = command.get("isMaster", False)
        deactivated = command.get("deactivatedCredentialIds", [])
        unavailable = command.get("unavailableCredentialIds")
        operator_active = command.get("operatorActive", True)
        if not isinstance(command_id, str) or not command_id:
            raise ValueError("id de comando NFC inválido")
        if not isinstance(operator_id, str) or not operator_id:
            raise ValueError("operatorId de comando NFC inválido")
        if not isinstance(is_master, bool):
            raise ValueError("isMaster de comando NFC inválido")
        if not isinstance(operator_active, bool):
            raise ValueError("operatorActive de comando NFC inválido")
        if (
            not isinstance(deactivated, list)
            or any(
                not isinstance(credential_id, str)
                or not _ENROLLED_CREDENTIAL_ID.fullmatch(credential_id)
                for credential_id in deactivated
            )
        ):
            raise ValueError("credenciales desactivadas de comando NFC inválidas")
        if (
            unavailable is not None
            and (
                not isinstance(unavailable, list)
                or any(
                    not isinstance(credential_id, str)
                    or not _ENROLLED_CREDENTIAL_ID.fullmatch(credential_id)
                    for credential_id in unavailable
                )
            )
        ):
            raise ValueError("credenciales reservadas de comando NFC inválidas")
        return NfcEnrollmentCommand(
            command_id,
            operator_id,
            is_master=is_master,
            deactivated_credential_ids=tuple(dict.fromkeys(deactivated)),
            unavailable_credential_ids=(
                tuple(dict.fromkeys(unavailable))
                if unavailable is not None
                else None
            ),
            operator_active=operator_active,
        )

    def credential_snapshot(self) -> tuple[NfcCredentialSnapshotEntry, ...] | None:
        return self._credential_snapshot

    @staticmethod
    def _parse_credential_snapshot(value: object) -> tuple[NfcCredentialSnapshotEntry, ...] | None:
        if value is None:
            return None
        if not isinstance(value, list):
            raise ValueError("inventario RFID inválido")
        parsed: list[NfcCredentialSnapshotEntry] = []
        seen: set[str] = set()
        for row in value:
            if not isinstance(row, dict):
                raise ValueError("credencial de inventario RFID inválida")
            credential_id = row.get("credentialId")
            operator_id = row.get("operatorId")
            credential_active = row.get("credentialActive")
            operator_active = row.get("operatorActive")
            is_master = row.get("isMaster")
            if (
                not isinstance(credential_id, str)
                or not _ENROLLED_CREDENTIAL_ID.fullmatch(credential_id)
                or credential_id in seen
                or (operator_id is not None and not isinstance(operator_id, str))
                or not isinstance(credential_active, bool)
                or not isinstance(operator_active, bool)
                or not isinstance(is_master, bool)
            ):
                raise ValueError("credencial de inventario RFID inválida")
            seen.add(credential_id)
            parsed.append(
                NfcCredentialSnapshotEntry(
                    credential_id,
                    operator_id,
                    credential_active,
                    operator_active,
                    is_master,
                )
            )
        return tuple(parsed)

    def result(
        self,
        command_id: str,
        *,
        success: bool,
        credential_id: str | None = None,
        error: str | None = None,
    ) -> None:
        self._request(
            f"/api/nfc-enrollment/commands/{command_id}/result",
            {
                "success": success,
                "credentialId": credential_id,
                "error": error,
            },
        )

    def identification_result(
        self,
        command_id: str,
        *,
        success: bool,
        credential_id: str | None = None,
        error: str | None = None,
    ) -> None:
        self._request(
            f"/api/nfc-identification/commands/{command_id}/result",
            {
                "success": success,
                "credentialId": credential_id,
                "error": error,
            },
        )

    def _request(self, path: str, payload: dict[str, object]) -> dict[str, object]:
        encoded = json.dumps(payload, separators=(",", ":")).encode("utf-8")
        request = Request(
            f"{self._base_url}{path}",
            data=encoded,
            method="POST",
            headers={
                "Content-Type": "application/json",
                "X-Edge-Sensor-Key": self._sensor_key,
                "User-Agent": "fuel-edge-nfc-enrollment/0.1",
            },
        )
        with urlopen(request, timeout=self._timeout) as response:
            body = response.read(16 * 1024)
        decoded = json.loads(body) if body else {}
        if not isinstance(decoded, dict):
            raise ValueError("respuesta NFC local inválida")
        return decoded


class EnrolledCredentialStore:
    """Persistencia privada de credenciales enroladas en terreno."""

    def __init__(self, path: Path) -> None:
        self.path = path

    def load_into(self, repository: MemoryCredentialRepository) -> None:
        if not self.path.exists():
            return
        if self.path.is_symlink() or not self.path.is_file():
            raise PermissionError("el registro NFC debe ser un archivo regular")
        if stat.S_IMODE(self.path.stat().st_mode) & 0o077:
            raise PermissionError("el registro NFC debe tener permisos 0600")
        decoded = json.loads(self.path.read_text(encoding="utf-8"))
        if not isinstance(decoded, list):
            raise ValueError("registro NFC inválido")
        loaded: dict[str, RfidCredential] = {}
        for row in decoded:
            if not isinstance(row, dict):
                raise ValueError("credencial NFC inválida")
            credential = RfidCredential(
                credential_id=str(row.get("credential_id", "")),
                operator_id=str(row.get("operator_id", "")),
                secret=bytes.fromhex(str(row.get("secret_hex", ""))),
                credential_active=row.get("credential_active") is not False,
                operator_active=row.get("operator_active") is not False,
                is_master=row.get("is_master") is True,
            )
            if credential.credential_id in loaded:
                raise ValueError("el registro NFC contiene credenciales duplicadas")
            loaded[credential.credential_id] = credential
        merged = dict(repository.credentials)
        merged.update(loaded)
        self._validate_single_master(merged.values())
        repository.credentials.clear()
        repository.credentials.update(merged)

    def save(self, repository: MemoryCredentialRepository) -> None:
        self._validate_single_master(repository.credentials.values())
        self.path.parent.mkdir(parents=True, exist_ok=True)
        rows = [
            {
                "credential_id": credential.credential_id,
                "operator_id": credential.operator_id,
                "secret_hex": credential.secret.hex(),
                "credential_active": credential.credential_active,
                "operator_active": credential.operator_active,
                "is_master": credential.is_master,
            }
            for credential in repository.credentials.values()
            if (
                credential.credential_id.startswith("nfc-")
                or not credential.credential_active
            )
        ]
        temporary = self.path.with_name(f".{self.path.name}.{os.getpid()}.tmp")
        try:
            descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            with os.fdopen(descriptor, "w", encoding="utf-8") as target:
                json.dump(rows, target, separators=(",", ":"), sort_keys=True)
                target.flush()
                os.fsync(target.fileno())
            os.replace(temporary, self.path)
            os.chmod(self.path, 0o600)
        finally:
            try:
                temporary.unlink()
            except FileNotFoundError:
                pass

    @staticmethod
    def _validate_single_master(credentials) -> None:
        active_masters = sum(
            credential.is_master and credential.credential_active
            for credential in credentials
        )
        if active_masters > 1:
            raise ValueError("sólo puede existir una credencial maestra activa")


class NfcEnrollmentCoordinator:
    """Mantiene una ventana solicitada por la web y consume una tarjeta una vez."""

    def __init__(
        self,
        web: NfcEnrollmentWebClient,
        repository: MemoryCredentialRepository,
        store: EnrolledCredentialStore,
        bootstrap_secret: bytes,
        *,
        poll_seconds: float = 0.25,
        proof_attempts: int = 3,
        on_error: Callable[[BaseException], None] | None = None,
        on_window_change: Callable[[bool], None] | None = None,
    ) -> None:
        if len(bootstrap_secret) < 32:
            raise ValueError("la clave de enrolamiento NFC es demasiado corta")
        if poll_seconds <= 0:
            raise ValueError("poll_seconds debe ser positivo")
        if proof_attempts <= 0:
            raise ValueError("proof_attempts debe ser positivo")
        self.web = web
        self.repository = repository
        self.store = store
        self.bootstrap_secret = bootstrap_secret
        self.poll_seconds = poll_seconds
        self.proof_attempts = proof_attempts
        self._on_error = on_error
        self._on_window_change = on_window_change
        self._lock = Lock()
        self._result_lock = Lock()
        self._active: NfcEnrollmentCommand | None = None
        self._pending_completion: tuple[NfcEnrollmentCommand, str] | None = None
        self._announced_window: bool | None = None
        self._announced_at = 0.0
        self._last_snapshot: tuple[NfcCredentialSnapshotEntry, ...] | None = None
        self._stop = Event()
        self._thread: Thread | None = None

    def start(self) -> None:
        if self._thread is not None:
            raise RuntimeError("el enrolamiento NFC ya está iniciado")
        # Limpia una ventana MQTT retenida si el proceso anterior terminó de
        # forma abrupta. El primer refresh volverá a activarla si aún corresponde.
        try:
            self._announce_window(False)
        except _EXPECTED_OPERATION_ERRORS as error:
            self._report_error(error)
        self._thread = Thread(target=self._run, name="fuel-edge-nfc-enrollment", daemon=True)
        self._thread.start()

    def close(self, timeout: float = 5.0) -> None:
        self._stop.set()
        if self._thread is not None:
            self._thread.join(timeout)
            if self._thread.is_alive():
                raise RuntimeError("el enrolamiento NFC no se detuvo a tiempo")
            self._thread = None
        try:
            self._flush_pending_completion()
        except _EXPECTED_OPERATION_ERRORS as error:
            self._report_error(error)
        with self._lock:
            self._active = None
        try:
            self._announce_window(False)
        except _EXPECTED_OPERATION_ERRORS as error:
            self._report_error(error)

    def refresh(self) -> NfcEnrollmentCommand | None:
        self._flush_pending_completion()
        command = self.web.next_command()
        snapshot_reader = getattr(self.web, "credential_snapshot", None)
        if callable(snapshot_reader):
            snapshot = snapshot_reader()
            if snapshot is not None:
                self._apply_credential_snapshot(snapshot)
        with self._lock:
            self._active = command
        self._announce_window(command is not None)
        return command

    def process_presentation(
        self,
        presentation: ValidatorPresentation,
        transport: ValidatorTransport,
        timeout_seconds: float,
    ) -> ValidatorDecision | None:
        with self._lock:
            command = self._active
        if command is None:
            return None

        proof = None
        identifying = command.purpose == "identification"
        failure_reason = (
            "identification_card_unreadable"
            if identifying
            else "enrollment_card_unreadable"
        )
        for _attempt in range(self.proof_attempts):
            challenge = secrets.token_bytes(32)
            candidate = transport.exchange_proof(
                presentation.validator_id,
                presentation.session_id,
                challenge,
                timeout_seconds,
                purpose="identification" if identifying else "enrollment",
            )
            if candidate is None:
                continue
            if not _ENROLLED_CREDENTIAL_ID.fullmatch(candidate.credential_id):
                failure_reason = (
                    "identification_unsupported_card"
                    if identifying
                    else "enrollment_unsupported_card"
                )
                continue
            expected = build_rfid_response(
                self.bootstrap_secret, candidate.credential_id, challenge
            )
            if candidate.challenge != challenge or not hmac.compare_digest(
                candidate.response, expected
            ):
                failure_reason = (
                    "identification_authentication_failed"
                    if identifying
                    else "enrollment_authentication_failed"
                )
                continue
            proof = candidate
            break

        if proof is None:
            return ValidatorDecision(
                validator_id=presentation.validator_id,
                session_id=presentation.session_id,
                allowed=False,
                state="locked",
                reason=failure_reason,
            )

        with self._lock:
            if self._active != command:
                return ValidatorDecision(
                    validator_id=presentation.validator_id,
                    session_id=presentation.session_id,
                    allowed=False,
                    state="locked",
                    reason="enrollment_window_changed",
                )
            existing = self.repository.get(proof.credential_id)
        if identifying:
            with self._lock:
                if self._active != command:
                    return ValidatorDecision(
                        validator_id=presentation.validator_id,
                        session_id=presentation.session_id,
                        allowed=False,
                        state="locked",
                        reason="identification_window_changed",
                    )
                self._pending_completion = (command, proof.credential_id)
            try:
                self._flush_pending_completion()
                reason = "identification_completed"
            except _EXPECTED_OPERATION_ERRORS as error:
                self._report_error(error)
                reason = "identification_pending_sync"
            return ValidatorDecision(
                validator_id=presentation.validator_id,
                session_id=presentation.session_id,
                allowed=False,
                state="locked",
                reason=reason,
            )
        if command.operator_id is None:
            raise ValueError("comando de enrolamiento sin operador")
        # La web es la autoridad sobre qué credenciales siguen vinculadas a
        # operadores vigentes. El registro privado de la Raspberry puede conservar
        # una credencial cuyo operador fue archivado o eliminado; en ese caso debe
        # poder reasignarse y sobrescribir esa copia local obsoleta.
        credential_is_unavailable = (
            proof.credential_id in command.unavailable_credential_ids
            if command.unavailable_credential_ids is not None
            else existing is not None and existing.operator_id != command.operator_id
        )
        if credential_is_unavailable:
            self.web.result(
                command.command_id,
                success=False,
                error="La credencial ya pertenece a otro operador.",
            )
            with self._lock:
                if self._active == command:
                    self._active = None
            self._announce_window(False)
            reason = "credential_already_assigned"
        else:
            with self._lock:
                if self._active != command:
                    return ValidatorDecision(
                        validator_id=presentation.validator_id,
                        session_id=presentation.session_id,
                        allowed=False,
                        state="locked",
                        reason="enrollment_window_changed",
                    )
                previous_credentials = dict(self.repository.credentials)
                credential_ids_to_deactivate = set(command.deactivated_credential_ids)
                if command.is_master:
                    credential_ids_to_deactivate.update(
                        credential.credential_id
                        for credential in self.repository.credentials.values()
                        if credential.is_master and credential.credential_active
                    )
                for credential_id in credential_ids_to_deactivate:
                    credential = self.repository.get(credential_id)
                    if credential is None:
                        continue
                    self.repository.add(
                        RfidCredential(
                            credential_id=credential.credential_id,
                            operator_id=credential.operator_id,
                            secret=credential.secret,
                            credential_active=False,
                            operator_active=credential.operator_active,
                            is_master=credential.is_master,
                        )
                    )
                self.repository.add(
                    RfidCredential(
                        credential_id=proof.credential_id,
                        operator_id=command.operator_id,
                        secret=self.bootstrap_secret,
                        operator_active=command.operator_active,
                        is_master=command.is_master,
                    )
                )
                try:
                    self.store.save(self.repository)
                except Exception:
                    self.repository.credentials.clear()
                    self.repository.credentials.update(previous_credentials)
                    raise
                self._pending_completion = (command, proof.credential_id)
            try:
                self._flush_pending_completion()
                reason = "enrollment_completed"
            except _EXPECTED_OPERATION_ERRORS as error:
                # La credencial ya quedó personalizada y persistida localmente.
                # Se conserva el resultado para reintentar de forma idempotente
                # desde el hilo de sondeo, sin exigir otra lectura física.
                self._report_error(error)
                reason = "enrollment_pending_sync"
        return ValidatorDecision(
            validator_id=presentation.validator_id,
            session_id=presentation.session_id,
            allowed=False,
            state="locked",
            reason=reason,
        )

    def _apply_credential_snapshot(
        self, snapshot: tuple[NfcCredentialSnapshotEntry, ...]
    ) -> None:
        if snapshot == self._last_snapshot:
            return
        with self._lock:
            previous_credentials = dict(self.repository.credentials)
            synchronized = {
                credential_id: credential
                for credential_id, credential in previous_credentials.items()
                if not credential_id.startswith("nfc-")
            }
            for entry in snapshot:
                synchronized[entry.credential_id] = RfidCredential(
                    credential_id=entry.credential_id,
                    operator_id=(
                        entry.operator_id
                        or f"rfid-unassigned:{entry.credential_id}"
                    ),
                    secret=self.bootstrap_secret,
                    credential_active=entry.credential_active,
                    operator_active=(
                        entry.operator_active and entry.operator_id is not None
                    ),
                    is_master=entry.is_master,
                )
            self.repository.credentials.clear()
            self.repository.credentials.update(synchronized)
            try:
                self.store.save(self.repository)
            except Exception:
                self.repository.credentials.clear()
                self.repository.credentials.update(previous_credentials)
                raise
            self._last_snapshot = snapshot

    def _run(self) -> None:
        while not self._stop.is_set():
            try:
                self.refresh()
            except _EXPECTED_OPERATION_ERRORS as error:
                self._report_error(error)
            if self._stop.wait(self.poll_seconds):
                break

    def _flush_pending_completion(self) -> bool:
        """Entrega el resultado a la web; puede repetirse si se perdió la respuesta."""

        with self._result_lock:
            with self._lock:
                pending = self._pending_completion
            if pending is None:
                return False
            command, credential_id = pending
            if command.purpose == "identification":
                self.web.identification_result(
                    command.command_id,
                    success=True,
                    credential_id=credential_id,
                )
            else:
                self.web.result(
                    command.command_id,
                    success=True,
                    credential_id=credential_id,
                )
            with self._lock:
                if self._pending_completion == pending:
                    self._pending_completion = None
                if self._active == command:
                    self._active = None
            try:
                self._announce_window(False)
            except _EXPECTED_OPERATION_ERRORS as error:
                # El resultado durable ya fue confirmado. El siguiente refresh
                # vuelve a limpiar el tópico retenido si MQTT estaba transitorio.
                self._report_error(error)
            return True

    def _report_error(self, error: BaseException) -> None:
        if self._on_error is not None:
            self._on_error(error)

    def _announce_window(self, active: bool) -> None:
        now = monotonic()
        if self._announced_window is active:
            # El estado cerrado es el valor seguro por defecto y su transporte
            # ya borra el retained. Repetirlo periódicamente sólo agrega una
            # ráfaga innecesaria a validadores antiguos con inbox pequeño. Una
            # ventana abierta sí se renueva mientras siga vigente.
            if not active or now - self._announced_at < 10.0:
                return
        if self._on_window_change is not None:
            self._on_window_change(active)
        self._announced_window = active
        self._announced_at = now
