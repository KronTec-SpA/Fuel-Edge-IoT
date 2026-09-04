from __future__ import annotations

import unittest
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone

from fuel_edge.access import DenialReason
from fuel_edge.domain import EdgeEvent, EdgeState, FuelEdgeMachine
from fuel_edge.rfid import (
    EquipmentEvidence,
    MemoryCredentialRepository,
    RfidAuthenticationReason,
    RfidAuthorizationService,
    RfidCredential,
    RfidProof,
    RfidReaderError,
    RfidValidator,
    build_rfid_response,
)


SECRET = bytes(range(32))


@dataclass
class SecureTestReader:
    credential_id: str
    secret: bytes

    def authenticate(self, challenge: bytes) -> RfidProof:
        return RfidProof(
            credential_id=self.credential_id,
            challenge=challenge,
            response=build_rfid_response(self.secret, self.credential_id, challenge),
        )


@dataclass
class FixedProofReader:
    proof: RfidProof | None

    def authenticate(self, challenge: bytes) -> RfidProof | None:
        return self.proof


class BrokenReader:
    def authenticate(self, challenge: bytes) -> RfidProof:
        raise OSError("SPI disconnected")


def assigned_machine() -> FuelEdgeMachine:
    machine = FuelEdgeMachine()
    machine.apply(EdgeEvent.ASSIGN, module_id="module-01", site_id="site-01")
    return machine


def equipment(**overrides) -> EquipmentEvidence:
    values = {
        "equipment_id": "tractor-01",
        "active": True,
        "present": True,
        "authenticated": True,
        "association_active": True,
        "assignment_valid_until": datetime.now(timezone.utc) + timedelta(days=1),
    }
    values.update(overrides)
    return EquipmentEvidence(**values)


def service_for(credential: RfidCredential) -> RfidAuthorizationService:
    repository = MemoryCredentialRepository()
    repository.add(credential)
    return RfidAuthorizationService(RfidValidator(repository))


