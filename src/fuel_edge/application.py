"""Orquestador nativo del RPi para validación, control y persistencia local."""

from __future__ import annotations

from collections import deque
from dataclasses import dataclass, field
from datetime import datetime
from threading import RLock
from time import monotonic
from typing import Callable, Protocol

from .access import AccessContext, AuthorizationEvidence, TechnologyAdoptionStage
from .domain import AuditRecord, EdgeEvent, EdgeState, FuelEdgeMachine
from .rfid import (
    EquipmentEvidence,
    RfidAuthorizationService,
    RfidCredential,
    RfidReaderError,
)
from .service import FuelEdgeService
from .nfc_enrollment import NfcEnrollmentCoordinator
from .validator_link import (
    CredentialPresenceUpdate,
    EquipmentPresenceUpdate,
    RemoteEquipmentObservation,
    RemoteRfidReader,
    ValidatorDecision,
    ValidatorPresentation,
    ValidatorTransport,
    ValidatorTransportError,
)


@dataclass(frozen=True, slots=True)
class EquipmentAuthorizationRecord:
    equipment_id: str
    active: bool = True
    assignment_valid_until: datetime | None = None


class AuthorizationDirectory(Protocol):
    def resolve_equipment(
        self,
        operator_id: str,
        observation: RemoteEquipmentObservation | None,
    ) -> EquipmentEvidence | None: ...


@dataclass(slots=True)
class MemoryAuthorizationDirectory:
    """Directorio local del RPi; nunca confía la asociación al validador."""

    equipment: dict[str, EquipmentAuthorizationRecord] = field(default_factory=dict)
    associations: set[tuple[str, str]] = field(default_factory=set)

    def resolve_equipment(
        self,
        operator_id: str,
        observation: RemoteEquipmentObservation | None,
    ) -> EquipmentEvidence | None:
        if observation is None:
            return None
        record = self.equipment.get(observation.equipment_id)
        return EquipmentEvidence(
            equipment_id=observation.equipment_id,
            active=record.active if record is not None else False,
            present=observation.present,
            authenticated=observation.authenticated,
            association_active=(
                record is not None
                and (operator_id, observation.equipment_id) in self.associations
            ),
            assignment_valid_until=(
                record.assignment_valid_until if record is not None else None
            ),
        )


