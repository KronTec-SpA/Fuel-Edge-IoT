import tempfile
import unittest
from unittest.mock import patch
from datetime import datetime, timezone
from pathlib import Path
from urllib.error import URLError

from fuel_edge.nfc_enrollment import (
    EnrolledCredentialStore,
    NfcCredentialSnapshotEntry,
    NfcEnrollmentCommand,
    NfcEnrollmentCoordinator,
)
from fuel_edge.rfid import MemoryCredentialRepository
from fuel_edge.rfid import RfidCredential, RfidProof, build_rfid_response
from fuel_edge.validator_link import (
    InMemoryValidatorTransport,
    SimulatedCard,
    ValidatorPresentation,
)


SECRET = bytes(range(32))


class FakeWeb:
    def __init__(self) -> None:
        self.command = NfcEnrollmentCommand("command-01", "operator-01")
        self.results: list[dict[str, object]] = []

    def next_command(self):
        return self.command

    def result(self, command_id, **result):
        self.results.append({"command_id": command_id, **result})


class SequencedWeb(FakeWeb):
    def __init__(self, commands):
        super().__init__()
        self.commands = iter(commands)

    def next_command(self):
        return next(self.commands)


class RetryableResultWeb(FakeWeb):
    def __init__(self) -> None:
        super().__init__()
        self.failures = 1

    def result(self, command_id, **result):
        if self.failures:
            self.failures -= 1
            raise URLError("respuesta local perdida")
        super().result(command_id, **result)
        self.command = None


class IntermittentCardTransport:
    def __init__(self) -> None:
        self.attempts = 0

    def exchange_proof(
        self, validator_id, session_id, challenge, timeout_seconds, *, purpose
    ):
        self.attempts += 1
        if self.attempts < 3:
            return None
        credential_id = "nfc-fa2f0707"
        return RfidProof(
            credential_id,
            challenge,
            build_rfid_response(SECRET, credential_id, challenge),
        )


class IdentificationWeb(FakeWeb):
    def __init__(self) -> None:
        super().__init__()
        self.command = NfcEnrollmentCommand(
            "identify-01", None, "identification"
        )
        self.identifications: list[dict[str, object]] = []

    def identification_result(self, command_id, **result):
        self.identifications.append({"command_id": command_id, **result})
        self.command = None


class SnapshotWeb(FakeWeb):
    def __init__(self, snapshot) -> None:
        super().__init__()
        self.command = None
        self.snapshot = snapshot

    def credential_snapshot(self):
        return self.snapshot


