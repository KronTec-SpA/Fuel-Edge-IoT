import unittest
from datetime import datetime, timedelta, timezone

from fuel_edge.access import (
    AccessContext,
    AuthorizationEvidence,
    DenialReason,
    TechnologyAdoptionStage,
)
from fuel_edge.domain import ControlConfig, EdgeEvent, EdgeState, FuelEdgeMachine, InvalidTransition
from fuel_edge.relay import MemoryPumpRelay


def assigned_machine() -> FuelEdgeMachine:
    machine = FuelEdgeMachine()
    machine.apply(EdgeEvent.ASSIGN, module_id="module-01", site_id="site-01")
    return machine


def normal_access(**overrides) -> AccessContext:
    values = {
        "credential_id": "nfc-01",
        "operator_id": "operator-01",
        "credential_active": True,
        "operator_active": True,
        "equipment_id": "tractor-01",
        "equipment_active": True,
        "equipment_present": True,
        "equipment_authenticated": True,
        "association_active": True,
        "assignment_valid_until": datetime.now(timezone.utc) + timedelta(days=1),
        "point_available": True,
        "control_chain_healthy": True,
    }
    values.update(overrides)
    return AccessContext(**values)


class FuelEdgeMachineTests(unittest.TestCase):
    def test_relay_test_uses_the_requested_bounded_time_and_returns_low(self) -> None:
        machine = assigned_machine()
        started_at = datetime(2026, 8, 16, 12, 0, tzinfo=timezone.utc)

        started = machine.start_relay_test(
            "relay-test-01", duration_seconds=25, at=started_at
        )

        self.assertIs(started.event, EdgeEvent.RELAY_TEST_STARTED)
        self.assertIs(machine.state, EdgeState.RELAY_TESTING)
        self.assertTrue(machine.relay.is_energized)
        self.assertIsNone(
            machine.check_timeouts(started_at + timedelta(seconds=24, milliseconds=999))
        )
        finished = machine.check_timeouts(started_at + timedelta(seconds=25))
        self.assertIsNotNone(finished)
        self.assertIs(finished.event, EdgeEvent.RELAY_TEST_FINISHED)
        self.assertIs(machine.state, EdgeState.LOCKED)
        self.assertFalse(machine.relay.is_energized)

        with self.assertRaisesRegex(ValueError, "entre 5 y 60 segundos"):
            machine.start_relay_test("relay-test-02", duration_seconds=4)

    def test_relay_test_does_not_depend_on_validator_link(self) -> None:
        machine = assigned_machine()
        machine.start_relay_test("relay-test-01", duration_seconds=30)

        disconnected = machine.apply(EdgeEvent.VALIDATOR_LINK_LOST)

        self.assertIs(disconnected.new_state, EdgeState.RELAY_TESTING)
        self.assertTrue(machine.relay.is_energized)
        self.assertFalse(machine.validator_online)

    def test_relay_test_cuts_immediately_on_k24_flow(self) -> None:
        machine = assigned_machine()
        machine.start_relay_test("relay-test-01")

        aborted = machine.record_k24_pulse(count=1)

        self.assertIsNotNone(aborted)
        self.assertIs(aborted.event, EdgeEvent.RELAY_TEST_ABORTED)
        self.assertEqual(aborted.metadata["reason"], "k24_flow_detected")
        self.assertIs(machine.state, EdgeState.LOCKED)
        self.assertFalse(machine.relay.is_energized)

    def test_normal_cycle_energizes_only_after_full_authorization(self) -> None:
        relay = MemoryPumpRelay()
        machine = FuelEdgeMachine(relay=relay)
        machine.apply(EdgeEvent.ASSIGN, module_id="module-01", site_id="site-01")
        self.assertFalse(relay.is_energized)

        machine.present_credential("nfc-01")
        machine.authorize(normal_access())
        self.assertIs(machine.state, EdgeState.AUTHORIZED)
        self.assertTrue(relay.is_energized)

        machine.apply(EdgeEvent.FLOW_STARTED)
        machine.apply(EdgeEvent.FLOW_STOPPED, reason="k24_inactivity", pulses=1234)
        self.assertIs(machine.state, EdgeState.CLOSING)
        self.assertFalse(relay.is_energized)
        machine.apply(EdgeEvent.CLOSE_CONFIRMED, liters=12.34)
        self.assertIs(machine.state, EdgeState.LOCKED)

    def test_normal_access_requires_authenticated_equipment_and_association(self) -> None:
        for changes, expected in (
            ({"equipment_present": False}, DenialReason.EQUIPMENT_NOT_PRESENT),
            ({"equipment_authenticated": False}, DenialReason.EQUIPMENT_NOT_AUTHENTICATED),
            ({"association_active": False}, DenialReason.ASSOCIATION_INACTIVE),
        ):
            machine = assigned_machine()
            machine.present_credential("nfc-01")
            record = machine.authorize(normal_access(**changes))
            self.assertIs(machine.state, EdgeState.LOCKED)
            self.assertFalse(machine.relay.is_energized)
            self.assertEqual(record.metadata["reason"], str(expected))

    def test_rfid_stage_allows_operator_without_mim_and_records_the_gap(self) -> None:
        machine = assigned_machine()
        machine.apply(
            EdgeEvent.ADOPTION_POLICY_CHANGED,
            stage="rfid_only",
            revision=2,
        )
        machine.present_credential("nfc-01")

        record = machine.authorize(
            normal_access(
                equipment_id=None,
                equipment_active=False,
                equipment_present=False,
                equipment_authenticated=False,
                association_active=False,
                assignment_valid_until=None,
            )
        )

        self.assertTrue(machine.relay.is_energized)
        self.assertIsNone(machine.equipment_id)
        self.assertEqual(
            record.metadata["authorization_evidence"],
            str(AuthorizationEvidence.RFID_ONLY),
        )
        self.assertEqual(record.metadata["equipment_issue"], "equipment_required")
        self.assertEqual(
            machine.technology_adoption_stage,
            TechnologyAdoptionStage.RFID_ONLY,
        )

    def test_early_adopter_keeps_full_evidence_in_an_initial_stage(self) -> None:
        machine = assigned_machine()
        machine.apply(
            EdgeEvent.ADOPTION_POLICY_CHANGED,
            stage="assisted",
            revision=2,
        )
        machine.present_credential("nfc-01")

        record = machine.authorize(normal_access())

        self.assertTrue(machine.relay.is_energized)
        self.assertEqual(machine.equipment_id, "tractor-01")
        self.assertEqual(
            record.metadata["authorization_evidence"],
            str(AuthorizationEvidence.FULL),
        )

    def test_assisted_stage_requires_its_approved_manual_window_for_missing_mim(self) -> None:
        machine = assigned_machine()
        machine.apply(
            EdgeEvent.ADOPTION_POLICY_CHANGED,
            stage="assisted",
            revision=2,
        )
        machine.present_credential("nfc-01")

        record = machine.authorize(
            normal_access(
                equipment_id=None,
                equipment_active=False,
                equipment_present=False,
                equipment_authenticated=False,
                association_active=False,
                assignment_valid_until=None,
            )
        )

        self.assertIs(machine.state, EdgeState.LOCKED)
        self.assertFalse(machine.relay.is_energized)
        self.assertEqual(record.metadata["reason"], "equipment_required")

    def test_rfid_stage_does_not_punish_an_early_adopter_when_mim_is_lost(self) -> None:
        machine = assigned_machine()
        machine.apply(
            EdgeEvent.ADOPTION_POLICY_CHANGED,
            stage="rfid_only",
            revision=2,
        )
        machine.present_credential("nfc-01")
        machine.authorize(normal_access())

        record = machine.downgrade_active_equipment("equipment_presence_lost")

        self.assertIs(machine.state, EdgeState.AUTHORIZED)
        self.assertTrue(machine.relay.is_energized)
        self.assertIsNone(machine.equipment_id)
        self.assertIs(record.event, EdgeEvent.ADOPTION_EVIDENCE_DOWNGRADED)
        self.assertEqual(record.metadata["authorization_evidence"], "rfid_only")

    def test_policy_change_only_affects_new_authorizations(self) -> None:
        machine = assigned_machine()
        machine.apply(
            EdgeEvent.ADOPTION_POLICY_CHANGED,
            stage="rfid_only",
            revision=2,
        )
        machine.present_credential("nfc-01")
        machine.authorize(normal_access())
        machine.apply(
            EdgeEvent.ADOPTION_POLICY_CHANGED,
            stage="full",
            revision=3,
        )

        record = machine.downgrade_active_equipment("equipment_presence_lost")

        self.assertIs(record.event, EdgeEvent.ADOPTION_EVIDENCE_DOWNGRADED)
        self.assertTrue(machine.relay.is_energized)
        self.assertEqual(record.metadata["adoption_stage"], "rfid_only")

    def test_expired_assignment_is_rejected(self) -> None:
        machine = assigned_machine()
        machine.present_credential("nfc-01")
        record = machine.authorize(
            normal_access(assignment_valid_until=datetime.now(timezone.utc) - timedelta(seconds=1))
        )
        self.assertEqual(record.metadata["reason"], str(DenialReason.ASSIGNMENT_EXPIRED))
        self.assertFalse(machine.relay.is_energized)

    def test_master_credential_can_authorize_without_equipment(self) -> None:
        machine = assigned_machine()
        machine.present_credential("master-01")
        machine.authorize(
            normal_access(
                credential_id="master-01",
                is_master=True,
                equipment_id=None,
                equipment_active=False,
                equipment_present=False,
                equipment_authenticated=False,
                association_active=False,
                assignment_valid_until=None,
            )
        )
        self.assertTrue(machine.relay.is_energized)
        self.assertIsNone(machine.equipment_id)

    def test_nfc_removal_ble_loss_and_start_timeout_cut_relay(self) -> None:
        for event in (EdgeEvent.NFC_REMOVED, EdgeEvent.BLE_LOST, EdgeEvent.START_TIMEOUT):
            machine = assigned_machine()
            machine.present_credential("nfc-01")
            machine.authorize(normal_access())
            machine.apply(event)
            self.assertFalse(machine.relay.is_energized)
            self.assertIs(machine.state, EdgeState.CLOSING)

    def test_telemetry_fault_alerts_but_does_not_cut_authorized_load(self) -> None:
        machine = assigned_machine()
        machine.present_credential("nfc-01")
        machine.authorize(normal_access())
        record = machine.apply(EdgeEvent.TELEMETRY_FAULT, sensor="K24")
        self.assertTrue(machine.relay.is_energized)
        self.assertIs(record.new_state, EdgeState.AUTHORIZED)

    def test_validator_link_loss_during_authorized_load_cuts_fail_safe(self) -> None:
        machine = assigned_machine()
        machine.present_credential("nfc-01")
        machine.authorize(normal_access())
        machine.record_k24_pulse(at=datetime.now(timezone.utc))
        machine.apply(EdgeEvent.VALIDATOR_LINK_LOST)
        self.assertFalse(machine.relay.is_energized)
        self.assertIs(machine.state, EdgeState.CLOSING)
        self.assertFalse(machine.validator_online)

    def test_validator_link_loss_before_authorization_blocks_new_load(self) -> None:
        machine = assigned_machine()
        machine.apply(EdgeEvent.VALIDATOR_LINK_LOST)
        with self.assertRaises(RuntimeError):
            machine.present_credential("nfc-01")
        self.assertFalse(machine.relay.is_energized)

    def test_start_and_k24_inactivity_timeouts_cut_relay(self) -> None:
        config = ControlConfig(start_timeout_seconds=60, k24_inactivity_seconds=40)
        machine = FuelEdgeMachine(config=config)
        machine.apply(EdgeEvent.ASSIGN, module_id="module-01", site_id="site-01")
        machine.present_credential("nfc-01")
        machine.authorize(normal_access())
        machine.check_timeouts(machine.authorized_at + timedelta(seconds=60))
        self.assertFalse(machine.relay.is_energized)
        self.assertIs(machine.state, EdgeState.CLOSING)

        machine = FuelEdgeMachine(config=config)
        machine.apply(EdgeEvent.ASSIGN, module_id="module-01", site_id="site-01")
        machine.present_credential("nfc-01")
        machine.authorize(normal_access())
        pulse_at = datetime.now(timezone.utc)
        machine.record_k24_pulse(count=10, at=pulse_at)
        self.assertIsNone(
            machine.check_timeouts(
                pulse_at + timedelta(seconds=39, milliseconds=999)
            )
        )
        machine.check_timeouts(pulse_at + timedelta(seconds=40))
        self.assertFalse(machine.relay.is_energized)
        self.assertEqual(machine.audit[-1].metadata["pulses"], 10)

    def test_confirmed_k24_fault_disables_inactivity_cut(self) -> None:
        machine = assigned_machine()
        machine.present_credential("nfc-01")
        machine.authorize(normal_access())
        pulse_at = datetime.now(timezone.utc)
        machine.record_k24_pulse(at=pulse_at)
        machine.apply(EdgeEvent.TELEMETRY_FAULT, sensor="K24", reason="circuit_open")
        result = machine.check_timeouts(pulse_at + timedelta(minutes=10))
        self.assertIsNone(result)
        self.assertTrue(machine.relay.is_energized)

    def test_pulses_without_authorized_transaction_are_critical(self) -> None:
        machine = assigned_machine()
        record = machine.record_k24_pulse(count=2, incident_id="UF-test")
        self.assertEqual(record.metadata["reason"], "unauthorized_flow")
        self.assertEqual(record.metadata["incident_id"], "UF-test")
        self.assertIn("detected_at", record.metadata)
        self.assertTrue(record.metadata["critical"])
        self.assertFalse(machine.relay.is_energized)

    def test_control_fault_always_deenergizes(self) -> None:
        machine = assigned_machine()
        machine.present_credential("nfc-01")
        machine.authorize(normal_access())
        machine.apply(EdgeEvent.CONTROL_FAULT, reason="validator_offline")
        self.assertFalse(machine.relay.is_energized)
        self.assertIs(machine.state, EdgeState.FAULT)

    def test_invalid_transition_while_energized_fails_safe(self) -> None:
        machine = assigned_machine()
        machine.present_credential("nfc-01")
        machine.authorize(normal_access())
        with self.assertRaises(InvalidTransition):
            machine.apply(EdgeEvent.CLOSE_CONFIRMED)
        self.assertFalse(machine.relay.is_energized)
        self.assertIs(machine.state, EdgeState.FAULT)

    def test_reset_requires_healthy_control_chain(self) -> None:
        machine = assigned_machine()
        machine.apply(EdgeEvent.CONTROL_FAULT, reason="test")
        with self.assertRaises(ValueError):
            machine.apply(EdgeEvent.RESET)
        machine.apply(EdgeEvent.RESET, control_chain_healthy=True)
        self.assertIs(machine.state, EdgeState.LOCKED)

    def test_assignment_requires_identity(self) -> None:
        with self.assertRaises(ValueError):
            FuelEdgeMachine().apply(EdgeEvent.ASSIGN)
