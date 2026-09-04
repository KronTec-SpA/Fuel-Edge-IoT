"""Política local de identidad, presencia y autorización de carga."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
from enum import StrEnum


class DenialReason(StrEnum):
    CREDENTIAL_INACTIVE = "credential_inactive"
    OPERATOR_INACTIVE = "operator_inactive"
    POINT_UNAVAILABLE = "point_unavailable"
    CONTROL_CHAIN_UNHEALTHY = "control_chain_unhealthy"
    EQUIPMENT_REQUIRED = "equipment_required"
    EQUIPMENT_INACTIVE = "equipment_inactive"
    EQUIPMENT_NOT_PRESENT = "equipment_not_present"
    EQUIPMENT_NOT_AUTHENTICATED = "equipment_not_authenticated"
    ASSOCIATION_INACTIVE = "association_inactive"
    ASSIGNMENT_EXPIRED = "assignment_expired"


class TechnologyAdoptionStage(StrEnum):
    """Piso de evidencia exigido al autorizar una nueva carga."""

    ASSISTED = "assisted"
    RFID_ONLY = "rfid_only"
    FULL = "full"


class AuthorizationEvidence(StrEnum):
    FULL = "full"
    RFID_ONLY = "rfid_only"
    MASTER = "master"


@dataclass(frozen=True, slots=True)
class AccessContext:
    credential_id: str
    operator_id: str
    credential_active: bool
    operator_active: bool
    is_master: bool = False
    equipment_id: str | None = None
    equipment_active: bool = False
    equipment_present: bool = False
    equipment_authenticated: bool = False
    association_active: bool = False
    assignment_valid_until: datetime | None = None
    point_available: bool = True
    control_chain_healthy: bool = True


@dataclass(frozen=True, slots=True)
class AccessDecision:
    allowed: bool
    reason: DenialReason | None = None
    evidence: AuthorizationEvidence | None = None
    equipment_issue: DenialReason | None = None


class AccessPolicy:
    """Aplica las reglas que deben cumplirse antes de energizar el relé."""

    def evaluate(
        self,
        context: AccessContext,
        now: datetime | None = None,
        *,
        adoption_stage: TechnologyAdoptionStage = TechnologyAdoptionStage.FULL,
    ) -> AccessDecision:
        now = now or datetime.now(timezone.utc)
        checks = (
            (context.credential_active, DenialReason.CREDENTIAL_INACTIVE),
            (context.operator_active, DenialReason.OPERATOR_INACTIVE),
            (context.point_available, DenialReason.POINT_UNAVAILABLE),
            (context.control_chain_healthy, DenialReason.CONTROL_CHAIN_UNHEALTHY),
        )
        for condition, reason in checks:
            if not condition:
                return AccessDecision(False, reason)

        if context.is_master:
            return AccessDecision(True, evidence=AuthorizationEvidence.MASTER)

        equipment_issue: DenialReason | None = None
        if not context.equipment_id:
            equipment_issue = DenialReason.EQUIPMENT_REQUIRED
        else:
            equipment_checks = (
                (context.equipment_active, DenialReason.EQUIPMENT_INACTIVE),
                (context.equipment_present, DenialReason.EQUIPMENT_NOT_PRESENT),
                (context.equipment_authenticated, DenialReason.EQUIPMENT_NOT_AUTHENTICATED),
                (context.association_active, DenialReason.ASSOCIATION_INACTIVE),
            )
            for condition, reason in equipment_checks:
                if not condition:
                    equipment_issue = reason
                    break
            if (
                equipment_issue is None
                and context.assignment_valid_until is not None
                and context.assignment_valid_until <= now
            ):
                equipment_issue = DenialReason.ASSIGNMENT_EXPIRED

        if equipment_issue is None:
            return AccessDecision(True, evidence=AuthorizationEvidence.FULL)
        if adoption_stage is TechnologyAdoptionStage.RFID_ONLY:
            return AccessDecision(
                True,
                evidence=AuthorizationEvidence.RFID_ONLY,
                equipment_issue=equipment_issue,
            )
        return AccessDecision(False, equipment_issue)
