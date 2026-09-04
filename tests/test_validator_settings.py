from __future__ import annotations

import unittest

from fuel_edge.validator_settings import (
    BluetoothSettings,
    ValidatorSettingsCoordinator,
)


class FakeWeb:
    def __init__(self) -> None:
        self.settings = BluetoothSettings(-68, 2)
        self.applied_settings: list[BluetoothSettings] = []
        self.observations: list[tuple[str, int]] = []

    def current(self) -> BluetoothSettings:
        return self.settings

    def applied(self, settings: BluetoothSettings) -> None:
        self.applied_settings.append(settings)

    def observation(self, module_id: str, rssi: int) -> None:
        self.observations.append((module_id, rssi))


class FakeTransport:
    def __init__(self) -> None:
        self.published: list[tuple[str, int, int]] = []
        self.handler = None

    def publish_runtime_config(self, validator_id: str, rssi_threshold: int, revision: int) -> None:
        self.published.append((validator_id, rssi_threshold, revision))

    def set_config_status_handler(self, handler) -> None:
        self.handler = handler


class ValidatorSettingsTests(unittest.TestCase):
    def test_publishes_setting_and_records_validator_ack(self) -> None:
        web = FakeWeb()
        transport = FakeTransport()
        coordinator = ValidatorSettingsCoordinator(web, transport, "validator-01")

        self.assertEqual(coordinator.refresh(), BluetoothSettings(-68, 2))
        self.assertEqual(transport.published, [("validator-01", -68, 2)])
        transport.handler("validator-01", -68, 2)
        self.assertEqual(web.applied_settings, [BluetoothSettings(-68, 2)])

    def test_records_measured_rssi_for_calibration_evidence(self) -> None:
        web = FakeWeb()
        coordinator = ValidatorSettingsCoordinator(web, FakeTransport(), "validator-01")

        coordinator.record_observation("equipment-module-0001", -72)
        coordinator.record_observation("equipment-module-0001", -68)

        self.assertEqual(
            web.observations,
            [("equipment-module-0001", -72), ("equipment-module-0001", -68)],
        )

    def test_rejects_unsafe_threshold(self) -> None:
        with self.assertRaises(ValueError):
            BluetoothSettings(-20, 1)


if __name__ == "__main__":
    unittest.main()
