"""Autenticación RFID/NFC y enlace seguro con el control de abastecimiento.

El UID de una tarjeta no se considera una credencial. El lector debe ejecutar un
desafío-respuesta con la tarjeta y devolver la prueba al agente edge. La
implementación concreta del lector queda detrás de :class:`RfidReader`, porque
el modelo de tarjeta y el lector físico aún deben seleccionarse en terreno.
"""

from __future__ import annotations

import hashlib
import hmac
import secrets
from collections import deque
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from enum import StrEnum
from typing import Callable, Protocol

from .access import AccessContext
from .domain import AuditRecord, EdgeEvent


_PROTOCOL_DOMAIN = b"fuel-edge/rfid/v1\x00"
_CHALLENGE_BYTES = 32
_PROOF_BYTES = hashlib.sha256().digest_size
_MAX_CREDENTIAL_ID_BYTES = 128


class RfidAuthenticationReason(StrEnum):
    NO_CREDENTIAL = "no_credential"
    MALFORMED_PRESENTATION = "malformed_presentation"
    UNKNOWN_CREDENTIAL = "unknown_credential"
    AUTHENTICATION_FAILED = "authentication_failed"


class RfidReaderError(RuntimeError):
    """El lector no pudo completar una operación de autenticación."""


@dataclass(frozen=True, slots=True)
class RfidCredential:
    """Registro local de una credencial y su vínculo con un operador.

    ``secret`` representa la clave única de la credencial. En producción debe
    obtenerse desde almacenamiento protegido y nunca registrarse en logs.
    """

    credential_id: str
    operator_id: str
    secret: bytes
    credential_active: bool = True
    operator_active: bool = True
    is_master: bool = False

    def __post_init__(self) -> None:
        if not isinstance(self.secret, bytes):
            raise TypeError("secret debe ser bytes")
        if not self.credential_id.strip():
            raise ValueError("credential_id no puede estar vacío")
        if not self.operator_id.strip():
            raise ValueError("operator_id no puede estar vacío")
        if len(self.credential_id.encode("utf-8")) > _MAX_CREDENTIAL_ID_BYTES:
            raise ValueError("credential_id excede el largo máximo")
        if len(self.secret) < 32:
            raise ValueError("secret debe contener al menos 32 bytes")


@dataclass(frozen=True, slots=True)
class RfidProof:
    """Prueba generada por una credencial para un desafío fresco."""

    credential_id: str
    challenge: bytes
    response: bytes


class RfidReader(Protocol):
    """Puerto para un lector capaz de autenticar una tarjeta criptográfica."""

    def authenticate(self, challenge: bytes) -> RfidProof | None:
        """Retorna ``None`` cuando no hay una credencial estable en el lector."""

        ...


class CredentialRepository(Protocol):
    def get(self, credential_id: str) -> RfidCredential | None: ...


class EdgeControlPort(Protocol):
    """Operaciones del núcleo usadas por RFID, con o sin persistencia detrás."""

    def present_credential(self, credential_id: str) -> AuditRecord: ...

    def authorize(self, context: AccessContext) -> AuditRecord: ...

    def apply(self, event: EdgeEvent, **metadata: object) -> AuditRecord: ...


@dataclass(slots=True)
class MemoryCredentialRepository:
    """Repositorio explícito para simulación y pruebas; no cifra secretos."""

    credentials: dict[str, RfidCredential] = field(default_factory=dict)

    def add(self, credential: RfidCredential) -> None:
        self.credentials[credential.credential_id] = credential

    def get(self, credential_id: str) -> RfidCredential | None:
        return self.credentials.get(credential_id)


@dataclass(frozen=True, slots=True)
class RfidAuthentication:
    authenticated: bool
    credential_id: str | None = None
    credential: RfidCredential | None = None
    reason: RfidAuthenticationReason | None = None


