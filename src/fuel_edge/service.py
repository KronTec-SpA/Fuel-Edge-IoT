"""Orquestación del núcleo, el relé y la persistencia local."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from math import isfinite
from threading import Event, RLock
from time import monotonic
from typing import Callable
from uuid import uuid4

from .access import AccessContext, TechnologyAdoptionStage
from .domain import (
    PUMP_TEST_DEFAULT_DURATION_SECONDS,
    PUMP_TEST_MAX_DURATION_SECONDS,
    PUMP_TEST_MIN_DURATION_SECONDS,
    AuditRecord,
    EdgeEvent,
    EdgeState,
    FuelEdgeMachine,
)
from .storage import EventStore


@dataclass(frozen=True, slots=True)
class _TransactionSnapshot:
    transaction_id: str | None
    pulse_count: int


@dataclass(frozen=True, slots=True)
class _UnauthorizedFlowSnapshot:
    incident_id: str
    started_at: datetime
    last_pulse_at: datetime
    pulse_count: int


RELAY_TEST_DURATION_SECONDS = PUMP_TEST_DEFAULT_DURATION_SECONDS
PUMP_ENABLEMENT_THRESHOLD_LITERS = 0.12


@dataclass(frozen=True, slots=True)
class RelayTestResult:
    success: bool
    error: str | None
    started_at: str
    completed_at: str


@dataclass(slots=True)
class _ActiveRelayTest:
    command_id: str
    started_at: datetime
    completed: Event
    result: RelayTestResult | None = None


@dataclass(frozen=True, slots=True)
class _ManualModeSegment:
    segment_id: str
    schedule_id: str
    operator_id: str | None = None
    credential_id: str | None = None
    is_master: bool = False
    equipment_id: str | None = None
    authorization_evidence: str = "assisted"
    adoption_stage: str | None = None
    assisted_mode: bool = False
    equipment_issue: str | None = None


class FuelEdgeService:
    """Única puerta de entrada operacional al núcleo de control."""

    def __init__(
        self,
        machine: FuelEdgeMachine,
        store: EventStore,
        *,
        pulses_per_liter: float,
        k24_enabled: bool = True,
        tank_level_enabled: bool = True,
        validator_enabled: bool = True,
        telemetry_session_id: str | None = None,
    ) -> None:
        if pulses_per_liter <= 0:
            raise ValueError("pulses_per_liter debe ser positivo")
        self.machine = machine
        self.store = store
        self.pulses_per_liter = pulses_per_liter
        self.k24_enabled = k24_enabled
        self.tank_level_enabled = tank_level_enabled
        self.validator_enabled = validator_enabled
        self.telemetry_session_id = telemetry_session_id or str(uuid4())
        self._validator_reported_at: float | None = None
        self._nfc_ready = False
        self._lock = RLock()
        self._active_relay_test: _ActiveRelayTest | None = None
        self._manual_segment: _ManualModeSegment | None = None
        self._manual_first_pulse_at: datetime | None = None
        self._manual_last_pulse_at: datetime | None = None
        self._manual_pulse_count = 0
        self.store.recover_active_manual_mode(
            datetime.now(timezone.utc).isoformat(),
            pulses_per_liter,
            PUMP_ENABLEMENT_THRESHOLD_LITERS,
        )
        active_unauthorized_flow = self.store.active_unauthorized_flow()
        self._unauthorized_flow: _UnauthorizedFlowSnapshot | None = None
        if active_unauthorized_flow is not None:
            incident_id, started_at, last_pulse_at, pulse_count = active_unauthorized_flow
            self._unauthorized_flow = _UnauthorizedFlowSnapshot(
                incident_id=incident_id,
                started_at=datetime.fromisoformat(started_at),
                last_pulse_at=datetime.fromisoformat(last_pulse_at),
                pulse_count=pulse_count,
            )

    def report_validator_hardware(self, nfc_ready: bool) -> None:
        """Registra un heartbeat físico; un retained antiguo no queda sano para siempre."""
        with self._lock:
            self._nfc_ready = nfc_ready
            self._validator_reported_at = monotonic()

    def report_validator_offline(self) -> None:
        with self._lock:
            self._nfc_ready = False
            self._validator_reported_at = None

    def assign(self, module_id: str, site_id: str) -> AuditRecord:
        record = self._execute(
            lambda: self.machine.apply(
                EdgeEvent.ASSIGN, module_id=module_id, site_id=site_id
            )
        )
        cached = self.store.technology_adoption_policy(site_id)
        if cached is not None:
            stage, revision = cached
            self.update_technology_adoption_policy(stage, revision)
        return record

    def update_technology_adoption_policy(
        self,
        stage: str | TechnologyAdoptionStage,
        revision: int,
    ) -> AuditRecord | None:
        normalized = TechnologyAdoptionStage(str(stage))
        with self._lock:
            if revision < self.machine.adoption_policy_revision:
                return None
            if revision == self.machine.adoption_policy_revision:
                if normalized is not self.machine.technology_adoption_stage:
                    raise ValueError("una revisión de adopción no puede cambiar de etapa")
                return None
            return self._execute(
                lambda: self.machine.apply(
                    EdgeEvent.ADOPTION_POLICY_CHANGED,
                    stage=str(normalized),
                    revision=revision,
                )
            )

    def present_credential(self, credential_id: str) -> AuditRecord:
        with self._lock:
            if self.machine.state is EdgeState.RELAY_TESTING:
                raise RuntimeError("prueba de relé en curso: punto ocupado")
        return self._execute(lambda: self.machine.present_credential(credential_id))

    def start_manual_mode(
        self,
        schedule_id: str,
        *,
        ends_at: datetime,
        at: datetime | None = None,
        purpose: str = "manual",
    ) -> AuditRecord:
        """Mantiene R0.1 cerrado y abre un segmento de consumo sin tag."""

        with self._lock:
            if self.machine.state is EdgeState.MANUAL_MODE:
                if self.machine.manual_mode_schedule_id == schedule_id:
                    return self.machine.audit[-1]
                raise RuntimeError("ya hay otro período de modo manual activo")
            if self.machine.state is not EdgeState.LOCKED:
                raise RuntimeError("el punto debe estar bloqueado para iniciar modo manual")
            if self._active_relay_test is not None:
                raise RuntimeError("hay una prueba de bomba en curso")
            if self._unauthorized_flow is not None:
                raise RuntimeError("hay flujo K24 pendiente de cierre")
            if not self.k24_enabled or not self.machine.k24_healthy:
                raise RuntimeError("K24 debe estar habilitado y saludable")
            return self._execute(
                lambda: self.machine.start_manual_mode(
                    schedule_id,
                    ends_at=ends_at,
                    at=at,
                    purpose=purpose,
                )
            )

    def stop_manual_mode(self, reason: str = "cancelled") -> AuditRecord | None:
        with self._lock:
            if self.machine.state is not EdgeState.MANUAL_MODE:
                return None
            return self._execute(lambda: self.machine.abort_manual_mode(reason))

    def assign_manual_operator(
        self,
        credential_id: str,
        operator_id: str,
        *,
        is_master: bool = False,
        equipment_id: str | None = None,
        authorization_evidence: str = "rfid_only",
        adoption_stage: str | None = None,
        equipment_issue: str | None = None,
    ) -> AuditRecord:
        """Cambia la imputación K24 al operador del tag sin actuar el relé."""

        if not credential_id or not operator_id:
            raise ValueError("la imputación manual requiere credencial y operador")
        with self._lock:
            if self.machine.state is not EdgeState.MANUAL_MODE:
                raise RuntimeError("el modo manual no está activo")
            current = self._manual_segment
            if (
                current is not None
                and current.credential_id == credential_id
                and current.operator_id == operator_id
                and current.equipment_id == equipment_id
                and current.authorization_evidence == authorization_evidence
            ):
                return self.machine.audit[-1]
            return self._execute(
                lambda: self.machine.apply(
                    EdgeEvent.MANUAL_CREDENTIAL_ASSIGNED,
                    schedule_id=self.machine.manual_mode_schedule_id,
                    credential_id=credential_id,
                    operator_id=operator_id,
                    is_master=is_master,
                    equipment_id=equipment_id,
                    authorization_evidence=authorization_evidence,
                    adoption_stage=adoption_stage,
                    assisted_mode=self.machine.manual_mode_purpose
                    == "adoption_assisted",
                    equipment_issue=equipment_issue,
                )
            )

    def clear_manual_operator(self, reason: str = "nfc_removed") -> AuditRecord | None:
        with self._lock:
            if self.machine.state is not EdgeState.MANUAL_MODE:
                return None
            current = self._manual_segment
            if current is None or current.operator_id is None:
                return None
            return self._execute(
                lambda: self.machine.apply(
                    EdgeEvent.MANUAL_CREDENTIAL_RELEASED,
                    schedule_id=self.machine.manual_mode_schedule_id,
                    credential_id=current.credential_id,
                    operator_id=current.operator_id,
                    reason=reason,
                )
            )

    def downgrade_manual_equipment(
        self,
        reason: str = "ble_presence_lost",
    ) -> AuditRecord | None:
        """Conserva el RFID, pero separa los litros posteriores a la pérdida MIM."""

        with self._lock:
            current = self._manual_segment
            if (
                self.machine.state is not EdgeState.MANUAL_MODE
                or current is None
                or current.operator_id is None
                or current.credential_id is None
                or current.equipment_id is None
            ):
                return None
            return self._execute(
                lambda: self.machine.apply(
                    EdgeEvent.MANUAL_CREDENTIAL_ASSIGNED,
                    schedule_id=self.machine.manual_mode_schedule_id,
                    credential_id=current.credential_id,
                    operator_id=current.operator_id,
                    is_master=current.is_master,
                    equipment_id=None,
                    authorization_evidence="rfid_only",
                    adoption_stage=current.adoption_stage,
                    assisted_mode=current.assisted_mode,
                    equipment_issue=reason,
                )
            )

    def reject_manual_credential(
        self,
        reason: str,
        *,
        credential_id: str | None = None,
    ) -> AuditRecord:
        with self._lock:
            if self.machine.state is not EdgeState.MANUAL_MODE:
                raise RuntimeError("el modo manual no está activo")
            return self._execute(
                lambda: self.machine.apply(
                    EdgeEvent.MANUAL_CREDENTIAL_REJECTED,
                    schedule_id=self.machine.manual_mode_schedule_id,
                    credential_id=credential_id,
                    reason=reason,
                )
            )

    def downgrade_active_equipment(
        self,
        reason: str = "equipment_presence_lost",
    ) -> AuditRecord:
        return self._execute(
            lambda: self.machine.downgrade_active_equipment(reason)
        )

    def authorize(self, context: AccessContext) -> AuditRecord:
        with self._lock:
            record = self.machine.authorize(context)
            try:
                self._persist(record)
                if record.event is EdgeEvent.AUTHORIZATION_GRANTED:
                    if not self.machine.transaction_id or not self.machine.operator_id:
                        raise RuntimeError("autorización sin identidad de transacción")
                    self.store.open_transaction(
                        self.machine.transaction_id,
                        self.machine.operator_id,
                        self.machine.equipment_id,
                        context.is_master,
                        record.occurred_at.isoformat(),
                        authorization_evidence=str(
                            record.metadata.get("authorization_evidence", "legacy")
                        ),
                        adoption_stage=str(
                            record.metadata.get("adoption_stage", "full")
                        ),
                        equipment_issue=(
                            str(record.metadata["equipment_issue"])
                            if record.metadata.get("equipment_issue")
                            else None
                        ),
                    )
            except Exception as exc:
                self._fail_safe_after_storage_error(exc)
            return record

    def apply(self, event: EdgeEvent, **metadata: object) -> AuditRecord:
        with self._lock:
            if (
                self.machine.state is EdgeState.RELAY_TESTING
                and event
                not in {
                    EdgeEvent.RELAY_TEST_FINISHED,
                    EdgeEvent.RELAY_TEST_ABORTED,
                    EdgeEvent.VALIDATOR_LINK_LOST,
                    EdgeEvent.VALIDATOR_LINK_RESTORED,
                }
            ):
                self._execute(
                    lambda: self.machine.abort_relay_test(
                        "control_event",
                        interrupted_by=str(event),
                    )
                )
            return self._execute(lambda: self.machine.apply(event, **metadata))

    def run_relay_test(
        self,
        command_id: str,
        *,
        duration_seconds: int = RELAY_TEST_DURATION_SECONDS,
        stop_event: Event | None = None,
    ) -> RelayTestResult:
        """Ejecuta una prueba acotada y garantiza LOW al terminar o cancelar."""

        stop_event = stop_event or Event()
        if not PUMP_TEST_MIN_DURATION_SECONDS <= duration_seconds <= PUMP_TEST_MAX_DURATION_SECONDS:
            raise ValueError(
                "duration_seconds debe estar entre "
                f"{PUMP_TEST_MIN_DURATION_SECONDS} y {PUMP_TEST_MAX_DURATION_SECONDS}"
            )
        started_at = datetime.now(timezone.utc)
        run = _ActiveRelayTest(command_id, started_at, Event())
        with self._lock:
            if self._active_relay_test is not None:
                raise RuntimeError("ya hay una prueba de relé en curso")
            if self.machine.state is not EdgeState.LOCKED:
                raise RuntimeError("el punto debe estar bloqueado para probar el relé")
            if self._unauthorized_flow is not None:
                raise RuntimeError("hay flujo K24 pendiente de cierre")
            if not self.k24_enabled:
                raise RuntimeError("K24 debe estar habilitado para probar el relé")
            if not self.machine.k24_healthy:
                raise RuntimeError("K24 no está saludable")
            self._active_relay_test = run
            try:
                self._execute(
                    lambda: self.machine.start_relay_test(
                        command_id,
                        duration_seconds=duration_seconds,
                        at=started_at,
                    )
                )
            except Exception:
                self._active_relay_test = None
                try:
                    self.machine.relay.deenergize()
                except Exception:
                    pass
                raise

        deadline = monotonic() + duration_seconds
        try:
            while not run.completed.is_set():
                remaining = deadline - monotonic()
                if remaining <= 0:
                    with self._lock:
                        if self.machine.state is EdgeState.RELAY_TESTING:
                            self._execute(self.machine.finish_relay_test)
                    break
                if stop_event.wait(min(remaining, 0.25)):
                    with self._lock:
                        if self.machine.state is EdgeState.RELAY_TESTING:
                            self._execute(
                                lambda: self.machine.abort_relay_test(
                                    "service_stopping"
                                )
                            )
                    break
            if run.result is None:
                raise RuntimeError("la prueba de relé terminó sin resultado")
            return run.result
        finally:
            # No tocar una autorización que pudiera comenzar después de que la
            # prueba ya volvió a LOCKED. Sólo se fuerza el cierre si la propia
            # prueba sigue siendo la dueña de la salida.
            with self._lock:
                if self.machine.state is EdgeState.RELAY_TESTING:
                    try:
                        self._execute(
                            lambda: self.machine.abort_relay_test(
                                "relay_test_finalizer"
                            )
                        )
                    except Exception:
                        try:
                            self.machine.relay.deenergize()
                        except Exception:
                            pass

    def abort_relay_test(self, reason: str = "cancelled") -> AuditRecord | None:
        with self._lock:
            if self.machine.state is not EdgeState.RELAY_TESTING:
                return None
            return self._execute(lambda: self.machine.abort_relay_test(reason))

    def record_k24_pulse(
        self, count: int = 1, at: datetime | None = None
    ) -> AuditRecord | None:
        at = at or datetime.now(timezone.utc)
        with self._lock:
            if self.machine.state is EdgeState.MANUAL_MODE:
                if count <= 0:
                    raise ValueError("count debe ser positivo")
                if self._manual_segment is None:
                    raise RuntimeError("modo manual sin segmento de consumo activo")
                try:
                    total = self.store.record_manual_mode_pulses(
                        self._manual_segment.segment_id,
                        count,
                    )
                except Exception as exc:
                    self._fail_safe_after_storage_error(exc)
                if self._manual_first_pulse_at is None:
                    self._manual_first_pulse_at = at
                self._manual_last_pulse_at = at
                self._manual_pulse_count = total
                return None
            if self.machine.state not in {EdgeState.AUTHORIZED, EdgeState.DISPENSING}:
                return self._record_unauthorized_flow(count, at)
            return self._execute_optional(
                lambda: self.machine.record_k24_pulse(count, at)
            )

    def tick(self, now: datetime | None = None) -> AuditRecord | None:
        now = now or datetime.now(timezone.utc)

        def advance() -> AuditRecord | None:
            # CLOSING representa el corte ya ordenado. La confirmación que
            # ofrece el adaptador es que el driver aceptó LOW; completar esta
            # transición evita que el punto quede ocupado indefinidamente.
            if self.machine.state is EdgeState.CLOSING:
                if self.machine.relay.is_energized:
                    return self.machine.apply(
                        EdgeEvent.CONTROL_FAULT,
                        reason="relay_remained_energized_during_close",
                    )
                return self.machine.apply(
                    EdgeEvent.CLOSE_CONFIRMED,
                    reason="relay_deenergized",
                )
            if (
                self.machine.state is EdgeState.DISPENSING
                and self._is_pump_enablement_candidate(self.machine.pulse_count)
                and self.machine.authorized_at is not None
                and self.machine.last_pulse_at is not None
            ):
                # Un volumen menor a 0,12 L puede ser sólo la descarga que
                # produce la presurización inicial. Conservamos la sesión y
                # todos sus pulsos durante la ventana completa de inicio. Si
                # luego aparece más flujo, el despacho clásico incluirá también
                # este volumen inicial.
                deadline = max(
                    self.machine.authorized_at
                    + timedelta(seconds=self.machine.config.start_timeout_seconds),
                    self.machine.last_pulse_at
                    + timedelta(seconds=self.machine.config.k24_inactivity_seconds),
                )
                if now < deadline:
                    return None
                return self.machine.apply(
                    EdgeEvent.FLOW_STOPPED,
                    reason="pump_enablement_window_elapsed",
                    pulses=self.machine.pulse_count,
                )
            return self.machine.check_timeouts(now)

        with self._lock:
            self._close_unauthorized_flow_if_inactive(now)
            self._close_manual_load_if_inactive(now)
            return self._execute_optional(advance)

    def _record_unauthorized_flow(
        self,
        count: int,
        at: datetime,
    ) -> AuditRecord | None:
        if count <= 0:
            raise ValueError("count debe ser positivo")
        incident = self._unauthorized_flow
        if incident is None:
            incident_id = f"UF-{uuid4()}"
            started_at = at
        else:
            incident_id = incident.incident_id
            started_at = incident.started_at
        try:
            total = self.store.record_unauthorized_flow_pulses(
                incident_id,
                started_at.isoformat(),
                at.isoformat(),
                count,
            )
            self._unauthorized_flow = _UnauthorizedFlowSnapshot(
                incident_id=incident_id,
                started_at=started_at,
                last_pulse_at=at,
                pulse_count=total,
            )
            if incident is not None:
                return None
            record = self.machine.record_k24_pulse(
                count,
                at,
                incident_id=incident_id,
            )
            if record is None:  # pragma: no cover - estado comprobado arriba
                raise RuntimeError("el primer pulso no autorizado no produjo auditoría")
            self._persist(record)
            self._complete_relay_test(record)
            return record
        except Exception as exc:
            self._fail_safe_after_storage_error(exc)

    def _close_unauthorized_flow_if_inactive(self, now: datetime) -> None:
        incident = self._unauthorized_flow
        if incident is None:
            return
        inactivity_deadline = incident.last_pulse_at + timedelta(
            seconds=self.machine.config.k24_inactivity_seconds
        )
        deadline = inactivity_deadline
        if self._is_pump_enablement_candidate(incident.pulse_count):
            deadline = max(
                incident.started_at
                + timedelta(seconds=self.machine.config.start_timeout_seconds),
                inactivity_deadline,
            )
        if now < deadline:
            return
        try:
            self.store.close_unauthorized_flow(
                incident.incident_id,
                now.isoformat(),
                self.pulses_per_liter,
                PUMP_ENABLEMENT_THRESHOLD_LITERS,
            )
            self._unauthorized_flow = None
        except Exception as exc:
            self._fail_safe_after_storage_error(exc)

    def _close_manual_load_if_inactive(self, now: datetime) -> None:
        """Publica una carga terminada sin abandonar el período manual."""

        last_pulse_at = self._manual_last_pulse_at
        if self.machine.state is not EdgeState.MANUAL_MODE or last_pulse_at is None:
            return
        inactivity_deadline = last_pulse_at + timedelta(
            seconds=self.machine.config.k24_inactivity_seconds
        )
        deadline = inactivity_deadline
        if (
            self._is_pump_enablement_candidate(self._manual_pulse_count)
            and self._manual_first_pulse_at is not None
        ):
            deadline = max(
                self._manual_first_pulse_at
                + timedelta(seconds=self.machine.config.start_timeout_seconds),
                inactivity_deadline,
            )
        if now < deadline:
            return
        current = self._manual_segment
        if current is None:
            self._fail_safe_after_storage_error(
                RuntimeError("modo manual sin segmento de consumo activo")
            )
        try:
            self.store.close_manual_mode_segment(
                current.segment_id,
                now.isoformat(),
                "k24_inactivity",
                self.pulses_per_liter,
                PUMP_ENABLEMENT_THRESHOLD_LITERS,
            )
            self._manual_segment = None
            self._manual_first_pulse_at = None
            self._manual_last_pulse_at = None
            self._manual_pulse_count = 0
            # El relé y el modo manual siguen activos. Abrimos un segmento con
            # la misma imputación para poder registrar otra carga del operador.
            self._open_manual_segment(
                current.schedule_id,
                now,
                operator_id=current.operator_id,
                credential_id=current.credential_id,
                is_master=current.is_master,
                equipment_id=current.equipment_id,
                authorization_evidence=current.authorization_evidence,
                adoption_stage=current.adoption_stage,
                assisted_mode=current.assisted_mode,
                equipment_issue=current.equipment_issue,
            )
        except Exception as exc:
            self._fail_safe_after_storage_error(exc)

    def record_tank_level(
        self,
        level_liters: float,
        occurred_at: str,
        *,
        source: str = "OCIO",
    ) -> int:
        if not isfinite(level_liters) or level_liters < 0:
            raise ValueError("level_liters debe ser finito y no negativo")
        if not source or len(source) > 80:
            raise ValueError("source inválido")
        return self.store.enqueue_tank_level(
            level_liters=level_liters,
            occurred_at=occurred_at,
            source=source,
            telemetry_session_id=self.telemetry_session_id,
        )

    def publish_status(self) -> int:
        validator_online = bool(
            self.validator_enabled
            and self._validator_reported_at is not None
            and monotonic() - self._validator_reported_at <= 15.0
        )
        return self.store.enqueue_latest(
            "web/status",
            {
                "moduleId": self.machine.module_id,
                "siteId": self.machine.site_id,
                "state": str(self.machine.state),
                "relayEnergized": self.machine.relay.is_energized,
                "validatorOnline": validator_online,
                "nfcReady": validator_online and self._nfc_ready,
                "k24Enabled": self.k24_enabled,
                "k24Healthy": self.machine.k24_healthy,
                "tankLevelEnabled": self.tank_level_enabled,
                "telemetrySessionId": self.telemetry_session_id,
                "technologyAdoptionStage": str(
                    self.machine.technology_adoption_stage
                ),
                "adoptionPolicyRevision": self.machine.adoption_policy_revision,
                "occurredAt": datetime.now().astimezone().isoformat(),
            },
            "web/status:latest",
        )

    def _execute(self, operation: Callable[[], AuditRecord]) -> AuditRecord:
        record = self._execute_optional(operation)
        if record is None:  # pragma: no cover - contrato de Callable
            raise RuntimeError("la operación no produjo un registro")
        return record

    def _execute_optional(
        self, operation: Callable[[], AuditRecord | None]
    ) -> AuditRecord | None:
        with self._lock:
            before = _TransactionSnapshot(
                transaction_id=self.machine.transaction_id,
                pulse_count=self.machine.pulse_count,
            )
            record = operation()
            if record is None:
                return None
            try:
                self._persist(record)
                if (
                    before.transaction_id
                    and record.new_state in {EdgeState.CLOSING, EdgeState.FAULT}
                ):
                    pulses = self.machine.pulse_count
                    self.store.close_transaction(
                        before.transaction_id,
                        record.occurred_at.isoformat(),
                        str(record.metadata.get("reason", record.event)),
                        pulses,
                        pulses / self.pulses_per_liter,
                        PUMP_ENABLEMENT_THRESHOLD_LITERS,
                    )
                self._complete_relay_test(record)
            except Exception as exc:
                self._fail_safe_after_storage_error(exc)
            return record

    def _persist(self, record: AuditRecord) -> None:
        payload = self.machine.audit_payload(record)
        self.store.record_audit(payload)
        self.store.enqueue("edge/audit", payload)
        if record.event is EdgeEvent.MANUAL_MODE_STARTED:
            schedule_id = str(record.metadata["schedule_id"])
            self.store.open_manual_mode_session(
                schedule_id,
                str(record.metadata["started_at"]),
                str(record.metadata["ends_at"]),
                str(record.metadata.get("purpose", "manual")),
            )
            self._open_manual_segment(
                schedule_id,
                record.occurred_at,
                authorization_evidence="assisted",
                adoption_stage=(
                    str(self.machine.technology_adoption_stage)
                    if record.metadata.get("purpose") == "adoption_assisted"
                    else None
                ),
                assisted_mode=record.metadata.get("purpose")
                == "adoption_assisted",
            )
        elif record.event is EdgeEvent.MANUAL_CREDENTIAL_ASSIGNED:
            self._switch_manual_segment(
                record,
                operator_id=str(record.metadata["operator_id"]),
                credential_id=str(record.metadata["credential_id"]),
                is_master=bool(record.metadata.get("is_master")),
                equipment_id=(
                    str(record.metadata["equipment_id"])
                    if record.metadata.get("equipment_id")
                    else None
                ),
                authorization_evidence=str(
                    record.metadata.get("authorization_evidence", "rfid_only")
                ),
                adoption_stage=(
                    str(record.metadata["adoption_stage"])
                    if record.metadata.get("adoption_stage")
                    else None
                ),
                assisted_mode=bool(record.metadata.get("assisted_mode")),
                equipment_issue=(
                    str(record.metadata["equipment_issue"])
                    if record.metadata.get("equipment_issue")
                    else None
                ),
            )
        elif record.event is EdgeEvent.MANUAL_CREDENTIAL_RELEASED:
            self._switch_manual_segment(record)
        elif (
            record.previous_state is EdgeState.MANUAL_MODE
            and record.new_state is not EdgeState.MANUAL_MODE
        ):
            self._close_manual_mode(record)
        elif record.event is EdgeEvent.RELAY_TEST_STARTED:
            self.store.open_pump_test_transaction(
                str(record.metadata["command_id"]),
                int(record.metadata["duration_seconds"]),
                record.occurred_at.isoformat(),
            )
        elif record.event in {
            EdgeEvent.RELAY_TEST_FINISHED,
            EdgeEvent.RELAY_TEST_ABORTED,
        }:
            self.store.close_pump_test_transaction(
                str(record.metadata["command_id"]),
                record.occurred_at.isoformat(),
                (
                    "completed"
                    if record.event is EdgeEvent.RELAY_TEST_FINISHED
                    else "interrupted"
                ),
                (
                    None
                    if record.event is EdgeEvent.RELAY_TEST_FINISHED
                    else str(record.metadata.get("reason", record.event))
                ),
            )
        elif record.event is EdgeEvent.ADOPTION_POLICY_CHANGED:
            if not self.machine.site_id:
                raise RuntimeError("política de adopción sin fundo asignado")
            self.store.save_technology_adoption_policy(
                self.machine.site_id,
                str(record.metadata["stage"]),
                int(record.metadata["revision"]),
                record.occurred_at.isoformat(),
            )
        elif record.event is EdgeEvent.ADOPTION_EVIDENCE_DOWNGRADED:
            self.store.downgrade_transaction_evidence(
                str(record.metadata["transaction_id"]),
                str(record.metadata.get("reason", "equipment_presence_lost")),
            )
        if (
            record.event is EdgeEvent.TELEMETRY_FAULT
            and record.metadata.get("reason") == "unauthorized_flow"
        ):
            incident_id = str(record.metadata.get("incident_id", ""))
            if not incident_id:
                raise RuntimeError("flujo no autorizado sin identificador de incidente")
            occurred_at = str(
                record.metadata.get("detected_at", record.occurred_at.isoformat())
            )
            self.store.enqueue_latest(
                "web/alert",
                {
                    "id": f"edge-alert-{incident_id}",
                    "severity": "critical",
                    "priority": "urgent",
                    "title": "Flujo de petróleo sin autorización",
                    "detail": (
                        "K24 detectó flujo sin una autorización activa. "
                        "Conteo en curso; posible bypass de la bomba."
                    ),
                    "occurredAt": occurred_at,
                },
                f"web/alert:{incident_id}",
            )
            return
        if (
            record.event is EdgeEvent.RELAY_TEST_ABORTED
            and record.metadata.get("reason") == "k24_flow_detected"
        ):
            incident_id = str(record.metadata.get("incident_id", ""))
            occurred_at = str(
                record.metadata.get("detected_at", record.occurred_at.isoformat())
            )
            self.store.enqueue_latest(
                "web/alert",
                {
                    "id": f"edge-alert-{incident_id or int(record.occurred_at.timestamp() * 1_000_000)}",
                    "severity": "critical",
                    "priority": "urgent",
                    "title": "Prueba de relé interrumpida por flujo K24",
                    "detail": (
                        "K24 detectó flujo durante la prueba de R0.1. "
                        "La Raspberry abrió el relé antes del tiempo solicitado."
                    ),
                    "occurredAt": occurred_at,
                },
                f"web/alert:{incident_id or occurred_at}",
            )
            return
        if record.event in {
            EdgeEvent.CONTROL_FAULT,
            EdgeEvent.TELEMETRY_FAULT,
            EdgeEvent.VALIDATOR_LINK_LOST,
            EdgeEvent.BLE_LOST,
        }:
            severity = "critical" if record.event in {EdgeEvent.CONTROL_FAULT, EdgeEvent.TELEMETRY_FAULT} else "warning"
            titles = {
                EdgeEvent.CONTROL_FAULT: "Falla de la cadena de control",
                EdgeEvent.TELEMETRY_FAULT: "Falla de telemetría",
                EdgeEvent.VALIDATOR_LINK_LOST: "Validador sin conexión",
                EdgeEvent.BLE_LOST: "Carga cerrada por pérdida BLE",
            }
            occurred_at = record.occurred_at.isoformat()
            self.store.enqueue(
                "web/alert",
                {
                    "id": f"edge-alert-{record.event}-{int(record.occurred_at.timestamp() * 1_000_000)}",
                    "severity": severity,
                    "title": titles[record.event],
                    "detail": str(record.metadata.get("reason", record.metadata.get("sensor", "Evento generado por el controlador edge"))),
                    "occurredAt": occurred_at,
                },
                dedupe_key=f"web/alert:{record.event}:{occurred_at}",
            )

    def _open_manual_segment(
        self,
        schedule_id: str,
        opened_at: datetime,
        *,
        operator_id: str | None = None,
        credential_id: str | None = None,
        is_master: bool = False,
        equipment_id: str | None = None,
        authorization_evidence: str = "assisted",
        adoption_stage: str | None = None,
        assisted_mode: bool = False,
        equipment_issue: str | None = None,
    ) -> None:
        segment = _ManualModeSegment(
            segment_id=str(uuid4()),
            schedule_id=schedule_id,
            operator_id=operator_id,
            credential_id=credential_id,
            is_master=is_master,
            equipment_id=equipment_id,
            authorization_evidence=authorization_evidence,
            adoption_stage=adoption_stage,
            assisted_mode=assisted_mode,
            equipment_issue=equipment_issue,
        )
        self.store.open_manual_mode_segment(
            segment.segment_id,
            schedule_id,
            opened_at.isoformat(),
            operator_id=operator_id,
            credential_id=credential_id,
            is_master=is_master,
            equipment_id=equipment_id,
            authorization_evidence=authorization_evidence,
            adoption_stage=adoption_stage,
            assisted_mode=assisted_mode,
            equipment_issue=equipment_issue,
        )
        self._manual_segment = segment
        self._manual_first_pulse_at = None
        self._manual_last_pulse_at = None
        self._manual_pulse_count = 0

    def _switch_manual_segment(
        self,
        record: AuditRecord,
        *,
        operator_id: str | None = None,
        credential_id: str | None = None,
        is_master: bool = False,
        equipment_id: str | None = None,
        authorization_evidence: str = "assisted",
        adoption_stage: str | None = None,
        assisted_mode: bool = False,
        equipment_issue: str | None = None,
    ) -> None:
        current = self._manual_segment
        if current is None:
            raise RuntimeError("modo manual sin segmento vigente")
        self.store.close_manual_mode_segment(
            current.segment_id,
            record.occurred_at.isoformat(),
            str(record.metadata.get("reason", record.event)),
            self.pulses_per_liter,
            PUMP_ENABLEMENT_THRESHOLD_LITERS,
        )
        self._manual_segment = None
        self._manual_first_pulse_at = None
        self._manual_last_pulse_at = None
        self._manual_pulse_count = 0
        self._open_manual_segment(
            current.schedule_id,
            record.occurred_at,
            operator_id=operator_id,
            credential_id=credential_id,
            is_master=is_master,
            equipment_id=equipment_id,
            authorization_evidence=authorization_evidence,
            adoption_stage=adoption_stage,
            assisted_mode=assisted_mode,
            equipment_issue=equipment_issue,
        )

    def _close_manual_mode(self, record: AuditRecord) -> None:
        current = self._manual_segment
        schedule_id = str(
            record.metadata.get("schedule_id")
            or (current.schedule_id if current is not None else "")
        )
        reason = str(record.metadata.get("reason", record.event))
        if current is not None:
            self.store.close_manual_mode_segment(
                current.segment_id,
                record.occurred_at.isoformat(),
                reason,
                self.pulses_per_liter,
                PUMP_ENABLEMENT_THRESHOLD_LITERS,
            )
            self._manual_segment = None
            self._manual_first_pulse_at = None
            self._manual_last_pulse_at = None
            self._manual_pulse_count = 0
        if schedule_id:
            self.store.close_manual_mode_session(
                schedule_id,
                record.occurred_at.isoformat(),
                (
                    "completed"
                    if record.event is EdgeEvent.MANUAL_MODE_FINISHED
                    else "interrupted"
                ),
                reason,
            )

    def _fail_safe_after_storage_error(self, error: Exception) -> None:
        """Un error de auditoría durante una carga abre el circuito y bloquea."""
        fault = self.machine.apply(
            EdgeEvent.CONTROL_FAULT,
            reason="persistence_failure",
            error=type(error).__name__,
        )
        try:
            self.store.record_audit(self.machine.audit_payload(fault))
        except Exception:
            pass
        raise RuntimeError("falló la persistencia local; relé desenergizado") from error

    def _is_pump_enablement_candidate(self, pulses: int) -> bool:
        return pulses / self.pulses_per_liter < PUMP_ENABLEMENT_THRESHOLD_LITERS

    def _complete_relay_test(self, record: AuditRecord) -> None:
        run = self._active_relay_test
        if run is None or record.new_state is EdgeState.RELAY_TESTING:
            return
        success = record.event is EdgeEvent.RELAY_TEST_FINISHED
        run.result = RelayTestResult(
            success=success,
            error=None if success else str(record.metadata.get("reason", record.event)),
            started_at=run.started_at.isoformat(),
            completed_at=record.occurred_at.isoformat(),
        )
        self._active_relay_test = None
        run.completed.set()
