from __future__ import annotations

import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
FIRMWARE = ROOT / "firmware" / "equipment_module" / "src" / "main.cpp"


def function_body(source: str, signature: str) -> str:
    start = source.index(signature)
    opening = source.index("{", start)
    depth = 0
    for index in range(opening, len(source)):
        if source[index] == "{":
            depth += 1
        elif source[index] == "}":
            depth -= 1
            if depth == 0:
                return source[opening + 1:index]
    raise AssertionError(f"función incompleta: {signature}")


class EquipmentFirmwareLifecycleTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.source = FIRMWARE.read_text(encoding="utf-8")

    def test_old_nvs_texts_do_not_mark_a_fresh_firmware_as_unified(self) -> None:
        body = function_body(self.source, "bool loadConfiguration()")
        self.assertIn('preferences.getBool("unified", false)', body)
        self.assertIn('preferences.getString("claimed_module", "")', body)
        self.assertIn("claim_schema == kClaimStateSchema", body)
        self.assertIn("claimed_module_id == EQUIPMENT_MODULE_ID", body)

    def test_signed_claim_commits_unification_marker_last(self) -> None:
        body = function_body(self.source, "bool applyClaimPacket(")
        equipment = body.index('preferences.putString("equipment_id"')
        unified = body.index('preferences.putBool("unified", true)')
        self.assertLess(equipment, unified)

    def test_unclaimed_module_uses_wifi_and_not_ble(self) -> None:
        body = function_body(self.source, "void setup()")
        wifi_branch = body.index("if (!claimed || enrollment_ack_pending)")
        wifi_start = body.index("startWifiEnrollment()", wifi_branch)
        ble_start = body.index("startBle()", wifi_branch)
        self.assertLess(wifi_start, ble_start)

    def test_factory_reset_requires_twenty_second_hold(self) -> None:
        self.assertIn("kFactoryResetHoldMilliseconds = 20000", self.source)
        body = function_body(self.source, "bool handleStartupButton(")
        self.assertIn("clearEquipmentAssignment();", body)
        self.assertIn("if (watchdog_ready) feedLoopWDT();", body)
        self.assertIn("ESP.restart();", body)
        setup = function_body(self.source, "void setup()")
        self.assertIn("handleStartupButton(true)", setup)
        self.assertIn("handleStartupButton(false)", setup)

    def test_confirmation_is_persisted_before_normal_ble_lifecycle(self) -> None:
        apply = function_body(self.source, "bool applyClaimPacket(")
        self.assertIn('preferences.putString("ack_command"', apply)
        load = function_body(self.source, "bool loadConfiguration()")
        self.assertIn('preferences.getString("ack_command", "")', load)
        setup = function_body(self.source, "void setup()")
        self.assertIn("!claimed || enrollment_ack_pending", setup)

    def test_deep_sleep_is_impossible_before_unification(self) -> None:
        body = function_body(self.source, "void loop()")
        self.assertIn("if (claimed && !connected && !reconnect_active", body)
        self.assertIn("!running_image_pending_verification", body)
        self.assertEqual(body.count("enterDeepSleep();"), 1)


if __name__ == "__main__":
    unittest.main()