@dataclass(frozen=True, slots=True)
class EquipmentEvidence:
    """Evidencia BLE ya seleccionada y autenticada por el validador."""

    equipment_id: str
    active: bool
    present: bool
    authenticated: bool
    association_active: bool
    assignment_valid_until: datetime | None = None

    def __post_init__(self) -> None:
        if not self.equipment_id.strip():
            raise ValueError("equipment_id no puede estar vacío")
        if (
            self.assignment_valid_until is not None
            and (
                self.assignment_valid_until.tzinfo is None
                or self.assignment_valid_until.utcoffset() is None
            )
        ):
            raise ValueError("assignment_valid_until debe incluir zona horaria")


@dataclass(frozen=True, slots=True)
class RfidAuthorizationOutcome:
    authentication: RfidAuthentication
    audit_record: AuditRecord | None

    @property
    def authorized(self) -> bool:
        return (
            self.audit_record is not None
            and self.audit_record.event is EdgeEvent.AUTHORIZATION_GRANTED
        )


def build_rfid_response(secret: bytes, credential_id: str, challenge: bytes) -> bytes:
    """Construye la respuesta canónica que debe producir la tarjeta segura.

    Se expone para adaptadores de hardware y bancos de prueba. No debe usarse
    para tarjetas que sólo entregan UID: esas tarjetas no cumplen el contrato.
    """

    encoded_id = credential_id.encode("utf-8")
    if not credential_id.strip() or len(encoded_id) > _MAX_CREDENTIAL_ID_BYTES:
        raise ValueError("credential_id inválido")
    if len(challenge) != _CHALLENGE_BYTES:
        raise ValueError(f"challenge debe contener {_CHALLENGE_BYTES} bytes")
    return hmac.digest(secret, _PROTOCOL_DOMAIN + encoded_id + b"\x00" + challenge, "sha256")


@dataclass(slots=True)
class RfidValidator:
    """Verifica pruebas RFID/NFC frescas sin confiar en el UID de la tarjeta."""

    credentials: CredentialRepository
    challenge_source: Callable[[int], bytes] = secrets.token_bytes

    def authenticate(self, reader: RfidReader) -> RfidAuthentication:
        challenge = self.challenge_source(_CHALLENGE_BYTES)
        if not isinstance(challenge, bytes) or len(challenge) != _CHALLENGE_BYTES:
            raise RuntimeError("challenge_source retornó un desafío inválido")

        try:
            proof = reader.authenticate(challenge)
        except RfidReaderError:
            raise
        except Exception as exc:
            raise RfidReaderError("falló la comunicación con el lector RFID") from exc

        if proof is None:
            return RfidAuthentication(False, reason=RfidAuthenticationReason.NO_CREDENTIAL)
        if not self._well_formed(proof) or not hmac.compare_digest(proof.challenge, challenge):
            return RfidAuthentication(
                False,
                credential_id=self._safe_id(proof.credential_id),
                reason=RfidAuthenticationReason.MALFORMED_PRESENTATION,
            )

        credential = self.credentials.get(proof.credential_id)
        if credential is None:
            return RfidAuthentication(
                False,
                credential_id=proof.credential_id,
                reason=RfidAuthenticationReason.UNKNOWN_CREDENTIAL,
            )

        expected = build_rfid_response(credential.secret, credential.credential_id, challenge)
        if not hmac.compare_digest(proof.response, expected):
            return RfidAuthentication(
                False,
                credential_id=proof.credential_id,
                reason=RfidAuthenticationReason.AUTHENTICATION_FAILED,
            )
        return RfidAuthentication(
            True,
            credential_id=credential.credential_id,
            credential=credential,
        )

    @staticmethod
    def _well_formed(proof: RfidProof) -> bool:
        try:
            encoded_id = proof.credential_id.encode("utf-8")
        except (AttributeError, UnicodeError):
            return False
        return (
            bool(proof.credential_id.strip())
            and len(encoded_id) <= _MAX_CREDENTIAL_ID_BYTES
            and isinstance(proof.challenge, bytes)
            and len(proof.challenge) == _CHALLENGE_BYTES
            and isinstance(proof.response, bytes)
            and len(proof.response) == _PROOF_BYTES
        )

    @staticmethod
    def _safe_id(credential_id: object) -> str | None:
        if not isinstance(credential_id, str):
            return None
        try:
            encoded = credential_id.encode("utf-8")
        except UnicodeError:
            return None
        if not credential_id.strip() or len(encoded) > _MAX_CREDENTIAL_ID_BYTES:
            return None
        return credential_id


