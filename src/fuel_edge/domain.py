"""Núcleo de control local, autorización y habilitación de bomba."""

from __future__ import annotations

from dataclasses import asdict, dataclass, field
from datetime import datetime, timedelta, timezone
from enum import StrEnum
from typing import Any
from uuid import uuid4

from .access import (
    AccessContext,
    AccessPolicy,
    AuthorizationEvidence,
    TechnologyAdoptionStage,
)
from .relay import MemoryPumpRelay, PumpRelay

PUMP_TEST_MIN_DURATION_SECONDS = 5
PUMP_TEST_MAX_DURATION_SECONDS = 60
PUMP_TEST_DEFAULT_DURATION_SECONDS = 10


class EdgeState(StrEnum):
    UNASSIGNED = "unassigned"
    LOCKED = "locked"
    RELAY_TESTING = "relay_testing"
    MANUAL_MODE = "manual_mode"
    VALIDATING = "validating"
    AUTHORIZED = "authorized"
    DISPENSING = "dispensing"
    CLOSING = "closing"
    FAULT = "fault"


class EdgeEvent(StrEnum):
    ASSIGN = "assign"
    NFC_PRESENTED = "nfc_presented"
    AUTHORIZATION_GRANTED = "authorization_granted"
    AUTHORIZATION_DENIED = "authorization_denied"
    NFC_REJECTED = "nfc_rejected"
    RELAY_TEST_STARTED = "relay_test_started"
    RELAY_TEST_FINISHED = "relay_test_finished"
    RELAY_TEST_ABORTED = "relay_test_aborted"
    MANUAL_MODE_STARTED = "manual_mode_started"
    MANUAL_MODE_FINISHED = "manual_mode_finished"
    MANUAL_MODE_ABORTED = "manual_mode_aborted"
    MANUAL_CREDENTIAL_ASSIGNED = "manual_credential_assigned"
    MANUAL_CREDENTIAL_RELEASED = "manual_credential_released"
    MANUAL_CREDENTIAL_REJECTED = "manual_credential_rejected"
    FLOW_STARTED = "flow_started"
    FLOW_STOPPED = "flow_stopped"
    NFC_REMOVED = "nfc_removed"
    BLE_LOST = "ble_lost"
    START_TIMEOUT = "start_timeout"
    CLOSE_CONFIRMED = "close_confirmed"
    TELEMETRY_FAULT = "telemetry_fault"
    TELEMETRY_RESTORED = "telemetry_restored"
    VALIDATOR_LINK_LOST = "validator_link_lost"
    VALIDATOR_LINK_RESTORED = "validator_link_restored"
    CONTROL_FAULT = "control_fault"
    RESET = "reset"
    ADOPTION_POLICY_CHANGED = "adoption_policy_changed"
    ADOPTION_EVIDENCE_DOWNGRADED = "adoption_evidence_downgraded"


class InvalidTransition(ValueError):
    """El evento no es válido en el estado actual."""


@dataclass(frozen=True, slots=True)
class AuditRecord:
    occurred_at: datetime
    previous_state: EdgeState
    event: EdgeEvent
    new_state: EdgeState
    relay_energized: bool
    metadata: dict[str, Any]


@dataclass(frozen=True, slots=True)
class ControlConfig:
    start_timeout_seconds: int = 60
    k24_inactivity_seconds: int = 40
    ble_loss_seconds: int = 20
    nfc_debounce_milliseconds: int = 300
    nfc_presence_timeout_milliseconds: int = 2500


