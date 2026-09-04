from __future__ import annotations

import re
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
FIRMWARE = ROOT / "firmware" / "equipment_module" / "src" / "main.cpp"
BLE_PROTOCOL = ROOT / "firmware" / "common" / "src" / "equipment_ble_protocol.h"


def block_body(source: str, declaration: str) -> str:
    """Return a balanced C++ block without depending on line formatting."""
    start = source.index(declaration)
    opening = source.index("{", start)
    depth = 0
    for index in range(opening, len(source)):
        if source[index] == "{":
            depth += 1
        elif source[index] == "}":
            depth -= 1
            if depth == 0:
                return source[opening + 1 : index]
    raise AssertionError(f"bloque incompleto: {declaration}")


def compact(source: str) -> str:
    return re.sub(r"\s+", " ", source).strip()


class EquipmentFirmwareLifecycleTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.source = FIRMWARE.read_text(encoding="utf-8")
        cls.protocol = BLE_PROTOCOL.read_text(encoding="utf-8")

    def assertOrdered(self, source: str, *fragments: str) -> None:  # noqa: N802
        body = compact(source)
        cursor = 0
        for fragment in fragments:
            normalized = compact(fragment)
            position = body.find(normalized, cursor)
            self.assertNotEqual(
                position,
                -1,
                f"no se encontró en orden: {normalized!r}",
            )
            cursor = position + len(normalized)

    def test_release_declares_compatible_wifi_and_ble_protocols(self) -> None:
        source = compact(self.source)
        protocol = compact(self.protocol)
        self.assertRegex(
            source,
            r'#define MIM_FIRMWARE_VERSION "0\.6\.2"',
        )
        self.assertIn(
            "constexpr char kFirmwareVersion[] = MIM_FIRMWARE_VERSION;", source
        )
        self.assertIn("#define MIM_FIRMWARE_SECURE_VERSION 1U", source)
        self.assertIn('"fuel-mim"', source)
        self.assertRegex(source, r"constexpr uint8_t kWifiProtocolVersion = 2;")
        self.assertRegex(protocol, r"constexpr uint8_t kProtocolVersion = 4;")
        self.assertRegex(
            protocol,
            r"kResponseSize = kModuleNonceSize \+ kResponseTagSize;",
        )
        self.assertRegex(
            protocol,
            r"kSessionCommandSize = kSessionCommandHeaderSize \+ kSessionTagSize;",
        )

    def test_release_has_no_battery_measurement_or_ble_metric(self) -> None:
        source = compact(self.source)
        protocol = compact(self.protocol)
        self.assertNotIn("readBatteryPercent", source)
        self.assertNotIn("battery_percent", source)
        self.assertNotIn("BATTERY_ADC_PIN", source)
        self.assertIn("constexpr size_t kAdvertisementSize = 4;", protocol)
        self.assertNotIn("kFlagLowBattery", protocol)

    def test_ble_advertisement_has_human_readable_module_name(self) -> None:
        name = compact(block_body(self.source, "String equipmentBleName()"))
        advertising = compact(block_body(self.source, "bool startAdvertising("))
        start = compact(block_body(self.source, "bool startBle()"))
        self.assertIn('return "Fuel-" + suffix;', name)
        self.assertIn("data.setManufacturerData", advertising)
        self.assertIn("data.setFlags(0x06);", advertising)
        self.assertIn("data.setName(equipmentBleName().c_str())", advertising)
        self.assertIn("const String ble_name = equipmentBleName();", start)

    def test_configuration_load_fails_closed_on_nvs_or_partial_state(self) -> None:
        body = compact(block_body(self.source, "bool loadConfiguration()"))
        self.assertRegex(
            body,
            r"if \(!preferences\.begin\(kPreferencesNamespace, true\)\) "
            r"\{ claim_storage_valid = false; return false; \}",
        )
        self.assertIn("claim_schema == kClaimStateSchema", body)
        self.assertIn("claimed_module_id == EQUIPMENT_MODULE_ID", body)
        self.assertIn("validIdentifier(site_id)", body)
        self.assertIn("validIdentifier(equipment_id)", body)
        self.assertIn("validDisplayName(device_name)", body)
        self.assertIn(
            "const bool ack_required = ack_marker_present ? ack_marker : any_ack_metadata;",
            body,
        )
        self.assertIn(
            "hexDecode(pending_claim_hash, decoded_hash, sizeof(decoded_hash))",
            body,
        )
        self.assertIn(
            "hexDecode(pending_receipt, decoded_receipt, sizeof(decoded_receipt))",
            body,
        )
        self.assertOrdered(
            body,
            "const bool ack_state_valid = !ack_required || complete_ack_metadata;",
            "claim_storage_valid = !unified || (assignment_valid && ack_state_valid);",
            "claimed = unified && assignment_valid && ack_state_valid;",
            "enrollment_ack_pending = claimed && ack_required;",
            "return claim_storage_valid;",
        )

    def test_claim_persistence_is_an_invalidate_write_commit_transaction(self) -> None:
        body = compact(block_body(self.source, "bool applyClaimPacket("))
        self.assertOrdered(
            body,
            'preferences.putBool("unified", false)',
            'preferences.putBool("ack_pending", false)',
            'preferences.putString("site_id", requested_site)',
            'preferences.putString("equipment_id", requested_equipment)',
            'preferences.putString("device_name", requested_name)',
            'preferences.putString("claimed_module", EQUIPMENT_MODULE_ID)',
            'preferences.putUChar("claim_schema", kClaimStateSchema)',
            'preferences.putBool("unified", true)',
            'if (!stored) (void)preferences.putBool("unified", false);',
            "preferences.end();",
            "if (!stored)",
            "site_id = requested_site;",
            "claimed = true;",
        )
        for key, value in (
            ("site_id", "requested_site"),
            ("equipment_id", "requested_equipment"),
            ("device_name", "requested_name"),
        ):
            self.assertRegex(
                body,
                rf'preferences\.putString\("{key}", {value}\) == {value}\.length\(\)',
            )
        self.assertIn('preferences.putBool("ack_pending", true) == 1', body)

    def test_factory_identity_marker_commits_last_and_is_required_at_boot(self) -> None:
        identity = compact(block_body(self.source, "bool verifyFactoryIdentity()"))
        self.assertIn(
            'preferences.getString("factory_module", "") == EQUIPMENT_MODULE_ID',
            identity,
        )
        self.assertIn(
            'preferences.getString("factory_hash", "") == expected_hash',
            identity,
        )
        self.assertOrdered(
            identity,
            'preferences.putBool("factory_ready", false)',
            'preferences.putString("factory_module", EQUIPMENT_MODULE_ID)',
            'preferences.putString("factory_hash", expected_hash)',
            'preferences.putBool("factory_ready", true)',
        )
        self_test = compact(block_body(self.source, "bool selfTestPassed()"))
        self.assertIn("release_identity_valid && factory_identity_valid", self_test)
        self.assertIn("factory_identity_valid && claim_storage_valid", self_test)

    def test_assignment_reset_invalidates_before_best_effort_cleanup(self) -> None:
        body = compact(block_body(self.source, "bool clearEquipmentAssignment()"))
        self.assertOrdered(
            body,
            'preferences.putBool("unified", false)',
            'preferences.putBool("ack_pending", false)',
            'removePreferenceIfPresent("site_id")',
            'removePreferenceIfPresent("equipment_id")',
            'removePreferenceIfPresent("claimed_module")',
            "preferences.end();",
            "if (!invalidated)",
            "claim_storage_valid = false;",
            "return false;",
            "claimed = false;",
            "claim_storage_valid = true;",
        )

    def test_server_confirmation_is_durable_before_pending_state_is_cleared(self) -> None:
        body = compact(block_body(self.source, "bool confirmPendingEnrollment()"))
        self.assertOrdered(
            body,
            'authenticatedEnrollmentRequest("confirm", payload, response)',
            'response["state"] != "confirmed"',
            'preferences.putBool("ack_pending", false)',
            'removePreferenceIfPresent("ack_command")',
            "preferences.end();",
            "if (!acknowledged)",
            "return false;",
            "enrollment_ack_pending = false;",
            "pending_command_id = \"\";",
            "ESP.restart();",
        )

    def test_wifi_v2_authenticates_raspberry_before_sending_the_action(self) -> None:
        body = compact(
            block_body(self.source, "bool authenticatedEnrollmentRequest(")
        )
        self.assertIn('challenge_request["version"] = kWifiProtocolVersion;', body)
        self.assertIn('challenge_request["action"] = action;', body)
        self.assertIn("challenge_ttl > 300", body)
        self.assertOrdered(
            body,
            "esp_fill_random(client_nonce, sizeof(client_nonce));",
            'postEnrollmentJson("/v1/enrollment/challenge"',
            "computeWifiServerProof(client_nonce, server_nonce, action, challenge_ttl",
            "constantTimeEqual(expected_server_proof, supplied_server_proof",
            "computeWifiHmac(kWifiClientDomain, sizeof(kWifiClientDomain)",
            'authenticated_request["clientNonce"]',
            'authenticated_request["serverNonce"]',
            'authenticated_request["payload"]',
            'authenticated_request["clientProof"]',
            "postEnrollmentJson(path.c_str(), request_body, response)",
            "verifyWifiResponseProof(client_nonce, server_nonce, action, payload",
            "if (authenticated) wifi_runtime_healthy = true;",
        )

    def test_wifi_v2_response_proof_uses_length_framing_and_binds_result(self) -> None:
        body = compact(block_body(self.source, "bool verifyWifiResponseProof("))
        self.assertIn("if (!ok || length > UINT32_MAX)", body)
        self.assertIn("const uint8_t prefix[4]", body)
        self.assertOrdered(
            body,
            "update_field(reinterpret_cast<const uint8_t*>(EQUIPMENT_MODULE_ID)",
            "update_field(client_nonce, 32);",
            "update_field(server_nonce, 32);",
            "update_field(reinterpret_cast<const uint8_t*>(action)",
            "update_field(reinterpret_cast<const uint8_t*>(request_payload.c_str())",
            "update_field(reinterpret_cast<const uint8_t*>(state.c_str())",
            "update_field(reinterpret_cast<const uint8_t*>(command_id.c_str())",
            "update_field(claim.empty() ? nullptr : claim.data(), claim.size());",
            "mbedtls_md_hmac_finish(&context, expected)",
            "constantTimeEqual(expected, supplied, sizeof(expected))",
        )
        self.assertIn('strcmp(action, "status") == 0 && state == "pending"', body)
        self.assertIn('strcmp(action, "status") == 0 && state == "claim"', body)
        self.assertIn('strcmp(action, "confirm") == 0 && state == "confirmed"', body)

    def test_wifi_v2_hmac_domains_bind_both_nonces_and_action(self) -> None:
        server = compact(block_body(self.source, "bool computeWifiServerProof("))
        client = compact(block_body(self.source, "bool computeWifiHmac("))
        response = compact(block_body(self.source, "bool verifyWifiResponseProof("))
        self.assertOrdered(
            server,
            "kWifiServerDomain",
            "sizeof(kWifiServerDomain)",
            "EQUIPMENT_MODULE_ID",
            "client_nonce, 32",
            "server_nonce, 32",
            "action",
            "&separator, 1",
            "ttl, sizeof(ttl)",
        )
        self.assertOrdered(
            client,
            "domain_size",
            "EQUIPMENT_MODULE_ID",
            "client_nonce, 32",
            "server_nonce, 32",
            "action",
            "&separator, 1",
            "payload.c_str()",
        )
        self.assertOrdered(
            response,
            "kWifiResponseDomain",
            "sizeof(kWifiResponseDomain)",
            "update_field",
        )

    def test_ble_v4_response_uses_fresh_module_nonce_bound_to_auth_tag(self) -> None:
        callback_class = block_body(self.source, "class ChallengeCallbacks final")
        callback = compact(block_body(callback_class, "void onWrite("))
        tag = compact(block_body(self.source, "bool buildEquipmentResponse("))
        self.assertOrdered(
            callback,
            "esp_fill_random(module_nonce, sizeof(module_nonce));",
            "active_connection_handle == connection.getConnHandle()",
            "!session_challenge_ready",
            "memcpy(session_challenge, value.data()",
            "memcpy(session_module_nonce, module_nonce",
            "session_challenge_ready = true;",
            "uint8_t response[fuel_equipment_ble::kResponseSize];",
            "memcpy(response, module_nonce, sizeof(module_nonce));",
            "buildEquipmentResponse(",
            "response + fuel_equipment_ble::kModuleNonceSize",
            "response_characteristic->setValue(response, sizeof(response));",
        )
        self.assertOrdered(
            tag,
            "fuel_equipment_ble::kHmacDomain",
            "sizeof(fuel_equipment_ble::kHmacDomain)",
            "EQUIPMENT_MODULE_ID",
            "&separator, 1",
            "equipment_id.c_str()",
            "&separator, 1",
            "challenge",
            "module_nonce",
            "mbedtls_md_hmac_finish(&context, response_tag)",
        )

    def test_ble_v4_session_authenticates_before_advancing_lease(self) -> None:
        callback_class = block_body(self.source, "class SessionCallbacks final")
        body = compact(block_body(callback_class, "void onWrite("))
        tag = compact(block_body(self.source, "bool buildSessionCommandTag("))
        self.assertIn(
            "value.size() != fuel_equipment_ble::kSessionCommandSize",
            body,
        )
        self.assertIn("sequence == 0", body)
        self.assertEqual(body.count("sequence == last_session_sequence + 1"), 2)
        authentication = body.index("if (!buildSessionCommandTag")
        sequence_commit = body.index("last_session_sequence = sequence;")
        lease_commit = body.index("session_lease_until = lease_until;")
        self.assertLess(authentication, sequence_commit)
        self.assertLess(sequence_commit, lease_commit)
        self.assertIn("reconnect_awake_until = lease_until;", body)
        self.assertIn(
            "constantTimeEqual( expected, command + fuel_equipment_ble::kSessionCommandHeaderSize",
            body,
        )
        self.assertOrdered(
            tag,
            "fuel_equipment_ble::kSessionHmacDomain",
            "sizeof(fuel_equipment_ble::kSessionHmacDomain)",
            "EQUIPMENT_MODULE_ID",
            "equipment_id.c_str()",
            "challenge",
            "module_nonce",
            "header",
            "mbedtls_md_hmac_finish(&context, tag)",
        )

    def test_connection_bound_crypto_state_is_cleared_at_every_boundary(self) -> None:
        server = block_body(self.source, "class ServerCallbacks final")
        connect = compact(block_body(server, "void onConnect("))
        disconnect = compact(block_body(server, "void onDisconnect("))
        start = compact(block_body(self.source, "bool startBle()"))
        for body in (connect, disconnect, start):
            self.assertIn("last_session_sequence = 0;", body)
            self.assertIn("session_challenge_ready = false;", body)
            self.assertIn("memset(session_challenge, 0", body)
            self.assertIn("memset(session_module_nonce, 0", body)

    def test_authenticated_reconnect_grace_does_not_extend_a_new_handshake(self) -> None:
        server = block_body(self.source, "class ServerCallbacks final")
        connect = compact(block_body(server, "void onConnect("))
        disconnect = compact(block_body(server, "void onDisconnect("))
        loop = compact(block_body(self.source, "void loop()"))
        session_class = block_body(self.source, "class SessionCallbacks final")
        session = compact(block_body(session_class, "void onWrite("))

        self.assertIn("constexpr uint16_t kChallengeGraceSeconds = 5;", self.source)
        self.assertNotIn("reconnect_awake_until = 0;", connect)
        self.assertNotIn("reconnect_awake_until = 0;", disconnect)
        self.assertOrdered(
            session,
            "buildSessionCommandTag",
            "const uint32_t lease_until",
            "session_lease_until = lease_until;",
            "reconnect_awake_until = lease_until;",
        )
        self.assertIn("!handshake_active && !lease_active", loop)
        self.assertNotIn("!handshake_active && !reconnect_active", loop)
        self.assertIn("claimed && !connected && !reconnect_active", loop)

    def test_watchdog_is_a_boot_gate_and_covers_ota_upload_work(self) -> None:
        initialize = compact(block_body(self.source, "bool initializeTaskWatchdog()"))
        setup = compact(block_body(self.source, "void setup()"))
        self_test = compact(block_body(self.source, "bool selfTestPassed()"))
        upload = compact(block_body(self.source, "void handleUpdateUpload()"))
        http = compact(block_body(self.source, "bool postEnrollmentJson("))
        self.assertIn("configuration.trigger_panic = true;", initialize)
        self.assertIn("portNUM_PROCESSORS", initialize)
        self.assertOrdered(
            initialize,
            "esp_task_wdt_reconfigure(&configuration)",
            "esp_task_wdt_init(&configuration)",
            "enableLoopWDT();",
            "esp_task_wdt_status(nullptr) == ESP_OK",
            "return ready;",
        )
        self.assertOrdered(
            setup,
            "watchdog_ready = initializeTaskWatchdog();",
            "(void)loadConfiguration();",
            "initializeOtaValidation();",
            "factory_identity_valid = verifyFactoryIdentity();",
            "if (!selfTestPassed())",
        )
        self.assertOrdered(
            self_test,
            "watchdog_ready",
            "release_identity_valid",
            "factory_identity_valid",
            "claim_storage_valid",
        )
        self.assertIn("if (watchdog_ready) feedLoopWDT();", upload)
        self.assertOrdered(
            http,
            "if (watchdog_ready) feedLoopWDT();",
            "http.POST(request_body)",
            "if (watchdog_ready) feedLoopWDT();",
            "http.getString()",
            "if (watchdog_ready) feedLoopWDT();",
        )

    def test_ota_trial_is_confirmed_only_after_self_test_and_runtime_health(self) -> None:
        initialize = compact(block_body(self.source, "void initializeOtaValidation()"))
        confirm = compact(block_body(self.source, "bool confirmRunningOtaImage() {"))
        maintain = compact(block_body(self.source, "void maintainOtaValidation()"))
        setup = compact(block_body(self.source, "void setup()"))
        loop = compact(block_body(self.source, "void loop()"))
        self.assertOrdered(
            initialize,
            "state != ESP_OTA_IMG_PENDING_VERIFY",
            "running_image_pending_verification = true;",
            "ota_validation_deadline = millis() + kOtaValidationMilliseconds;",
        )
        self.assertOrdered(
            confirm,
            "if (!selfTestPassed()) return false;",
            "esp_ota_mark_app_valid_cancel_rollback()",
            "if (result != ESP_OK)",
            "running_image_pending_verification = false;",
        )
        self.assertNotIn("confirmRunningOtaImage()", setup)
        self.assertOrdered(
            maintain,
            "if (!selfTestPassed())",
            'rollbackRunningOtaImage("self_test")',
            "bool runtime_healthy = wifi_enrollment_mode && wifi_runtime_healthy;",
            "now - ble_health_started_at >= kBleHealthValidationMilliseconds",
            "runtime_healthy = connected ||",
            "if (runtime_healthy)",
            "confirmRunningOtaImage()",
            "if (!deadlinePending(ota_validation_deadline, now))",
            'rollbackRunningOtaImage("health_timeout")',
        )
        self.assertIn("!running_image_pending_verification", loop)

    def test_unclaimed_or_unconfirmed_module_stays_awake_on_wifi(self) -> None:
        setup = compact(block_body(self.source, "void setup()"))
        loop = compact(block_body(self.source, "void loop()"))
        self.assertOrdered(
            setup,
            "if (!claimed || enrollment_ack_pending)",
            "startWifiEnrollment()",
            "return;",
            "startBle()",
        )
        self.assertIn("if (claimed && !connected && !reconnect_active", loop)
        self.assertEqual(loop.count("enterDeepSleep();"), 1)

    def test_expired_or_signed_closed_ble_session_disconnects_fail_safe(self) -> None:
        loop = compact(block_body(self.source, "void loop()"))
        self.assertIn(
            "disconnect_requested || (!handshake_active && !lease_active)",
            loop,
        )
        self.assertOrdered(
            loop,
            "if (connected &&",
            "ble_server->disconnect(connection_handle);",
            "return;",
            "if (claimed && !connected && !reconnect_active",
            "enterDeepSleep();",
        )

    def test_physical_assignment_reset_requires_twenty_seconds_and_clean_restart(self) -> None:
        source = compact(self.source)
        button = compact(block_body(self.source, "bool handleStartupButton("))
        setup = compact(block_body(self.source, "void setup()"))
        self.assertRegex(
            source,
            r"constexpr unsigned long kFactoryResetHoldMilliseconds = 20000;",
        )
        self.assertOrdered(
            button,
            "millis() - pressed_at < kFactoryResetHoldMilliseconds",
            "if (watchdog_ready) feedLoopWDT();",
            "if (digitalRead(CONFIG_BUTTON_PIN) == LOW)",
            "const bool assignment_cleared = clearEquipmentAssignment();",
            "while (digitalRead(CONFIG_BUTTON_PIN) == LOW)",
            "if (watchdog_ready) feedLoopWDT();",
            "delay(kButtonDebounceMilliseconds);",
            "if (assignment_cleared)",
            "ESP.restart();",
        )
        self.assertIn("waiting_for_release=true", button)
        self.assertIn("return allow_maintenance && startMaintenancePortal();", button)
        self.assertOrdered(
            setup,
            "(void)loadConfiguration();",
            "factory_identity_valid = verifyFactoryIdentity();",
            "recovery_controls_trusted",
            "handleStartupButton(true)",
            "if (operator_wake_requested)",
            "handleStartupButton(false)",
            "if (!selfTestPassed())",
        )
        self.assertIn("portalPasswordConfigured()", setup)

    def test_button_wake_selects_exactly_sixty_seconds(self) -> None:
        policy = compact(block_body(self.source, "void configureBootWakePolicy()"))
        cause = compact(block_body(self.source, "bool wokeFromOperatorButton("))
        setup = compact(block_body(self.source, "void setup()"))
        self.assertIn(
            "#define OPERATIONAL_ADVERTISE_WINDOW_SECONDS 60", self.source
        )
        self.assertIn("static_assert(OPERATIONAL_ADVERTISE_WINDOW_SECONDS == 60", self.source)
        self.assertNotIn("HEALTH_WAKE_INTERVAL_SECONDS", self.source)
        self.assertOrdered(
            policy,
            "boot_wakeup_cause = esp_sleep_get_wakeup_cause();",
            "operator_wake_requested = wokeFromOperatorButton(boot_wakeup_cause);",
            "active_advertise_window_seconds = OPERATIONAL_ADVERTISE_WINDOW_SECONDS;",
        )
        self.assertIn("cause == ESP_SLEEP_WAKEUP_GPIO", cause)
        self.assertIn("cause == ESP_SLEEP_WAKEUP_EXT1", cause)
        self.assertOrdered(
            setup,
            "pinMode(CONFIG_BUTTON_PIN, INPUT_PULLUP);",
            "configureBootWakePolicy();",
            "initializeButtonState();",
            "const bool service_boot =",
            "boot_wakeup_cause == ESP_SLEEP_WAKEUP_UNDEFINED;",
            "if (recovery_controls_trusted)",
            "if (service_boot && handleStartupButton(true))",
            "if (operator_wake_requested)",
            "handleStartupButton(false)",
        )

    def test_deep_sleep_arms_only_d1_and_has_no_periodic_wake(self) -> None:
        sleep = compact(block_body(self.source, "bool enterDeepSleep()"))
        self.assertOrdered(
            sleep,
            "esp_sleep_disable_wakeup_source(ESP_SLEEP_WAKEUP_ALL);",
            "if (digitalRead(CONFIG_BUTTON_PIN) == HIGH)",
            "esp_deep_sleep_enable_gpio_wakeup(",
            "ESP_GPIO_WAKEUP_GPIO_LOW",
            "button_wake_enabled = button_result == ESP_OK;",
        )
        self.assertIn(
            'Serial.printf("sleep=button_wakeup_skipped pin=%d reason=held_low',
            sleep,
        )
        self.assertNotIn("esp_sleep_enable_timer_wakeup", sleep)
        self.assertIn("esp_deep_sleep_start();", sleep)

    def test_button_is_debounced_and_cannot_extend_an_operational_window(self) -> None:
        button = compact(block_body(self.source, "void maintainOperationalButton("))
        activate = compact(block_body(self.source, "void activateOperatorWindow("))
        loop = compact(block_body(self.source, "void loop()"))
        self.assertIn("now - button_raw_changed_at < kButtonDebounceMilliseconds", button)
        self.assertIn('activateOperatorWindow(now, "press");', button)
        self.assertOrdered(
            activate,
            "if (operator_wake_requested)",
            "window_already_active=true",
            "operator_wake_requested = true;",
            "active_advertise_window_seconds = OPERATIONAL_ADVERTISE_WINDOW_SECONDS;",
            "advertising_started_at = now;",
        )
        self.assertEqual(activate.count("advertising_started_at = now;"), 1)
        self.assertNotIn("handleStartupButton", loop)
        self.assertOrdered(
            loop,
            "const uint32_t now = millis();",
            "maintainOperationalButton(now);",
            "active_advertise_window_seconds * 1000UL",
            "enterDeepSleep();",
        )
        sleep = compact(block_body(self.source, "bool enterDeepSleep()"))
        self.assertGreaterEqual(
            sleep.count("if (digitalRead(CONFIG_BUTTON_PIN) == LOW)"), 2
        )
        self.assertNotIn("LOW && !button_stable_low", sleep)

    def test_authenticated_close_sleeps_without_waiting_for_sixty_seconds(self) -> None:
        session_class = block_body(self.source, "class SessionCallbacks final")
        session = compact(block_body(session_class, "void onWrite("))
        loop = compact(block_body(self.source, "void loop()"))
        self.assertOrdered(
            session,
            "buildSessionCommandTag",
            "ble_disconnect_requested = true;",
            "signed_session_closed = true;",
        )
        self.assertIn("authenticated_close = signed_session_closed;", loop)
        self.assertIn(
            "(authenticated_close || now - advertising_started_at >= active_advertise_window_seconds * 1000UL)",
            loop,
        )


if __name__ == "__main__":
    unittest.main()
