"""Carga segura de identidades locales usadas por la validación del RPi."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
import tomllib

from .application import (
    EquipmentAuthorizationRecord,
    MemoryAuthorizationDirectory,
)
from .rfid import MemoryCredentialRepository, RfidCredential


@dataclass(frozen=True, slots=True)
class ValidatorRegistry:
    credentials: MemoryCredentialRepository
    directory: MemoryAuthorizationDirectory


def load_validator_registry(path: str | Path) -> ValidatorRegistry:
    """Carga claves y asociaciones; exige un archivo privado (0600 o más estricto)."""

    registry_path = Path(path)
    mode = registry_path.stat().st_mode
    if mode & 0o077:
        raise PermissionError(
            "validator.registry_path contiene secretos y debe tener permisos 0600"
        )
    with registry_path.open("rb") as registry_file:
        raw = tomllib.load(registry_file)

    credential_rows = raw.get("credentials", [])
    equipment_rows = raw.get("equipment", [])
    association_rows = raw.get("associations", [])
    if not isinstance(credential_rows, list):
        raise ValueError("credentials debe ser una lista TOML")
    if not isinstance(equipment_rows, list):
        raise ValueError("equipment debe ser una lista TOML")
    if not isinstance(association_rows, list):
        raise ValueError("associations debe ser una lista TOML")

    credentials = MemoryCredentialRepository()
    active_masters = 0
    operator_ids: set[str] = set()
    for row in credential_rows:
        if not isinstance(row, dict):
            raise ValueError("cada credentials debe ser una tabla")
        credential_id = _text(row, "credential_id", "credentials")
        if credentials.get(credential_id) is not None:
            raise ValueError(f"credential_id duplicado: {credential_id}")
        operator_id = _text(row, "operator_id", "credentials")
        secret = _secret(row)
        credential = RfidCredential(
            credential_id=credential_id,
            operator_id=operator_id,
            secret=secret,
            credential_active=_boolean(row, "credential_active", True),
            operator_active=_boolean(row, "operator_active", True),
            is_master=_boolean(row, "is_master", False),
        )
        if credential.is_master and credential.credential_active:
            active_masters += 1
        credentials.add(credential)
        operator_ids.add(operator_id)
    if active_masters > 1:
        raise ValueError("sólo puede existir una credencial maestra activa")

    equipment: dict[str, EquipmentAuthorizationRecord] = {}
    for row in equipment_rows:
        if not isinstance(row, dict):
            raise ValueError("cada equipment debe ser una tabla")
        equipment_id = _text(row, "equipment_id", "equipment")
        if equipment_id in equipment:
            raise ValueError(f"equipment_id duplicado: {equipment_id}")
        equipment[equipment_id] = EquipmentAuthorizationRecord(
            equipment_id=equipment_id,
            active=_boolean(row, "active", True),
            assignment_valid_until=_optional_datetime(
                row, "assignment_valid_until"
            ),
        )

    associations: set[tuple[str, str]] = set()
    for row in association_rows:
        if not isinstance(row, dict):
            raise ValueError("cada associations debe ser una tabla")
        operator_id = _text(row, "operator_id", "associations")
        equipment_id = _text(row, "equipment_id", "associations")
        if operator_id not in operator_ids:
            raise ValueError(f"asociación usa operador desconocido: {operator_id}")
        if equipment_id not in equipment:
            raise ValueError(f"asociación usa equipo desconocido: {equipment_id}")
        if _boolean(row, "active", True):
            associations.add((operator_id, equipment_id))

    return ValidatorRegistry(
        credentials=credentials,
        directory=MemoryAuthorizationDirectory(
            equipment=equipment,
            associations=associations,
        ),
    )


def _secret(row: dict[str, object]) -> bytes:
    value = _text(row, "secret_hex", "credentials")
    try:
        secret = bytes.fromhex(value)
    except ValueError as exc:
        raise ValueError("credentials.secret_hex no es hexadecimal") from exc
    if len(secret) < 32:
        raise ValueError("credentials.secret_hex debe contener al menos 32 bytes")
    return secret


def _text(row: dict[str, object], key: str, section: str) -> str:
    value = row.get(key)
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"{section}.{key} es obligatorio")
    return value.strip()


def _boolean(row: dict[str, object], key: str, default: bool) -> bool:
    value = row.get(key, default)
    if not isinstance(value, bool):
        raise ValueError(f"{key} debe ser boolean")
    return value


def _optional_datetime(
    row: dict[str, object], key: str
) -> datetime | None:
    value = row.get(key)
    if value is None:
        return None
    if isinstance(value, datetime):
        parsed = value
    elif isinstance(value, str):
        try:
            parsed = datetime.fromisoformat(value)
        except ValueError as exc:
            raise ValueError(f"{key} inválido") from exc
    else:
        raise ValueError(f"{key} debe ser fecha ISO-8601")
    if parsed.tzinfo is None or parsed.utcoffset() is None:
        raise ValueError(f"{key} debe incluir zona horaria")
    return parsed
