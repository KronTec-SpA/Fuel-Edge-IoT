"""Contrato versionado entre el validador de terreno y la aplicación del RPi."""

from __future__ import annotations

import base64
import json
import re
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Callable, Protocol

from .rfid import RfidProof, RfidReader, RfidReaderError, build_rfid_response


PROTOCOL_VERSION = 1
MAX_MESSAGE_BYTES = 4096
_IDENTIFIER = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$")


class ValidatorProtocolError(ValueError):
    """El mensaje remoto no cumple el contrato o excede sus límites."""


class ValidatorTransportError(RfidReaderError):
    """No fue posible completar el intercambio con el validador."""


@dataclass(frozen=True, slots=True)
class RemoteEquipmentObservation:
    """Señales BLE observadas por el validador; aún no son autorización."""

    equipment_id: str
    present: bool
    authenticated: bool
    rssi: int | None = None
    module_id: str | None = None

    def __post_init__(self) -> None:
        _validate_identifier(self.equipment_id, "equipment_id")
        if self.module_id is not None:
            _validate_identifier(self.module_id, "module_id")
        if self.rssi is not None and not -127 <= self.rssi <= 20:
            raise ValueError("rssi fuera de rango")


@dataclass(frozen=True, slots=True)
class EquipmentPresenceUpdate:
    """Cambio de presencia BLE confirmado por el validador durante una carga."""

    validator_id: str
    session_id: str
    equipment_id: str
    present: bool
    authenticated: bool
    lost_for_seconds: int = 0
    module_id: str | None = None
    rssi: int | None = None
    occurred_at: datetime = field(default_factory=lambda: datetime.now(timezone.utc))

    def __post_init__(self) -> None:
        _validate_identifier(self.validator_id, "validator_id")
        _validate_identifier(self.session_id, "session_id")
        _validate_identifier(self.equipment_id, "equipment_id")
        if self.module_id is not None:
            _validate_identifier(self.module_id, "module_id")
        if self.lost_for_seconds < 0:
            raise ValueError("lost_for_seconds no puede ser negativo")
        if self.rssi is not None and not -127 <= self.rssi <= 20:
            raise ValueError("rssi fuera de rango")
        _require_aware(self.occurred_at, "occurred_at")


@dataclass(frozen=True, slots=True)
class CredentialPresenceUpdate:
    """Presencia mantenida de la credencial durante una carga autorizada."""

    validator_id: str
    session_id: str
    credential_id: str
    present: bool
    authenticated: bool
    absent_for_milliseconds: int = 0
    occurred_at: datetime = field(default_factory=lambda: datetime.now(timezone.utc))

    def __post_init__(self) -> None:
        _validate_identifier(self.validator_id, "validator_id")
        _validate_identifier(self.session_id, "session_id")
        _validate_identifier(self.credential_id, "credential_id")
        if self.absent_for_milliseconds < 0:
            raise ValueError("absent_for_milliseconds no puede ser negativo")
        if self.present and not self.authenticated:
            raise ValueError("una credencial presente debe estar autenticada")
        _require_aware(self.occurred_at, "occurred_at")


@dataclass(frozen=True, slots=True)
class ValidatorPresentation:
    validator_id: str
    session_id: str
    equipment: RemoteEquipmentObservation | None = None
    occurred_at: datetime = field(default_factory=lambda: datetime.now(timezone.utc))

    def __post_init__(self) -> None:
        _validate_identifier(self.validator_id, "validator_id")
        _validate_identifier(self.session_id, "session_id")
        _require_aware(self.occurred_at, "occurred_at")


@dataclass(frozen=True, slots=True)
class ValidatorDecision:
    validator_id: str
    session_id: str
    allowed: bool
    state: str
    reason: str | None = None
    transaction_id: str | None = None

    def __post_init__(self) -> None:
        _validate_identifier(self.validator_id, "validator_id")
        _validate_identifier(self.session_id, "session_id")
        if not self.state:
            raise ValueError("state no puede estar vacío")
        if self.allowed and not self.transaction_id:
            raise ValueError("una autorización requiere transaction_id")
        if not self.allowed and not self.reason:
            raise ValueError("un rechazo requiere reason")


class ValidatorTransport(Protocol):
    """RPC sobre el enlace Wi-Fi/MQTT del validador."""

    def exchange_proof(
        self,
        validator_id: str,
        session_id: str,
        challenge: bytes,
        timeout_seconds: float,
        *,
        purpose: str = "authorization",
    ) -> RfidProof | None: ...

    def publish_decision(self, decision: ValidatorDecision) -> None: ...