class RfidValidatorTests(unittest.TestCase):
    def test_valid_proof_and_equipment_authorize_relay(self) -> None:
        credential = RfidCredential("card-01", "operator-01", SECRET)
        service = service_for(credential)
        machine = assigned_machine()

        outcome = service.handle_presentation(
            machine,
            SecureTestReader("card-01", SECRET),
            equipment=equipment(),
        )

        self.assertTrue(outcome.authorized)
        self.assertIs(machine.state, EdgeState.AUTHORIZED)
        self.assertTrue(machine.relay.is_energized)
        self.assertEqual(machine.operator_id, "operator-01")
        self.assertEqual(machine.equipment_id, "tractor-01")

    def test_card_uid_without_valid_cryptographic_proof_is_rejected(self) -> None:
        credential = RfidCredential("card-01", "operator-01", SECRET)
        service = service_for(credential)
        machine = assigned_machine()
        invalid_proof = RfidProof("card-01", bytes(32), bytes(32))

        outcome = service.handle_presentation(machine, FixedProofReader(invalid_proof))

        self.assertFalse(outcome.authorized)
        self.assertIs(
            outcome.authentication.reason,
            RfidAuthenticationReason.MALFORMED_PRESENTATION,
        )
        self.assertIs(machine.state, EdgeState.LOCKED)
        self.assertFalse(machine.relay.is_energized)
        self.assertIs(outcome.audit_record.event, EdgeEvent.NFC_REJECTED)

    def test_wrong_key_is_rejected(self) -> None:
        credential = RfidCredential("card-01", "operator-01", SECRET)
        service = service_for(credential)
        machine = assigned_machine()

        outcome = service.handle_presentation(
            machine,
            SecureTestReader("card-01", b"x" * 32),
        )

        self.assertIs(
            outcome.authentication.reason,
            RfidAuthenticationReason.AUTHENTICATION_FAILED,
        )
        self.assertFalse(machine.relay.is_energized)

    def test_unknown_card_is_rejected_and_audited(self) -> None:
        service = service_for(RfidCredential("card-01", "operator-01", SECRET))
        machine = assigned_machine()

        outcome = service.handle_presentation(
            machine,
            SecureTestReader("unknown-card", b"z" * 32),
        )

        self.assertIs(outcome.authentication.reason, RfidAuthenticationReason.UNKNOWN_CREDENTIAL)
        self.assertEqual(outcome.audit_record.metadata["credential_id"], "unknown-card")
        self.assertFalse(machine.relay.is_energized)

    def test_replayed_proof_fails_against_fresh_challenge(self) -> None:
        old_challenge = b"a" * 32
        replayed = RfidProof(
            "card-01",
            old_challenge,
            build_rfid_response(SECRET, "card-01", old_challenge),
        )
        repository = MemoryCredentialRepository(
            {"card-01": RfidCredential("card-01", "operator-01", SECRET)}
        )
        validator = RfidValidator(repository, challenge_source=lambda size: b"b" * size)

        result = validator.authenticate(FixedProofReader(replayed))

        self.assertFalse(result.authenticated)
        self.assertIs(result.reason, RfidAuthenticationReason.MALFORMED_PRESENTATION)

    def test_inactive_credential_is_denied_by_access_policy(self) -> None:
        credential = RfidCredential(
            "card-01", "operator-01", SECRET, credential_active=False
        )
        service = service_for(credential)
        machine = assigned_machine()

        outcome = service.handle_presentation(
            machine,
            SecureTestReader("card-01", SECRET),
            equipment=equipment(),
        )

        self.assertTrue(outcome.authentication.authenticated)
        self.assertFalse(outcome.authorized)
        self.assertEqual(
            outcome.audit_record.metadata["reason"],
            str(DenialReason.CREDENTIAL_INACTIVE),
        )
        self.assertFalse(machine.relay.is_energized)

    def test_master_credential_authorizes_without_ble_equipment(self) -> None:
        credential = RfidCredential(
            "master-01", "manager-01", SECRET, is_master=True
        )
        service = service_for(credential)
        machine = assigned_machine()

        outcome = service.handle_presentation(
            machine,
            SecureTestReader("master-01", SECRET),
        )

        self.assertTrue(outcome.authorized)
        self.assertIsNone(machine.equipment_id)
        self.assertTrue(machine.relay.is_energized)

    def test_normal_credential_without_ble_equipment_is_denied(self) -> None:
        credential = RfidCredential("card-01", "operator-01", SECRET)
        service = service_for(credential)
        machine = assigned_machine()

        outcome = service.handle_presentation(
            machine,
            SecureTestReader("card-01", SECRET),
        )

        self.assertFalse(outcome.authorized)
        self.assertEqual(
            outcome.audit_record.metadata["reason"],
            str(DenialReason.EQUIPMENT_REQUIRED),
        )
        self.assertFalse(machine.relay.is_energized)

    def test_second_failed_attempt_in_five_minutes_requests_alert(self) -> None:
        service = service_for(RfidCredential("card-01", "operator-01", SECRET))
        bad_reader = SecureTestReader("card-01", b"x" * 32)
        start = datetime(2026, 8, 9, 12, tzinfo=timezone.utc)

        first = service.handle_presentation(assigned_machine(), bad_reader, now=start)
        second = service.handle_presentation(
            assigned_machine(), bad_reader, now=start + timedelta(minutes=4)
        )

        self.assertFalse(first.audit_record.metadata["alert_required"])
        self.assertTrue(second.audit_record.metadata["alert_required"])
        self.assertEqual(second.audit_record.metadata["failed_attempts_in_window"], 2)

    def test_no_card_does_not_change_machine_state(self) -> None:
        service = service_for(RfidCredential("card-01", "operator-01", SECRET))
        machine = assigned_machine()

        outcome = service.handle_presentation(machine, FixedProofReader(None))

        self.assertIsNone(outcome.audit_record)
        self.assertIs(machine.state, EdgeState.LOCKED)
        self.assertEqual(len(machine.audit), 1)

    def test_reader_failure_is_normalized_and_never_energizes_relay(self) -> None:
        service = service_for(RfidCredential("card-01", "operator-01", SECRET))
        machine = assigned_machine()

        with self.assertRaises(RfidReaderError):
            service.handle_presentation(machine, BrokenReader())

        self.assertIs(machine.state, EdgeState.LOCKED)
        self.assertFalse(machine.relay.is_energized)

    def test_secret_must_be_cryptographically_sized(self) -> None:
        with self.assertRaises(ValueError):
            RfidCredential("card-01", "operator-01", b"short")

    def test_malformed_reader_types_are_rejected_without_crashing(self) -> None:
        repository = MemoryCredentialRepository(
            {"card-01": RfidCredential("card-01", "operator-01", SECRET)}
        )
        validator = RfidValidator(repository)
        malformed = RfidProof("card-01", None, None)  # type: ignore[arg-type]

        result = validator.authenticate(FixedProofReader(malformed))

        self.assertFalse(result.authenticated)
        self.assertIs(result.reason, RfidAuthenticationReason.MALFORMED_PRESENTATION)

    def test_equipment_assignment_time_must_include_timezone(self) -> None:
        with self.assertRaises(ValueError):
            equipment(assignment_valid_until=datetime(2026, 8, 9, 12))


if __name__ == "__main__":
    unittest.main()