class NfcEnrollmentTests(unittest.TestCase):
    def test_web_inventory_reconciles_assignments_and_deletions_on_edge(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            repository = MemoryCredentialRepository()
            repository.add(RfidCredential("manual-card", "operator-local", SECRET))
            repository.add(RfidCredential("nfc-stale000", "operator-stale", SECRET))
            store = EnrolledCredentialStore(Path(directory) / "credentials.json")
            web = SnapshotWeb((
                NfcCredentialSnapshotEntry(
                    "nfc-11111111", "operator-01", True, True, False
                ),
                NfcCredentialSnapshotEntry(
                    "nfc-22222222", None, True, False, False
                ),
            ))
            coordinator = NfcEnrollmentCoordinator(web, repository, store, SECRET)

            coordinator.refresh()

            self.assertIsNone(repository.get("nfc-stale000"))
            self.assertEqual(
                repository.get("manual-card").operator_id, "operator-local"
            )
            assigned = repository.get("nfc-11111111")
            self.assertEqual(assigned.operator_id, "operator-01")
            self.assertTrue(assigned.credential_active)
            self.assertTrue(assigned.operator_active)
            unassigned = repository.get("nfc-22222222")
            self.assertTrue(unassigned.credential_active)
            self.assertFalse(unassigned.operator_active)
            self.assertTrue(unassigned.operator_id.startswith("rfid-unassigned:"))

            web.snapshot = ()
            coordinator.refresh()

            self.assertIsNone(repository.get("nfc-11111111"))
            self.assertIsNone(repository.get("nfc-22222222"))
            self.assertIsNotNone(repository.get("manual-card"))
            restored = MemoryCredentialRepository()
            store.load_into(restored)
            self.assertIsNone(restored.get("nfc-11111111"))
            self.assertIsNone(restored.get("nfc-22222222"))

    def test_identifies_a_credential_without_enrolling_or_changing_it(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            repository = MemoryCredentialRepository()
            store = EnrolledCredentialStore(Path(directory) / "credentials.json")
            web = IdentificationWeb()
            coordinator = NfcEnrollmentCoordinator(web, repository, store, SECRET)
            coordinator.refresh()
            transport = InMemoryValidatorTransport(
                {"validator-01": SimulatedCard("nfc-fa2f0707", SECRET)}
            )
            presentation = ValidatorPresentation(
                validator_id="validator-01",
                session_id="session-identify",
                equipment=None,
                occurred_at=datetime.now(timezone.utc),
            )

            decision = coordinator.process_presentation(presentation, transport, 1.0)

            self.assertEqual(decision.reason, "identification_completed")
            self.assertEqual(
                web.identifications[0]["credential_id"], "nfc-fa2f0707"
            )
            self.assertEqual(repository.credentials, {})
            self.assertFalse(store.path.exists())

    def test_refresh_drops_cancelled_command_and_accepts_the_next_request(self) -> None:
        first = NfcEnrollmentCommand("command-01", "operator-01")
        second = NfcEnrollmentCommand("command-02", "operator-02")
        web = SequencedWeb([first, None, second])
        announcements: list[bool] = []
        with tempfile.TemporaryDirectory() as directory:
            coordinator = NfcEnrollmentCoordinator(
                web,
                MemoryCredentialRepository(),
                EnrolledCredentialStore(Path(directory) / "credentials.json"),
                SECRET,
                on_window_change=announcements.append,
            )

            self.assertEqual(coordinator.refresh(), first)
            self.assertIsNone(coordinator.refresh())
            self.assertEqual(coordinator.refresh(), second)

        self.assertEqual(announcements, [True, False, True])

    def test_closed_window_is_not_republished_after_the_refresh_interval(self) -> None:
        announcements: list[bool] = []
        with tempfile.TemporaryDirectory() as directory:
            coordinator = NfcEnrollmentCoordinator(
                SequencedWeb([None, None]),
                MemoryCredentialRepository(),
                EnrolledCredentialStore(Path(directory) / "credentials.json"),
                SECRET,
                on_window_change=announcements.append,
            )
            with patch(
                "fuel_edge.nfc_enrollment.monotonic", side_effect=(0.0, 30.0)
            ):
                coordinator.refresh()
                coordinator.refresh()

        self.assertEqual(announcements, [False])

    def test_enrolls_unique_physical_credential_and_persists_it(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            repository = MemoryCredentialRepository()
            store = EnrolledCredentialStore(Path(directory) / "credentials.json")
            web = FakeWeb()
            coordinator = NfcEnrollmentCoordinator(web, repository, store, SECRET)
            coordinator.refresh()
            transport = InMemoryValidatorTransport(
                {"validator-01": SimulatedCard("nfc-fa2f0707", SECRET)}
            )
            presentation = ValidatorPresentation(
                validator_id="validator-01",
                session_id="session-01",
                equipment=None,
                occurred_at=datetime.now(timezone.utc),
            )

            decision = coordinator.process_presentation(presentation, transport, 1.0)

            self.assertIsNotNone(decision)
            self.assertEqual(decision.reason, "enrollment_completed")
            credential = repository.get("nfc-fa2f0707")
            self.assertIsNotNone(credential)
            self.assertEqual(credential.operator_id, "operator-01")
            self.assertEqual(web.results[0]["credential_id"], "nfc-fa2f0707")
            self.assertEqual(store.path.stat().st_mode & 0o777, 0o600)

            restored = MemoryCredentialRepository()
            store.load_into(restored)
            self.assertEqual(restored.get("nfc-fa2f0707").operator_id, "operator-01")

    def test_reassigns_local_credential_orphaned_by_deleted_operator(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            repository = MemoryCredentialRepository()
            repository.add(
                RfidCredential("nfc-fa2f0707", "operator-deleted", SECRET)
            )
            store = EnrolledCredentialStore(Path(directory) / "credentials.json")
            web = FakeWeb()
            web.command = NfcEnrollmentCommand(
                "command-02",
                "operator-recreated",
                unavailable_credential_ids=(),
            )
            coordinator = NfcEnrollmentCoordinator(web, repository, store, SECRET)
            coordinator.refresh()
            transport = InMemoryValidatorTransport(
                {"validator-01": SimulatedCard("nfc-fa2f0707", SECRET)}
            )
            presentation = ValidatorPresentation(
                validator_id="validator-01",
                session_id="session-recreated",
                equipment=None,
                occurred_at=datetime.now(timezone.utc),
            )

            decision = coordinator.process_presentation(presentation, transport, 1.0)

            self.assertEqual(decision.reason, "enrollment_completed")
            self.assertEqual(
                repository.get("nfc-fa2f0707").operator_id,
                "operator-recreated",
            )
            restored = MemoryCredentialRepository()
            store.load_into(restored)
            self.assertEqual(
                restored.get("nfc-fa2f0707").operator_id,
                "operator-recreated",
            )

    def test_rejects_credential_reserved_by_another_current_operator(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            repository = MemoryCredentialRepository()
            repository.add(RfidCredential("nfc-fa2f0707", "operator-01", SECRET))
            store = EnrolledCredentialStore(Path(directory) / "credentials.json")
            web = FakeWeb()
            web.command = NfcEnrollmentCommand(
                "command-02",
                "operator-02",
                unavailable_credential_ids=("nfc-fa2f0707",),
            )
            coordinator = NfcEnrollmentCoordinator(web, repository, store, SECRET)
            coordinator.refresh()
            transport = InMemoryValidatorTransport(
                {"validator-01": SimulatedCard("nfc-fa2f0707", SECRET)}
            )
            presentation = ValidatorPresentation(
                validator_id="validator-01",
                session_id="session-conflict",
                equipment=None,
                occurred_at=datetime.now(timezone.utc),
            )

            decision = coordinator.process_presentation(presentation, transport, 1.0)

            self.assertEqual(decision.reason, "credential_already_assigned")
            self.assertEqual(repository.get("nfc-fa2f0707").operator_id, "operator-01")
            self.assertEqual(
                web.results[0]["error"],
                "La credencial ya pertenece a otro operador.",
            )

    def test_master_enrollment_atomically_disables_the_previous_master(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            repository = MemoryCredentialRepository()
            repository.add(
                RfidCredential(
                    "nfc-aaaaaaaa",
                    "operator-old",
                    SECRET,
                    is_master=True,
                )
            )
            store = EnrolledCredentialStore(Path(directory) / "credentials.json")
            web = FakeWeb()
            web.command = NfcEnrollmentCommand(
                "command-master",
                "operator-new",
                is_master=True,
                deactivated_credential_ids=("nfc-aaaaaaaa",),
            )
            coordinator = NfcEnrollmentCoordinator(web, repository, store, SECRET)
            coordinator.refresh()
            transport = InMemoryValidatorTransport(
                {"validator-01": SimulatedCard("nfc-bbbbbbbb", SECRET)}
            )
            presentation = ValidatorPresentation(
                validator_id="validator-01",
                session_id="session-master",
                equipment=None,
                occurred_at=datetime.now(timezone.utc),
            )

            decision = coordinator.process_presentation(presentation, transport, 1.0)

            self.assertEqual(decision.reason, "enrollment_completed")
            previous = repository.get("nfc-aaaaaaaa")
            current = repository.get("nfc-bbbbbbbb")
            self.assertFalse(previous.credential_active)
            self.assertTrue(previous.is_master)
            self.assertTrue(current.credential_active)
            self.assertTrue(current.is_master)
            self.assertEqual(current.operator_id, "operator-new")
            self.assertEqual(
                sum(
                    credential.is_master and credential.credential_active
                    for credential in repository.credentials.values()
                ),
                1,
            )

            restored = MemoryCredentialRepository()
            store.load_into(restored)
            self.assertFalse(restored.get("nfc-aaaaaaaa").credential_active)
            self.assertTrue(restored.get("nfc-bbbbbbbb").is_master)

    def test_keyboard_simulation_cannot_be_enrolled_as_a_physical_card(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            repository = MemoryCredentialRepository()
            coordinator = NfcEnrollmentCoordinator(
                FakeWeb(),
                repository,
                EnrolledCredentialStore(Path(directory) / "credentials.json"),
                SECRET,
            )
            coordinator.refresh()
            transport = InMemoryValidatorTransport(
                {"validator-01": SimulatedCard("card-01", SECRET)}
            )
            presentation = ValidatorPresentation(
                validator_id="validator-01",
                session_id="session-02",
                equipment=None,
                occurred_at=datetime.now(timezone.utc),
            )

            decision = coordinator.process_presentation(presentation, transport, 1.0)

            self.assertEqual(decision.reason, "enrollment_unsupported_card")
            self.assertEqual(repository.credentials, {})

    def test_retries_transient_card_reads_before_rejecting_the_session(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            repository = MemoryCredentialRepository()
            coordinator = NfcEnrollmentCoordinator(
                FakeWeb(),
                repository,
                EnrolledCredentialStore(Path(directory) / "credentials.json"),
                SECRET,
            )
            coordinator.refresh()
            transport = IntermittentCardTransport()
            presentation = ValidatorPresentation(
                validator_id="validator-01",
                session_id="session-retry",
                equipment=None,
                occurred_at=datetime.now(timezone.utc),
            )

            decision = coordinator.process_presentation(presentation, transport, 1.0)

            self.assertEqual(transport.attempts, 3)
            self.assertEqual(decision.reason, "enrollment_completed")
            self.assertIsNotNone(repository.get("nfc-fa2f0707"))

    def test_retries_web_completion_without_requiring_the_card_again(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            web = RetryableResultWeb()
            repository = MemoryCredentialRepository()
            coordinator = NfcEnrollmentCoordinator(
                web,
                repository,
                EnrolledCredentialStore(Path(directory) / "credentials.json"),
                SECRET,
            )
            coordinator.refresh()
            transport = InMemoryValidatorTransport(
                {"validator-01": SimulatedCard("nfc-fa2f0707", SECRET)}
            )
            presentation = ValidatorPresentation(
                validator_id="validator-01",
                session_id="session-sync",
                equipment=None,
                occurred_at=datetime.now(timezone.utc),
            )

            decision = coordinator.process_presentation(presentation, transport, 1.0)
            refreshed = coordinator.refresh()

            self.assertEqual(decision.reason, "enrollment_pending_sync")
            self.assertIsNone(refreshed)
            self.assertEqual(web.results[0]["credential_id"], "nfc-fa2f0707")
