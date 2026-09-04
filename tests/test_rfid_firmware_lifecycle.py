from __future__ import annotations

import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
FIRMWARE = ROOT / "firmware" / "rfid_validator" / "src" / "main.cpp"
PLATFORMIO = ROOT / "firmware" / "rfid_validator" / "platformio.ini"
README = ROOT / "firmware" / "rfid_validator" / "README.md"


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
                return source[opening + 1 : index]
    raise AssertionError(f"función incompleta: {signature}")


class RfidFirmwareLifecycleTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.source = FIRMWARE.read_text(encoding="utf-8")
        cls.platformio = PLATFORMIO.read_text(encoding="utf-8")
        cls.readme = README.read_text(encoding="utf-8")

    def test_halt_is_sent_before_crypto1_is_stopped(self) -> None:
        body = function_body(self.source, "void haltSelectedCard()")

        halt = body.index("rfid_reader.PICC_HaltA();")
        stop_crypto = body.index("rfid_reader.PCD_StopCrypto1();")

        self.assertLess(halt, stop_crypto)

    def test_presence_authentication_uses_safe_card_shutdown(self) -> None:
        body = function_body(
            self.source,
            "bool mifareCardReady(bool enrollment, bool identification = false)",
        )

        self.assertIn("ready = readMifareMarker(key_a);", body)
        self.assertIn("haltSelectedCard();", body)
        self.assertNotIn("rfid_reader.PCD_StopCrypto1();", body)

    def test_identification_reads_a_factory_card_without_personalizing_it(self) -> None:
        body = function_body(
            self.source,
            "bool mifareCardReady(bool enrollment, bool identification = false)",
        )
        identification = body[body.index("else if (!ready && identification)") :]

        self.assertIn("authenticateMifare(default_key)", identification)
        self.assertNotIn("personalizeMifareCard", identification)

    def test_personalization_reselects_before_authenticating_new_key(self) -> None:
        body = function_body(
            self.source,
            "bool personalizeMifareCard(const MFRC522::MIFARE_Key& key_a,",
        )

        halt = body.index("haltSelectedCard();")
        reselect = body.index("if (!selectPendingCard()) return false;")
        verify = body.index("return readMifareMarker(key_a);")

        self.assertLess(halt, reselect)
        self.assertLess(reselect, verify)

    def test_wifi_is_retried_after_a_runtime_disconnect(self) -> None:
        connect = function_body(
            self.source,
            "bool connectWifi(unsigned long timeout_milliseconds = 0)",
        )
        maintain = function_body(self.source, "void maintainWifiConnection()")
        loop = function_body(self.source, "void loop()")

        self.assertIn("WiFi.setAutoReconnect(true);", connect)
        self.assertIn("WiFi.disconnect(true, false);", maintain)
        self.assertLess(
            maintain.index("WiFi.disconnect(true, false);"),
            maintain.index("WiFi.begin(WIFI_SSID, WIFI_PASSWORD);"),
        )
        self.assertIn("WiFi.begin(WIFI_SSID, WIFI_PASSWORD);", maintain)
        self.assertIn("next_wifi_reconnect", maintain)
        self.assertIn("maintainWifiConnection();", loop)

    def test_initial_wifi_timeout_falls_back_to_background_recovery(self) -> None:
        connect = function_body(
            self.source,
            "bool connectWifi(unsigned long timeout_milliseconds = 0)",
        )
        setup = function_body(self.source, "void setup()")
        loop = function_body(self.source, "void loop()")

        self.assertIn("kWifiInitialConnectMilliseconds = 30000", self.source)
        self.assertIn("effective_timeout", connect)
        self.assertNotIn("timeout_milliseconds == 0 ? 0", connect)
        self.assertIn(
            "const bool wifi_connected = connectWifi(kWifiInitialConnectMilliseconds);",
            setup,
        )
        self.assertIn("startMqtt();", setup)
        self.assertNotIn("if (!connectWifi", setup)
        self.assertIn("maintainMqttConnection();", loop)

    def test_wifi_power_save_is_disabled_for_mqtt_ble_coexistence(self) -> None:
        connect = function_body(
            self.source,
            "bool connectWifi(unsigned long timeout_milliseconds = 0)",
        )
        maintain = function_body(self.source, "void maintainWifiConnection()")

        self.assertIn("WiFi.setSleep(false);", connect)
        self.assertIn("WiFi.setSleep(false);", maintain)

    def test_mqtt_callback_defers_all_stateful_work_to_loop(self) -> None:
        callback = function_body(
            self.source,
            "esp_err_t onMqttEvent(esp_mqtt_event_handle_t event)",
        )
        deferred = function_body(self.source, "void processDeferredMqttEvents()")
        loop = function_body(self.source, "void loop()")

        self.assertIn("queueMqttMessage", callback)
        self.assertIn("queueMqttConnectionChange", callback)
        for forbidden in (
            "handleChallenge(",
            "handleDecision(",
            "handleEquipmentRegistry(",
            "closeEquipmentSession(",
            "clearOtaBootMetadata(",
            "rfid_reader.",
            "Serial.",
        ):
            self.assertNotIn(forbidden, callback)
        self.assertIn("dispatchMqttMessage", deferred)
        self.assertIn("processDeferredMqttEvents();", loop)

    def test_mqtt_disconnect_is_sticky_and_inbox_overflow_fails_safe(self) -> None:
        queue_connection = function_body(
            self.source, "void queueMqttConnectionChange(bool online)"
        )
        apply_connection = function_body(
            self.source, "void applyMqttConnectionChange()"
        )
        fail_safe = function_body(self.source, "bool applyMqttInboxFailSafe()")

        self.assertIn("mqtt_disconnect_pending = true;", queue_connection)
        self.assertLess(
            apply_connection.index("if (disconnect_pending)"),
            apply_connection.index("if (!connect_pending || !target_online)"),
        )
        self.assertIn("kMqttInboxCapacity = 8", self.source)
        self.assertIn("mqtt_inbox_failure_count", fail_safe)
        self.assertIn("active_session.clear();", fail_safe)
        self.assertIn("closeEquipmentSession();", fail_safe)
        self.assertIn("esp_mqtt_client_disconnect", fail_safe)

    def test_empty_enrollment_tombstone_closes_without_reconnecting(self) -> None:
        queue = function_body(
            self.source,
            "bool queueMqttMessage(DeferredMqttMessageType type, const char* payload,",
        )
        callback = function_body(
            self.source, "esp_err_t onMqttEvent(esp_mqtt_event_handle_t event)"
        )
        enrollment = function_body(
            self.source,
            "void handleEnrollmentWindow(const char* payload, size_t length)",
        )

        self.assertIn("empty_enrollment_reset", queue)
        self.assertIn(
            "queueMqttMessage(DeferredMqttMessageType::Enrollment, nullptr, 0)",
            callback,
        )
        self.assertIn("if (length == 0)", enrollment)
        self.assertIn("enrollment_window_active = false;", enrollment)
        self.assertNotIn("markMqttInboxFailure", enrollment)

    def test_mqtt_payload_copy_is_complete_before_slot_publication(self) -> None:
        queue = function_body(
            self.source,
            "bool queueMqttMessage(DeferredMqttMessageType type, const char* payload,",
        )

        allocation = queue.index("malloc(length + 1)")
        copy = queue.index("memcpy(payload_copy")
        enter = queue.index("portENTER_CRITICAL(&mqtt_inbox_mutex);")
        publish = queue.index("mqtt_inbox[index].payload = payload_copy;")
        ready = queue.index("mqtt_inbox[index].state = MqttInboxState::Ready;")
        leave = queue.index("portEXIT_CRITICAL(&mqtt_inbox_mutex);")
        self.assertLess(allocation, copy)
        self.assertLess(copy, enter)
        self.assertLess(enter, publish)
        self.assertLess(publish, ready)
        self.assertLess(ready, leave)
        self.assertNotIn("char payload[kMaxMessageSize + 1]", self.source)

    def test_mqtt_dynamic_payload_is_freed_after_processing_and_fail_safe(self) -> None:
        deferred = function_body(self.source, "void processDeferredMqttEvents()")
        fail_safe = function_body(self.source, "bool applyMqttInboxFailSafe()")

        self.assertIn("free(processed_payload);", deferred)
        self.assertIn("free(discarded[index]);", fail_safe)

    def test_firmware_version_is_ota_deployable(self) -> None:
        self.assertIn('kFirmwareVersion[] = "0.6.3"', self.source)

    def test_rfid_reset_stays_driven_and_unknown_versions_are_rejected(self) -> None:
        self.assertIn("#define RFID_RST_PIN D5", self.source)
        self.assertIn(
            "MFRC522 rfid_reader(RFID_SS_PIN, MFRC522::UNUSED_PIN);",
            self.source,
        )
        initialize = function_body(self.source, "bool initializeRfidReader()")
        supported = function_body(
            self.source, "bool supportedRfidVersion(byte version)"
        )

        self.assertIn("pinMode(RFID_RST_PIN, OUTPUT);", initialize)
        self.assertIn("digitalWrite(RFID_RST_PIN, LOW);", initialize)
        self.assertGreaterEqual(
            initialize.count("digitalWrite(RFID_RST_PIN, HIGH);"), 2
        )
        self.assertLess(
            initialize.index("rfid_reader.PCD_Init();"),
            initialize.rindex("digitalWrite(RFID_RST_PIN, HIGH);"),
        )
        for version in ("0x88", "0x90", "0x91", "0x92"):
            self.assertIn(version, supported)
        self.assertIn("supportedRfidVersion(version)", initialize)
        self.assertNotIn("version != 0x00 && version != 0xff", initialize)

    def test_open_web_window_wakes_a_card_already_in_the_field(self) -> None:
        acquisition = function_body(
            self.source, "bool readCardForPresentation()"
        )
        poll = function_body(self.source, "void pollPhysicalCard()")

        self.assertIn("if (!enrollment_window_active)", acquisition)
        self.assertIn("PICC_IsNewCardPresent()", acquisition)
        self.assertIn("PICC_WakeupA", acquisition)
        self.assertIn("MFRC522::STATUS_COLLISION", acquisition)
        self.assertIn("readCardForPresentation()", poll)
        self.assertNotIn("PICC_IsNewCardPresent()", poll)

    def test_proactive_scan_authenticates_mim_before_card_presentation(self) -> None:
        discovery = function_body(
            self.source, "void maintainProactiveEquipmentDiscovery()"
        )
        presentation = function_body(
            self.source, "void publishPresentation(bool include_equipment = false)"
        )
        poll = function_body(self.source, "void pollPhysicalCard()")

        self.assertIn(
            "scanAndAuthenticateEquipment(kProactiveScanSliceMilliseconds)",
            discovery,
        )
        self.assertIn("equipment_waiting_for_card = true;", discovery)
        self.assertIn("equipment_link_deadline", discovery)
        self.assertIn('"waiting_tag"', discovery)
        self.assertIn("AuthorizationPhase::CredentialPreflight", presentation)
        self.assertIn("AuthorizationPhase::EquipmentValidation", presentation)
        self.assertIn("equipment_client->isConnected()", presentation)
        self.assertIn("equipment_authenticated", presentation)
        self.assertIn("link_window_active", poll)
        self.assertIn("publishPresentation(link_window_active);", poll)
        self.assertNotIn("scanAndAuthenticateEquipment", poll)

    def test_prelink_window_is_exactly_one_minute_and_refreshes_presence(self) -> None:
        maintain = function_body(self.source, "void maintainEquipmentSession()")
        refresh_rssi = function_body(
            self.source, "bool refreshConnectedEquipmentRssi()"
        )
        decision = function_body(
            self.source, "void handleDecision(const char* payload, size_t length)"
        )

        self.assertIn("kEquipmentLinkWindowMilliseconds = 60000", self.source)
        self.assertIn("kEquipmentPresenceHeartbeatMilliseconds = 1000", self.source)
        self.assertIn('expireEquipmentLinkWindow("tag_timeout")', maintain)
        self.assertIn("equipment_client->getRssi()", refresh_rssi)
        self.assertIn("sample >= 0", refresh_rssi)
        self.assertIn("active_equipment_rssi = sample;", refresh_rssi)
        self.assertLess(
            maintain.index("refreshConnectedEquipmentRssi()"),
            maintain.index("publishEquipmentPresenceState("),
        )
        self.assertIn('"waiting_tag" : "authorized"', maintain)
        self.assertIn("retry_tag_within_link_window", decision)
        self.assertIn("equipment_link_deadline", decision)
        self.assertNotIn("equipment_link_deadline = millis()", decision)

    def test_only_first_equipment_required_decision_starts_mim_scan(self) -> None:
        decision = function_body(
            self.source, "void handleDecision(const char* payload, size_t length)"
        )

        self.assertIn('reason == "equipment_required"', decision)
        self.assertIn(
            "authorization_phase == AuthorizationPhase::CredentialPreflight",
            decision,
        )
        clear_session = decision.index("active_session.clear();")
        scan_presentation = decision.index("publishPresentation(true);")
        self.assertLess(clear_session, scan_presentation)
        self.assertIn(
            "authorization_phase = AuthorizationPhase::Idle;",
            function_body(self.source, "void clearPhysicalCard()"),
        )

    def test_master_fast_path_has_a_distinct_short_chime(self) -> None:
        chime = function_body(self.source, "void playMasterChime()")
        decision = function_body(
            self.source, "void handleDecision(const char* payload, size_t length)"
        )

        self.assertIn("{1568, 2093, 2637, 3136}", chime)
        self.assertIn("{75, 90, 100, 170}", chime)
        self.assertIn("beep(2, 70, 35);", chime)
        self.assertIn("master_authorized", decision)
        self.assertIn("playMasterChime();", decision)
        self.assertIn("equipment_scan=false", decision)

    def test_ble_session_commands_are_fresh_authenticated_and_monotonic(self) -> None:
        response = function_body(
            self.source, "bool buildExpectedEquipmentResponse("
        )
        legacy_response = function_body(
            self.source, "bool buildExpectedLegacyEquipmentResponse("
        )
        session_tag = function_body(
            self.source, "bool buildEquipmentSessionTag("
        )
        authenticate = function_body(
            self.source, "bool authenticateEquipmentAddress("
        )
        send = function_body(
            self.source, "bool sendEquipmentSessionCommand("
        )
        clear = function_body(
            self.source, "void clearEquipmentSessionSigningContext()"
        )
        close = function_body(self.source, "void closeEquipmentSession()")

        self.assertIn("fuel_equipment_ble::kModuleNonceSize", response)
        self.assertIn("module_nonce", response)
        self.assertNotIn("module_nonce", legacy_response)
        self.assertIn("trusted.secret", legacy_response)
        self.assertIn("fuel_equipment_ble::kHmacDomain", legacy_response)
        self.assertIn("fuel_equipment_ble::kChallengeSize", legacy_response)
        self.assertIn("fuel_equipment_ble::kResponseTagSize", self.source)
        self.assertIn("fuel_equipment_ble::kSessionHmacDomain", session_tag)
        self.assertIn("sizeof(fuel_equipment_ble::kSessionHmacDomain)", session_tag)
        self.assertIn("module_nonce", session_tag)
        self.assertIn("fuel_equipment_ble::kSessionCommandHeaderSize", session_tag)

        self.assertIn(
            "response.size() == fuel_equipment_ble::kResponseSize", authenticate
        )
        self.assertIn("response.size() == kLegacyEquipmentResponseSize", authenticate)
        self.assertNotIn("response.size() >=", authenticate)
        self.assertNotIn("response.size() <=", authenticate)
        self.assertIn("reason=response_size", authenticate)
        self.assertIn(
            "response_bytes + fuel_equipment_ble::kModuleNonceSize", authenticate
        )
        self.assertIn("memcpy(equipment_session_challenge", authenticate)
        self.assertIn("memcpy(equipment_session_module_nonce", authenticate)
        self.assertIn("equipment_session_mode = negotiated_mode;", authenticate)
        self.assertIn("EquipmentSessionMode::Legacy32", authenticate)
        self.assertIn("EquipmentSessionMode::SignedV4", authenticate)
        self.assertLess(
            authenticate.index("trustedEquipment(module_id)"),
            authenticate.index("response_characteristic->readValue()"),
        )
        signed_branch = authenticate[
            authenticate.index(
                "if (response.size() == fuel_equipment_ble::kResponseSize)"
            ) : authenticate.index(
                "else if (response.size() == kLegacyEquipmentResponseSize)"
            )
        ]
        self.assertNotIn("buildExpectedLegacyEquipmentResponse", signed_branch)
        self.assertIn("reason=hmac", signed_branch)
        self.assertIn("return false;", signed_branch)

        self.assertIn("fuel_equipment_ble::kSessionCommandSize", send)
        self.assertIn("equipment_session_sequence + 1", send)
        self.assertIn("encodeSessionCommandHeader", send)
        write = send.index("equipment_session_control->writeValue")
        commit = send.index("equipment_session_sequence = sequence;")
        self.assertLess(write, commit)

        self.assertIn("equipment_session_sequence = 0;", clear)
        self.assertIn(
            "equipment_session_mode = EquipmentSessionMode::None;", clear
        )
        self.assertIn("memset(equipment_session_challenge", clear)
        self.assertIn("memset(equipment_session_module_nonce", clear)
        self.assertIn("sendEquipmentSessionCommand", close)
        self.assertIn("sendLegacyEquipmentSessionCommand", close)
        self.assertNotIn("writeValue", close)

    def test_legacy_equipment_migration_is_explicit_authenticated_and_scoped(self) -> None:
        authenticate = function_body(
            self.source, "bool authenticateEquipmentAddress("
        )
        legacy_send = function_body(
            self.source, "bool sendLegacyEquipmentSessionCommand("
        )
        hold = function_body(self.source, "bool sendEquipmentHold()")
        destroy = function_body(self.source, "void destroyEquipmentClient()")
        maintain = function_body(self.source, "void maintainEquipmentSession()")

        self.assertIn("#define VALIDATOR_ALLOW_LEGACY_EQUIPMENT 0", self.source)
        self.assertIn("#if VALIDATOR_ALLOW_LEGACY_EQUIPMENT == 1", self.source)
        self.assertIn("-DVALIDATOR_ALLOW_LEGACY_EQUIPMENT=0", self.platformio)
        self.assertIn("buildExpectedLegacyEquipmentResponse", authenticate)
        self.assertIn("constantTimeEqual", authenticate)
        self.assertIn("reason=response_size", authenticate)
        self.assertIn("mode=legacy_32", authenticate)
        self.assertIn("kLegacyEquipmentHoldCommandSize = 3", self.source)
        self.assertIn("kLegacyEquipmentCloseCommandSize = 1", self.source)
        self.assertIn("static_cast<uint8_t>(seconds >> 8)", legacy_send)
        self.assertIn("static_cast<uint8_t>(seconds)", legacy_send)
        self.assertIn("EquipmentSessionMode::Legacy32", hold)
        self.assertIn("clearEquipmentSessionSigningContext();", destroy)
        self.assertLess(
            maintain.index("destroyEquipmentClient();"),
            maintain.index(
                "if ((!authorized_equipment_session && !equipment_waiting_for_card)"
            ),
        )
        self.assertIn("no volver a habilitar", self.readme.lower())
        self.assertIn("-DVALIDATOR_ALLOW_LEGACY_EQUIPMENT=0", self.readme)

    def test_v4_identity_can_negotiate_exact_legacy_32_response(self) -> None:
        authenticate = function_body(
            self.source, "bool authenticateEquipmentAddress("
        )
        legacy_branch = authenticate[
            authenticate.index(
                "else if (response.size() == kLegacyEquipmentResponseSize)"
            ) : authenticate.index("} else {", authenticate.index(
                "else if (response.size() == kLegacyEquipmentResponseSize)"
            ))
        ]

        self.assertIn(
            "identity_protocol_version == fuel_equipment_ble::kProtocolVersion",
            authenticate,
        )
        self.assertNotIn("identity_protocol_version", legacy_branch)
        self.assertIn("#if VALIDATOR_ALLOW_LEGACY_EQUIPMENT == 1", legacy_branch)
        self.assertIn(
            "negotiated_mode = EquipmentSessionMode::Legacy32;", legacy_branch
        )

    def test_ble_session_commands_are_authenticated_and_sequenced(self) -> None:
        authenticate = function_body(
            self.source,
            "bool authenticateEquipmentAddress(const String& address, int rssi,",
        )
        tag = function_body(self.source, "bool buildEquipmentSessionTag(")
        send = function_body(
            self.source,
            "bool sendEquipmentSessionCommand(uint8_t operation, uint16_t seconds)",
        )
        close = function_body(self.source, "void closeEquipmentSession()")

        self.assertIn("equipment_session_challenge", authenticate)
        self.assertIn("equipment_session_secret", authenticate)
        self.assertIn("kSessionHmacDomain", tag)
        self.assertIn("kSessionCommandHeaderSize", tag)
        self.assertIn("encodeSessionCommandHeader", send)
        self.assertIn("buildEquipmentSessionTag", send)
        self.assertIn("kSessionCommandSize", send)
        self.assertIn("equipment_session_sequence = sequence;", send)
        self.assertIn("sendEquipmentSessionCommand", close)
        self.assertNotIn("writeValue(&command, 1", close)

    def test_mqtt_uses_current_idf_config_and_event_registration(self) -> None:
        start = function_body(self.source, "void startMqtt() {")

        self.assertIn("config.broker.address.uri", start)
        self.assertIn("config.broker.verification.certificate", start)
        self.assertIn("config.credentials.authentication.certificate", start)
        self.assertIn("config.credentials.authentication.key", start)
        self.assertIn("config.session.keepalive", start)
        self.assertIn("config.buffer.size", start)
        self.assertIn("esp_mqtt_client_register_event", start)

    def test_arduino_build_resolves_production_secrets(self) -> None:
        self.assertIn(
            '#if __has_include("../include/validator_secrets.h")', self.source
        )
        self.assertIn('#include "../include/validator_secrets.h"', self.source)

    def test_mim_registry_is_received_over_mqtt_and_persisted(self) -> None:
        mqtt = function_body(self.source, "esp_err_t onMqttEvent(esp_mqtt_event_handle_t event)")
        dispatcher = function_body(
            self.source, "void dispatchMqttMessage(PendingMqttMessage& message)"
        )
        handler = function_body(self.source, "void handleEquipmentRegistry(const char* payload, size_t length)")
        self.assertIn("equipment_registry_topic", mqtt)
        self.assertIn("DeferredMqttMessageType::EquipmentRegistry", mqtt)
        self.assertIn("handleEquipmentRegistry", dispatcher)
        self.assertIn("persistEquipmentRegistry", handler)
        self.assertIn("publishEquipmentRegistryStatus", handler)
        self.assertIn("kMaximumTrustedEquipment = 32", self.source)

    def test_ota_requires_https_mtls_hash_and_safe_idle(self) -> None:
        handler = function_body(
            self.source,
            "void handleOtaCommand(const char* payload, size_t length)",
        )
        download = function_body(self.source, "void performOtaUpdate()")
        safety = function_body(self.source, "bool otaSafeToStart()")
        self.assertIn('String(kOtaBaseUrl) + VALIDATOR_ID', handler)
        self.assertIn("validLowerHex(sha256, 64)", handler)
        self.assertIn("MQTT_CLIENT_CERT", download)
        self.assertIn("MQTT_CLIENT_KEY", download)
        self.assertIn("sha256Update", download)
        self.assertIn("esp_ota_set_boot_partition", download)
        self.assertIn("active_session.isEmpty()", safety)
        self.assertIn("!authorized_equipment_session", safety)

    def test_ota_releases_mqtt_tls_heap_and_reports_failure_after_reconnect(self) -> None:
        download = function_body(self.source, "void performOtaUpdate()")
        failure = function_body(
            self.source,
            "void failOtaUpdate(const char* detail, esp_http_client_handle_t client,",
        )
        connection = function_body(
            self.source, "void applyMqttConnectionChange()"
        )
        loop = function_body(self.source, "void loop()")

        self.assertIn("esp_mqtt_client_stop(mqtt_client)", download)
        self.assertLess(
            download.index("esp_mqtt_client_stop(mqtt_client)"),
            download.index("esp_http_client_open(client, 0)"),
        )
        self.assertIn("esp_http_client_get_and_clear_last_tls_error", download)
        self.assertIn("esp_mqtt_client_start(mqtt_client)", failure)
        self.assertIn("ota_failure_status_pending = true", failure)
        self.assertIn("publishPendingOtaFailure();", connection)
        self.assertIn("if (!ota_update_running) maintainMqttConnection();", loop)

    def test_ota_build_pins_dual_slots_and_requires_bootloader_rollback(self) -> None:
        self.assertIn("platform = espressif32@55.3.39", self.platformio)
        self.assertIn(
            "board_build.partitions = app3M_fat9M_fact512k_16MB.csv",
            self.platformio,
        )
        self.assertIn("CONFIG_BOOTLOADER_APP_ROLLBACK_ENABLE", self.source)
        self.assertIn(
            '#error "The RFID validator requires ESP-IDF bootloader app rollback"',
            self.source,
        )

    def test_ota_receipt_survives_healthy_and_mqtt_reconnect_until_empty_ack(self) -> None:
        callback = function_body(
            self.source, "esp_err_t onMqttEvent(esp_mqtt_event_handle_t event)"
        )
        queue = function_body(
            self.source,
            "bool queueMqttMessage(DeferredMqttMessageType type, const char* payload,",
        )
        handler = function_body(
            self.source,
            "void handleOtaCommand(const char* payload, size_t length)",
        )
        connection = function_body(
            self.source, "void applyMqttConnectionChange()"
        )
        confirm = function_body(
            self.source, "void confirmRunningOtaImageIfHealthy()"
        )
        acknowledgement = function_body(
            self.source, "void acknowledgeOtaReceipt()"
        )
        deferred = function_body(
            self.source, "void completeDeferredOtaReceiptAck()"
        )

        empty_ota = callback.index("event->total_data_len == 0")
        invalid_length = callback.index("event->total_data_len != event->data_len")
        self.assertLess(empty_ota, invalid_length)
        self.assertIn("empty_ota_ack", queue)
        self.assertIn("if (length == 0)", handler)
        self.assertIn("acknowledgeOtaReceipt();", handler)
        self.assertIn("ota_receipt_pending", connection)
        self.assertIn("publishPendingOtaReceipt();", connection)
        self.assertNotIn("clearOtaBootMetadata();", confirm)
        self.assertIn("clearOtaBootMetadata();", acknowledgement)
        self.assertIn("running_image_pending_verification", acknowledgement)
        self.assertIn('putBool("ack-pending", true)', acknowledgement)
        self.assertIn("clearOtaBootMetadata();", deferred)
        self.assertIn("completeDeferredOtaReceiptAck();", connection)

    def test_ota_receipt_is_committed_before_boot_selection(self) -> None:
        download = function_body(self.source, "void performOtaUpdate()")

        metadata = download.index('ota_preferences.putString("target"')
        select = download.index("esp_ota_set_boot_partition(target)")
        self.assertLess(metadata, select)
        self.assertIn('ota_preferences.putString("nonce"', download)
        self.assertIn('ota_preferences.putString("previous"', download)
        self.assertIn("target_state != ESP_OTA_IMG_NEW", download)

    def test_ota_rejects_a_physical_bootloader_without_pending_verify(self) -> None:
        initialize = function_body(
            self.source, "void initializeOtaRollbackState()"
        )
        rollback = function_body(
            self.source, "void rollbackRunningOtaImage(const char* reason)"
        )
        setup = function_body(self.source, "void setup()")

        self.assertIn("state != ESP_OTA_IMG_VALID", initialize)
        self.assertIn("ota_boot_state_invalid = true;", initialize)
        self.assertIn('rollbackRunningOtaImage("bootloader_state")', setup)
        self.assertIn("esp_ota_mark_app_invalid_rollback_and_reboot", rollback)
        self.assertIn("ota_boot_previous_partition", rollback)
        self.assertIn("esp_ota_set_boot_partition(previous)", rollback)

    def test_ota_boot_is_confirmed_or_rolled_back(self) -> None:
        confirm = function_body(
            self.source, "void confirmRunningOtaImageIfHealthy()"
        )
        rollback = function_body(
            self.source, "void rollbackUnhealthyOtaImageIfExpired()"
        )
        self.assertIn("esp_ota_mark_app_valid_cancel_rollback", confirm)
        self.assertIn("mqtt_online", confirm)
        self.assertIn("rfid_ready", confirm)
        self.assertIn('rollbackRunningOtaImage("health_timeout")', rollback)


if __name__ == "__main__":
    unittest.main()
