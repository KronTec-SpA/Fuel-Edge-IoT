from __future__ import annotations

import tempfile
import unittest
from re import fullmatch
from datetime import datetime, timedelta, timezone
from pathlib import Path

from fuel_edge.application import FuelEdgeApplication, MemoryAuthorizationDirectory
from fuel_edge.domain import EdgeState, FuelEdgeMachine
from fuel_edge.manual_mode import ManualModeCoordinator, ManualModeSchedule
from fuel_edge.rfid import (
    MemoryCredentialRepository,
    RfidAuthorizationService,
    RfidCredential,
    RfidValidator,
)
from fuel_edge.service import FuelEdgeService
from fuel_edge.storage import EventStore
from fuel_edge.validator_link import (
    CredentialPresenceUpdate,
    InMemoryValidatorTransport,
    SimulatedCard,
    ValidatorPresentation,
)


SECRET = bytes(range(32))


class ManualModeTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.store = EventStore(Path(self.temporary.name) / "edge.db")
        self.machine = FuelEdgeMachine()
        self.service = FuelEdgeService(
            self.machine,
            self.store,
            pulses_per_liter=100,
        )
        self.service.assign("rpi-01", "fundo-01")

    def tearDown(self) -> None:
        self.store.close()
        self.temporary.cleanup()

    def test_manual_mode_keeps_relay_closed_and_segments_consumption_by_tag(self) -> None:
        now = datetime.now(timezone.utc)
        self.service.start_manual_mode(
            "manual-01",
            ends_at=now + timedelta(hours=1),
            at=now,
        )
        self.assertIs(self.machine.state, EdgeState.MANUAL_MODE)
        self.assertTrue(self.machine.relay.is_energized)

        self.service.record_k24_pulse(100)
        self.service.assign_manual_operator("tag-01", "operator-01")
        self.service.record_k24_pulse(250)
        self.service.clear_manual_operator()
        self.assertTrue(self.machine.relay.is_energized)
        self.service.record_k24_pulse(50)
        self.service.stop_manual_mode("cancelled")

        self.assertIs(self.machine.state, EdgeState.LOCKED)
        self.assertFalse(self.machine.relay.is_energized)
        segments = self.store.connection.execute(
            """SELECT operator_id,pulses,liters,status FROM manual_mode_segments
            ORDER BY opened_at,id"""
        ).fetchall()
        self.assertEqual(len(segments), 3)
        tagged = next(row for row in segments if row[0] == "operator-01")
        self.assertEqual(tagged, ("operator-01", 250, 2.5, "closed"))
        movements = self.store.pending(("web/fuel-movement",))
        tagged_movement = next(
            payload for _, _, payload in movements
            if payload.get("operatorId") == "operator-01"
        )
        self.assertTrue(tagged_movement["manualMode"])
        self.assertEqual(tagged_movement["liters"], 2.5)
        self.assertIsNotNone(fullmatch(r"[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}", tagged_movement["id"]))
        self.assertEqual(tagged_movement["reference"], tagged_movement["id"])
        self.assertEqual(tagged_movement["manualModeSessionId"], "manual-01")
        self.assertEqual(self.store.pending(("web/alert",)), [])

    def test_adoption_session_preserves_the_best_evidence_reached(self) -> None:
        now = datetime.now(timezone.utc)
        self.service.update_technology_adoption_policy("assisted", 2)
        self.service.start_manual_mode(
            "adoption-session-01",
            ends_at=now + timedelta(hours=1),
            at=now,
            purpose="adoption_assisted",
        )
        self.service.assign_manual_operator(
            "tag-01",
            "operator-01",
            equipment_id="tractor-01",
            authorization_evidence="full",
            adoption_stage="assisted",
        )
        self.service.record_k24_pulse(150, at=now + timedelta(seconds=1))
        self.service.tick(now + timedelta(seconds=41))

        movement = self.store.pending(("web/fuel-movement",))[0][2]
        self.assertEqual(movement["authorizationEvidence"], "full")
        self.assertEqual(movement["adoptionStage"], "assisted")
        self.assertEqual(movement["equipmentId"], "tractor-01")
        self.assertTrue(movement["assistedMode"])
        session = self.store.connection.execute(
            "SELECT purpose FROM manual_mode_sessions WHERE id=?",
            ("adoption-session-01",),
        ).fetchone()
        self.assertEqual(session, ("adoption_assisted",))

    def test_assisted_session_separates_liters_after_mim_loss(self) -> None:
        now = datetime.now(timezone.utc)
        self.service.update_technology_adoption_policy("assisted", 2)
        self.service.start_manual_mode(
            "adoption-session-mim-loss",
            ends_at=now + timedelta(hours=1),
            at=now,
            purpose="adoption_assisted",
        )
        self.service.assign_manual_operator(
            "tag-01",
            "operator-01",
            equipment_id="tractor-01",
            authorization_evidence="full",
            adoption_stage="assisted",
        )
        self.service.record_k24_pulse(50, at=now + timedelta(seconds=1))

        self.service.downgrade_manual_equipment()
        self.service.record_k24_pulse(100, at=now + timedelta(seconds=2))
        self.service.tick(now + timedelta(seconds=42))

        movements = [payload for _, _, payload in self.store.pending(("web/fuel-movement",))]
        self.assertEqual(len(movements), 2)
        self.assertEqual(movements[0]["authorizationEvidence"], "full")
        self.assertEqual(movements[0]["liters"], 0.5)
        self.assertEqual(movements[1]["authorizationEvidence"], "rfid_only")
        self.assertEqual(movements[1]["liters"], 1.0)
        self.assertEqual(movements[1]["equipmentIssue"], "ble_presence_lost")

    def test_k24_inactivity_merges_short_pause_and_then_segments_manual_loads(self) -> None:
        now = datetime.now(timezone.utc)
        self.service.start_manual_mode(
            "manual-loads",
            ends_at=now + timedelta(hours=1),
            at=now,
        )
        self.service.assign_manual_operator("tag-01", "operator-01")

        first_pulse_at = now + timedelta(seconds=1)
        self.service.record_k24_pulse(250, at=first_pulse_at)
        self.assertIsNone(self.service.tick(first_pulse_at + timedelta(seconds=20)))
        self.assertEqual(self.store.pending(("web/fuel-movement",)), [])

        second_pulse_at = first_pulse_at + timedelta(seconds=30)
        self.service.record_k24_pulse(125, at=second_pulse_at)
        self.service.tick(second_pulse_at + timedelta(seconds=39))
        self.assertEqual(self.store.pending(("web/fuel-movement",)), [])

        self.service.tick(second_pulse_at + timedelta(seconds=40))

        self.assertIs(self.machine.state, EdgeState.MANUAL_MODE)
        self.assertTrue(self.machine.relay.is_energized)
        first_movement = self.store.pending(("web/fuel-movement",))[0][2]
        self.assertEqual(first_movement["liters"], 3.75)
        self.assertEqual(first_movement["operatorId"], "operator-01")
        self.assertEqual(first_movement["closeReason"], "k24_inactivity")

        third_pulse_at = second_pulse_at + timedelta(seconds=50)
        self.service.record_k24_pulse(50, at=third_pulse_at)
        self.service.tick(third_pulse_at + timedelta(seconds=40))

        movements = self.store.pending(("web/fuel-movement",))
        self.assertEqual(len(movements), 2)
        self.assertNotEqual(movements[0][2]["id"], movements[1][2]["id"])
        self.assertEqual(movements[1][2]["liters"], 0.5)
        self.assertEqual(movements[1][2]["operatorId"], "operator-01")
        active_segment = self.store.connection.execute(
            """SELECT operator_id,pulses,status FROM manual_mode_segments
            WHERE status='active'"""
        ).fetchone()
        self.assertEqual(active_segment, ("operator-01", 0, "active"))

    def test_untagged_manual_load_is_published_after_k24_inactivity(self) -> None:
        now = datetime.now(timezone.utc)
        self.service.start_manual_mode(
            "manual-untagged-load",
            ends_at=now + timedelta(hours=1),
            at=now,
        )
        pulse_at = now + timedelta(seconds=1)
        self.service.record_k24_pulse(80, at=pulse_at)

        self.service.tick(pulse_at + timedelta(seconds=40))

        movement = self.store.pending(("web/fuel-movement",))[0][2]
        self.assertEqual(movement["liters"], 0.8)
        self.assertIsNone(movement["operatorId"])
        self.assertTrue(movement["manualMode"])
        self.assertIs(self.machine.state, EdgeState.MANUAL_MODE)
        self.assertTrue(self.machine.relay.is_energized)

    def test_manual_microflow_waits_for_start_window_and_becomes_pump_enablement(self) -> None:
        now = datetime.now(timezone.utc)
        self.service.start_manual_mode(
            "manual-pump-enablement",
            ends_at=now + timedelta(hours=1),
            at=now,
        )
        pulse_at = now + timedelta(seconds=1)
        self.service.record_k24_pulse(11, at=pulse_at)

        self.assertIsNone(self.service.tick(pulse_at + timedelta(seconds=20)))
        self.assertEqual(self.store.pending(("web/fuel-movement",)), [])
        self.assertTrue(self.machine.relay.is_energized)

        self.assertIsNone(self.service.tick(pulse_at + timedelta(seconds=60)))

        movement = self.store.pending(("web/fuel-movement",))[0][2]
        self.assertEqual(movement["liters"], 0.11)
        self.assertEqual(movement["classification"], "pump_enablement")
        self.assertTrue(movement["manualMode"])
        self.assertIs(self.machine.state, EdgeState.MANUAL_MODE)

    def test_manual_microflow_becomes_classic_dispatch_when_more_fuel_arrives(self) -> None:
        now = datetime.now(timezone.utc)
        self.service.start_manual_mode(
            "manual-promoted-dispatch",
            ends_at=now + timedelta(hours=1),
            at=now,
        )
        self.service.record_k24_pulse(11, at=now + timedelta(seconds=1))
        self.service.record_k24_pulse(1, at=now + timedelta(seconds=25))

        self.service.tick(now + timedelta(seconds=65))

        movement = self.store.pending(("web/fuel-movement",))[0][2]
        self.assertEqual(movement["liters"], 0.12)
        self.assertEqual(movement["pulses"], 12)
        self.assertEqual(movement["classification"], "standard")

    def test_presented_tag_changes_attribution_without_opening_relay(self) -> None:
        credentials = MemoryCredentialRepository()
        credentials.add(RfidCredential("tag-01", "operator-01", SECRET))
        transport = InMemoryValidatorTransport(
            {"validator-01": SimulatedCard("tag-01", SECRET)}
        )
        application = FuelEdgeApplication(
            control=self.service,
            rfid=RfidAuthorizationService(RfidValidator(credentials)),
            transport=transport,
            directory=MemoryAuthorizationDirectory(),
            validator_id="validator-01",
        )
        now = datetime.now(timezone.utc)
        self.service.start_manual_mode(
            "manual-02",
            ends_at=now + timedelta(hours=1),
            at=now,
        )

        decision = application.process_presentation(
            ValidatorPresentation("validator-01", "session-01")
        )
        self.assertTrue(decision.allowed)
        self.assertEqual(decision.state, "manual_mode")
        self.service.record_k24_pulse(125)
        released = application.process_credential_presence(
            CredentialPresenceUpdate(
                validator_id="validator-01",
                session_id="session-01",
                credential_id="tag-01",
                present=False,
                authenticated=False,
                absent_for_milliseconds=300,
            )
        )

        self.assertIsNotNone(released)
        self.assertIs(self.machine.state, EdgeState.MANUAL_MODE)
        self.assertTrue(self.machine.relay.is_energized)
        tagged = self.store.connection.execute(
            """SELECT operator_id,pulses,liters FROM manual_mode_segments
            WHERE operator_id='operator-01'"""
        ).fetchone()
        self.assertEqual(tagged, ("operator-01", 125, 1.25))

    def test_rejected_tag_returns_consumption_to_untagged_segment(self) -> None:
        credentials = MemoryCredentialRepository()
        credentials.add(RfidCredential("tag-01", "operator-01", SECRET))
        transport = InMemoryValidatorTransport(
            {"validator-01": SimulatedCard("tag-01", SECRET)}
        )
        application = FuelEdgeApplication(
            control=self.service,
            rfid=RfidAuthorizationService(RfidValidator(credentials)),
            transport=transport,
            directory=MemoryAuthorizationDirectory(),
            validator_id="validator-01",
        )
        now = datetime.now(timezone.utc)
        self.service.start_manual_mode(
            "manual-invalid-tag",
            ends_at=now + timedelta(hours=1),
            at=now,
        )
        self.assertTrue(
            application.process_presentation(
                ValidatorPresentation("validator-01", "session-valid")
            ).allowed
        )
        self.service.record_k24_pulse(50)

        transport.cards["validator-01"] = SimulatedCard("tag-unknown", SECRET)
        rejected = application.process_presentation(
            ValidatorPresentation("validator-01", "session-invalid")
        )
        self.assertFalse(rejected.allowed)
        self.assertIs(self.machine.state, EdgeState.MANUAL_MODE)
        self.assertTrue(self.machine.relay.is_energized)
        self.service.record_k24_pulse(25)
        self.service.stop_manual_mode("cancelled")

        segments = self.store.connection.execute(
            """SELECT operator_id,pulses FROM manual_mode_segments
            WHERE pulses>0 ORDER BY opened_at,id"""
        ).fetchall()
        self.assertEqual(segments, [("operator-01", 50), (None, 25)])


