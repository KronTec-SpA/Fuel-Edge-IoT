from __future__ import annotations

import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

from fuel_edge.application import (
    EquipmentAuthorizationRecord,
    FuelEdgeApplication,
    MemoryAuthorizationDirectory,
)
from fuel_edge.domain import EdgeState, FuelEdgeMachine
from fuel_edge.rfid import (
    MemoryCredentialRepository,
    RfidAuthorizationService,
    RfidCredential,
    RfidProof,
    RfidValidator,
)
from fuel_edge.service import FuelEdgeService
from fuel_edge.storage import EventStore
from fuel_edge.validator_link import (
    CredentialPresenceUpdate,
    EquipmentPresenceUpdate,
    InMemoryValidatorTransport,
    RemoteEquipmentObservation,
    SimulatedCard,
    ValidatorPresentation,
)


SECRET = bytes(range(32))


def build_application(
    directory: MemoryAuthorizationDirectory | None = None,
    transport: InMemoryValidatorTransport | None = None,
) -> tuple[
    FuelEdgeApplication,
    EventStore,
    InMemoryValidatorTransport,
    tempfile.TemporaryDirectory,
]:
    temporary = tempfile.TemporaryDirectory()
    store = EventStore(Path(temporary.name) / "edge.db")
    machine = FuelEdgeMachine()
    control = FuelEdgeService(machine, store, pulses_per_liter=100.0)
    control.assign("module-01", "site-01")
    credentials = MemoryCredentialRepository()
    credentials.add(RfidCredential("card-01", "operator-01", SECRET))
    transport = transport or InMemoryValidatorTransport(
        {"validator-01": SimulatedCard("card-01", SECRET)}
    )
    directory = directory or MemoryAuthorizationDirectory(
        equipment={
            "tractor-01": EquipmentAuthorizationRecord(
                "tractor-01",
                assignment_valid_until=datetime.now(timezone.utc) + timedelta(days=1),
            )
        },
        associations={("operator-01", "tractor-01")},
    )
    application = FuelEdgeApplication(
        control=control,
        rfid=RfidAuthorizationService(RfidValidator(credentials)),
        transport=transport,
        directory=directory,
        validator_id="validator-01",
    )
    return application, store, transport, temporary


def presentation(session_id: str = "session-01") -> ValidatorPresentation:
    return ValidatorPresentation(
        validator_id="validator-01",
        session_id=session_id,
        equipment=RemoteEquipmentObservation(
            equipment_id="tractor-01",
            present=True,
            authenticated=True,
            rssi=-45,
        ),
    )


