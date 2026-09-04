from __future__ import annotations

import json
import unittest
from unittest.mock import patch

from fuel_edge.main import _sync_equipment_registry
from fuel_edge.validator_link import ValidatorTransportError


class DisconnectingDistributor:
    def sync_if_changed(self) -> None:
        raise ValidatorTransportError("MQTT se desconectó antes de publicar")


class MainResilienceTests(unittest.TestCase):
    def test_registry_publish_race_is_logged_for_retry_without_escaping(self) -> None:
        with patch("fuel_edge.main.print") as log:
            _sync_equipment_registry(DisconnectingDistributor())  # type: ignore[arg-type]

        payload = json.loads(log.call_args.args[0])
        self.assertEqual(payload["component"], "equipment_registry")
        self.assertEqual(payload["status"], "retrying")
        self.assertEqual(payload["error"], "ValidatorTransportError")


if __name__ == "__main__":
    unittest.main()