@dataclass(slots=True)
class FuelEdgeMachine:
    """Decide localmente la habilitación y siempre corta ante fallas de control."""

    relay: PumpRelay = field(default_factory=MemoryPumpRelay)
    access_policy: AccessPolicy = field(default_factory=AccessPolicy)
    config: ControlConfig = field(default_factory=ControlConfig)
    state: EdgeState = EdgeState.UNASSIGNED
    module_id: str | None = None
    site_id: str | None = None
    transaction_id: str | None = None
    operator_id: str | None = None
    equipment_id: str | None = None
    authorized_at: datetime | None = None
    last_pulse_at: datetime | None = None
    pulse_count: int = 0
    relay_test_deadline: datetime | None = None
    relay_test_command_id: str | None = None
    relay_test_duration_seconds: int | None = None
    manual_mode_schedule_id: str | None = None
    manual_mode_deadline: datetime | None = None
    manual_mode_purpose: str = "manual"
    technology_adoption_stage: TechnologyAdoptionStage = TechnologyAdoptionStage.FULL
    adoption_policy_revision: int = 1
    active_adoption_stage: TechnologyAdoptionStage | None = None
    validator_online: bool = True
    k24_healthy: bool = True
    audit: list[AuditRecord] = field(default_factory=list)

    _TRANSITIONS = {
        (EdgeState.UNASSIGNED, EdgeEvent.ASSIGN): EdgeState.LOCKED,
        (EdgeState.LOCKED, EdgeEvent.NFC_PRESENTED): EdgeState.VALIDATING,
        (EdgeState.LOCKED, EdgeEvent.RELAY_TEST_STARTED): EdgeState.RELAY_TESTING,
        (EdgeState.LOCKED, EdgeEvent.MANUAL_MODE_STARTED): EdgeState.MANUAL_MODE,
        (EdgeState.RELAY_TESTING, EdgeEvent.RELAY_TEST_FINISHED): EdgeState.LOCKED,
        (EdgeState.RELAY_TESTING, EdgeEvent.RELAY_TEST_ABORTED): EdgeState.LOCKED,
        (EdgeState.MANUAL_MODE, EdgeEvent.MANUAL_MODE_FINISHED): EdgeState.LOCKED,
        (EdgeState.MANUAL_MODE, EdgeEvent.MANUAL_MODE_ABORTED): EdgeState.LOCKED,
        (EdgeState.MANUAL_MODE, EdgeEvent.MANUAL_CREDENTIAL_ASSIGNED): EdgeState.MANUAL_MODE,
        (EdgeState.MANUAL_MODE, EdgeEvent.MANUAL_CREDENTIAL_RELEASED): EdgeState.MANUAL_MODE,
        (EdgeState.MANUAL_MODE, EdgeEvent.MANUAL_CREDENTIAL_REJECTED): EdgeState.MANUAL_MODE,
        (EdgeState.VALIDATING, EdgeEvent.AUTHORIZATION_GRANTED): EdgeState.AUTHORIZED,
        (EdgeState.VALIDATING, EdgeEvent.AUTHORIZATION_DENIED): EdgeState.LOCKED,
        (EdgeState.VALIDATING, EdgeEvent.NFC_REJECTED): EdgeState.LOCKED,
        (EdgeState.AUTHORIZED, EdgeEvent.FLOW_STARTED): EdgeState.DISPENSING,
        (EdgeState.AUTHORIZED, EdgeEvent.ADOPTION_EVIDENCE_DOWNGRADED): EdgeState.AUTHORIZED,
        (EdgeState.AUTHORIZED, EdgeEvent.NFC_REMOVED): EdgeState.CLOSING,
        (EdgeState.AUTHORIZED, EdgeEvent.BLE_LOST): EdgeState.CLOSING,
        (EdgeState.AUTHORIZED, EdgeEvent.START_TIMEOUT): EdgeState.CLOSING,
        (EdgeState.DISPENSING, EdgeEvent.FLOW_STOPPED): EdgeState.CLOSING,
        (EdgeState.DISPENSING, EdgeEvent.ADOPTION_EVIDENCE_DOWNGRADED): EdgeState.DISPENSING,
        (EdgeState.DISPENSING, EdgeEvent.NFC_REMOVED): EdgeState.CLOSING,
        (EdgeState.DISPENSING, EdgeEvent.BLE_LOST): EdgeState.CLOSING,
        (EdgeState.CLOSING, EdgeEvent.CLOSE_CONFIRMED): EdgeState.LOCKED,
        (EdgeState.FAULT, EdgeEvent.RESET): EdgeState.LOCKED,
        (EdgeState.LOCKED, EdgeEvent.VALIDATOR_LINK_LOST): EdgeState.LOCKED,
        # La prueba de bomba es un control local del PLC. El validador puede
        # desconectarse durante ella sin tomar propiedad de R0.1 ni cortarla.
        (EdgeState.RELAY_TESTING, EdgeEvent.VALIDATOR_LINK_LOST): EdgeState.RELAY_TESTING,
        (EdgeState.RELAY_TESTING, EdgeEvent.VALIDATOR_LINK_RESTORED): EdgeState.RELAY_TESTING,
        # El modo manual pertenece al PLC: una caída del validador impide
        # identificar nuevos tags, pero no abre R0.1 antes del fin programado.
        (EdgeState.MANUAL_MODE, EdgeEvent.VALIDATOR_LINK_LOST): EdgeState.MANUAL_MODE,
        (EdgeState.MANUAL_MODE, EdgeEvent.VALIDATOR_LINK_RESTORED): EdgeState.MANUAL_MODE,
        (EdgeState.VALIDATING, EdgeEvent.VALIDATOR_LINK_LOST): EdgeState.LOCKED,
        (EdgeState.AUTHORIZED, EdgeEvent.VALIDATOR_LINK_LOST): EdgeState.CLOSING,
        (EdgeState.DISPENSING, EdgeEvent.VALIDATOR_LINK_LOST): EdgeState.CLOSING,
        (EdgeState.LOCKED, EdgeEvent.VALIDATOR_LINK_RESTORED): EdgeState.LOCKED,
        (EdgeState.AUTHORIZED, EdgeEvent.VALIDATOR_LINK_RESTORED): EdgeState.AUTHORIZED,
        (EdgeState.DISPENSING, EdgeEvent.VALIDATOR_LINK_RESTORED): EdgeState.DISPENSING,
    }

    def __post_init__(self) -> None:
        # El arranque siempre deja el circuito de mando abierto.
        self.relay.deenergize()

    def present_credential(self, credential_id: str) -> AuditRecord:
        if not self.validator_online:
            raise RuntimeError("validator offline: no se admiten nuevas cargas")
        return self.apply(EdgeEvent.NFC_PRESENTED, credential_id=credential_id)

    def authorize(self, context: AccessContext) -> AuditRecord:
        if self.state is not EdgeState.VALIDATING:
            return self._invalid(EdgeEvent.AUTHORIZATION_GRANTED)

        try:
            decision = self.access_policy.evaluate(
                context,
                adoption_stage=self.technology_adoption_stage,
            )
        except TypeError as exc:
            # Conserva políticas locales antiguas con evaluate(context). Esas
            # políticas siguen siendo fail-safe: no reciben la relajación de adopción.
            if "adoption_stage" not in str(exc) or "unexpected keyword" not in str(exc):
                raise
            decision = self.access_policy.evaluate(context)
        metadata = {
            "credential_id": context.credential_id,
            "operator_id": context.operator_id,
            "equipment_id": context.equipment_id,
            "is_master": context.is_master,
            "adoption_stage": str(self.technology_adoption_stage),
        }
        if not decision.allowed:
            metadata["reason"] = str(decision.reason)
            return self.apply(EdgeEvent.AUTHORIZATION_DENIED, **metadata)

        transaction_id = str(uuid4())
        authorized_at = datetime.now(timezone.utc)
        try:
            self.relay.energize()
            if not self.relay.is_energized:
                raise RuntimeError("relay did not confirm energized state")
        except Exception as exc:
            # Se intenta LOW incluso si la orden HIGH devolvió error; _enter_fault
            # vuelve a intentarlo para no ocultar una falla de corte persistente.
            try:
                self.relay.deenergize()
            except Exception:
                pass
            return self._enter_fault("relay_enable_failed", error=type(exc).__name__)

        evidence = decision.evidence or AuthorizationEvidence.FULL
        metadata["authorization_evidence"] = str(evidence)
        if decision.equipment_issue is not None:
            metadata["equipment_issue"] = str(decision.equipment_issue)
            metadata["observed_equipment_id"] = context.equipment_id
        self.operator_id = context.operator_id
        self.equipment_id = (
            context.equipment_id
            if evidence is AuthorizationEvidence.FULL
            else None
        )
        metadata["equipment_id"] = self.equipment_id
        self.transaction_id = transaction_id
        self.active_adoption_stage = self.technology_adoption_stage
        self.authorized_at = authorized_at
        self.last_pulse_at = None
        self.pulse_count = 0
        metadata["transaction_id"] = transaction_id
        metadata["start_timeout_seconds"] = self.config.start_timeout_seconds
        return self.apply(EdgeEvent.AUTHORIZATION_GRANTED, **metadata)

    def downgrade_active_equipment(self, reason: str) -> AuditRecord:
        """Continúa con RFID sin castigar al operador que intentó usar el MIM."""

        if self.active_adoption_stage is not TechnologyAdoptionStage.RFID_ONLY:
            raise RuntimeError("la etapa actual no admite continuar sin MIM")
        if self.state not in {EdgeState.AUTHORIZED, EdgeState.DISPENSING}:
            return self._invalid(EdgeEvent.ADOPTION_EVIDENCE_DOWNGRADED)
        if not self.transaction_id or not self.operator_id or not self.equipment_id:
            raise RuntimeError("no existe evidencia completa que degradar")
        previous_equipment_id = self.equipment_id
        self.equipment_id = None
        return self.apply(
            EdgeEvent.ADOPTION_EVIDENCE_DOWNGRADED,
            reason=reason,
            transaction_id=self.transaction_id,
            operator_id=self.operator_id,
            previous_equipment_id=previous_equipment_id,
            equipment_id=None,
            authorization_evidence=str(AuthorizationEvidence.RFID_ONLY),
            adoption_stage=str(self.active_adoption_stage),
        )

    def start_relay_test(
        self,
        command_id: str,
        *,
        duration_seconds: int = PUMP_TEST_DEFAULT_DURATION_SECONDS,
        at: datetime | None = None,
    ) -> AuditRecord:
        """Energiza R0.1 sólo dentro de una prueba de mantenimiento acotada."""

        if self.state is not EdgeState.LOCKED:
            return self._invalid(EdgeEvent.RELAY_TEST_STARTED)
        if not PUMP_TEST_MIN_DURATION_SECONDS <= duration_seconds <= PUMP_TEST_MAX_DURATION_SECONDS:
            raise ValueError(
                "la prueba de bomba debe durar entre "
                f"{PUMP_TEST_MIN_DURATION_SECONDS} y {PUMP_TEST_MAX_DURATION_SECONDS} segundos"
            )
        if not command_id:
            raise ValueError("la prueba de relé requiere command_id")
        if self.transaction_id is not None or self.relay.is_energized:
            raise RuntimeError("el punto debe estar libre y con el relé abierto")
        started_at = at or datetime.now(timezone.utc)
        try:
            self.relay.energize()
            if not self.relay.is_energized:
                raise RuntimeError("relay did not confirm energized state")
        except Exception as exc:
            try:
                self.relay.deenergize()
            except Exception:
                pass
            return self._enter_fault(
                "relay_test_enable_failed", error=type(exc).__name__
            )
        self.relay_test_command_id = command_id
        self.relay_test_duration_seconds = duration_seconds
        self.relay_test_deadline = started_at + timedelta(seconds=duration_seconds)
        return self.apply(
            EdgeEvent.RELAY_TEST_STARTED,
            command_id=command_id,
            duration_seconds=duration_seconds,
            deadline=self.relay_test_deadline.isoformat(),
        )

    def finish_relay_test(self) -> AuditRecord:
        return self.apply(
            EdgeEvent.RELAY_TEST_FINISHED,
            command_id=self.relay_test_command_id,
            duration_seconds=self.relay_test_duration_seconds,
        )

    def start_manual_mode(
        self,
        schedule_id: str,
        *,
        ends_at: datetime,
        at: datetime | None = None,
        purpose: str = "manual",
    ) -> AuditRecord:
        """Cierra R0.1 durante una ventana explícita administrada por la web."""

        if self.state is not EdgeState.LOCKED:
            return self._invalid(EdgeEvent.MANUAL_MODE_STARTED)
        if not schedule_id:
            raise ValueError("el modo manual requiere schedule_id")
        if ends_at.tzinfo is None or ends_at.utcoffset() is None:
            raise ValueError("ends_at debe incluir zona horaria")
        started_at = at or datetime.now(timezone.utc)
        if started_at.tzinfo is None or started_at.utcoffset() is None:
            raise ValueError("at debe incluir zona horaria")
        started_at = started_at.astimezone(timezone.utc)
        deadline = ends_at.astimezone(timezone.utc)
        if deadline <= started_at:
            raise ValueError("el fin del modo manual debe ser futuro")
        if self.transaction_id is not None or self.relay.is_energized:
            raise RuntimeError("el punto debe estar libre y con el relé abierto")
        if purpose not in {"manual", "adoption_assisted"}:
            raise ValueError("purpose de modo manual inválido")
        try:
            self.relay.energize()
            if not self.relay.is_energized:
                raise RuntimeError("relay did not confirm energized state")
        except Exception as exc:
            try:
                self.relay.deenergize()
            except Exception:
                pass
            return self._enter_fault(
                "manual_mode_enable_failed", error=type(exc).__name__
            )
        self.manual_mode_schedule_id = schedule_id
        self.manual_mode_deadline = deadline
        self.manual_mode_purpose = purpose
        return self.apply(
            EdgeEvent.MANUAL_MODE_STARTED,
            schedule_id=schedule_id,
            started_at=started_at.isoformat(),
            ends_at=deadline.isoformat(),
            purpose=purpose,
        )

    def finish_manual_mode(self, reason: str = "scheduled_end") -> AuditRecord:
        return self.apply(
            EdgeEvent.MANUAL_MODE_FINISHED,
            schedule_id=self.manual_mode_schedule_id,
            reason=reason,
        )

    def abort_manual_mode(self, reason: str) -> AuditRecord:
        return self.apply(
            EdgeEvent.MANUAL_MODE_ABORTED,
            schedule_id=self.manual_mode_schedule_id,
            reason=reason,
        )

    def abort_relay_test(self, reason: str, **metadata: Any) -> AuditRecord:
        return self.apply(
            EdgeEvent.RELAY_TEST_ABORTED,
            command_id=self.relay_test_command_id,
            duration_seconds=self.relay_test_duration_seconds,
            reason=reason,
            **metadata,
        )

    def record_k24_pulse(
        self,
        count: int = 1,
        at: datetime | None = None,
        *,
        incident_id: str | None = None,
    ) -> AuditRecord | None:
        if count <= 0:
            raise ValueError("count debe ser positivo")
        at = at or datetime.now(timezone.utc)
        if self.state is EdgeState.RELAY_TESTING:
            return self.abort_relay_test(
                "k24_flow_detected",
                sensor="K24",
                pulse_count=count,
                detected_at=at.isoformat(),
                **({"incident_id": incident_id} if incident_id else {}),
            )
        if self.state is EdgeState.MANUAL_MODE:
            # El servicio contabiliza estos pulsos en el segmento del tag
            # vigente sin transferirle la propiedad del relé.
            return None
        if self.state not in {EdgeState.AUTHORIZED, EdgeState.DISPENSING}:
            return self.apply(
                EdgeEvent.TELEMETRY_FAULT,
                sensor="K24",
                reason="unauthorized_flow",
                pulse_count=count,
                critical=True,
                detected_at=at.isoformat(),
                **({"incident_id": incident_id} if incident_id else {}),
            )
        record = None
        if self.state is EdgeState.AUTHORIZED:
            record = self.apply(EdgeEvent.FLOW_STARTED, first_pulse_at=at.isoformat())
        self.pulse_count += count
        self.last_pulse_at = at
        return record

    def check_timeouts(self, now: datetime | None = None) -> AuditRecord | None:
        now = now or datetime.now(timezone.utc)
        if (
            self.state is EdgeState.RELAY_TESTING
            and self.relay_test_deadline is not None
            and now >= self.relay_test_deadline
        ):
            return self.finish_relay_test()
        if (
            self.state is EdgeState.MANUAL_MODE
            and self.manual_mode_deadline is not None
            and now >= self.manual_mode_deadline
        ):
            return self.finish_manual_mode()
        if self.state is EdgeState.AUTHORIZED and self.authorized_at is not None:
            deadline = self.authorized_at + timedelta(seconds=self.config.start_timeout_seconds)
            if now >= deadline:
                return self.apply(EdgeEvent.START_TIMEOUT, reason="no_flow_after_authorization")
        if self.state is EdgeState.DISPENSING and self.last_pulse_at is not None and self.k24_healthy:
            deadline = self.last_pulse_at + timedelta(seconds=self.config.k24_inactivity_seconds)
            if now >= deadline:
                return self.apply(
                    EdgeEvent.FLOW_STOPPED,
                    reason="k24_inactivity",
                    pulses=self.pulse_count,
                )
        return None

    def apply(self, event: EdgeEvent, **metadata: Any) -> AuditRecord:
        if event is EdgeEvent.CONTROL_FAULT:
            return self._enter_fault(str(metadata.pop("reason", "control_fault")), **metadata)
        if event is EdgeEvent.TELEMETRY_FAULT:
            if str(metadata.get("sensor", "")).upper() == "K24" and metadata.get("reason") != "unauthorized_flow":
                self.k24_healthy = False
            return self._record(event, self.state, metadata)
        if event is EdgeEvent.TELEMETRY_RESTORED:
            if str(metadata.get("sensor", "")).upper() == "K24":
                self.k24_healthy = True
            return self._record(event, self.state, metadata)
        if event is EdgeEvent.ADOPTION_POLICY_CHANGED:
            stage = TechnologyAdoptionStage(str(metadata.get("stage", "")))
            revision = int(metadata.get("revision", 0))
            if revision <= 0:
                raise ValueError("revision de adopción inválida")
            self.technology_adoption_stage = stage
            self.adoption_policy_revision = revision
            return self._record(event, self.state, metadata)

        if event is EdgeEvent.VALIDATOR_LINK_LOST:
            self.validator_online = False
        elif event is EdgeEvent.VALIDATOR_LINK_RESTORED:
            self.validator_online = True

        if event is EdgeEvent.RESET and not metadata.get("control_chain_healthy", False):
            raise ValueError("RESET requiere confirmación control_chain_healthy")
        if event is EdgeEvent.RESET and (not self.module_id or not self.site_id):
            raise ValueError("RESET no puede habilitar un punto sin asignación")

        try:
            new_state = self._TRANSITIONS[(self.state, event)]
        except KeyError:
            return self._invalid(event)

        if event is EdgeEvent.ASSIGN:
            module_id = metadata.get("module_id")
            site_id = metadata.get("site_id")
            if not module_id or not site_id:
                raise ValueError("ASSIGN requiere module_id y site_id")
            self.module_id = str(module_id)
            self.site_id = str(site_id)

        if event in {
            EdgeEvent.AUTHORIZATION_DENIED,
            EdgeEvent.NFC_REJECTED,
            EdgeEvent.RELAY_TEST_FINISHED,
            EdgeEvent.RELAY_TEST_ABORTED,
            EdgeEvent.MANUAL_MODE_FINISHED,
            EdgeEvent.MANUAL_MODE_ABORTED,
            EdgeEvent.NFC_REMOVED,
            EdgeEvent.BLE_LOST,
            EdgeEvent.START_TIMEOUT,
            EdgeEvent.FLOW_STOPPED,
            EdgeEvent.CLOSE_CONFIRMED,
            EdgeEvent.RESET,
        }:
            self.relay.deenergize()
        if event is EdgeEvent.VALIDATOR_LINK_LOST and new_state not in {
            EdgeState.RELAY_TESTING,
            EdgeState.MANUAL_MODE,
        }:
            self.relay.deenergize()

        record = self._record(event, new_state, metadata)
        if new_state is EdgeState.LOCKED:
            self._clear_session()
        return record

    def _invalid(self, event: EdgeEvent) -> AuditRecord:
        previous_state = self.state
        if self.relay.is_energized:
            self._enter_fault("invalid_transition", attempted_event=str(event))
        raise InvalidTransition(f"{event} no es válido desde {previous_state}")

    def _enter_fault(self, reason: str, **metadata: Any) -> AuditRecord:
        self.relay.deenergize()
        self.relay_test_deadline = None
        self.relay_test_command_id = None
        self.relay_test_duration_seconds = None
        self.manual_mode_schedule_id = None
        self.manual_mode_deadline = None
        self.manual_mode_purpose = "manual"
        metadata["reason"] = reason
        return self._record(EdgeEvent.CONTROL_FAULT, EdgeState.FAULT, metadata)

    def _record(self, event: EdgeEvent, new_state: EdgeState, metadata: dict[str, Any]) -> AuditRecord:
        record = AuditRecord(
            occurred_at=datetime.now(timezone.utc),
            previous_state=self.state,
            event=event,
            new_state=new_state,
            relay_energized=self.relay.is_energized,
            metadata=dict(metadata),
        )
        self.state = new_state
        self.audit.append(record)
        return record

    def _clear_session(self) -> None:
        self.transaction_id = None
        self.operator_id = None
        self.equipment_id = None
        self.active_adoption_stage = None
        self.authorized_at = None
        self.last_pulse_at = None
        self.pulse_count = 0
        self.relay_test_deadline = None
        self.relay_test_command_id = None
        self.relay_test_duration_seconds = None
        self.manual_mode_schedule_id = None
        self.manual_mode_deadline = None
        self.manual_mode_purpose = "manual"

    @staticmethod
    def audit_payload(record: AuditRecord) -> dict[str, Any]:
        payload = asdict(record)
        payload["occurred_at"] = record.occurred_at.isoformat()
        payload["previous_state"] = str(record.previous_state)
        payload["event"] = str(record.event)
        payload["new_state"] = str(record.new_state)
        return payload