@dataclass(slots=True)
class RemoteRfidReader(RfidReader):
    """Presenta el validador MQTT como un lector para el núcleo RFID."""

    transport: ValidatorTransport
    validator_id: str
    session_id: str
    timeout_seconds: float = 5.0

    def __post_init__(self) -> None:
        _validate_identifier(self.validator_id, "validator_id")
        _validate_identifier(self.session_id, "session_id")
        if self.timeout_seconds <= 0:
            raise ValueError("timeout_seconds debe ser positivo")

    def authenticate(self, challenge: bytes) -> RfidProof | None:
        try:
            return self.transport.exchange_proof(
                self.validator_id,
                self.session_id,
                challenge,
                self.timeout_seconds,
            )
        except RfidReaderError:
            raise
        except Exception as exc:
            raise ValidatorTransportError("falló el enlace con el validador") from exc


class ValidatorMessageCodec:
    """Serializa JSON compacto y valida todo dato recibido antes de usarlo."""

    @staticmethod
    def encode_presentation(message: ValidatorPresentation) -> bytes:
        equipment = None
        if message.equipment is not None:
            equipment = {
                "equipment_id": message.equipment.equipment_id,
                "present": message.equipment.present,
                "authenticated": message.equipment.authenticated,
                "rssi": message.equipment.rssi,
                "module_id": message.equipment.module_id,
            }
        return _encode(
            {
                "version": PROTOCOL_VERSION,
                "type": "rfid.presentation",
                "validator_id": message.validator_id,
                "session_id": message.session_id,
                "occurred_at": message.occurred_at.astimezone(timezone.utc).isoformat(),
                "equipment": equipment,
            }
        )

    @staticmethod
    def decode_presentation(payload: bytes) -> ValidatorPresentation:
        data = _decode(payload, "rfid.presentation")
        equipment_data = data.get("equipment")
        equipment = None
        if equipment_data is not None:
            if not isinstance(equipment_data, dict):
                raise ValidatorProtocolError("equipment debe ser un objeto o null")
            equipment = RemoteEquipmentObservation(
                equipment_id=_string(equipment_data, "equipment_id"),
                present=_boolean(equipment_data, "present"),
                authenticated=_boolean(equipment_data, "authenticated"),
                rssi=_optional_integer(equipment_data, "rssi"),
                module_id=_optional_string(equipment_data, "module_id"),
            )
        return ValidatorPresentation(
            validator_id=_string(data, "validator_id"),
            session_id=_string(data, "session_id"),
            occurred_at=_datetime(data, "occurred_at"),
            equipment=equipment,
        )

    @staticmethod
    def encode_challenge(
        validator_id: str,
        session_id: str,
        challenge: bytes,
        *,
        purpose: str = "authorization",
    ) -> bytes:
        _validate_identifier(validator_id, "validator_id")
        _validate_identifier(session_id, "session_id")
        if not isinstance(challenge, bytes) or len(challenge) != 32:
            raise ValueError("challenge debe contener 32 bytes")
        if purpose not in {"authorization", "enrollment", "identification"}:
            raise ValueError("purpose RFID inválido")
        return _encode(
            {
                "version": PROTOCOL_VERSION,
                "type": "rfid.challenge",
                "validator_id": validator_id,
                "session_id": session_id,
                "challenge": _b64encode(challenge),
                "purpose": purpose,
            }
        )

    @staticmethod
    def decode_challenge(payload: bytes) -> tuple[str, str, bytes]:
        data = _decode(payload, "rfid.challenge")
        validator_id = _string(data, "validator_id")
        session_id = _string(data, "session_id")
        _validate_identifier(validator_id, "validator_id")
        _validate_identifier(session_id, "session_id")
        challenge = _b64decode(_string(data, "challenge"), "challenge", 32)
        return validator_id, session_id, challenge

    @staticmethod
    def encode_proof(
        validator_id: str,
        session_id: str,
        proof: RfidProof | None,
    ) -> bytes:
        _validate_identifier(validator_id, "validator_id")
        _validate_identifier(session_id, "session_id")
        data: dict[str, object] = {
            "version": PROTOCOL_VERSION,
            "type": "rfid.proof",
            "validator_id": validator_id,
            "session_id": session_id,
            "credential_present": proof is not None,
        }
        if proof is not None:
            data.update(
                {
                    "credential_id": proof.credential_id,
                    "challenge": _b64encode(proof.challenge),
                    "response": _b64encode(proof.response),
                }
            )
        return _encode(data)

    @staticmethod
    def decode_proof(payload: bytes) -> tuple[str, str, RfidProof | None]:
        data = _decode(payload, "rfid.proof")
        validator_id = _string(data, "validator_id")
        session_id = _string(data, "session_id")
        _validate_identifier(validator_id, "validator_id")
        _validate_identifier(session_id, "session_id")
        if not _boolean(data, "credential_present"):
            return validator_id, session_id, None
        proof = RfidProof(
            credential_id=_string(data, "credential_id"),
            challenge=_b64decode(_string(data, "challenge"), "challenge", 32),
            response=_b64decode(_string(data, "response"), "response", 32),
        )
        return validator_id, session_id, proof

    @staticmethod
    def encode_decision(message: ValidatorDecision) -> bytes:
        return _encode(
            {
                "version": PROTOCOL_VERSION,
                "type": "rfid.decision",
                "validator_id": message.validator_id,
                "session_id": message.session_id,
                "allowed": message.allowed,
                "state": message.state,
                "reason": message.reason,
                "transaction_id": message.transaction_id,
            }
        )

    @staticmethod
    def decode_decision(payload: bytes) -> ValidatorDecision:
        data = _decode(payload, "rfid.decision")
        return ValidatorDecision(
            validator_id=_string(data, "validator_id"),
            session_id=_string(data, "session_id"),
            allowed=_boolean(data, "allowed"),
            state=_string(data, "state"),
            reason=_optional_string(data, "reason"),
            transaction_id=_optional_string(data, "transaction_id"),
        )

    @staticmethod
    def encode_equipment_presence(message: EquipmentPresenceUpdate) -> bytes:
        return _encode(
            {
                "version": PROTOCOL_VERSION,
                "type": "equipment.presence",
                "validator_id": message.validator_id,
                "session_id": message.session_id,
                "module_id": message.module_id,
                "equipment_id": message.equipment_id,
                "present": message.present,
                "authenticated": message.authenticated,
                "lost_for_seconds": message.lost_for_seconds,
                "rssi": message.rssi,
                "occurred_at": message.occurred_at.astimezone(timezone.utc).isoformat(),
            }
        )

    @staticmethod
    def decode_equipment_presence(payload: bytes) -> EquipmentPresenceUpdate:
        data = _decode(payload, "equipment.presence")
        return EquipmentPresenceUpdate(
            validator_id=_string(data, "validator_id"),
            session_id=_string(data, "session_id"),
            module_id=_optional_string(data, "module_id"),
            equipment_id=_string(data, "equipment_id"),
            present=_boolean(data, "present"),
            authenticated=_boolean(data, "authenticated"),
            lost_for_seconds=_integer(data, "lost_for_seconds"),
            rssi=_optional_integer(data, "rssi"),
            occurred_at=_datetime(data, "occurred_at"),
        )

    @staticmethod
    def encode_credential_presence(message: CredentialPresenceUpdate) -> bytes:
        return _encode(
            {
                "version": PROTOCOL_VERSION,
                "type": "credential.presence",
                "validator_id": message.validator_id,
                "session_id": message.session_id,
                "credential_id": message.credential_id,
                "present": message.present,
                "authenticated": message.authenticated,
                "absent_for_milliseconds": message.absent_for_milliseconds,
                "occurred_at": message.occurred_at.astimezone(timezone.utc).isoformat(),
            }
        )

    @staticmethod
    def decode_credential_presence(payload: bytes) -> CredentialPresenceUpdate:
        data = _decode(payload, "credential.presence")
        return CredentialPresenceUpdate(
            validator_id=_string(data, "validator_id"),
            session_id=_string(data, "session_id"),
            credential_id=_string(data, "credential_id"),
            present=_boolean(data, "present"),
            authenticated=_boolean(data, "authenticated"),
            absent_for_milliseconds=_integer(data, "absent_for_milliseconds"),
            occurred_at=_datetime(data, "occurred_at"),
        )


