"""Autorización de equipos contra la asignación vigente de la web local."""

from __future__ import annotations

from datetime import datetime
import json
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

from .config import WebSyncConfig
from .rfid import EquipmentEvidence
from .validator_link import RemoteEquipmentObservation


class WebAuthorizationDirectory:
    """Consulta la fuente autoritativa local y falla siempre hacia circuito abierto."""

    def __init__(
        self,
        config: WebSyncConfig,
        sensor_key: str,
        site_id: str,
    ) -> None:
        if len(sensor_key) < 24:
            raise ValueError("la clave de autorización web es demasiado corta")
        self._url = f"{config.base_url}/api/equipment-enrollment/authorization/resolve"
        self._sensor_key = sensor_key
        self._site_id = site_id
        self._timeout = config.request_timeout_seconds

    def resolve_equipment(
        self,
        operator_id: str,
        observation: RemoteEquipmentObservation | None,
    ) -> EquipmentEvidence | None:
        if observation is None:
            return None
        try:
            record = self._resolve(operator_id, observation)
        except (HTTPError, URLError, OSError, TimeoutError, TypeError, ValueError):
            record = None
        if record is None:
            return EquipmentEvidence(
                equipment_id=observation.equipment_id,
                active=False,
                present=observation.present,
                authenticated=observation.authenticated,
                association_active=False,
            )
        return EquipmentEvidence(
            equipment_id=observation.equipment_id,
            active=record["active"],
            present=observation.present,
            authenticated=observation.authenticated,
            association_active=record["association_active"],
            assignment_valid_until=record["valid_until"],
        )

    def _resolve(
        self,
        operator_id: str,
        observation: RemoteEquipmentObservation,
    ) -> dict[str, object] | None:
        payload = json.dumps(
            {
                "operatorId": operator_id,
                "equipmentId": observation.equipment_id,
                "moduleId": observation.module_id,
                "siteId": self._site_id,
            },
            separators=(",", ":"),
        ).encode("utf-8")
        request = Request(
            self._url,
            data=payload,
            method="POST",
            headers={
                "Content-Type": "application/json",
                "X-Edge-Sensor-Key": self._sensor_key,
                "User-Agent": "fuel-edge-authorization/0.1",
            },
        )
        with urlopen(request, timeout=self._timeout) as response:
            body = json.loads(response.read(16 * 1024))
        equipment = body.get("equipment") if isinstance(body, dict) else None
        if not isinstance(equipment, dict):
            return None
        active = equipment.get("active")
        association_active = equipment.get("associationActive")
        if not isinstance(active, bool) or not isinstance(association_active, bool):
            return None
        valid_until = _optional_datetime(equipment.get("assignmentValidUntil"))
        return {
            "active": active,
            "association_active": association_active,
            "valid_until": valid_until,
        }


def _optional_datetime(value: object) -> datetime | None:
    if value is None:
        return None
    if not isinstance(value, str):
        raise ValueError("assignmentValidUntil inválido")
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if parsed.tzinfo is None or parsed.utcoffset() is None:
        raise ValueError("assignmentValidUntil debe incluir zona horaria")
    return parsed
