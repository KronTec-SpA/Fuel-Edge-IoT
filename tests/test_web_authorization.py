from __future__ import annotations

from datetime import timezone
import json
import unittest
from unittest.mock import MagicMock, patch
from urllib.error import URLError

from fuel_edge.config import WebSyncConfig
from fuel_edge.validator_link import RemoteEquipmentObservation
from fuel_edge.web_authorization import WebAuthorizationDirectory


class _Response:
    def __init__(self, payload: dict[str, object]) -> None:
        self._payload = json.dumps(payload).encode("utf-8")

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False

    def read(self, _limit: int) -> bytes:
        return self._payload


class WebAuthorizationDirectoryTests(unittest.TestCase):
    def setUp(self) -> None:
        self.directory = WebAuthorizationDirectory(
            WebSyncConfig(enabled=True), "s" * 32, "fundo-norte"
        )
        self.observation = RemoteEquipmentObservation(
            equipment_id="eq-001",
            module_id="xiao-001",
            present=True,
            authenticated=True,
        )

    @patch("fuel_edge.web_authorization.urlopen")
    def test_resolves_fundo_assignment_and_expiry(self, call: MagicMock) -> None:
        call.return_value = _Response({
            "equipment": {
                "active": True,
                "associationActive": True,
                "assignmentValidUntil": "2026-08-18T23:59:00.000Z",
            }
        })

        evidence = self.directory.resolve_equipment("operator-01", self.observation)

        self.assertIsNotNone(evidence)
        assert evidence is not None
        self.assertTrue(evidence.active)
        self.assertTrue(evidence.association_active)
        self.assertEqual(evidence.assignment_valid_until.tzinfo, timezone.utc)
        request = call.call_args.args[0]
        body = json.loads(request.data)
        self.assertEqual(body["siteId"], "fundo-norte")
        self.assertEqual(body["moduleId"], "xiao-001")
        self.assertEqual(request.get_header("X-edge-sensor-key"), "s" * 32)

    @patch("fuel_edge.web_authorization.urlopen", side_effect=URLError("offline"))
    def test_fails_closed_when_web_is_unavailable(self, _call: MagicMock) -> None:
        evidence = self.directory.resolve_equipment("operator-01", self.observation)

        self.assertIsNotNone(evidence)
        assert evidence is not None
        self.assertFalse(evidence.active)
        self.assertFalse(evidence.association_active)


if __name__ == "__main__":
    unittest.main()