@dataclass(slots=True)
class RfidAuthorizationService:
    """Orquesta RFID y entrega al controlador edge la decisión final.

    Los rechazos criptográficos se registran como ``NFC_REJECTED``. Una prueba
    válida todavía debe superar las reglas de operador, equipo, asociación,
    punto y cadena de control antes de energizar el relé.
    """

    validator: RfidValidator
    failed_attempt_window: timedelta = timedelta(minutes=5)
    failed_attempt_threshold: int = 2
    _failed_attempts: deque[datetime] = field(default_factory=deque, init=False)

    def __post_init__(self) -> None:
        if self.failed_attempt_window <= timedelta(0):
            raise ValueError("failed_attempt_window debe ser positivo")
        if self.failed_attempt_threshold <= 0:
            raise ValueError("failed_attempt_threshold debe ser positivo")

    def handle_presentation(
        self,
        controller: EdgeControlPort,
        reader: RfidReader,
        *,
        equipment: EquipmentEvidence | None = None,
        equipment_resolver: Callable[[RfidCredential], EquipmentEvidence | None]
        | None = None,
        point_available: bool = True,
        control_chain_healthy: bool = True,
        now: datetime | None = None,
    ) -> RfidAuthorizationOutcome:
        if equipment is not None and equipment_resolver is not None:
            raise ValueError("use equipment o equipment_resolver, no ambos")
        now = self._utc(now)
        authentication = self.validator.authenticate(reader)
        if authentication.reason is RfidAuthenticationReason.NO_CREDENTIAL:
            return RfidAuthorizationOutcome(authentication, None)

        presented_id = authentication.credential_id or "unidentified-credential"
        controller.present_credential(presented_id)
        if not authentication.authenticated:
            failed_attempts = self._register_failed_attempt(now)
            record = controller.apply(
                EdgeEvent.NFC_REJECTED,
                credential_id=authentication.credential_id,
                reason=str(authentication.reason),
                failed_attempts_in_window=failed_attempts,
                alert_required=failed_attempts >= self.failed_attempt_threshold,
            )
            return RfidAuthorizationOutcome(authentication, record)

        credential = authentication.credential
        if credential is None:  # Invariante defensiva: nunca autorizar sin registro.
            raise RuntimeError("autenticación válida sin credencial")
        if equipment_resolver is not None:
            equipment = equipment_resolver(credential)

        context = AccessContext(
            credential_id=credential.credential_id,
            operator_id=credential.operator_id,
            credential_active=credential.credential_active,
            operator_active=credential.operator_active,
            is_master=credential.is_master,
            equipment_id=equipment.equipment_id if equipment else None,
            equipment_active=equipment.active if equipment else False,
            equipment_present=equipment.present if equipment else False,
            equipment_authenticated=equipment.authenticated if equipment else False,
            association_active=equipment.association_active if equipment else False,
            assignment_valid_until=equipment.assignment_valid_until if equipment else None,
            point_available=point_available,
            control_chain_healthy=control_chain_healthy,
        )
        record = controller.authorize(context)
        return RfidAuthorizationOutcome(authentication, record)

    def _register_failed_attempt(self, now: datetime) -> int:
        cutoff = now - self.failed_attempt_window
        while self._failed_attempts and self._failed_attempts[0] <= cutoff:
            self._failed_attempts.popleft()
        self._failed_attempts.append(now)
        return len(self._failed_attempts)

    @staticmethod
    def _utc(value: datetime | None) -> datetime:
        value = value or datetime.now(timezone.utc)
        if value.tzinfo is None or value.utcoffset() is None:
            raise ValueError("now debe incluir zona horaria")
        return value.astimezone(timezone.utc)