class FakeManualModeWeb:
    def __init__(self, schedule: ManualModeSchedule) -> None:
        self.schedule = schedule
        self.states: list[tuple[str, str, str | None]] = []

    def current_schedule(self) -> ManualModeSchedule | None:
        return self.schedule

    def report_state(self, schedule_id: str, state: str, error: str | None = None) -> None:
        self.states.append((schedule_id, state, error))


class ManualModeCoordinatorTests(unittest.TestCase):
    def test_reconciles_start_and_end_of_scheduled_window(self) -> None:
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        store = EventStore(Path(temporary.name) / "edge.db")
        self.addCleanup(store.close)
        machine = FuelEdgeMachine()
        service = FuelEdgeService(machine, store, pulses_per_liter=100)
        service.assign("rpi-01", "fundo-01")
        now = datetime.now(timezone.utc)
        schedule = ManualModeSchedule(
            "manual-03",
            now - timedelta(minutes=1),
            now + timedelta(hours=1),
            True,
            "scheduled",
        )
        web = FakeManualModeWeb(schedule)
        coordinator = ManualModeCoordinator(web, service)

        self.assertTrue(coordinator.refresh())
        self.assertIs(machine.state, EdgeState.MANUAL_MODE)
        self.assertEqual(web.states[-1][:2], ("manual-03", "active"))

        web.schedule = ManualModeSchedule(
            "manual-03",
            schedule.start_at,
            schedule.end_at,
            False,
            "active",
        )
        self.assertTrue(coordinator.refresh())
        self.assertIs(machine.state, EdgeState.LOCKED)
        self.assertEqual(web.states[-1][:2], ("manual-03", "completed"))

    def test_service_restart_closes_previous_segment_and_resumes_same_schedule(self) -> None:
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        store = EventStore(Path(temporary.name) / "edge.db")
        self.addCleanup(store.close)
        now = datetime.now(timezone.utc)
        first_machine = FuelEdgeMachine()
        first = FuelEdgeService(first_machine, store, pulses_per_liter=100)
        first.assign("rpi-01", "fundo-01")
        first.start_manual_mode("manual-restart", ends_at=now + timedelta(hours=1), at=now)
        first.assign_manual_operator("tag-01", "operator-01")
        first.record_k24_pulse(75)

        restarted_machine = FuelEdgeMachine()
        restarted = FuelEdgeService(restarted_machine, store, pulses_per_liter=100)
        restarted.assign("rpi-01", "fundo-01")
        restarted.start_manual_mode(
            "manual-restart",
            ends_at=now + timedelta(hours=1),
            at=now + timedelta(seconds=2),
        )

        self.assertIs(restarted_machine.state, EdgeState.MANUAL_MODE)
        recovered = store.connection.execute(
            """SELECT status,close_reason,pulses,liters FROM manual_mode_segments
            WHERE operator_id='operator-01'"""
        ).fetchone()
        self.assertEqual(recovered, ("closed", "edge_restarted", 75, 0.75))
        session = store.connection.execute(
            "SELECT status,close_reason FROM manual_mode_sessions WHERE id='manual-restart'"
        ).fetchone()
        self.assertEqual(session, ("active", None))


if __name__ == "__main__":
    unittest.main()