@dataclass(frozen=True, slots=True)
class SimulatedCard:
    credential_id: str
    secret: bytes


@dataclass(slots=True)
class InMemoryValidatorTransport:
    """Validador completo de banco que usa exactamente el contrato JSON."""

    cards: dict[str, SimulatedCard | None] = field(default_factory=dict)
    decisions: list[ValidatorDecision] = field(default_factory=list)
    wire_messages: list[bytes] = field(default_factory=list)
    proof_mutator: Callable[[RfidProof], RfidProof] | None = None

    def exchange_proof(
        self,
        validator_id: str,
        session_id: str,
        challenge: bytes,
        timeout_seconds: float,
        *,
        purpose: str = "authorization",
    ) -> RfidProof | None:
        if timeout_seconds <= 0:
            raise ValidatorTransportError("timeout inválido")
        request = ValidatorMessageCodec.encode_challenge(
            validator_id, session_id, challenge, purpose=purpose
        )
        self.wire_messages.append(request)
        decoded_validator, decoded_session, decoded_challenge = (
            ValidatorMessageCodec.decode_challenge(request)
        )
        card = self.cards.get(decoded_validator)
        proof = None
        if card is not None:
            proof = RfidProof(
                credential_id=card.credential_id,
                challenge=decoded_challenge,
                response=build_rfid_response(
                    card.secret, card.credential_id, decoded_challenge
                ),
            )
            if self.proof_mutator is not None:
                proof = self.proof_mutator(proof)
        response = ValidatorMessageCodec.encode_proof(
            decoded_validator, decoded_session, proof
        )
        self.wire_messages.append(response)
        response_validator, response_session, decoded_proof = (
            ValidatorMessageCodec.decode_proof(response)
        )
        if response_validator != validator_id or response_session != session_id:
            raise ValidatorTransportError("respuesta RFID sin correlación")
        return decoded_proof

    def publish_decision(self, decision: ValidatorDecision) -> None:
        payload = ValidatorMessageCodec.encode_decision(decision)
        self.wire_messages.append(payload)
        self.decisions.append(ValidatorMessageCodec.decode_decision(payload))