class FuelEdgeApplicationTests(unittest.TestCase):
    def test_end_to_end_validator_conversation_authorizes_and_persists(self) -> None:
        application, store, transport, temporary = build_application()
        self.addCleanup(temporary.cleanup)
        self.addCleanup(store.close)

        decision = application.process_presentation(presentation())

        self.assertTrue(decision.allowed)
        self.assertIs(application.machine.state, EdgeState.AUTHORIZED)
        self.assertTrue(application.machine.relay.is_energized)
        self.assertEqual(transport.decisions[-1], decision)
        message_types = [
            json_type(payload) for payload in transport.wire_messages
        ]
        self.assertEqual(
            message_types,
            ["rfid.challenge", "rfid.proof", "rfid.decision"],
        )
        transaction = store.connection.execute(
            "SELECT operator_id, equipment_id, status FROM transactions"
        ).fetchone()
        self.assertEqual(transaction, ("operator-01", "tractor-01", "authorized"))
        events = [
            row[0]
            for row in store.connection.execute(
                "SELECT event FROM audit_log ORDER BY id"
            ).fetchall()
        ]
        self.assertEqual(
            events,
            ["assign", "nfc_presented", "authorization_granted"],
        )

    def test_rpi_not_validator_decides_operator_equipment_association(self) -> None:
        directory = MemoryAuthorizationDirectory(
            equipment={
                "tractor-01": EquipmentAuthorizationRecord("tractor-01", active=True)
            },
            associations=set(),
        )
        application, store, transport, temporary = build_application(directory=directory)
        self.addCleanup(temporary.cleanup)
        self.addCleanup(store.close)

        decision = application.process_presentation(presentation())

        self.assertFalse(decision.allowed)
        self.assertEqual(decision.reason, "association_inactive")
        self.assertFalse(application.machine.relay.is_energized)
        self.assertIs(application.machine.state, EdgeState.LOCKED)

    def test_tampered_remote_proof_is_rejected(self) -> None:
        transport = InMemoryValidatorTransport(
            {"validator-01": SimulatedCard("card-01", SECRET)},
            proof_mutator=lambda proof: RfidProof(
                proof.credential_id, proof.challenge, bytes(32)
            ),
        )
        application, store, transport, temporary = build_application(transport=transport)
        self.addCleanup(temporary.cleanup)
        self.addCleanup(store.close)

        decision = application.process_presentation(presentation())

        self.assertFalse(decision.allowed)
        self.assertEqual(decision.reason, "authentication_failed")
        self.assertFalse(application.machine.relay.is_energized)

    def test_replayed_session_is_rejected_without_cutting_active_load(self) -> None:
        application, store, transport, temporary = build_application()
        self.addCleanup(temporary.cleanup)
        self.addCleanup(store.close)
        first = application.process_presentation(presentation())

        replay = application.process_presentation(presentation())

        self.assertTrue(first.allowed)
        self.assertFalse(replay.allowed)
        self.assertEqual(replay.reason, "replayed_session")
        self.assertIs(application.machine.state, EdgeState.AUTHORIZED)
        self.assertTrue(application.machine.relay.is_energized)

    def test_new_session_during_active_load_returns_busy_without_fault(self) -> None:
        application, store, transport, temporary = build_application()
        self.addCleanup(temporary.cleanup)
        self.addCleanup(store.close)
        application.process_presentation(presentation())

        decision = application.process_presentation(presentation("session-02"))

        self.assertFalse(decision.allowed)
        self.assertEqual(decision.reason, "point_busy")
        self.assertIs(application.machine.state, EdgeState.AUTHORIZED)
        self.assertTrue(application.machine.relay.is_energized)

    def test_authenticated_prelink_presence_updates_map_without_authorizing(self) -> None:
        application, store, transport, temporary = build_application()
        self.addCleanup(temporary.cleanup)
        self.addCleanup(store.close)
        observations: list[tuple[str, int]] = []
        application.on_equipment_observation = (
            lambda module_id, rssi: observations.append((module_id, rssi))
        )

        record = application.process_equipment_presence(
            EquipmentPresenceUpdate(
                validator_id="validator-01",
                session_id="prelink-session-01",
                module_id="equipment-module-0001",
                equipment_id="tractor-01",
                present=True,
                authenticated=True,
                rssi=-51,
            )
        )

        self.assertIsNone(record)
        self.assertEqual(observations, [("equipment-module-0001", -51)])
        self.assertIs(application.machine.state, EdgeState.LOCKED)
        self.assertFalse(application.machine.relay.is_energized)

    def test_confirmed_correlated_ble_loss_cuts_active_load(self) -> None:
        application, store, transport, temporary = build_application()
        self.addCleanup(temporary.cleanup)
        self.addCleanup(store.close)
        application.process_presentation(presentation())

        too_early = application.process_equipment_presence(
            EquipmentPresenceUpdate(
                validator_id="validator-01",
                session_id="session-01",
                module_id="equipment-module-0001",
                equipment_id="tractor-01",
                present=False,
                authenticated=False,
                lost_for_seconds=19,
            )
        )
        self.assertIsNone(too_early)
        self.assertTrue(application.machine.relay.is_energized)

        record = application.process_equipment_presence(
            EquipmentPresenceUpdate(
                validator_id="validator-01",
                session_id="session-01",
                module_id="equipment-module-0001",
                equipment_id="tractor-01",
                present=False,
                authenticated=False,
                lost_for_seconds=20,
                rssi=-80,
            )
        )

        self.assertIsNotNone(record)
        self.assertIs(application.machine.state, EdgeState.CLOSING)
        self.assertFalse(application.machine.relay.is_energized)
        transaction = store.connection.execute(
            "SELECT status, close_reason FROM transactions"
        ).fetchone()
        self.assertEqual(transaction, ("closed", "ble_presence_lost"))

    def test_rfid_stage_turns_mim_loss_into_evidence_downgrade(self) -> None:
        application, store, transport, temporary = build_application()
        self.addCleanup(temporary.cleanup)
        self.addCleanup(store.close)
        application.control.update_technology_adoption_policy("rfid_only", 2)
        application.process_presentation(presentation())

        record = application.process_equipment_presence(
            EquipmentPresenceUpdate(
                validator_id="validator-01",
                session_id="session-01",
                module_id="equipment-module-0001",
                equipment_id="tractor-01",
                present=False,
                authenticated=False,
                lost_for_seconds=20,
                rssi=-80,
            )
        )

        self.assertIsNotNone(record)
        self.assertIs(application.machine.state, EdgeState.AUTHORIZED)
        self.assertTrue(application.machine.relay.is_energized)
        transaction = store.connection.execute(
            """SELECT status,equipment_id,authorization_evidence,equipment_issue
            FROM transactions"""
        ).fetchone()
        self.assertEqual(
            transaction,
            ("authorized", None, "rfid_only", "equipment_presence_lost"),
        )

    def test_uncorrelated_ble_loss_is_ignored(self) -> None:
        application, store, transport, temporary = build_application()
        self.addCleanup(temporary.cleanup)
        self.addCleanup(store.close)
        application.process_presentation(presentation())

        record = application.process_equipment_presence(
            EquipmentPresenceUpdate(
                validator_id="validator-01",
                session_id="different-session",
                equipment_id="tractor-01",
                present=False,
                authenticated=False,
                lost_for_seconds=60,
            )
        )

        self.assertIsNone(record)
        self.assertIs(application.machine.state, EdgeState.AUTHORIZED)
        self.assertTrue(application.machine.relay.is_energized)

    def test_confirmed_rfid_removal_cuts_active_load_after_debounce(self) -> None:
        application, store, transport, temporary = build_application()
        self.addCleanup(temporary.cleanup)
        self.addCleanup(store.close)
        application.process_presentation(presentation())

        too_early = application.process_credential_presence(
            CredentialPresenceUpdate(
                validator_id="validator-01",
                session_id="session-01",
                credential_id="card-01",
                present=False,
                authenticated=False,
                absent_for_milliseconds=299,
            )
        )
        self.assertIsNone(too_early)
        self.assertTrue(application.machine.relay.is_energized)

        record = application.process_credential_presence(
            CredentialPresenceUpdate(
                validator_id="validator-01",
                session_id="session-01",
                credential_id="card-01",
                present=False,
                authenticated=False,
                absent_for_milliseconds=300,
            )
        )

        self.assertIsNotNone(record)
        self.assertIs(application.machine.state, EdgeState.CLOSING)
        self.assertFalse(application.machine.relay.is_energized)
        transaction = store.connection.execute(
            "SELECT status, close_reason FROM transactions"
        ).fetchone()
        self.assertEqual(transaction, ("closed", "nfc_removed"))

    def test_authenticated_rfid_heartbeat_renews_short_presence_lease(self) -> None:
        application, store, transport, temporary = build_application()
        self.addCleanup(temporary.cleanup)
        self.addCleanup(store.close)
        clock = [0.0]
        application.monotonic_clock = lambda: clock[0]
        application.process_presentation(presentation())

        clock[0] = 1.0
        application.process_credential_presence(
            CredentialPresenceUpdate(
                validator_id="validator-01",
                session_id="session-01",
                credential_id="card-01",
                present=True,
                authenticated=True,
            )
        )
        clock[0] = 3.499
        self.assertIsNone(application.check_credential_presence_timeout())
        self.assertTrue(application.machine.relay.is_energized)

        clock[0] = 3.5
        record = application.check_credential_presence_timeout()

        self.assertIsNotNone(record)
        self.assertIs(application.machine.state, EdgeState.CLOSING)
        self.assertFalse(application.machine.relay.is_energized)
        transaction = store.connection.execute(
            "SELECT status, close_reason FROM transactions"
        ).fetchone()
        self.assertEqual(transaction, ("closed", "credential_presence_timeout"))

    def test_uncorrelated_rfid_removal_is_ignored(self) -> None:
        application, store, transport, temporary = build_application()
        self.addCleanup(temporary.cleanup)
        self.addCleanup(store.close)
        application.process_presentation(presentation())

        record = application.process_credential_presence(
            CredentialPresenceUpdate(
                validator_id="validator-01",
                session_id="different-session",
                credential_id="card-01",
                present=False,
                authenticated=False,
                absent_for_milliseconds=500,
            )
        )

        self.assertIsNone(record)
        self.assertIs(application.machine.state, EdgeState.AUTHORIZED)
        self.assertTrue(application.machine.relay.is_energized)

    def test_validator_disconnect_cuts_active_load_immediately(self) -> None:
        application, store, transport, temporary = build_application()
        self.addCleanup(temporary.cleanup)
        self.addCleanup(store.close)
        application.process_presentation(presentation())

        application.process_validator_disconnect()

        self.assertIs(application.machine.state, EdgeState.CLOSING)
        self.assertFalse(application.machine.relay.is_energized)
        self.assertFalse(application.machine.validator_online)
        transaction = store.connection.execute(
            "SELECT status, close_reason FROM transactions"
        ).fetchone()
        self.assertEqual(transaction, ("closed", "validator_link_lost"))


def json_type(payload: bytes) -> str:
    import json

    return str(json.loads(payload)["type"])


if __name__ == "__main__":
    unittest.main()
