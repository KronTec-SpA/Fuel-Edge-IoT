import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from threading import Event, Thread
from time import monotonic

from fuel_edge.access import AccessContext, AccessDecision
from fuel_edge.domain import EdgeEvent, EdgeState, FuelEdgeMachine
from fuel_edge.relay import MemoryPumpRelay
from fuel_edge.rfid import (
    EquipmentEvidence,
    MemoryCredentialRepository,
    RfidAuthorizationService,
    RfidCredential,
    RfidProof,
    RfidValidator,
    build_rfid_response,
)
from fuel_edge.service import FuelEdgeService
from fuel_edge.storage import EventStore


def valid_access() -> AccessContext:
    return AccessContext(
        credential_id="nfc-01",
        operator_id="operator-01",
        credential_active=True,
        operator_active=True,
        equipment_id="tractor-01",
        equipment_active=True,
        equipment_present=True,
        equipment_authenticated=True,
        association_active=True,
        assignment_valid_until=datetime.now(timezone.utc) + timedelta(days=1),
    )


class FuelEdgeServiceTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary_directory = tempfile.TemporaryDirectory()
        self.store = EventStore(Path(self.temporary_directory.name) / "edge.db")
        self.relay = MemoryPumpRelay()
        self.machine = FuelEdgeMachine(relay=self.relay)
        self.service = FuelEdgeService(
            self.machine,
            self.store,
            pulses_per_liter=100,
            telemetry_session_id="telemetry-test-session",
        )
        self.service.assign("module-01", "site-01")

    def tearDown(self) -> None:
        self.store.close()
        self.temporary_directory.cleanup()

    def test_authorization_and_cut_are_audited_as_one_transaction(self) -> None:
        self.service.present_credential("nfc-01")
        authorization = self.service.authorize(valid_access())
        transaction_id = authorization.metadata["transaction_id"]
        self.assertTrue(self.relay.is_energized)

        self.service.record_k24_pulse(count=250)
        # El total de balance ya debe ser durable antes del cierre del despacho.
        self.assertEqual(self.store.inventory_pulses(), 250)
        self.service.apply(EdgeEvent.NFC_REMOVED, reason="nfc_removed")

        row = self.store.connection.execute(
            "SELECT status, close_reason, pulses, liters FROM transactions WHERE id = ?",
            (transaction_id,),
        ).fetchone()
        self.assertEqual(row, ("closed", "nfc_removed", 250, 2.5))
        self.assertFalse(self.relay.is_energized)
        self.assertIs(self.machine.state, EdgeState.CLOSING)
        self.assertGreaterEqual(len(self.store.pending()), 5)

        confirmation = self.service.tick()

        self.assertIsNotNone(confirmation)
        self.assertIs(confirmation.event, EdgeEvent.CLOSE_CONFIRMED)
        self.assertIs(self.machine.state, EdgeState.LOCKED)

    def test_sub_threshold_liter_stays_open_for_start_window_and_becomes_pump_enablement(self) -> None:
        self.service.present_credential("nfc-01")
        self.service.authorize(valid_access())
        started_at = self.machine.authorized_at
        self.assertIsNotNone(started_at)
        pulse_at = started_at + timedelta(seconds=1)

        self.service.record_k24_pulse(count=11, at=pulse_at)

        self.assertIsNone(self.service.tick(pulse_at + timedelta(seconds=20)))
        self.assertTrue(self.relay.is_energized)
        self.assertEqual(self.store.pending(("web/fuel-movement",)), [])

        closed = self.service.tick(started_at + timedelta(seconds=60))

        self.assertIsNotNone(closed)
        self.assertIs(closed.event, EdgeEvent.FLOW_STOPPED)
        movement = self.store.pending(("web/fuel-movement",))[0][2]
        self.assertEqual(movement["liters"], 0.11)
        self.assertEqual(movement["classification"], "pump_enablement")
        self.assertIn("Habilitación de bomba", movement["detail"])

    def test_threshold_liter_is_promoted_with_all_pulses_when_dispensing_continues(self) -> None:
        self.service.present_credential("nfc-01")
        self.service.authorize(valid_access())
        started_at = self.machine.authorized_at
        self.assertIsNotNone(started_at)

        self.service.record_k24_pulse(count=11, at=started_at + timedelta(seconds=1))
        self.assertIsNone(self.service.tick(started_at + timedelta(seconds=30)))
        self.service.record_k24_pulse(count=1, at=started_at + timedelta(seconds=31))
        self.assertIsNone(self.service.tick(started_at + timedelta(seconds=70)))
        self.service.tick(started_at + timedelta(seconds=71))

        movement = self.store.pending(("web/fuel-movement",))[0][2]
        self.assertEqual(movement["liters"], 0.12)
        self.assertEqual(movement["pulses"], 12)
        self.assertEqual(movement["classification"], "standard")

    def test_short_pause_is_kept_in_the_same_load_until_40_seconds(self) -> None:
        self.service.present_credential("nfc-01")
        self.service.authorize(valid_access())
        started_at = self.machine.authorized_at
        self.assertIsNotNone(started_at)
        first_pulse_at = started_at + timedelta(seconds=1)

        self.service.record_k24_pulse(count=250, at=first_pulse_at)
        self.assertIsNone(self.service.tick(first_pulse_at + timedelta(seconds=20)))

        second_pulse_at = first_pulse_at + timedelta(seconds=30)
        self.service.record_k24_pulse(count=125, at=second_pulse_at)
        self.assertIsNone(self.service.tick(second_pulse_at + timedelta(seconds=39)))
        closed = self.service.tick(second_pulse_at + timedelta(seconds=40))

        self.assertIsNotNone(closed)
        self.assertIs(closed.event, EdgeEvent.FLOW_STOPPED)
        movements = self.store.pending(("web/fuel-movement",))
        self.assertEqual(len(movements), 1)
        self.assertEqual(movements[0][2]["pulses"], 375)
        self.assertEqual(movements[0][2]["liters"], 3.75)

    def test_relay_test_completes_through_tick_and_is_audited(self) -> None:
        outcome: list[object] = []
        worker = Thread(
            target=lambda: outcome.append(
                self.service.run_relay_test("relay-test-01", duration_seconds=25)
            )
        )
        worker.start()
        deadline = monotonic() + 1
        while self.machine.state is not EdgeState.RELAY_TESTING and monotonic() < deadline:
            Event().wait(0.005)
        self.assertIs(self.machine.state, EdgeState.RELAY_TESTING)
        self.assertTrue(self.relay.is_energized)

        self.service.tick(self.machine.relay_test_deadline)
        worker.join(1)

        self.assertFalse(worker.is_alive())
        self.assertTrue(outcome[0].success)
        self.assertFalse(self.relay.is_energized)
        self.assertIs(self.machine.state, EdgeState.LOCKED)
        events = [
            row[0]
            for row in self.store.connection.execute(
                "SELECT event FROM audit_log ORDER BY id"
            ).fetchall()
        ]
        self.assertEqual(
            events,
            ["assign", "relay_test_started", "relay_test_finished"],
        )
        transaction = self.store.connection.execute(
            """SELECT duration_seconds,status,close_reason
            FROM pump_test_transactions WHERE id='relay-test-01'"""
        ).fetchone()
        self.assertEqual(transaction, (25, "completed", None))

    def test_validator_disconnect_does_not_interrupt_pump_test(self) -> None:
        outcome: list[object] = []
        worker = Thread(
            target=lambda: outcome.append(
                self.service.run_relay_test("relay-test-validator-free", duration_seconds=30)
            )
        )
        worker.start()
        deadline = monotonic() + 1
        while self.machine.state is not EdgeState.RELAY_TESTING and monotonic() < deadline:
            Event().wait(0.005)

        self.service.apply(EdgeEvent.VALIDATOR_LINK_LOST, reason="mqtt_disconnected")

        self.assertIs(self.machine.state, EdgeState.RELAY_TESTING)
        self.assertTrue(self.relay.is_energized)
        self.service.tick(self.machine.relay_test_deadline)
        worker.join(1)
        self.assertTrue(outcome[0].success)

    def test_k24_flow_aborts_relay_test_before_requested_time(self) -> None:
        outcome: list[object] = []
        worker = Thread(
            target=lambda: outcome.append(self.service.run_relay_test("relay-test-02"))
        )
        worker.start()
        deadline = monotonic() + 1
        while self.machine.state is not EdgeState.RELAY_TESTING and monotonic() < deadline:
            Event().wait(0.005)

        record = self.service.record_k24_pulse(count=1)
        worker.join(1)

        self.assertIsNotNone(record)
        self.assertIs(record.event, EdgeEvent.RELAY_TEST_ABORTED)
        self.assertFalse(outcome[0].success)
        self.assertEqual(outcome[0].error, "k24_flow_detected")
        self.assertFalse(self.relay.is_energized)
        transaction = self.store.connection.execute(
            """SELECT status,close_reason FROM pump_test_transactions
            WHERE id='relay-test-02'"""
        ).fetchone()
        self.assertEqual(transaction, ("interrupted", "k24_flow_detected"))
        alerts = self.store.pending(("web/alert",))
        self.assertEqual(len(alerts), 1)
        self.assertIn("interrumpida", alerts[0][2]["title"].lower())

    def test_denied_access_never_opens_transaction_or_relay(self) -> None:
        self.service.present_credential("nfc-01")
        denied = valid_access()
        denied = AccessContext(
            **{
                field: getattr(denied, field)
                for field in denied.__dataclass_fields__
                if field != "equipment_present"
            },
            equipment_present=False,
        )
        self.service.authorize(denied)
        count = self.store.connection.execute("SELECT count(*) FROM transactions").fetchone()[0]
        self.assertEqual(count, 0)
        self.assertFalse(self.relay.is_energized)

    def test_tank_level_is_queued_for_durable_web_delivery(self) -> None:
        event_id = self.service.record_tank_level(
            1432.5, "2026-08-10T12:30:00+00:00", calibration_id="manufacturer-curve-v1"
        )
        event = next(item for item in self.store.pending() if item[0] == event_id)
        self.assertEqual(event[1], "web/level-reading")
        self.assertEqual(event[2]["levelLiters"], 1432.5)
        self.assertEqual(event[2]["telemetrySessionId"], "telemetry-test-session")
        self.assertEqual(event[2]["calibrationId"], "manufacturer-curve-v1")

    def test_unauthorized_k24_flow_is_alerted_and_closed_as_a_dispatch(self) -> None:
        started_at = datetime.now(timezone.utc)

        first = self.service.record_k24_pulse(count=2, at=started_at)
        repeated = self.service.record_k24_pulse(
            count=391,
            at=started_at + timedelta(seconds=1),
        )

        self.assertIsNotNone(first)
        self.assertEqual(first.metadata["reason"], "unauthorized_flow")
        self.assertIsNone(repeated)
        active = self.store.connection.execute(
            "SELECT id,pulses,status FROM unauthorized_flow_incidents"
        ).fetchone()
        self.assertEqual(active[1:], (393, "active"))
        immediate_alerts = self.store.pending(("web/alert",))
        self.assertEqual(len(immediate_alerts), 1)
        self.assertIn("Conteo en curso", immediate_alerts[0][2]["detail"])

        self.assertIsNone(self.service.tick(started_at + timedelta(seconds=40)))

        incident = self.store.connection.execute(
            "SELECT pulses,liters,status FROM unauthorized_flow_incidents"
        ).fetchone()
        self.assertEqual(incident, (393, None, "active"))

        self.assertIsNone(self.service.tick(started_at + timedelta(seconds=41)))

        incident = self.store.connection.execute(
            "SELECT pulses,liters,status FROM unauthorized_flow_incidents"
        ).fetchone()
        self.assertEqual(incident, (393, 3.93, "closed"))
        movements = self.store.pending(("web/fuel-movement",))
        self.assertEqual(len(movements), 1)
        self.assertEqual(movements[0][2]["id"], active[0])
        self.assertEqual(movements[0][2]["liters"], 3.93)
        self.assertTrue(movements[0][2]["unauthorized"])
        self.assertIsNone(movements[0][2]["operatorId"])
        final_alerts = self.store.pending(("web/alert",))
        self.assertEqual(len(final_alerts), 1)
        self.assertIn("393 pulsos (3,9 L)", final_alerts[0][2]["detail"])

    def test_active_unauthorized_flow_is_recovered_after_restart(self) -> None:
        started_at = datetime.now(timezone.utc)
        self.service.record_k24_pulse(count=1, at=started_at)

        recovered_machine = FuelEdgeMachine(relay=MemoryPumpRelay())
        recovered = FuelEdgeService(
            recovered_machine,
            self.store,
            pulses_per_liter=100,
        )
        recovered.tick(started_at + timedelta(seconds=21))
        self.assertEqual(
            self.store.connection.execute(
                "SELECT status FROM unauthorized_flow_incidents"
            ).fetchone(),
            ("active",),
        )
        self.assertEqual(self.store.pending(("web/fuel-movement",)), [])

        recovered.tick(started_at + timedelta(seconds=60))

        row = self.store.connection.execute(
            "SELECT pulses,liters,status FROM unauthorized_flow_incidents"
        ).fetchone()
        self.assertEqual(row, (1, 0.01, "closed"))
        movement = self.store.pending(("web/fuel-movement",))[0][2]
        self.assertEqual(movement["liters"], 0.01)
        self.assertEqual(movement["classification"], "pump_enablement")
        final_alert = self.store.pending(("web/alert",))[0][2]
        self.assertEqual(final_alert["severity"], "info")
        self.assertEqual(final_alert["priority"], "low")

    def test_runtime_status_is_coalesced_instead_of_growing_forever(self) -> None:
        self.service.report_validator_hardware(False)
        first = self.service.publish_status()
        second = self.service.publish_status()
        self.assertEqual(first, second)
        events = self.store.pending(("web/status",))
        self.assertEqual(len(events), 1)
        self.assertEqual(events[0][2]["moduleId"], "module-01")
        self.assertTrue(events[0][2]["validatorOnline"])
        self.assertFalse(events[0][2]["nfcReady"])
        self.assertTrue(events[0][2]["k24Enabled"])
        self.assertTrue(events[0][2]["tankLevelEnabled"])
        self.assertEqual(events[0][2]["telemetrySessionId"], "telemetry-test-session")

    def test_storage_failure_after_authorization_cuts_relay_and_faults(self) -> None:
        self.service.present_credential("nfc-01")
        self.store.close()

        with self.assertRaisesRegex(RuntimeError, "relé desenergizado"):
            self.service.authorize(valid_access())
        self.assertFalse(self.relay.is_energized)
        self.assertIs(self.machine.state, EdgeState.FAULT)

        # Evita cerrar por segunda vez en tearDown.
        self.store = EventStore(Path(self.temporary_directory.name) / "reopened.db")

    def test_rfid_path_routes_through_persistent_service(self) -> None:
        secret = bytes(range(32))
        repository = MemoryCredentialRepository(
            {"card-01": RfidCredential("card-01", "operator-01", secret)}
        )
        rfid = RfidAuthorizationService(RfidValidator(repository))

        class Reader:
            def authenticate(self, challenge):
                return RfidProof(
                    "card-01",
                    challenge,
                    build_rfid_response(secret, "card-01", challenge),
                )

        outcome = rfid.handle_presentation(
            self.service,
            Reader(),
            equipment=EquipmentEvidence(
                equipment_id="tractor-01",
                active=True,
                present=True,
                authenticated=True,
                association_active=True,
                assignment_valid_until=datetime.now(timezone.utc) + timedelta(days=1),
            ),
        )

        self.assertTrue(outcome.authorized)
        self.assertTrue(self.relay.is_energized)
        transactions = self.store.connection.execute(
            "SELECT count(*) FROM transactions"
        ).fetchone()[0]
        self.assertEqual(transactions, 1)

    def test_mqtt_authorization_and_main_tick_are_serialized(self) -> None:
        started = Event()
        release = Event()
        tick_completed = Event()
        errors: list[Exception] = []

        class BlockingPolicy:
            def evaluate(self, context):
                started.set()
                release.wait(1.0)
                return AccessDecision(True)

        self.machine.access_policy = BlockingPolicy()
        self.service.present_credential("nfc-01")

        def authorize() -> None:
            try:
                self.service.authorize(valid_access())
            except Exception as exc:
                errors.append(exc)

        def tick() -> None:
            try:
                self.service.tick()
                tick_completed.set()
            except Exception as exc:
                errors.append(exc)

        authorization_worker = Thread(target=authorize)
        tick_worker = Thread(target=tick)
        authorization_worker.start()
        self.assertTrue(started.wait(1.0))
        tick_worker.start()
        self.assertFalse(tick_completed.wait(0.05))
        release.set()
        authorization_worker.join(1.0)
        tick_worker.join(1.0)

        self.assertEqual(errors, [])
        self.assertTrue(tick_completed.is_set())