def _encode(data: dict[str, object]) -> bytes:
    payload = json.dumps(
        data, ensure_ascii=True, separators=(",", ":"), sort_keys=True
    ).encode("utf-8")
    if len(payload) > MAX_MESSAGE_BYTES:
        raise ValidatorProtocolError("mensaje excede el tamaño máximo")
    return payload


def _decode(payload: bytes, expected_type: str) -> dict[str, object]:
    if not isinstance(payload, bytes):
        raise ValidatorProtocolError("payload debe ser bytes")
    if not payload or len(payload) > MAX_MESSAGE_BYTES:
        raise ValidatorProtocolError("tamaño de payload inválido")
    try:
        data = json.loads(payload.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError, RecursionError) as exc:
        raise ValidatorProtocolError("JSON inválido") from exc
    if not isinstance(data, dict):
        raise ValidatorProtocolError("el mensaje debe ser un objeto")
    if data.get("version") != PROTOCOL_VERSION:
        raise ValidatorProtocolError("versión de protocolo no soportada")
    if data.get("type") != expected_type:
        raise ValidatorProtocolError("tipo de mensaje inesperado")
    return data


def _validate_identifier(value: str, name: str) -> None:
    if not isinstance(value, str) or not _IDENTIFIER.fullmatch(value):
        raise ValueError(f"{name} inválido")


def _string(data: dict[str, object], key: str) -> str:
    value = data.get(key)
    if not isinstance(value, str) or not value:
        raise ValidatorProtocolError(f"{key} debe ser string no vacío")
    return value


def _optional_string(data: dict[str, object], key: str) -> str | None:
    value = data.get(key)
    if value is None:
        return None
    if not isinstance(value, str) or not value:
        raise ValidatorProtocolError(f"{key} debe ser string o null")
    return value


def _boolean(data: dict[str, object], key: str) -> bool:
    value = data.get(key)
    if not isinstance(value, bool):
        raise ValidatorProtocolError(f"{key} debe ser boolean")
    return value


def _optional_integer(data: dict[str, object], key: str) -> int | None:
    value = data.get(key)
    if value is None:
        return None
    if not isinstance(value, int) or isinstance(value, bool):
        raise ValidatorProtocolError(f"{key} debe ser integer o null")
    return value


def _integer(data: dict[str, object], key: str) -> int:
    value = data.get(key)
    if not isinstance(value, int) or isinstance(value, bool):
        raise ValidatorProtocolError(f"{key} debe ser integer")
    return value


def _datetime(data: dict[str, object], key: str) -> datetime:
    try:
        value = datetime.fromisoformat(_string(data, key))
    except ValueError as exc:
        raise ValidatorProtocolError(f"{key} inválido") from exc
    _require_aware(value, key)
    return value


def _require_aware(value: datetime, name: str) -> None:
    if value.tzinfo is None or value.utcoffset() is None:
        raise ValueError(f"{name} debe incluir zona horaria")


def _b64encode(value: bytes) -> str:
    if not isinstance(value, bytes):
        raise ValueError("sólo se puede codificar bytes")
    return base64.urlsafe_b64encode(value).decode("ascii")


def _b64decode(value: str, name: str, expected_size: int) -> bytes:
    try:
        decoded = base64.b64decode(value, altchars=b"-_", validate=True)
    except (ValueError, TypeError) as exc:
        raise ValidatorProtocolError(f"{name} no es base64 válido") from exc
    if len(decoded) != expected_size:
        raise ValidatorProtocolError(f"{name} tiene largo inválido")
    return decoded
