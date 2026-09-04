from __future__ import annotations

import json
import unittest
from datetime import datetime, timezone
from unittest.mock import patch

from fuel_edge.rfid import RfidProof
from fuel_edge.validator_link import (
    CredentialPresenceUpdate,
    EquipmentPresenceUpdate,
    MAX_MESSAGE_BYTES,
    RemoteEquipmentObservation,
    ValidatorDecision,
    ValidatorMessageCodec,
    ValidatorPresentation,
    ValidatorProtocolError,
)


class ValidatorMessageCodecTests(unittest.TestCase):
    def test_complete_wire_conversation_round_trips(self) -> None:
        presentation = ValidatorPresentation(
            validator_id="validator-01",
            session_id="session-01",
            occurred_at=datetime(2026, 8, 9, 12, tzinfo=timezone.utc),
            equipment=RemoteEquipmentObservation(
                equipment_id="tractor-01",
                present=True,
                authenticated=True,
                rssi=-47,
                module_id="equipment-module-0001",
            ),
        )
        decoded_presentation = ValidatorMessageCodec.decode_presentation(
            ValidatorMessageCodec.encode_presentation(presentation)
        )
        self.assertEqual(decoded_presentation, presentation)

        challenge = bytes(range(32))
        validator_id, session_id, decoded_challenge = (
            ValidatorMessageCodec.decode_challenge(
                ValidatorMessageCodec.encode_challenge(
                    "validator-01", "session-01", challenge
                )
            )
        )
        self.assertEqual((validator_id, session_id), ("validator-01", "session-01"))
        self.assertEqual(decoded_challenge, challenge)

        proof = RfidProof("card-01", challenge, b"p" * 32)
        validator_id, session_id, decoded_proof = ValidatorMessageCodec.decode_proof(
            ValidatorMessageCodec.encode_proof(
                "validator-01", "session-01", proof
            )
        )
        self.assertEqual(validator_id, "validator-01")
        self.assertEqual(session_id, "session-01")
        self.assertEqual(decoded_proof, proof)

        decision = ValidatorDecision(
            validator_id="validator-01",
            session_id="session-01",
            allowed=True,
            state="authorized",
            transaction_id="transaction-01",
        )
        self.assertEqual(
            ValidatorMessageCodec.decode_decision(
                ValidatorMessageCodec.encode_decision(decision)
            ),
            decision,
        )

        presence = EquipmentPresenceUpdate(
            validator_id="validator-01",
            session_id="session-01",
            module_id="equipment-module-0001",
            equipment_id="tractor-01",
            present=False,
            authenticated=False,
            lost_for_seconds=20,
            rssi=-72,
            occurred_at=datetime(2026, 8, 9, 12, 1, tzinfo=timezone.utc),
        )
        self.assertEqual(
            ValidatorMessageCodec.decode_equipment_presence(
                ValidatorMessageCodec.encode_equipment_presence(presence)
            ),
            presence,
        )

        credential_presence = CredentialPresenceUpdate(
            validator_id="validator-01",
            session_id="session-01",
            credential_id="card-01",
            present=False,
            authenticated=False,
            absent_for_milliseconds=300,
            occurred_at=datetime(2026, 8, 9, 12, 1, tzinfo=timezone.utc),
        )
        self.assertEqual(
            ValidatorMessageCodec.decode_credential_presence(
                ValidatorMessageCodec.encode_credential_presence(
                    credential_presence
                )
            ),
            credential_presence,
        )

    def test_presence_update_rejects_negative_durations(self) -> None:
        with self.assertRaises(ValueError):
            EquipmentPresenceUpdate(
                validator_id="validator-01",
                session_id="session-01",
                equipment_id="tractor-01",
                present=False,
                authenticated=False,
                lost_for_seconds=-1,
            )
        with self.assertRaises(ValueError):
            CredentialPresenceUpdate(
                validator_id="validator-01",
                session_id="session-01",
                credential_id="card-01",
                present=False,
                authenticated=False,
                absent_for_milliseconds=-1,
            )
        with self.assertRaises(ValueError):
            CredentialPresenceUpdate(
                validator_id="validator-01",
                session_id="session-01",
                credential_id="card-01",
                present=True,
                authenticated=False,
            )

    def test_unknown_protocol_version_is_rejected(self) -> None:
        payload = json.dumps(
            {
                "version": 99,
                "type": "rfid.proof",
                "validator_id": "validator-01",
                "session_id": "session-01",
                "credential_present": False,
            }
        ).encode()
        with self.assertRaises(ValidatorProtocolError):
            ValidatorMessageCodec.decode_proof(payload)

    def test_topic_injection_identifiers_are_rejected(self) -> None:
        with self.assertRaises(ValueError):
            ValidatorMessageCodec.encode_challenge(
                "validator/+/attack", "session-01", bytes(32)
            )

    def test_oversized_and_invalid_base64_messages_are_rejected(self) -> None:
        with self.assertRaises(ValidatorProtocolError):
            ValidatorMessageCodec.decode_proof(b"x" * (MAX_MESSAGE_BYTES + 1))
        payload = json.dumps(
            {
                "version": 1,
                "type": "rfid.proof",
                "validator_id": "validator-01",
                "session_id": "session-01",
                "credential_present": True,
                "credential_id": "card-01",
                "challenge": "not-base64!",
                "response": "not-base64!",
            }
        ).encode()
        with self.assertRaises(ValidatorProtocolError):
            ValidatorMessageCodec.decode_proof(payload)

    def test_excessive_json_nesting_is_normalized_as_protocol_error(self) -> None:
        # CPython documenta RecursionError para JSON con demasiada profundidad.
        # Debe tratarse como entrada remota inválida, nunca escapar al loop MQTT.
        with patch(
            "fuel_edge.validator_link.json.loads",
            side_effect=RecursionError("JSON demasiado profundo"),
        ):
            with self.assertRaises(ValidatorProtocolError):
                ValidatorMessageCodec.decode_proof(b"{}")


if __name__ == "__main__":
    unittest.main()