@dataclass(slots=True)
class FuelEdgeApplication:
    """Une el validador remoto con la máquina segura que corre en el RPi."""

    control: FuelEdgeService
    rfid: RfidAuthorizationService
    transport: ValidatorTransport
    directory: AuthorizationDirectory
    validator_id: str
    proof_timeout_seconds: float = 5.0
    nfc_enrollment: NfcEnrollmentCoordinator | None = None
    on_equipment_observation: Callable[[str, int], None] | None = None
    point_available: Callable[[], bool] = lambda: True
    control_chain_healthy: Callable[[], bool] = lambda: True
    _lock: RLock = field(default_factory=RLock, init=False)
    _processed_sessions: set[str] = field(default_factory=set, init=False)
    _session_order: deque[str] = field(default_factory=deque, init=False)
    _active_validator_session: str | None = field(default=None, init=False)
    _active_equipment_id: str | None = field(default=None, init=False)
    _active_credential_id: str | None = field(default=None, init=False)
    _credential_last_seen: float | None = field(default=None, init=False)
    monotonic_clock: Callable[[], float] = monotonic

    @property
    def machine(self) -> FuelEdgeMachine:
        return self.control.machine

    def process_presentation(
        self, presentation: ValidatorPresentation
    ) -> ValidatorDecision:
        """Procesa una conversación completa y responde al validador."""

        with self._lock:
            if (
                presentation.equipment is not None
                and presentation.equipment.rssi is not None
                and presentation.equipment.module_id is not None
                and self.on_equipment_observation is not None
            ):
                self.on_equipment_observation(
                    presentation.equipment.module_id,
                    presentation.equipment.rssi,
                )
            if presentation.validator_id != self.validator_id:
                return self._publish_rejection(presentation, "validator_not_assigned")
            if presentation.session_id in self._processed_sessions:
                return self._publish_rejection(presentation, "replayed_session")
            self._remember_session(presentation.session_id)

            if self.machine.state is EdgeState.MANUAL_MODE:
                return self._process_manual_presentation(presentation)
            if self.machine.state is not EdgeState.LOCKED:
                return self._publish_rejection(presentation, "point_busy")

            if self.nfc_enrollment is not None:
                try:
                    enrollment_decision = self.nfc_enrollment.process_presentation(
                        presentation,
                        self.transport,
                        self.proof_timeout_seconds,
                    )
                except (OSError, TimeoutError, ValueError):
                    enrollment_decision = ValidatorDecision(
                        validator_id=presentation.validator_id,
                        session_id=presentation.session_id,
                        allowed=False,
                        state=str(self.machine.state),
                        reason="enrollment_local_error",
                    )
                if enrollment_decision is not None:
                    self._publish(enrollment_decision)
                    return enrollment_decision

            if not self.machine.validator_online:
                self.control.apply(
                    EdgeEvent.VALIDATOR_LINK_RESTORED,
                    validator_id=presentation.validator_id,
                )

            reader = RemoteRfidReader(
                transport=self.transport,
                validator_id=presentation.validator_id,
                session_id=presentation.session_id,
                timeout_seconds=self.proof_timeout_seconds,
            )
            try:
                outcome = self.rfid.handle_presentation(
                    self.control,
                    reader,
                    equipment_resolver=lambda credential: self._resolve_equipment(
                        credential, presentation.equipment
                    ),
                    point_available=self.point_available(),
                    control_chain_healthy=self.control_chain_healthy(),
                )
            except RfidReaderError:
                self._mark_validator_offline(presentation.validator_id)
                return self._publish_rejection(
                    presentation, "validator_link_error", mark_offline=False
                )
            except RuntimeError:
                return self._publish_rejection(
                    presentation, "local_persistence_error", mark_offline=False
                )
            if outcome.authorized:
                self._active_validator_session = presentation.session_id
                self._active_equipment_id = self.machine.equipment_id
                self._active_credential_id = outcome.authentication.credential_id
                self._credential_last_seen = self.monotonic_clock()
                decision = ValidatorDecision(
                    validator_id=presentation.validator_id,
                    session_id=presentation.session_id,
                    allowed=True,
                    state=str(self.machine.state),
                    transaction_id=self.machine.transaction_id,
                )
            else:
                reason = "no_credential"
                if outcome.audit_record is not None:
                    reason = str(outcome.audit_record.metadata.get("reason", "denied"))
                elif outcome.authentication.reason is not None:
                    reason = str(outcome.authentication.reason)
                decision = ValidatorDecision(
                    validator_id=presentation.validator_id,
                    session_id=presentation.session_id,
                    allowed=False,
                    state=str(self.machine.state),
                    reason=reason,
                )
            try:
                self._publish(decision)
            except ValidatorTransportError:
                self._mark_validator_offline(presentation.validator_id)
                raise
            return decision

    def _process_manual_presentation(
        self,
        presentation: ValidatorPresentation,
    ) -> ValidatorDecision:
        """Autentica el tag y cambia sólo la imputación, nunca el estado de R0.1."""

        if not self.machine.validator_online:
            self.control.apply(
                EdgeEvent.VALIDATOR_LINK_RESTORED,
                validator_id=presentation.validator_id,
            )
        reader = RemoteRfidReader(
            transport=self.transport,
            validator_id=presentation.validator_id,
            session_id=presentation.session_id,
            timeout_seconds=self.proof_timeout_seconds,
        )
        try:
            authentication = self.rfid.validator.authenticate(reader)
        except RfidReaderError:
            self._mark_validator_offline(presentation.validator_id)
            return self._publish_rejection(
                presentation,
                "validator_link_error",
                mark_offline=False,
            )

        credential = authentication.credential
        reason: str | None = None
        if not authentication.authenticated or credential is None:
            reason = str(authentication.reason or "authentication_failed")
        elif not credential.credential_active:
            reason = "credential_inactive"
        elif not credential.operator_active:
            reason = "operator_inactive"

        if reason is not None:
            # Un tag rechazado sustituye físicamente al anterior. Volvemos al
            # segmento sin operador para no imputar sus pulsos a otra persona.
            self.control.clear_manual_operator("credential_rejected")
            self._clear_active_session()
            self.control.reject_manual_credential(
                reason,
                credential_id=authentication.credential_id,
            )
            return self._publish_rejection(presentation, reason)

        equipment_id: str | None = None
        evidence = AuthorizationEvidence.RFID_ONLY
        equipment_issue: str | None = None
        adoption_stage: str | None = None
        if self.machine.manual_mode_purpose == "adoption_assisted":
            adoption_stage = str(self.machine.technology_adoption_stage)
            equipment = self._resolve_equipment(credential, presentation.equipment)
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
                assignment_valid_until=(
                    equipment.assignment_valid_until if equipment else None
                ),
                point_available=self.point_available(),
                control_chain_healthy=self.control_chain_healthy(),
            )
            adoption_decision = self.machine.access_policy.evaluate(
                context,
                adoption_stage=self.machine.technology_adoption_stage,
            )
            if adoption_decision.evidence is AuthorizationEvidence.FULL:
                evidence = AuthorizationEvidence.FULL
                equipment_id = equipment.equipment_id if equipment else None
            elif adoption_decision.evidence is AuthorizationEvidence.MASTER:
                evidence = AuthorizationEvidence.MASTER
            elif adoption_decision.equipment_issue is not None:
                equipment_issue = str(adoption_decision.equipment_issue)
            elif adoption_decision.reason is not None:
                equipment_issue = str(adoption_decision.reason)

        record = self.control.assign_manual_operator(
            credential.credential_id,
            credential.operator_id,
            is_master=credential.is_master,
            equipment_id=equipment_id,
            authorization_evidence=str(evidence),
            adoption_stage=adoption_stage,
            equipment_issue=equipment_issue,
        )
        self._active_validator_session = presentation.session_id
        self._active_equipment_id = equipment_id
        self._active_credential_id = credential.credential_id
        self._credential_last_seen = self.monotonic_clock()
        decision = ValidatorDecision(
            validator_id=presentation.validator_id,
            session_id=presentation.session_id,
            allowed=True,
            state=str(self.machine.state),
            transaction_id=(
                f"manual:{record.metadata.get('schedule_id')}"
                if record.metadata.get("schedule_id")
                else None
            ),
        )
        try:
            self._publish(decision)
        except ValidatorTransportError:
            self._mark_validator_offline(presentation.validator_id)
            raise
        return decision

    def process_equipment_presence(
        self, update: EquipmentPresenceUpdate
    ) -> AuditRecord | None:
        """Actualiza el radar y aplica pérdidas BLE correlacionadas a una carga."""

        with self._lock:
            if update.validator_id != self.validator_id:
                return None
            # El validador publica presencia autenticada mientras mantiene el
            # MIM a la espera de una tarjeta. Esta observación alimenta el mapa
            # sin convertir por sí sola la proximidad BLE en autorización.
            if (
                update.present
                and update.authenticated
                and update.module_id is not None
                and update.rssi is not None
                and self.on_equipment_observation is not None
            ):
                self.on_equipment_observation(update.module_id, update.rssi)
            if update.session_id != self._active_validator_session:
                return None
            if update.equipment_id != self._active_equipment_id:
                return None
            if update.present and update.authenticated:
                return None
            if update.lost_for_seconds < self.machine.config.ble_loss_seconds:
                return None
            if self.machine.state is EdgeState.MANUAL_MODE:
                record = self.control.downgrade_manual_equipment(
                    "equipment_presence_lost"
                )
                self._active_equipment_id = None
                return record
            if self.machine.state not in {EdgeState.AUTHORIZED, EdgeState.DISPENSING}:
                return None
            if (
                self.machine.active_adoption_stage
                is TechnologyAdoptionStage.RFID_ONLY
            ):
                record = self.control.downgrade_active_equipment(
                    "equipment_presence_lost"
                )
                self._active_equipment_id = None
                return record
            record = self.control.apply(
                EdgeEvent.BLE_LOST,
                reason="ble_presence_lost",
                validator_id=update.validator_id,
                session_id=update.session_id,
                module_id=update.module_id,
                equipment_id=update.equipment_id,
                lost_for_seconds=update.lost_for_seconds,
                last_rssi=update.rssi,
            )
            self._clear_active_session()
            return record

    def process_credential_presence(
        self, update: CredentialPresenceUpdate
    ) -> AuditRecord | None:
        """Mantiene el permiso RFID y corta ante ausencia o cambio de llave."""

        with self._lock:
            if update.validator_id != self.validator_id:
                return None
            if update.session_id != self._active_validator_session:
                return None
            manual_mode = self.machine.state is EdgeState.MANUAL_MODE
            if not manual_mode and self.machine.state not in {EdgeState.AUTHORIZED, EdgeState.DISPENSING}:
                return None
            credential_changed = update.credential_id != self._active_credential_id
            if update.present and update.authenticated and not credential_changed:
                self._credential_last_seen = self.monotonic_clock()
                return None
            if (
                not credential_changed
                and update.absent_for_milliseconds
                < self.machine.config.nfc_debounce_milliseconds
            ):
                return None
            reason = "credential_changed" if credential_changed else "nfc_removed"
            if manual_mode:
                record = self.control.clear_manual_operator(reason)
            else:
                record = self.control.apply(
                    EdgeEvent.NFC_REMOVED,
                    reason=reason,
                    validator_id=update.validator_id,
                    session_id=update.session_id,
                    credential_id=update.credential_id,
                    absent_for_milliseconds=update.absent_for_milliseconds,
                )
            self._clear_active_session()
            return record

    def check_credential_presence_timeout(self) -> AuditRecord | None:
        """Corta si desaparecen los heartbeats que demuestran la llave presente."""

        with self._lock:
            manual_mode = self.machine.state is EdgeState.MANUAL_MODE
            if not manual_mode and self.machine.state not in {EdgeState.AUTHORIZED, EdgeState.DISPENSING}:
                return None
            if self._active_validator_session is None or self._credential_last_seen is None:
                return None
            elapsed_ms = int(
                (self.monotonic_clock() - self._credential_last_seen) * 1000
            )
            if elapsed_ms < self.machine.config.nfc_presence_timeout_milliseconds:
                return None
            if manual_mode:
                record = self.control.clear_manual_operator(
                    "credential_presence_timeout"
                )
            else:
                record = self.control.apply(
                    EdgeEvent.NFC_REMOVED,
                    reason="credential_presence_timeout",
                    validator_id=self.validator_id,
                    session_id=self._active_validator_session,
                    credential_id=self._active_credential_id,
                    absent_for_milliseconds=elapsed_ms,
                )
            self._clear_active_session()
            return record

    def process_validator_disconnect(self) -> None:
        """Corta de inmediato al confirmarse la caída del enlace del validador."""

        with self._lock:
            self._mark_validator_offline(self.validator_id)
            if self.machine.state is EdgeState.MANUAL_MODE:
                self.control.clear_manual_operator("validator_link_lost")
            if self.machine.state not in {EdgeState.AUTHORIZED, EdgeState.DISPENSING}:
                self._clear_active_session()

    def _resolve_equipment(
        self,
        credential: RfidCredential,
        observation: RemoteEquipmentObservation | None,
    ) -> EquipmentEvidence | None:
        return self.directory.resolve_equipment(credential.operator_id, observation)

    def _publish_rejection(
        self,
        presentation: ValidatorPresentation,
        reason: str,
        *,
        mark_offline: bool = True,
    ) -> ValidatorDecision:
        decision = ValidatorDecision(
            validator_id=presentation.validator_id,
            session_id=presentation.session_id,
            allowed=False,
            state=str(self.machine.state),
            reason=reason,
        )
        try:
            self._publish(decision)
        except ValidatorTransportError:
            if mark_offline:
                self._mark_validator_offline(presentation.validator_id)
            raise
        return decision

    def _publish(self, decision: ValidatorDecision) -> None:
        try:
            self.transport.publish_decision(decision)
        except ValidatorTransportError:
            raise
        except Exception as exc:
            raise ValidatorTransportError("no se pudo responder al validador") from exc

    def _mark_validator_offline(self, validator_id: str) -> None:
        if not self.machine.validator_online:
            return
        try:
            self.control.apply(
                EdgeEvent.VALIDATOR_LINK_LOST,
                validator_id=validator_id,
            )
        except (RuntimeError, ValueError):
            pass

    def _clear_active_session(self) -> None:
        self._active_validator_session = None
        self._active_equipment_id = None
        self._active_credential_id = None
        self._credential_last_seen = None

    def _remember_session(self, session_id: str) -> None:
        self._processed_sessions.add(session_id)
        self._session_order.append(session_id)
        while len(self._session_order) > 512:
            expired = self._session_order.popleft()
            self._processed_sessions.discard(expired)
