#include <Arduino.h>
#include <ArduinoJson.h>
#include <HTTPClient.h>
#include <NimBLEDevice.h>
#include <Preferences.h>
#include <Update.h>
#include <WebServer.h>
#include <WiFi.h>
#include <vector>
#include <esp_app_desc.h>
#include <esp_ota_ops.h>
#include <esp_random.h>
#include <esp_secure_boot.h>
#include <esp_sleep.h>
#include <esp_system.h>
#include <esp_task_wdt.h>
#include <mbedtls/md.h>

#include <equipment_ble_protocol.h>

#define MIM_FIRMWARE_VERSION "0.6.2"
#define MIM_FIRMWARE_SECURE_VERSION 1U

// El core Arduino enlaza por defecto una descripción débil de la librería
// precompilada ("arduino-lib-builder", secure_version 0). Una definición
// fuerte y determinista evita liberar un OTA sin identidad ni nivel
// anti-rollback verificables. El SHA-256 del ELF se completa al generar la
// imagen ESP32.
extern "C" const esp_app_desc_t esp_app_desc
    __attribute__((section(".rodata_desc"), used)) = {
        ESP_APP_DESC_MAGIC_WORD,
        MIM_FIRMWARE_SECURE_VERSION,
        {0, 0},
        MIM_FIRMWARE_VERSION,
        "fuel-mim",
        "00:00:00",
        "Jan 01 1970",
        "v5.5.4",
        {0},
        0,
        199,
        16,
        {0},
        {0},
};

#if __has_include("equipment_secrets.h")
#include "equipment_secrets.h"
#ifndef EQUIPMENT_PROVISIONED
// Compatibilidad con headers de fábrica generados antes del schema 0.4.
#define EQUIPMENT_PROVISIONED 1
#endif
#else
#define EQUIPMENT_PROVISIONED 0
#define EQUIPMENT_MODULE_ID ""
#define FACTORY_EQUIPMENT_ID ""
static const unsigned char EQUIPMENT_MODULE_SECRET[32] = {};
#define PROVISIONING_AP_PASSWORD ""
#define CONFIG_BUTTON_PIN 2
#define OPERATIONAL_ADVERTISE_WINDOW_SECONDS 60
#define BLE_TX_POWER_DBM 20
#endif

#if __has_include("equipment_network_secrets.h")
#include "equipment_network_secrets.h"
#ifndef EQUIPMENT_NETWORK_PROVISIONED
#define EQUIPMENT_NETWORK_PROVISIONED 1
#endif
#else
#define EQUIPMENT_NETWORK_PROVISIONED 0
#define ENROLLMENT_WIFI_SSID ""
#define ENROLLMENT_WIFI_PASSWORD ""
#define ENROLLMENT_SERVER_URL "http://10.42.0.1:8788"
#endif

// Los headers de fábrica anteriores a 0.6.0 conservan identidad y secreto, pero
// no definen la nueva política energética. Estos defaults migran esas unidades
// sin exigir rotar su identidad criptográfica.
#ifndef OPERATIONAL_ADVERTISE_WINDOW_SECONDS
#define OPERATIONAL_ADVERTISE_WINDOW_SECONDS 60
#endif
#ifndef BLE_TX_POWER_DBM
#define BLE_TX_POWER_DBM 20
#endif

namespace {

static_assert(OPERATIONAL_ADVERTISE_WINDOW_SECONDS == 60,
              "la búsqueda operacional debe durar exactamente 60 segundos");
static_assert(BLE_TX_POWER_DBM >= -3 && BLE_TX_POWER_DBM <= 20,
              "BLE_TX_POWER_DBM fuera del rango ESP32-C3");
static_assert(CONFIG_BUTTON_PIN >= 0 && CONFIG_BUTTON_PIN < 64,
              "CONFIG_BUTTON_PIN no cabe en la máscara de despertar");
static_assert(sizeof(EQUIPMENT_MODULE_SECRET) == 32,
              "EQUIPMENT_MODULE_SECRET debe tener exactamente 32 bytes");

constexpr char kFirmwareVersion[] = MIM_FIRMWARE_VERSION;
constexpr char kPreferencesNamespace[] = "fuel-equipment";
constexpr char kPortalUser[] = "admin";
constexpr uint8_t kClaimStateSchema = 1;
constexpr uint8_t kWifiProtocolVersion = 2;
constexpr size_t kMaximumIdentifierLength = 63;
constexpr size_t kMaximumHttpResponseBytes = 4096;
constexpr size_t kIdentityPayloadBytes = 768;
constexpr uint16_t kChallengeGraceSeconds = 5;
constexpr unsigned long kFactoryResetHoldMilliseconds = 20000;
constexpr uint32_t kButtonDebounceMilliseconds = 40;
constexpr unsigned long kWifiRetryMilliseconds = 3000;
constexpr unsigned long kWifiMaximumRetryMilliseconds = 60000;
constexpr unsigned long kEnrollmentPollMilliseconds = 2000;
constexpr unsigned long kEnrollmentPendingPollMilliseconds = 15000;
constexpr unsigned long kEnrollmentMaximumPollMilliseconds = 30000;
constexpr unsigned long kOtaValidationMilliseconds = 90000;
constexpr unsigned long kBleHealthValidationMilliseconds = 5000;
constexpr unsigned long kMaintenanceTimeoutMilliseconds = 10UL * 60UL * 1000UL;
constexpr uint32_t kTaskWatchdogMilliseconds = 15000;
constexpr char kWifiServerDomain[] = "fuel-edge/equipment/wifi/server/v2";
constexpr char kWifiClientDomain[] = "fuel-edge/equipment/wifi/client/v2";
constexpr char kWifiResponseDomain[] = "fuel-edge/equipment/wifi/response/v2";
constexpr char kWifiReceiptDomain[] = "fuel-edge/equipment/wifi/receipt/v2";
// BLE usa unidades de 0,625 ms: 160–240 equivale a 100–150 ms. Esta cadencia
// entrega varios anuncios en cada bloque de escaneo de 1 s del validador sin
// mantener el radio despierto más tiempo del necesario.
constexpr uint16_t kAdvertisementMinIntervalUnits = 160;
constexpr uint16_t kAdvertisementMaxIntervalUnits = 240;

Preferences preferences;
WebServer portal(80);
String equipment_id;
String site_id;
String device_name;
String configured_ssid;
String configured_wifi_password;
String claimed_module_id;
String pending_command_id;
String pending_claim_hash;
String pending_receipt;
bool maintenance_mode = false;
bool wifi_enrollment_mode = false;
bool ota_upload_ok = false;
bool ota_restart_pending = false;
bool claimed = false;
bool enrollment_ack_pending = false;
bool claim_storage_valid = false;
bool watchdog_ready = false;
bool ble_runtime_ready = false;
bool wifi_runtime_healthy = false;
bool running_image_pending_verification = false;
bool factory_identity_valid = false;
unsigned long advertising_started_at = 0;
unsigned long next_wifi_attempt_at = 0;
unsigned long next_enrollment_poll_at = 0;
unsigned long wifi_retry_delay = kWifiRetryMilliseconds;
unsigned long enrollment_poll_delay = kEnrollmentPollMilliseconds;
unsigned long ota_validation_deadline = 0;
unsigned long ble_health_started_at = 0;
unsigned long maintenance_last_activity_at = 0;
esp_sleep_wakeup_cause_t boot_wakeup_cause = ESP_SLEEP_WAKEUP_UNDEFINED;
uint32_t active_advertise_window_seconds =
    OPERATIONAL_ADVERTISE_WINDOW_SECONDS;
bool operator_wake_requested = false;
bool button_raw_low = false;
bool button_stable_low = false;
uint32_t button_raw_changed_at = 0;

portMUX_TYPE ble_state_mux = portMUX_INITIALIZER_UNLOCKED;
constexpr uint16_t kInvalidConnectionHandle = UINT16_MAX;
uint16_t active_connection_handle = kInvalidConnectionHandle;
uint32_t connection_deadline_at = 0;
uint32_t session_lease_until = 0;
uint32_t reconnect_awake_until = 0;
uint32_t last_session_sequence = 0;
bool ble_connected = false;
bool session_challenge_ready = false;
bool ble_disconnect_requested = false;
bool signed_session_closed = false;
uint8_t session_challenge[fuel_equipment_ble::kChallengeSize] = {};
uint8_t session_module_nonce[fuel_equipment_ble::kModuleNonceSize] = {};

bool confirmRunningOtaImage();
void rollbackRunningOtaImage(const char* reason);

NimBLEServer* ble_server = nullptr;
NimBLECharacteristic* identity_characteristic = nullptr;
NimBLECharacteristic* response_characteristic = nullptr;

bool validIdentifier(const String& value) {
  if (value.isEmpty() || value.length() > kMaximumIdentifierLength) return false;
  for (size_t index = 0; index < value.length(); ++index) {
    const char character = value[index];
    const bool valid = isalnum(static_cast<unsigned char>(character)) ||
                       character == '.' || character == '_' || character == '-';
    if (!valid || (index == 0 && !isalnum(static_cast<unsigned char>(character)))) {
      return false;
    }
  }
  return true;
}

bool validDisplayName(const String& value) {
  if (value.length() < 3 || value.length() >
      fuel_equipment_ble::kMaximumClaimValueLength) return false;
  for (size_t index = 0; index < value.length(); ++index) {
    const unsigned char character = static_cast<unsigned char>(value[index]);
    if (character < 0x20 || character == 0x7f || character == '<' ||
        character == '>') return false;
  }
  return true;
}

bool moduleSecretConfigured() {
  uint8_t aggregate = 0;
  for (const unsigned char value : EQUIPMENT_MODULE_SECRET) aggregate |= value;
  return aggregate != 0;
}

bool portalPasswordConfigured() {
  return strlen(PROVISIONING_AP_PASSWORD) >= 12 &&
         strlen(PROVISIONING_AP_PASSWORD) <= 63 &&
         strstr(PROVISIONING_AP_PASSWORD, "REEMPLAZAR") == nullptr;
}

bool deadlinePending(uint32_t deadline, uint32_t now) {
  return deadline != 0 && static_cast<int32_t>(deadline - now) > 0;
}

unsigned long retryWithJitter(unsigned long base,
                              unsigned long maximum) {
  const unsigned long bounded = min(base, maximum);
  const unsigned long lower = bounded - (bounded / 4UL);
  const unsigned long window = max(1UL, bounded - lower + 1UL);
  return lower + (esp_random() % window);
}

String equipmentBleName() {
  const String suffix = String(EQUIPMENT_MODULE_ID).substring(
      max(0, static_cast<int>(strlen(EQUIPMENT_MODULE_ID)) - 6));
  return "Fuel-" + suffix;
}

bool buildEquipmentResponse(
    const uint8_t challenge[fuel_equipment_ble::kChallengeSize],
    const uint8_t module_nonce[fuel_equipment_ble::kModuleNonceSize],
    uint8_t response_tag[fuel_equipment_ble::kResponseTagSize]) {
  const mbedtls_md_info_t* info = mbedtls_md_info_from_type(MBEDTLS_MD_SHA256);
  if (info == nullptr) return false;
  mbedtls_md_context_t context;
  mbedtls_md_init(&context);
  bool ok = mbedtls_md_setup(&context, info, 1) == 0;
  ok = ok && mbedtls_md_hmac_starts(
                 &context, EQUIPMENT_MODULE_SECRET,
                 sizeof(EQUIPMENT_MODULE_SECRET)) == 0;
  ok = ok && mbedtls_md_hmac_update(
                 &context,
                 reinterpret_cast<const unsigned char*>(
                     fuel_equipment_ble::kHmacDomain),
                 sizeof(fuel_equipment_ble::kHmacDomain)) == 0;
  ok = ok && mbedtls_md_hmac_update(
                 &context,
                 reinterpret_cast<const unsigned char*>(EQUIPMENT_MODULE_ID),
                 strlen(EQUIPMENT_MODULE_ID)) == 0;
  const uint8_t separator = 0;
  ok = ok && mbedtls_md_hmac_update(&context, &separator, 1) == 0;
  ok = ok && mbedtls_md_hmac_update(
                 &context,
                 reinterpret_cast<const unsigned char*>(equipment_id.c_str()),
                 equipment_id.length()) == 0;
  ok = ok && mbedtls_md_hmac_update(&context, &separator, 1) == 0;
  ok = ok && mbedtls_md_hmac_update(
                 &context, challenge,
                 fuel_equipment_ble::kChallengeSize) == 0;
  ok = ok && mbedtls_md_hmac_update(
                 &context, module_nonce,
                 fuel_equipment_ble::kModuleNonceSize) == 0;
  ok = ok && mbedtls_md_hmac_finish(&context, response_tag) == 0;
  mbedtls_md_free(&context);
  return ok;
}

bool refreshIdentity() {
  // Durante el enrolamiento Wi-Fi todavía no existe el servidor GATT; la
  // identidad se construirá al iniciar el ciclo BLE después del reinicio.
  if (identity_characteristic == nullptr) return true;
  JsonDocument document;
  document["version"] = fuel_equipment_ble::kProtocolVersion;
  document["module_id"] = EQUIPMENT_MODULE_ID;
  document["equipment_id"] = equipment_id;
  document["site_id"] = site_id;
  document["device_name"] = device_name;
  document["claimed"] = claimed;
  document["firmware"] = kFirmwareVersion;
  const size_t required = measureJson(document);
  if (required == 0 || required + 1 > kIdentityPayloadBytes) {
    Serial.printf("ble=identity_oversize bytes=%u capacity=%u\n",
                  static_cast<unsigned int>(required),
                  static_cast<unsigned int>(kIdentityPayloadBytes));
    return false;
  }
  char payload[kIdentityPayloadBytes];
  const size_t length = serializeJson(document, payload, sizeof(payload));
  if (length != required) return false;
  identity_characteristic->setValue(
      reinterpret_cast<const uint8_t*>(payload), length);
  return true;
}

bool startAdvertising(bool reset_window = false) {
  NimBLEAdvertising* advertising = NimBLEDevice::getAdvertising();
  if (advertising == nullptr) return false;
  advertising->stop();
  advertising->setMinInterval(kAdvertisementMinIntervalUnits);
  advertising->setMaxInterval(kAdvertisementMaxIntervalUnits);
  NimBLEAdvertisementData data;
  const uint8_t flags = claimed ? fuel_equipment_ble::kFlagConfigured
                                : fuel_equipment_ble::kFlagEnrollmentReady;
  const uint8_t manufacturer[fuel_equipment_ble::kAdvertisementSize] = {
      fuel_equipment_ble::kAdvertisementMagic0,
      fuel_equipment_ble::kAdvertisementMagic1,
      fuel_equipment_ble::kProtocolVersion,
      flags,
  };
  data.setManufacturerData(std::string(
      reinterpret_cast<const char*>(manufacturer), sizeof(manufacturer)));
  data.setFlags(0x06);
  // Un nombre corto cabe junto a flags y manufacturer data en los 31 bytes del
  // anuncio legacy. Así una persona puede confirmar alimentación desde un
  // celular sin conocer la dirección BLE aleatoria del módulo.
  if (!data.setName(equipmentBleName().c_str())) return false;
  if (!advertising->setAdvertisementData(data)) return false;
  advertising->enableScanResponse(false);
  if (reset_window) advertising_started_at = millis();
  return advertising->start();
}

const char* wakeCauseName(esp_sleep_wakeup_cause_t cause) {
  switch (cause) {
    case ESP_SLEEP_WAKEUP_GPIO:
      return "button";
    case ESP_SLEEP_WAKEUP_EXT1:
      return "button_ext1";
    case ESP_SLEEP_WAKEUP_UNDEFINED:
      return "cold_boot";
    default:
      return "other";
  }
}

bool wokeFromOperatorButton(esp_sleep_wakeup_cause_t cause) {
  return cause == ESP_SLEEP_WAKEUP_GPIO || cause == ESP_SLEEP_WAKEUP_EXT1;
}

void configureBootWakePolicy() {
  boot_wakeup_cause = esp_sleep_get_wakeup_cause();
  operator_wake_requested = wokeFromOperatorButton(boot_wakeup_cause);
  active_advertise_window_seconds = OPERATIONAL_ADVERTISE_WINDOW_SECONDS;
  Serial.printf("wake=cause_%s code=%d advertise_seconds=%lu\n",
                wakeCauseName(boot_wakeup_cause),
                static_cast<int>(boot_wakeup_cause),
                static_cast<unsigned long>(active_advertise_window_seconds));
}

void initializeButtonState() {
  button_raw_low = digitalRead(CONFIG_BUTTON_PIN) == LOW;
  button_stable_low = button_raw_low;
  button_raw_changed_at = millis();
}

void activateOperatorWindow(uint32_t now, const char* reason) {
  if (operator_wake_requested) {
    // Una ventana operacional ya iniciada es fija: pulsaciones repetidas no
    // permiten agotar la batería extendiendo indefinidamente los 60 segundos.
    Serial.printf("button=ignored reason=%s window_already_active=true\n", reason);
    return;
  }
  // Una pulsación durante la breve autoprueba de una OTA sí convierte ese
  // arranque excepcional en una ventana operacional completa.
  operator_wake_requested = true;
  active_advertise_window_seconds = OPERATIONAL_ADVERTISE_WINDOW_SECONDS;
  advertising_started_at = now;
  Serial.printf("button=operational_window_started reason=%s seconds=%lu\n",
                reason,
                static_cast<unsigned long>(active_advertise_window_seconds));
}

void maintainOperationalButton(uint32_t now) {
  const bool raw_low = digitalRead(CONFIG_BUTTON_PIN) == LOW;
  if (raw_low != button_raw_low) {
    button_raw_low = raw_low;
    button_raw_changed_at = now;
  }
  if (raw_low == button_stable_low ||
      now - button_raw_changed_at < kButtonDebounceMilliseconds) {
    return;
  }
  button_stable_low = raw_low;
  if (button_stable_low) {
    activateOperatorWindow(now, "press");
  } else {
    Serial.println("button=released");
  }
}

bool constantTimeEqual(const uint8_t* left, const uint8_t* right, size_t length) {
  uint8_t difference = 0;
  for (size_t index = 0; index < length; ++index) difference |= left[index] ^ right[index];
  return difference == 0;
}

bool buildSessionCommandTag(
    const uint8_t challenge[fuel_equipment_ble::kChallengeSize],
    const uint8_t module_nonce[fuel_equipment_ble::kModuleNonceSize],
    const uint8_t header[fuel_equipment_ble::kSessionCommandHeaderSize],
    uint8_t tag[fuel_equipment_ble::kSessionTagSize]) {
  const mbedtls_md_info_t* info = mbedtls_md_info_from_type(MBEDTLS_MD_SHA256);
  if (info == nullptr) return false;
  mbedtls_md_context_t context;
  mbedtls_md_init(&context);
  const uint8_t separator = 0;
  bool ok = mbedtls_md_setup(&context, info, 1) == 0;
  ok = ok && mbedtls_md_hmac_starts(
                 &context, EQUIPMENT_MODULE_SECRET,
                 sizeof(EQUIPMENT_MODULE_SECRET)) == 0;
  ok = ok && mbedtls_md_hmac_update(
                 &context,
                 reinterpret_cast<const uint8_t*>(
                     fuel_equipment_ble::kSessionHmacDomain),
                 sizeof(fuel_equipment_ble::kSessionHmacDomain)) == 0;
  ok = ok && mbedtls_md_hmac_update(
                 &context,
                 reinterpret_cast<const uint8_t*>(EQUIPMENT_MODULE_ID),
                 strlen(EQUIPMENT_MODULE_ID)) == 0;
  ok = ok && mbedtls_md_hmac_update(&context, &separator, 1) == 0;
  ok = ok && mbedtls_md_hmac_update(
                 &context,
                 reinterpret_cast<const uint8_t*>(equipment_id.c_str()),
                 equipment_id.length()) == 0;
  ok = ok && mbedtls_md_hmac_update(&context, &separator, 1) == 0;
  ok = ok && mbedtls_md_hmac_update(
                 &context, challenge,
                 fuel_equipment_ble::kChallengeSize) == 0;
  ok = ok && mbedtls_md_hmac_update(
                 &context, module_nonce,
                 fuel_equipment_ble::kModuleNonceSize) == 0;
  ok = ok && mbedtls_md_hmac_update(
                 &context, header,
                 fuel_equipment_ble::kSessionCommandHeaderSize) == 0;
  ok = ok && mbedtls_md_hmac_finish(&context, tag) == 0;
  mbedtls_md_free(&context);
  return ok;
}

class ServerCallbacks final : public NimBLEServerCallbacks {
  void onConnect(NimBLEServer* server, NimBLEConnInfo& connection) override {
    const uint16_t handle = connection.getConnHandle();
    bool accepted = false;
    portENTER_CRITICAL(&ble_state_mux);
    if (active_connection_handle == kInvalidConnectionHandle) {
      active_connection_handle = handle;
      ble_connected = true;
      connection_deadline_at =
          millis() + (kChallengeGraceSeconds * 1000UL);
      session_lease_until = 0;
      last_session_sequence = 0;
      session_challenge_ready = false;
      ble_disconnect_requested = false;
      signed_session_closed = false;
      memset(session_challenge, 0, sizeof(session_challenge));
      memset(session_module_nonce, 0, sizeof(session_module_nonce));
      accepted = true;
    }
    portEXIT_CRITICAL(&ble_state_mux);
    if (!accepted) {
      Serial.printf("ble=connection_rejected handle=%u reason=busy\n", handle);
      server->disconnect(handle);
      return;
    }
    Serial.printf(
        "ble=connected peer=%s handle=%u interval_ms=%lu timeout_ms=%lu\n",
        connection.getAddress().toString().c_str(), handle,
        static_cast<unsigned long>(connection.getConnInterval() * 5UL / 4UL),
        static_cast<unsigned long>(connection.getConnTimeout() * 10UL));
  }

  void onDisconnect(NimBLEServer*, NimBLEConnInfo& connection,
                    int reason) override {
    const uint16_t handle = connection.getConnHandle();
    bool active_peer = false;
    portENTER_CRITICAL(&ble_state_mux);
    if (active_connection_handle == handle) {
      active_connection_handle = kInvalidConnectionHandle;
      ble_connected = false;
      connection_deadline_at = 0;
      session_lease_until = 0;
      last_session_sequence = 0;
      session_challenge_ready = false;
      ble_disconnect_requested = false;
      memset(session_challenge, 0, sizeof(session_challenge));
      memset(session_module_nonce, 0, sizeof(session_module_nonce));
      active_peer = true;
    }
    portEXIT_CRITICAL(&ble_state_mux);
    if (!active_peer) return;
    Serial.printf("ble=disconnected peer=%s reason=0x%02x\n",
                  connection.getAddress().toString().c_str(), reason);
    if (!startAdvertising(false)) {
      Serial.println("ble=advertising_restart_failed");
    }
  }
};

class ChallengeCallbacks final : public NimBLECharacteristicCallbacks {
  void onWrite(NimBLECharacteristic* characteristic,
               NimBLEConnInfo& connection) override {
    const std::string value = characteristic->getValue();
    if (value.size() != fuel_equipment_ble::kChallengeSize ||
        response_characteristic == nullptr) {
      return;
    }
    uint8_t module_nonce[fuel_equipment_ble::kModuleNonceSize];
    esp_fill_random(module_nonce, sizeof(module_nonce));
    bool accepted = false;
    portENTER_CRITICAL(&ble_state_mux);
    if (ble_connected &&
        active_connection_handle == connection.getConnHandle() &&
        !session_challenge_ready) {
      memcpy(session_challenge, value.data(), sizeof(session_challenge));
      memcpy(session_module_nonce, module_nonce, sizeof(session_module_nonce));
      session_challenge_ready = true;
      accepted = true;
    }
    portEXIT_CRITICAL(&ble_state_mux);
    if (!accepted) return;

    uint8_t response[fuel_equipment_ble::kResponseSize];
    memcpy(response, module_nonce, sizeof(module_nonce));
    if (!buildEquipmentResponse(
            reinterpret_cast<const uint8_t*>(value.data()), module_nonce,
            response + fuel_equipment_ble::kModuleNonceSize)) {
      portENTER_CRITICAL(&ble_state_mux);
      if (active_connection_handle == connection.getConnHandle()) {
        session_challenge_ready = false;
        memset(session_challenge, 0, sizeof(session_challenge));
        memset(session_module_nonce, 0, sizeof(session_module_nonce));
      }
      portEXIT_CRITICAL(&ble_state_mux);
      return;
    }
    response_characteristic->setValue(response, sizeof(response));
    response_characteristic->notify();
  }
};

class SessionCallbacks final : public NimBLECharacteristicCallbacks {
  void onWrite(NimBLECharacteristic* characteristic,
               NimBLEConnInfo& connection) override {
    const std::string value = characteristic->getValue();
    if (value.size() != fuel_equipment_ble::kSessionCommandSize) return;
    uint8_t command[fuel_equipment_ble::kSessionCommandSize];
    memcpy(command, value.data(), sizeof(command));
    if (command[0] != fuel_equipment_ble::kSessionCommandVersion) return;
    const uint8_t operation = command[1];
    const uint16_t seconds = fuel_equipment_ble::decodeHoldSeconds(command);
    const uint32_t sequence =
        fuel_equipment_ble::decodeSessionSequence(command);
    if (sequence == 0 ||
        (operation == fuel_equipment_ble::kCommandHoldAwake &&
         (seconds == 0 ||
          seconds > fuel_equipment_ble::kMaximumHoldSeconds)) ||
        (operation == fuel_equipment_ble::kCommandCloseSession && seconds != 0) ||
        (operation != fuel_equipment_ble::kCommandHoldAwake &&
         operation != fuel_equipment_ble::kCommandCloseSession)) {
      return;
    }

    uint8_t challenge[fuel_equipment_ble::kChallengeSize];
    uint8_t module_nonce[fuel_equipment_ble::kModuleNonceSize];
    bool state_valid = false;
    portENTER_CRITICAL(&ble_state_mux);
    if (ble_connected && session_challenge_ready &&
        active_connection_handle == connection.getConnHandle() &&
        last_session_sequence != UINT32_MAX &&
        sequence == last_session_sequence + 1) {
      memcpy(challenge, session_challenge, sizeof(challenge));
      memcpy(module_nonce, session_module_nonce, sizeof(module_nonce));
      state_valid = true;
    }
    portEXIT_CRITICAL(&ble_state_mux);
    if (!state_valid) return;

    uint8_t expected[fuel_equipment_ble::kSessionTagSize];
    if (!buildSessionCommandTag(challenge, module_nonce, command, expected) ||
        !constantTimeEqual(
            expected,
            command + fuel_equipment_ble::kSessionCommandHeaderSize,
            sizeof(expected))) {
      Serial.println("ble=session_command_rejected reason=authentication");
      return;
    }

    bool applied = false;
    portENTER_CRITICAL(&ble_state_mux);
    if (ble_connected && session_challenge_ready &&
        active_connection_handle == connection.getConnHandle() &&
        last_session_sequence != UINT32_MAX &&
        sequence == last_session_sequence + 1) {
      last_session_sequence = sequence;
      if (operation == fuel_equipment_ble::kCommandHoldAwake) {
        connection_deadline_at = 0;
        const uint32_t lease_until =
            millis() + (static_cast<uint32_t>(seconds) * 1000UL);
        session_lease_until = lease_until;
        // Una caída de radio no debe mandar el MIM a dormir antes de que el
        // validador alcance a reconectar. Esta gracia sólo nace de un HOLD
        // firmado; nunca autoriza al peer siguiente ni extiende su handshake.
        reconnect_awake_until = lease_until;
        ble_disconnect_requested = false;
        signed_session_closed = false;
      } else {
        session_lease_until = 0;
        reconnect_awake_until = 0;
        ble_disconnect_requested = true;
        // Sólo un CLOSE autenticado permite omitir el resto de la ventana y
        // volver inmediatamente a deep sleep después del disconnect.
        signed_session_closed = true;
      }
      applied = true;
    }
    portEXIT_CRITICAL(&ble_state_mux);
    if (applied) {
      Serial.printf("ble=session_command operation=%u sequence=%lu seconds=%u\n",
                    operation, static_cast<unsigned long>(sequence), seconds);
    }
  }
};

String hexEncode(const uint8_t* value, size_t length) {
  constexpr char digits[] = "0123456789abcdef";
  String encoded;
  encoded.reserve(length * 2);
  for (size_t index = 0; index < length; ++index) {
    encoded += digits[value[index] >> 4];
    encoded += digits[value[index] & 0x0f];
  }
  return encoded;
}

bool hexDecode(const String& encoded, uint8_t* output, size_t length) {
  if (encoded.length() != length * 2) return false;
  auto nibble = [](char character) -> int {
    if (character >= '0' && character <= '9') return character - '0';
    if (character >= 'a' && character <= 'f') return character - 'a' + 10;
    if (character >= 'A' && character <= 'F') return character - 'A' + 10;
    return -1;
  };
  for (size_t index = 0; index < length; ++index) {
    const int high = nibble(encoded[index * 2]);
    const int low = nibble(encoded[index * 2 + 1]);
    if (high < 0 || low < 0) return false;
    output[index] = static_cast<uint8_t>((high << 4) | low);
  }
  return true;
}

bool computeWifiHmac(const char* domain, size_t domain_size,
                     const uint8_t client_nonce[32],
                     const uint8_t server_nonce[32], const char* action,
                     const String& payload, uint8_t output[32]) {
  const mbedtls_md_info_t* info = mbedtls_md_info_from_type(MBEDTLS_MD_SHA256);
  if (info == nullptr) return false;
  mbedtls_md_context_t context;
  mbedtls_md_init(&context);
  const uint8_t separator = 0;
  bool ok = mbedtls_md_setup(&context, info, 1) == 0;
  ok = ok && mbedtls_md_hmac_starts(&context, EQUIPMENT_MODULE_SECRET,
                                     sizeof(EQUIPMENT_MODULE_SECRET)) == 0;
  ok = ok && mbedtls_md_hmac_update(
                 &context, reinterpret_cast<const uint8_t*>(domain),
                 domain_size) == 0;
  ok = ok && mbedtls_md_hmac_update(
                 &context,
                 reinterpret_cast<const uint8_t*>(EQUIPMENT_MODULE_ID),
                 strlen(EQUIPMENT_MODULE_ID)) == 0;
  ok = ok && mbedtls_md_hmac_update(&context, &separator, 1) == 0;
  ok = ok && mbedtls_md_hmac_update(&context, client_nonce, 32) == 0;
  ok = ok && mbedtls_md_hmac_update(&context, server_nonce, 32) == 0;
  if (action != nullptr) {
    ok = ok && mbedtls_md_hmac_update(
                   &context, reinterpret_cast<const uint8_t*>(action),
                   strlen(action)) == 0;
    ok = ok && mbedtls_md_hmac_update(&context, &separator, 1) == 0;
    ok = ok && mbedtls_md_hmac_update(
                   &context, reinterpret_cast<const uint8_t*>(payload.c_str()),
                   payload.length()) == 0;
  }
  ok = ok && mbedtls_md_hmac_finish(&context, output) == 0;
  mbedtls_md_free(&context);
  return ok;
}

bool computeWifiServerProof(const uint8_t client_nonce[32],
                            const uint8_t server_nonce[32],
                            const char* action, uint32_t ttl_seconds,
                            uint8_t output[32]) {
  const mbedtls_md_info_t* info = mbedtls_md_info_from_type(MBEDTLS_MD_SHA256);
  if (info == nullptr || action == nullptr || ttl_seconds == 0) return false;
  mbedtls_md_context_t context;
  mbedtls_md_init(&context);
  const uint8_t separator = 0;
  const uint8_t ttl[4] = {
      static_cast<uint8_t>(ttl_seconds >> 24),
      static_cast<uint8_t>(ttl_seconds >> 16),
      static_cast<uint8_t>(ttl_seconds >> 8),
      static_cast<uint8_t>(ttl_seconds),
  };
  bool ok = mbedtls_md_setup(&context, info, 1) == 0;
  ok = ok && mbedtls_md_hmac_starts(&context, EQUIPMENT_MODULE_SECRET,
                                     sizeof(EQUIPMENT_MODULE_SECRET)) == 0;
  ok = ok && mbedtls_md_hmac_update(
                 &context, reinterpret_cast<const uint8_t*>(kWifiServerDomain),
                 sizeof(kWifiServerDomain)) == 0;
  ok = ok && mbedtls_md_hmac_update(
                 &context,
                 reinterpret_cast<const uint8_t*>(EQUIPMENT_MODULE_ID),
                 strlen(EQUIPMENT_MODULE_ID)) == 0;
  ok = ok && mbedtls_md_hmac_update(&context, &separator, 1) == 0;
  ok = ok && mbedtls_md_hmac_update(&context, client_nonce, 32) == 0;
  ok = ok && mbedtls_md_hmac_update(&context, server_nonce, 32) == 0;
  ok = ok && mbedtls_md_hmac_update(
                 &context, reinterpret_cast<const uint8_t*>(action),
                 strlen(action)) == 0;
  ok = ok && mbedtls_md_hmac_update(&context, &separator, 1) == 0;
  ok = ok && mbedtls_md_hmac_update(&context, ttl, sizeof(ttl)) == 0;
  ok = ok && mbedtls_md_hmac_finish(&context, output) == 0;
  mbedtls_md_free(&context);
  return ok;
}

bool verifyWifiResponseProof(const uint8_t client_nonce[32],
                             const uint8_t server_nonce[32],
                             const char* action, const String& request_payload,
                             JsonDocument& response) {
  uint8_t supplied[32];
  if (!hexDecode(response["serverProof"] | "", supplied, sizeof(supplied))) {
    return false;
  }
  const String state = response["state"] | "";
  const String command_id = response["commandId"] | "";
  const String claim_hex = response["claim"] | "";
  std::vector<uint8_t> claim;
  if (strcmp(action, "status") == 0 && state == "pending") {
    if (!command_id.isEmpty() || !claim_hex.isEmpty()) return false;
  } else if (strcmp(action, "status") == 0 && state == "claim") {
    if (!validIdentifier(command_id) || claim_hex.isEmpty() ||
        claim_hex.length() > 512 || claim_hex.length() % 2 != 0) {
      return false;
    }
    claim.resize(claim_hex.length() / 2);
    if (!hexDecode(claim_hex, claim.data(), claim.size())) return false;
  } else if (strcmp(action, "confirm") == 0 && state == "confirmed") {
    if (!validIdentifier(command_id) || !claim_hex.isEmpty()) return false;
  } else {
    return false;
  }

  const mbedtls_md_info_t* info = mbedtls_md_info_from_type(MBEDTLS_MD_SHA256);
  if (info == nullptr) return false;
  mbedtls_md_context_t context;
  mbedtls_md_init(&context);
  bool ok = mbedtls_md_setup(&context, info, 1) == 0;
  ok = ok && mbedtls_md_hmac_starts(&context, EQUIPMENT_MODULE_SECRET,
                                     sizeof(EQUIPMENT_MODULE_SECRET)) == 0;
  ok = ok && mbedtls_md_hmac_update(
                 &context, reinterpret_cast<const uint8_t*>(kWifiResponseDomain),
                 sizeof(kWifiResponseDomain)) == 0;
  auto update_field = [&context, &ok](const uint8_t* data, size_t length) {
    if (!ok || length > UINT32_MAX) {
      ok = false;
      return;
    }
    const uint32_t field_length = static_cast<uint32_t>(length);
    const uint8_t prefix[4] = {
        static_cast<uint8_t>(field_length >> 24),
        static_cast<uint8_t>(field_length >> 16),
        static_cast<uint8_t>(field_length >> 8),
        static_cast<uint8_t>(field_length),
    };
    ok = mbedtls_md_hmac_update(&context, prefix, sizeof(prefix)) == 0;
    if (ok && length > 0) {
      ok = mbedtls_md_hmac_update(&context, data, length) == 0;
    }
  };
  update_field(reinterpret_cast<const uint8_t*>(EQUIPMENT_MODULE_ID),
               strlen(EQUIPMENT_MODULE_ID));
  update_field(client_nonce, 32);
  update_field(server_nonce, 32);
  update_field(reinterpret_cast<const uint8_t*>(action), strlen(action));
  update_field(reinterpret_cast<const uint8_t*>(request_payload.c_str()),
               request_payload.length());
  update_field(reinterpret_cast<const uint8_t*>(state.c_str()), state.length());
  update_field(reinterpret_cast<const uint8_t*>(command_id.c_str()),
               command_id.length());
  update_field(claim.empty() ? nullptr : claim.data(), claim.size());
  uint8_t expected[32];
  ok = ok && mbedtls_md_hmac_finish(&context, expected) == 0;
  mbedtls_md_free(&context);
  return ok && constantTimeEqual(expected, supplied, sizeof(expected));
}

bool verifyClaimReceipt(const String& command_id, const uint8_t claim_hash[32],
                        const uint8_t supplied_receipt[32]) {
  const mbedtls_md_info_t* info = mbedtls_md_info_from_type(MBEDTLS_MD_SHA256);
  if (info == nullptr || !validIdentifier(command_id)) return false;
  mbedtls_md_context_t context;
  mbedtls_md_init(&context);
  uint8_t expected[32];
  const uint8_t separator = 0;
  bool ok = mbedtls_md_setup(&context, info, 1) == 0;
  ok = ok && mbedtls_md_hmac_starts(&context, EQUIPMENT_MODULE_SECRET,
                                     sizeof(EQUIPMENT_MODULE_SECRET)) == 0;
  ok = ok && mbedtls_md_hmac_update(
                 &context, reinterpret_cast<const uint8_t*>(kWifiReceiptDomain),
                 sizeof(kWifiReceiptDomain)) == 0;
  ok = ok && mbedtls_md_hmac_update(
                 &context,
                 reinterpret_cast<const uint8_t*>(EQUIPMENT_MODULE_ID),
                 strlen(EQUIPMENT_MODULE_ID)) == 0;
  ok = ok && mbedtls_md_hmac_update(&context, &separator, 1) == 0;
  ok = ok && mbedtls_md_hmac_update(
                 &context, reinterpret_cast<const uint8_t*>(command_id.c_str()),
                 command_id.length()) == 0;
  ok = ok && mbedtls_md_hmac_update(&context, claim_hash, 32) == 0;
  ok = ok && mbedtls_md_hmac_finish(&context, expected) == 0;
  mbedtls_md_free(&context);
  return ok && constantTimeEqual(expected, supplied_receipt, sizeof(expected));
}

bool verifyClaimTag(const uint8_t* nonce, const String& requested_site,
                    const String& requested_equipment,
                    const String& requested_name, const uint8_t* supplied_tag) {
  const mbedtls_md_info_t* info = mbedtls_md_info_from_type(MBEDTLS_MD_SHA256);
  if (info == nullptr) return false;
  mbedtls_md_context_t context;
  mbedtls_md_init(&context);
  uint8_t expected[fuel_equipment_ble::kClaimTagSize];
  const uint8_t separator = 0;
  bool ok = mbedtls_md_setup(&context, info, 1) == 0;
  ok = ok && mbedtls_md_hmac_starts(&context, EQUIPMENT_MODULE_SECRET,
                                     sizeof(EQUIPMENT_MODULE_SECRET)) == 0;
  ok = ok && mbedtls_md_hmac_update(
                 &context,
                 reinterpret_cast<const unsigned char*>(fuel_equipment_ble::kClaimHmacDomain),
                 sizeof(fuel_equipment_ble::kClaimHmacDomain)) == 0;
  ok = ok && mbedtls_md_hmac_update(
                 &context, reinterpret_cast<const unsigned char*>(EQUIPMENT_MODULE_ID),
                 strlen(EQUIPMENT_MODULE_ID)) == 0;
  ok = ok && mbedtls_md_hmac_update(&context, &separator, 1) == 0;
  ok = ok && mbedtls_md_hmac_update(&context, nonce,
                                     fuel_equipment_ble::kClaimNonceSize) == 0;
  ok = ok && mbedtls_md_hmac_update(
                 &context, reinterpret_cast<const unsigned char*>(requested_site.c_str()),
                 requested_site.length()) == 0;
  ok = ok && mbedtls_md_hmac_update(&context, &separator, 1) == 0;
  ok = ok && mbedtls_md_hmac_update(
                 &context, reinterpret_cast<const unsigned char*>(requested_equipment.c_str()),
                 requested_equipment.length()) == 0;
  ok = ok && mbedtls_md_hmac_update(&context, &separator, 1) == 0;
  ok = ok && mbedtls_md_hmac_update(
                 &context, reinterpret_cast<const unsigned char*>(requested_name.c_str()),
                 requested_name.length()) == 0;
  ok = ok && mbedtls_md_hmac_finish(&context, expected) == 0;
  mbedtls_md_free(&context);
  return ok && constantTimeEqual(expected, supplied_tag, sizeof(expected));
}

bool sha256Digest(const uint8_t* value, size_t length, uint8_t output[32]) {
  const mbedtls_md_info_t* info = mbedtls_md_info_from_type(MBEDTLS_MD_SHA256);
  return info != nullptr && mbedtls_md(info, value, length, output) == 0;
}

bool verifyFactoryIdentity() {
  if (!validIdentifier(String(EQUIPMENT_MODULE_ID)) ||
      !moduleSecretConfigured()) {
    return false;
  }
  uint8_t secret_hash[32];
  if (!sha256Digest(EQUIPMENT_MODULE_SECRET, sizeof(EQUIPMENT_MODULE_SECRET),
                    secret_hash)) {
    return false;
  }
  const String expected_hash = hexEncode(secret_hash, sizeof(secret_hash));
  if (!preferences.begin(kPreferencesNamespace, false)) return false;
  const bool ready = preferences.getBool("factory_ready", false);
  bool valid = false;
  if (ready) {
    valid = preferences.getString("factory_module", "") ==
                EQUIPMENT_MODULE_ID &&
            preferences.getString("factory_hash", "") == expected_hash;
  } else {
    // En la primera migración OTA se usa la asignación durable como ancla. Una
    // imagen de otro MIM no puede adoptar su propia identidad y dejar un
    // marcador incorrecto que sobreviva al rollback. Un equipo aún sin ancla
    // debe inicializar 0.4.x por cable en el proceso de fábrica.
    if ((!claimed_module_id.isEmpty() &&
         claimed_module_id != EQUIPMENT_MODULE_ID) ||
        (running_image_pending_verification && claimed_module_id.isEmpty())) {
      preferences.end();
      Serial.println("config=factory_identity_anchor_missing_or_mismatch");
      return false;
    }
    // El marcador vuelve true sólo después de guardar ambos valores. Un corte
    // en el primer arranque permite repetir la inicialización; una OTA futura
    // con identidad o secreto de otro MIM queda bloqueada por la comparación.
    valid = preferences.putBool("factory_ready", false) == 1 &&
            preferences.putString("factory_module", EQUIPMENT_MODULE_ID) ==
                strlen(EQUIPMENT_MODULE_ID) &&
            preferences.putString("factory_hash", expected_hash) ==
                expected_hash.length() &&
            preferences.putBool("factory_ready", true) == 1;
  }
  preferences.end();
  if (!valid) Serial.println("config=factory_identity_mismatch");
  return valid;
}

bool removePreferenceIfPresent(const char* key) {
  return !preferences.isKey(key) || preferences.remove(key);
}

bool applyClaimPacket(const uint8_t* value, size_t value_size,
                      const String& command_id = "",
                      const String& receipt_hex = "") {
  const size_t minimum = 1 + fuel_equipment_ble::kClaimNonceSize + 3 +
                         fuel_equipment_ble::kClaimTagSize;
  if (value_size < minimum || value[0] != fuel_equipment_ble::kProtocolVersion) {
    return false;
  }
  size_t offset = 1;
  const uint8_t* nonce = value + offset;
  offset += fuel_equipment_ble::kClaimNonceSize;
  auto readValue = [value, value_size, &offset](String& output) {
    if (offset >= value_size) return false;
    const size_t length = value[offset++];
    if (length == 0 || length > fuel_equipment_ble::kMaximumClaimValueLength ||
        offset + length > value_size) return false;
    output = String(reinterpret_cast<const char*>(value + offset), length);
    offset += length;
    return true;
  };
  String requested_site, requested_equipment, requested_name;
  if (!readValue(requested_site) || !readValue(requested_equipment) ||
      !readValue(requested_name) ||
      offset + fuel_equipment_ble::kClaimTagSize != value_size ||
      !validIdentifier(requested_site) ||
      !validIdentifier(requested_equipment) ||
      !validDisplayName(requested_name) ||
      !verifyClaimTag(nonce, requested_site, requested_equipment, requested_name,
                      value + offset)) {
    return false;
  }

  String claim_hash_hex;
  if (!command_id.isEmpty()) {
    uint8_t claim_hash[32];
    uint8_t receipt[32];
    if (!sha256Digest(value, value_size, claim_hash) ||
        !hexDecode(receipt_hex, receipt, sizeof(receipt)) ||
        !verifyClaimReceipt(command_id, claim_hash, receipt)) {
      return false;
    }
    claim_hash_hex = hexEncode(claim_hash, sizeof(claim_hash));
  }

  if (!preferences.begin(kPreferencesNamespace, false)) return false;
  // Primero se invalida el commit anterior. Esto también hace segura una
  // reasignación: un corte entre claves jamás puede mezclar la asignación
  // vieja con la nueva y seguir apareciendo como un MIM unificado.
  bool stored = preferences.putBool("unified", false) == 1;
  if (stored) stored = preferences.putBool("ack_pending", false) == 1;
  if (stored) {
    stored = preferences.putString("site_id", requested_site) ==
             requested_site.length();
  }
  if (stored) {
    stored = preferences.putString("equipment_id", requested_equipment) ==
             requested_equipment.length();
  }
  if (stored) {
    stored = preferences.putString("device_name", requested_name) ==
             requested_name.length();
  }
  if (stored) {
    stored = preferences.putString("claimed_module", EQUIPMENT_MODULE_ID) ==
             strlen(EQUIPMENT_MODULE_ID);
  }
  if (stored) {
    stored = preferences.putUChar("claim_schema", kClaimStateSchema) == 1;
  }
  if (stored && command_id.isEmpty()) {
    stored = removePreferenceIfPresent("ack_command") &&
             removePreferenceIfPresent("ack_hash") &&
             removePreferenceIfPresent("ack_receipt");
  } else if (stored) {
    stored = preferences.putString("ack_command", command_id) ==
                 command_id.length() &&
             preferences.putString("ack_hash", claim_hash_hex) ==
                 claim_hash_hex.length() &&
             preferences.putString("ack_receipt", receipt_hex) ==
                 receipt_hex.length() &&
             preferences.putBool("ack_pending", true) == 1;
  }
  // El único estado operacional es aquél cuyo marcador se pudo confirmar al
  // final. Si cualquier escritura falla, unified permanece falso.
  if (stored) stored = preferences.putBool("unified", true) == 1;
  if (!stored) (void)preferences.putBool("unified", false);
  preferences.end();
  if (!stored) {
    Serial.println("enrollment=persistence_failed");
    return false;
  }
  site_id = requested_site;
  equipment_id = requested_equipment;
  device_name = requested_name;
  pending_command_id = command_id;
  pending_claim_hash = claim_hash_hex;
  pending_receipt = receipt_hex;
  enrollment_ack_pending = !command_id.isEmpty();
  claim_storage_valid = true;
  claimed = true;
  (void)refreshIdentity();
  Serial.printf("enrollment=stored module=%s site=%s equipment=%s ack_pending=%u\n",
                EQUIPMENT_MODULE_ID, site_id.c_str(), equipment_id.c_str(),
                enrollment_ack_pending);
  return true;
}

bool startBle() {
  const String ble_name = equipmentBleName();
  NimBLEDevice::init(ble_name.c_str());
  NimBLEDevice::setMTU(256);
  if (!NimBLEDevice::setPower(BLE_TX_POWER_DBM)) return false;
  Serial.printf("ble=tx_power configured_dbm=%d actual_dbm=%d\n",
                BLE_TX_POWER_DBM, NimBLEDevice::getPower());
  ble_server = NimBLEDevice::createServer();
  if (ble_server == nullptr) return false;
  ble_server->setCallbacks(new ServerCallbacks());
  NimBLEService* service =
      ble_server->createService(fuel_equipment_ble::kServiceUuid);
  if (service == nullptr) return false;
  identity_characteristic = service->createCharacteristic(
      fuel_equipment_ble::kIdentityUuid, NIMBLE_PROPERTY::READ);
  NimBLECharacteristic* challenge = service->createCharacteristic(
      fuel_equipment_ble::kChallengeUuid, NIMBLE_PROPERTY::WRITE);
  response_characteristic = service->createCharacteristic(
      fuel_equipment_ble::kResponseUuid,
      NIMBLE_PROPERTY::READ | NIMBLE_PROPERTY::NOTIFY);
  NimBLECharacteristic* session = service->createCharacteristic(
      fuel_equipment_ble::kSessionControlUuid, NIMBLE_PROPERTY::WRITE);
  if (identity_characteristic == nullptr || challenge == nullptr ||
      response_characteristic == nullptr || session == nullptr) {
    return false;
  }
  challenge->setCallbacks(new ChallengeCallbacks());
  session->setCallbacks(new SessionCallbacks());
  portENTER_CRITICAL(&ble_state_mux);
  active_connection_handle = kInvalidConnectionHandle;
  connection_deadline_at = 0;
  session_lease_until = 0;
  reconnect_awake_until = 0;
  last_session_sequence = 0;
  ble_connected = false;
  session_challenge_ready = false;
  ble_disconnect_requested = false;
  signed_session_closed = false;
  memset(session_challenge, 0, sizeof(session_challenge));
  memset(session_module_nonce, 0, sizeof(session_module_nonce));
  portEXIT_CRITICAL(&ble_state_mux);
  return refreshIdentity() && startAdvertising(true);
}

bool postEnrollmentJson(const char* path, const String& request_body,
                        JsonDocument& response) {
  HTTPClient http;
  const String url = String(ENROLLMENT_SERVER_URL) + path;
  if (!http.begin(url)) return false;
  http.setConnectTimeout(2500);
  http.setTimeout(4000);
  http.addHeader("Content-Type", "application/json");
  if (watchdog_ready) feedLoopWDT();
  const int status = http.POST(request_body);
  if (watchdog_ready) feedLoopWDT();
  const int content_length = http.getSize();
  if (status != 200 || content_length <= 0 ||
      content_length > static_cast<int>(kMaximumHttpResponseBytes)) {
    http.end();
    Serial.printf(
        "enrollment=http_error path=%s status=%d content_length=%d\n",
        path, status, content_length);
    return false;
  }
  const String body = http.getString();
  if (watchdog_ready) feedLoopWDT();
  http.end();
  if (body.length() != static_cast<size_t>(content_length) ||
      body.length() > kMaximumHttpResponseBytes) {
    Serial.printf("enrollment=http_body_invalid path=%s\n", path);
    return false;
  }
  return deserializeJson(response, body) == DeserializationError::Ok;
}

bool authenticatedEnrollmentRequest(const char* action, const String& payload,
                                    JsonDocument& response) {
  uint8_t client_nonce[32];
  uint8_t server_nonce[32];
  uint8_t expected_server_proof[32];
  uint8_t supplied_server_proof[32];
  uint8_t client_proof[32];
  esp_fill_random(client_nonce, sizeof(client_nonce));

  JsonDocument challenge_request;
  challenge_request["version"] = kWifiProtocolVersion;
  challenge_request["moduleId"] = EQUIPMENT_MODULE_ID;
  challenge_request["action"] = action;
  challenge_request["clientNonce"] =
      hexEncode(client_nonce, sizeof(client_nonce));
  String challenge_body;
  serializeJson(challenge_request, challenge_body);
  JsonDocument challenge_response;
  uint32_t challenge_ttl = 0;
  if (!postEnrollmentJson("/v1/enrollment/challenge", challenge_body,
                          challenge_response) ||
      challenge_response["version"] != kWifiProtocolVersion ||
      challenge_response["action"].as<String>() != action ||
      (challenge_ttl = challenge_response["expiresInSeconds"] | 0U) == 0 ||
      challenge_ttl > 300 ||
      !hexDecode(challenge_response["serverNonce"] | "", server_nonce,
                 sizeof(server_nonce)) ||
      !hexDecode(challenge_response["serverProof"] | "",
                 supplied_server_proof, sizeof(supplied_server_proof)) ||
      !computeWifiServerProof(client_nonce, server_nonce, action, challenge_ttl,
                              expected_server_proof) ||
      !constantTimeEqual(expected_server_proof, supplied_server_proof,
                         sizeof(expected_server_proof))) {
    Serial.println("enrollment=raspberry_auth_failed");
    return false;
  }
  if (!computeWifiHmac(kWifiClientDomain, sizeof(kWifiClientDomain),
                       client_nonce, server_nonce, action, payload,
                       client_proof)) {
    return false;
  }

  JsonDocument authenticated_request;
  authenticated_request["version"] = kWifiProtocolVersion;
  authenticated_request["moduleId"] = EQUIPMENT_MODULE_ID;
  authenticated_request["clientNonce"] =
      hexEncode(client_nonce, sizeof(client_nonce));
  authenticated_request["serverNonce"] =
      hexEncode(server_nonce, sizeof(server_nonce));
  authenticated_request["payload"] = payload;
  authenticated_request["clientProof"] =
      hexEncode(client_proof, sizeof(client_proof));
  String request_body;
  serializeJson(authenticated_request, request_body);
  const String path = String("/v1/enrollment/") + action;
  const bool authenticated =
      postEnrollmentJson(path.c_str(), request_body, response) &&
      response["version"] == kWifiProtocolVersion &&
      verifyWifiResponseProof(client_nonce, server_nonce, action, payload,
                              response);
  if (authenticated) wifi_runtime_healthy = true;
  return authenticated;
}

bool confirmPendingEnrollment() {
  if (!enrollment_ack_pending) return true;
  JsonDocument payload_document;
  payload_document["commandId"] = pending_command_id;
  payload_document["claimHash"] = pending_claim_hash;
  payload_document["receipt"] = pending_receipt;
  String payload;
  serializeJson(payload_document, payload);
  JsonDocument response;
  if (!authenticatedEnrollmentRequest("confirm", payload, response) ||
      response["state"] != "confirmed" ||
      response["commandId"].as<String>() != pending_command_id) {
    return false;
  }
  if (!preferences.begin(kPreferencesNamespace, false)) return false;
  // El servidor ya confirmó. Se persiste primero el fin del estado pendiente;
  // las cadenas son sólo datos auxiliares y pueden limpiarse después sin
  // comprometer la coherencia si se corta la energía.
  const bool acknowledged = preferences.putBool("ack_pending", false) == 1;
  if (acknowledged) {
    (void)removePreferenceIfPresent("ack_command");
    (void)removePreferenceIfPresent("ack_hash");
    (void)removePreferenceIfPresent("ack_receipt");
  }
  preferences.end();
  if (!acknowledged) {
    Serial.println("enrollment=ack_persistence_failed");
    return false;
  }
  enrollment_ack_pending = false;
  pending_command_id = "";
  pending_claim_hash = "";
  pending_receipt = "";
  Serial.printf("enrollment=completed module=%s site=%s equipment=%s\n",
                EQUIPMENT_MODULE_ID, site_id.c_str(), equipment_id.c_str());
  if (running_image_pending_verification && !confirmRunningOtaImage()) {
    rollbackRunningOtaImage("wifi_confirmation_restart");
  }
  delay(150);
  ESP.restart();
  return true;
}

enum class EnrollmentPollResult : uint8_t { Completed, Pending, Error };

EnrollmentPollResult pollEnrollment() {
  if (enrollment_ack_pending) {
    return confirmPendingEnrollment() ? EnrollmentPollResult::Completed
                                      : EnrollmentPollResult::Error;
  }
  JsonDocument payload_document;
  payload_document["firmware"] = kFirmwareVersion;
  payload_document["bleProtocol"] = fuel_equipment_ble::kProtocolVersion;
  payload_document["rssi"] = constrain(WiFi.RSSI(), -127, 20);
  String payload;
  serializeJson(payload_document, payload);
  JsonDocument response;
  if (!authenticatedEnrollmentRequest("status", payload, response)) {
    return EnrollmentPollResult::Error;
  }
  const String state = response["state"] | "";
  if (state == "pending") {
    Serial.printf("enrollment=waiting module=%s rssi=%ld\n",
                  EQUIPMENT_MODULE_ID, static_cast<long>(WiFi.RSSI()));
    return EnrollmentPollResult::Pending;
  }
  if (state != "claim") return EnrollmentPollResult::Error;
  const String command_id = response["commandId"] | "";
  const String claim_hex = response["claim"] | "";
  const String receipt_hex = response["receipt"] | "";
  if (claim_hex.isEmpty() || claim_hex.length() % 2 != 0 ||
      claim_hex.length() > 512) {
    return EnrollmentPollResult::Error;
  }
  std::vector<uint8_t> claim(claim_hex.length() / 2);
  if (!hexDecode(claim_hex, claim.data(), claim.size()) ||
      !applyClaimPacket(claim.data(), claim.size(), command_id, receipt_hex)) {
    Serial.println("enrollment=claim_rejected");
    return EnrollmentPollResult::Error;
  }
  return confirmPendingEnrollment() ? EnrollmentPollResult::Completed
                                    : EnrollmentPollResult::Error;
}

bool startWifiEnrollment() {
  if (!WiFi.mode(WIFI_STA)) {
    Serial.println("enrollment=wifi_mode_failed");
    return false;
  }
  WiFi.setSleep(true);
  WiFi.begin(ENROLLMENT_WIFI_SSID, ENROLLMENT_WIFI_PASSWORD);
  wifi_enrollment_mode = true;
  next_wifi_attempt_at = millis() + retryWithJitter(10000, 10000);
  next_enrollment_poll_at = 0;
  wifi_retry_delay = kWifiRetryMilliseconds;
  enrollment_poll_delay = kEnrollmentPollMilliseconds;
  Serial.printf("enrollment=wifi_connecting ssid=%s module=%s ack_pending=%u\n",
                ENROLLMENT_WIFI_SSID, EQUIPMENT_MODULE_ID,
                enrollment_ack_pending);
  return true;
}

void maintainWifiEnrollment() {
  const unsigned long now = millis();
  if (WiFi.status() != WL_CONNECTED) {
    if (static_cast<long>(now - next_wifi_attempt_at) >= 0) {
      WiFi.disconnect();
      WiFi.begin(ENROLLMENT_WIFI_SSID, ENROLLMENT_WIFI_PASSWORD);
      const unsigned long retry = retryWithJitter(
          wifi_retry_delay, kWifiMaximumRetryMilliseconds);
      next_wifi_attempt_at = now + retry;
      wifi_retry_delay = min(kWifiMaximumRetryMilliseconds,
                             wifi_retry_delay * 2UL);
      Serial.printf("enrollment=wifi_retry next_ms=%lu\n", retry);
    }
    delay(20);
    return;
  }
  wifi_retry_delay = kWifiRetryMilliseconds;
  if (static_cast<long>(now - next_enrollment_poll_at) >= 0) {
    const EnrollmentPollResult result = pollEnrollment();
    if (result == EnrollmentPollResult::Completed) {
      enrollment_poll_delay = kEnrollmentPollMilliseconds;
    } else if (result == EnrollmentPollResult::Pending) {
      enrollment_poll_delay = kEnrollmentPendingPollMilliseconds;
    } else {
      enrollment_poll_delay = min(kEnrollmentMaximumPollMilliseconds,
                                  enrollment_poll_delay * 2UL);
    }
    next_enrollment_poll_at =
        millis() + retryWithJitter(enrollment_poll_delay,
                                   kEnrollmentMaximumPollMilliseconds);
  }
  delay(20);
}

bool portalAuthenticated() {
  if (portal.authenticate(kPortalUser, PROVISIONING_AP_PASSWORD)) return true;
  portal.requestAuthentication();
  return false;
}

String htmlEscape(const String& value) {
  String escaped;
  escaped.reserve(value.length() + 16);
  for (size_t index = 0; index < value.length(); ++index) {
    switch (value[index]) {
      case '&': escaped += F("&amp;"); break;
      case '<': escaped += F("&lt;"); break;
      case '>': escaped += F("&gt;"); break;
      case '\"': escaped += F("&quot;"); break;
      case '\'': escaped += F("&#39;"); break;
      default: escaped += value[index]; break;
    }
  }
  return escaped;
}

bool validWifiSsid(const String& value) {
  if (value.length() > 32) return false;
  for (size_t index = 0; index < value.length(); ++index) {
    const uint8_t character = static_cast<uint8_t>(value[index]);
    if (character < 0x20 || character == 0x7f) return false;
  }
  return true;
}

void handlePortalRoot() {
  if (!portalAuthenticated()) return;
  maintenance_last_activity_at = millis();
  const String secure_ota = esp_secure_boot_enabled() ? "habilitada" : "bloqueada";
  String page =
      "<!doctype html><meta name=viewport content='width=device-width'>"
      "<title>Módulo de equipo</title><h1>Configuración del módulo</h1>"
      "<p>Módulo: <code>" +
      htmlEscape(String(EQUIPMENT_MODULE_ID)) +
      "</code></p><p>Equipo asignado: <code>" + htmlEscape(equipment_id) +
      "</code></p><p>OTA segura: " + secure_ota +
      "</p><form method=post action=/save>"
      "<label>SSID de mantenimiento <input name=ssid value='" +
      htmlEscape(configured_ssid) +
      "' maxlength=32></label><br>"
      "<label>Clave Wi-Fi <input type=password name=wifi_password maxlength=63>"
      "</label><br><button>Guardar y reiniciar</button></form>"
      "<h2>Firmware firmado</h2><form method=post action=/update "
      "enctype=multipart/form-data><input type=file name=firmware required>"
      "<button>Actualizar</button></form>";
  portal.send(200, "text/html; charset=utf-8", page);
}

void handleSave() {
  if (!portalAuthenticated()) return;
  maintenance_last_activity_at = millis();
  const String requested_ssid = portal.arg("ssid");
  const String requested_password = portal.arg("wifi_password");
  if (!validWifiSsid(requested_ssid) ||
      (!requested_password.isEmpty() &&
       (requested_password.length() < 8 || requested_password.length() > 63))) {
    portal.send(400, "text/plain; charset=utf-8",
                "credenciales Wi-Fi inválidas");
    return;
  }
  if (!preferences.begin(kPreferencesNamespace, false)) {
    portal.send(500, "text/plain; charset=utf-8", "no se pudo abrir NVS");
    return;
  }
  bool saved = requested_ssid.isEmpty()
                   ? removePreferenceIfPresent("ssid")
                   : preferences.putString("ssid", requested_ssid) ==
                         requested_ssid.length();
  if (saved && !requested_password.isEmpty()) {
    saved = preferences.putString("wifi_password", requested_password) ==
            requested_password.length();
  }
  preferences.end();
  if (!saved) {
    portal.send(500, "text/plain; charset=utf-8",
                "no se pudo persistir la configuración");
    return;
  }
  portal.send(200, "text/plain; charset=utf-8", "Guardado. Reiniciando...");
  delay(300);
  ESP.restart();
}

void handleUpdateUpload() {
  if (!portalAuthenticated()) return;
  maintenance_last_activity_at = millis();
  if (watchdog_ready) feedLoopWDT();
  HTTPUpload& upload = portal.upload();
  if (upload.status == UPLOAD_FILE_START) {
    ota_upload_ok = esp_secure_boot_enabled() &&
                    Update.begin(UPDATE_SIZE_UNKNOWN, U_FLASH);
  } else if (upload.status == UPLOAD_FILE_WRITE) {
    if (ota_upload_ok && Update.write(upload.buf, upload.currentSize) !=
                             upload.currentSize) {
      ota_upload_ok = false;
      Update.abort();
    }
  } else if (upload.status == UPLOAD_FILE_END) {
    if (ota_upload_ok) {
      ota_upload_ok = Update.end(true);
    } else {
      Update.abort();
    }
  } else if (upload.status == UPLOAD_FILE_ABORTED) {
    Update.abort();
    ota_upload_ok = false;
  }
}

void handleUpdateFinished() {
  if (!portalAuthenticated()) return;
  maintenance_last_activity_at = millis();
  if (!esp_secure_boot_enabled()) {
    portal.send(503, "text/plain; charset=utf-8",
                "OTA bloqueada: Secure Boot v2 no está habilitado");
    return;
  }
  portal.send(ota_upload_ok ? 200 : 500, "text/plain; charset=utf-8",
              ota_upload_ok ? "Firmware verificado. Reiniciando..."
                            : "La actualización fue rechazada");
  ota_restart_pending = ota_upload_ok;
}

bool startMaintenancePortal() {
  if (!WiFi.mode(WIFI_AP_STA)) {
    Serial.println("maintenance=wifi_mode_failed");
    return false;
  }
  const String suffix = String(EQUIPMENT_MODULE_ID).substring(
      max(0, static_cast<int>(strlen(EQUIPMENT_MODULE_ID)) - 6));
  const String ap_name = "FuelModule-" + suffix;
  if (!WiFi.softAP(ap_name.c_str(), PROVISIONING_AP_PASSWORD)) {
    Serial.println("maintenance=ap_start_failed");
    WiFi.mode(WIFI_OFF);
    return false;
  }
  if (!configured_ssid.isEmpty()) {
    WiFi.begin(configured_ssid.c_str(), configured_wifi_password.c_str());
  }
  portal.on("/", HTTP_GET, handlePortalRoot);
  portal.on("/save", HTTP_POST, handleSave);
  portal.on("/update", HTTP_POST, handleUpdateFinished, handleUpdateUpload);
  portal.begin();
  maintenance_mode = true;
  maintenance_last_activity_at = millis();
  Serial.printf("maintenance=ready ap=%s ip=%s\n", ap_name.c_str(),
                WiFi.softAPIP().toString().c_str());
  return true;
}

bool clearEquipmentAssignment() {
  if (!preferences.begin(kPreferencesNamespace, false)) return false;
  // Se invalida primero: aun si el resto de la limpieza se interrumpe, el
  // siguiente arranque jamás utilizará la asignación anterior.
  const bool invalidated = preferences.putBool("unified", false) == 1 &&
                           preferences.putBool("ack_pending", false) == 1;
  if (invalidated) {
    (void)removePreferenceIfPresent("site_id");
    (void)removePreferenceIfPresent("equipment_id");
    (void)removePreferenceIfPresent("device_name");
    (void)removePreferenceIfPresent("claimed_module");
    (void)removePreferenceIfPresent("claim_schema");
    (void)removePreferenceIfPresent("ack_command");
    (void)removePreferenceIfPresent("ack_hash");
    (void)removePreferenceIfPresent("ack_receipt");
  }
  preferences.end();
  if (!invalidated) {
    claim_storage_valid = false;
    Serial.println("enrollment=factory_assignment_clear_failed");
    return false;
  }
  equipment_id = FACTORY_EQUIPMENT_ID;
  site_id = "";
  device_name = "";
  claimed_module_id = "";
  pending_command_id = "";
  pending_claim_hash = "";
  pending_receipt = "";
  claimed = false;
  enrollment_ack_pending = false;
  claim_storage_valid = true;
  Serial.printf("enrollment=factory_assignment_cleared module=%s\n",
                EQUIPMENT_MODULE_ID);
  return true;
}

bool handleStartupButton(bool allow_maintenance) {
  if (digitalRead(CONFIG_BUTTON_PIN) != LOW) return false;
  const unsigned long pressed_at = millis();
  Serial.println("button=pressed hold_20s_to_reset release_for_maintenance");
  while (digitalRead(CONFIG_BUTTON_PIN) == LOW &&
         millis() - pressed_at < kFactoryResetHoldMilliseconds) {
    // El watchdog de producción vence a los 15 s. Un hold válido de 20 s debe
    // seguir supervisado sin convertirse accidentalmente en un reset por WDT.
    if (watchdog_ready) feedLoopWDT();
    delay(20);
  }
  if (digitalRead(CONFIG_BUTTON_PIN) == LOW) {
    const bool assignment_cleared = clearEquipmentAssignment();
    Serial.printf("button=factory_reset threshold_seconds=20 cleared=%u "
                  "waiting_for_release=true\n",
                  assignment_cleared);
    // Reiniciar mientras D1 continúa en LOW volvería a ejecutar el mismo hold.
    // Se espera una liberación real, alimentando el watchdog, y sólo entonces
    // se inicia un boot limpio que cargará el estado NVS ya restablecido.
    while (digitalRead(CONFIG_BUTTON_PIN) == LOW) {
      if (watchdog_ready) feedLoopWDT();
      delay(20);
    }
    delay(kButtonDebounceMilliseconds);
    if (assignment_cleared) {
      Serial.println("button=factory_reset restart=clean_state_boot");
      Serial.flush();
      ESP.restart();
      while (true) delay(1000);
    }
    return false;
  }
  return allow_maintenance && startMaintenancePortal();
}

bool loadConfiguration() {
  if (!preferences.begin(kPreferencesNamespace, true)) {
    claim_storage_valid = false;
    return false;
  }
  equipment_id = preferences.getString("equipment_id", FACTORY_EQUIPMENT_ID);
  site_id = preferences.getString("site_id", "");
  device_name = preferences.getString("device_name", "");
  configured_ssid = preferences.getString("ssid", "");
  configured_wifi_password = preferences.getString("wifi_password", "");
  claimed_module_id = preferences.getString("claimed_module", "");
  pending_command_id = preferences.getString("ack_command", "");
  pending_claim_hash = preferences.getString("ack_hash", "");
  pending_receipt = preferences.getString("ack_receipt", "");
  const uint8_t claim_schema = preferences.getUChar("claim_schema", 0);
  const bool unified = preferences.getBool("unified", false);
  const bool ack_marker_present = preferences.isKey("ack_pending");
  const bool ack_marker = preferences.getBool("ack_pending", false);
  preferences.end();
  // Las versiones anteriores inferían la asignación sólo por textos guardados.
  // El marcador explícito hace que el primer arranque de este ciclo de vida se
  // mantenga despierto, incluso si el flasheo dejó datos NVS antiguos.
  const bool assignment_valid =
      claim_schema == kClaimStateSchema &&
      claimed_module_id == EQUIPMENT_MODULE_ID && validIdentifier(site_id) &&
      validIdentifier(equipment_id) && validDisplayName(device_name);
  const bool any_ack_metadata = !pending_command_id.isEmpty() ||
                                !pending_claim_hash.isEmpty() ||
                                !pending_receipt.isEmpty();
  uint8_t decoded_hash[32];
  uint8_t decoded_receipt[32];
  const bool complete_ack_metadata =
      validIdentifier(pending_command_id) &&
      hexDecode(pending_claim_hash, decoded_hash, sizeof(decoded_hash)) &&
      hexDecode(pending_receipt, decoded_receipt, sizeof(decoded_receipt));
  const bool ack_required = ack_marker_present ? ack_marker : any_ack_metadata;
  const bool ack_state_valid = !ack_required || complete_ack_metadata;
  claim_storage_valid = !unified || (assignment_valid && ack_state_valid);
  claimed = unified && assignment_valid && ack_state_valid;
  enrollment_ack_pending = claimed && ack_required;
  return claim_storage_valid;
}

bool selfTestPassed() {
  const esp_app_desc_t* application = esp_app_get_description();
  const bool release_identity_valid =
      application != nullptr &&
      application->magic_word == ESP_APP_DESC_MAGIC_WORD &&
      application->secure_version == MIM_FIRMWARE_SECURE_VERSION &&
      strcmp(application->version, kFirmwareVersion) == 0 &&
      strcmp(application->project_name, "fuel-mim") == 0;
  const bool enrollment_network_valid =
      EQUIPMENT_NETWORK_PROVISIONED == 1 &&
      strlen(ENROLLMENT_WIFI_SSID) >= 1 &&
      strlen(ENROLLMENT_WIFI_SSID) <= 32 &&
      strlen(ENROLLMENT_WIFI_PASSWORD) >= 8 &&
      strlen(ENROLLMENT_WIFI_PASSWORD) <= 63 &&
      strcmp(ENROLLMENT_SERVER_URL, "http://10.42.0.1:8788") == 0;
  return EQUIPMENT_PROVISIONED == 1 && watchdog_ready &&
         release_identity_valid && factory_identity_valid &&
         claim_storage_valid &&
         validIdentifier(String(EQUIPMENT_MODULE_ID)) &&
         (!claimed || (validIdentifier(site_id) && validIdentifier(equipment_id) &&
                       validDisplayName(device_name))) && moduleSecretConfigured() &&
         enrollment_network_valid && portalPasswordConfigured();
}

bool initializeTaskWatchdog() {
  esp_task_wdt_config_t configuration = {};
  configuration.timeout_ms = kTaskWatchdogMilliseconds;
  configuration.idle_core_mask =
      (static_cast<uint32_t>(1U) << portNUM_PROCESSORS) - 1U;
  configuration.trigger_panic = true;
  esp_err_t result = esp_task_wdt_reconfigure(&configuration);
  if (result == ESP_ERR_INVALID_STATE) {
    result = esp_task_wdt_init(&configuration);
  }
  if (result != ESP_OK) {
    Serial.printf("watchdog=configure_failed error=%d\n", result);
    return false;
  }
  enableLoopWDT();
  const bool ready = esp_task_wdt_status(nullptr) == ESP_OK;
  Serial.printf("watchdog=%s timeout_ms=%lu\n", ready ? "ready" : "failed",
                static_cast<unsigned long>(kTaskWatchdogMilliseconds));
  return ready;
}

void initializeOtaValidation() {
  const esp_partition_t* running = esp_ota_get_running_partition();
  esp_ota_img_states_t state;
  if (esp_ota_get_state_partition(running, &state) != ESP_OK ||
      state != ESP_OTA_IMG_PENDING_VERIFY) {
    return;
  }
  running_image_pending_verification = true;
  ota_validation_deadline = millis() + kOtaValidationMilliseconds;
  Serial.println("ota=trial_started");
}

void rollbackRunningOtaImage(const char* reason) {
  if (!running_image_pending_verification) return;
  Serial.printf("ota=rollback reason=%s\n", reason);
  Serial.flush();
  const esp_err_t result = esp_ota_mark_app_invalid_rollback_and_reboot();
  Serial.printf("ota=rollback_failed error=%d\n", result);
  ESP.restart();
}

bool confirmRunningOtaImage() {
  if (!running_image_pending_verification) return true;
  if (!selfTestPassed()) return false;
  const esp_err_t result = esp_ota_mark_app_valid_cancel_rollback();
  if (result != ESP_OK) {
    Serial.printf("ota=confirmation_failed error=%d\n", result);
    return false;
  }
  running_image_pending_verification = false;
  Serial.println("ota=confirmed runtime_healthy=true");
  return true;
}

void maintainOtaValidation() {
  if (!running_image_pending_verification) return;
  if (!selfTestPassed()) {
    rollbackRunningOtaImage("self_test");
    return;
  }
  const uint32_t now = millis();
  bool runtime_healthy = wifi_enrollment_mode && wifi_runtime_healthy;
  if (ble_runtime_ready &&
      now - ble_health_started_at >= kBleHealthValidationMilliseconds) {
    bool connected = false;
    portENTER_CRITICAL(&ble_state_mux);
    connected = ble_connected;
    portEXIT_CRITICAL(&ble_state_mux);
    NimBLEAdvertising* advertising = NimBLEDevice::getAdvertising();
    runtime_healthy = connected ||
                      (advertising != nullptr && advertising->isAdvertising());
  }
  if (runtime_healthy) {
    if (!confirmRunningOtaImage()) rollbackRunningOtaImage("confirmation");
    return;
  }
  if (!deadlinePending(ota_validation_deadline, now)) {
    rollbackRunningOtaImage("health_timeout");
  }
}

[[noreturn]] void enterRecoverySleep(uint32_t seconds, const char* reason) {
  WiFi.mode(WIFI_OFF);
  const esp_err_t result = esp_sleep_enable_timer_wakeup(
      static_cast<uint64_t>(seconds) * 1000000ULL);
  Serial.printf("recovery=sleep reason=%s wake_seconds=%lu timer=%d\n", reason,
                static_cast<unsigned long>(seconds), result);
  Serial.flush();
  if (result == ESP_OK) esp_deep_sleep_start();
  ESP.restart();
  while (true) delay(1000);
}

bool enterDeepSleep() {
  bool connected = false;
  portENTER_CRITICAL(&ble_state_mux);
  connected = ble_connected;
  portEXIT_CRITICAL(&ble_state_mux);
  if (connected || (ble_server != nullptr &&
                    ble_server->getConnectedCount() != 0)) {
    return false;
  }
  // Si el contacto acaba de bajar, se deja que el debounce lo transforme en
  // una nueva ventana operacional antes de apagar el radio.
  if (digitalRead(CONFIG_BUTTON_PIN) == LOW) {
    return false;
  }
  NimBLEAdvertising* advertising =
      ble_runtime_ready ? NimBLEDevice::getAdvertising() : nullptr;
  if (advertising != nullptr) advertising->stop();

  // Cierra la carrera connect/sleep: una vez detenido advertising se vuelve a
  // inspeccionar tanto el estado de callbacks como el estado real del server.
  portENTER_CRITICAL(&ble_state_mux);
  connected = ble_connected;
  portEXIT_CRITICAL(&ble_state_mux);
  if (connected || (ble_server != nullptr &&
                    ble_server->getConnectedCount() != 0)) {
    (void)startAdvertising(false);
    return false;
  }
  if (digitalRead(CONFIG_BUTTON_PIN) == LOW) {
    (void)startAdvertising(false);
    return false;
  }
  // No hay despertares periódicos operacionales. El único wake normal es el
  // botón; los timers quedan reservados para recuperación de fallas antes de
  // llegar a este ciclo unificado.
  (void)esp_sleep_disable_wakeup_source(ESP_SLEEP_WAKEUP_ALL);
  bool button_wake_enabled = false;
  esp_err_t button_result = ESP_OK;
  if (digitalRead(CONFIG_BUTTON_PIN) == HIGH) {
    const uint64_t button_mask =
        1ULL << static_cast<uint8_t>(CONFIG_BUTTON_PIN);
#if CONFIG_IDF_TARGET_ESP32C3
    button_result = esp_deep_sleep_enable_gpio_wakeup(
        button_mask, ESP_GPIO_WAKEUP_GPIO_LOW);
#else
    button_result = esp_sleep_enable_ext1_wakeup_io(
        button_mask, ESP_EXT1_WAKEUP_ANY_LOW);
#endif
    button_wake_enabled = button_result == ESP_OK;
    if (!button_wake_enabled) {
      Serial.printf("sleep=button_wakeup_failed pin=%d error=%d\n",
                    CONFIG_BUTTON_PIN, button_result);
    }
  } else {
    // Un botón mantenido o averiado no debe provocar un ciclo infinito de
    // arranques. Se duerme sin fuente de wake y requiere liberar el botón más
    // un reset o ciclo de energía para recuperarse.
    Serial.printf("sleep=button_wakeup_skipped pin=%d reason=held_low\n",
                  CONFIG_BUTTON_PIN);
  }
  Serial.printf("sleep=enter timer_wake=false button_wake=%u button_pin=%d\n",
                button_wake_enabled, CONFIG_BUTTON_PIN);
  Serial.flush();
  esp_deep_sleep_start();
  return true;
}

}  // namespace

void setup() {
  Serial.begin(115200);
  delay(150);
  Serial.printf("boot=started firmware=%s reset_reason=%d free_heap=%u\n",
                kFirmwareVersion, static_cast<int>(esp_reset_reason()),
                ESP.getFreeHeap());
  watchdog_ready = initializeTaskWatchdog();
  pinMode(CONFIG_BUTTON_PIN, INPUT_PULLUP);
  configureBootWakePolicy();
  initializeButtonState();
  (void)loadConfiguration();
  initializeOtaValidation();
  factory_identity_valid = verifyFactoryIdentity();

  // El reset físico debe seguir disponible aunque una escritura NVS anterior
  // haya quedado parcial. Sólo se habilita después de autenticar la identidad
  // de fábrica y el watchdog; una pulsación breve no abre mantenimiento si el
  // self-test completo aún falla.
  const bool recovery_controls_trusted =
      EQUIPMENT_PROVISIONED == 1 && watchdog_ready && factory_identity_valid &&
      validIdentifier(String(EQUIPMENT_MODULE_ID)) &&
      moduleSecretConfigured() && portalPasswordConfigured();
  const bool service_boot =
      boot_wakeup_cause == ESP_SLEEP_WAKEUP_UNDEFINED;
  if (recovery_controls_trusted) {
    if (service_boot && handleStartupButton(true)) {
      return;
    }
    if (operator_wake_requested) {
      // El mismo botón que despierta el MIM debe poder limpiar la asignación
      // si permanece pulsado veinte segundos. Una pulsación breve conserva la
      // ruta operacional y nunca abre el portal de mantenimiento.
      (void)handleStartupButton(false);
    }
  }

  if (!selfTestPassed()) {
    Serial.println("config=invalid operation_blocked=true");
    if (running_image_pending_verification) {
      rollbackRunningOtaImage("boot_self_test");
    }
    enterRecoverySleep(300, "invalid_configuration");
  }

  if (!selfTestPassed()) {
    if (running_image_pending_verification) {
      rollbackRunningOtaImage("assignment_reset_failed");
    }
    enterRecoverySleep(300, "assignment_storage");
  }
  if (!claimed || enrollment_ack_pending) {
    if (!startWifiEnrollment()) {
      if (running_image_pending_verification) {
        rollbackRunningOtaImage("wifi_initialization");
      }
      enterRecoverySleep(60, "wifi_initialization");
    }
    Serial.println(claimed ? "lifecycle=enrollment_confirmation power=awake" :
                             "lifecycle=wifi_enrollment power=awake");
    return;
  }
  if (!WiFi.mode(WIFI_OFF)) {
    enterRecoverySleep(60, "wifi_shutdown");
  }
  if (!operator_wake_requested && !running_image_pending_verification) {
    Serial.println("lifecycle=unified power=deep_sleep reason=no_button_wake");
    (void)enterDeepSleep();
    enterRecoverySleep(60, "deep_sleep_entry");
  }
  if (!operator_wake_requested) {
    active_advertise_window_seconds =
        kBleHealthValidationMilliseconds / 1000UL;
    Serial.printf("ota=ble_health_window seconds=%lu\n",
                  static_cast<unsigned long>(active_advertise_window_seconds));
  }
  if (!startBle()) {
    Serial.println("ble=initialization_failed");
    if (running_image_pending_verification) {
      rollbackRunningOtaImage("ble_initialization");
    }
    enterRecoverySleep(60, "ble_initialization");
  }
  ble_runtime_ready = true;
  ble_health_started_at = millis();
  Serial.printf(
      "ble=advertising module=%s equipment=%s claimed=%u tx_power_dbm=%d "
      "wake=%s window_seconds=%lu\n",
      EQUIPMENT_MODULE_ID, equipment_id.c_str(), claimed, BLE_TX_POWER_DBM,
      wakeCauseName(boot_wakeup_cause),
      static_cast<unsigned long>(active_advertise_window_seconds));
  Serial.println("lifecycle=unified power=low");
}

void loop() {
  if (maintenance_mode) {
    portal.handleClient();
    maintainOtaValidation();
    if (ota_restart_pending) {
      delay(300);
      ESP.restart();
    }
    if (millis() - maintenance_last_activity_at >=
        kMaintenanceTimeoutMilliseconds) {
      Serial.println("maintenance=timeout");
      ESP.restart();
    }
    delay(5);
    return;
  }
  if (wifi_enrollment_mode) {
    maintainWifiEnrollment();
    maintainOtaValidation();
    return;
  }
  maintainOtaValidation();
  const uint32_t now = millis();
  maintainOperationalButton(now);
  bool connected = false;
  bool disconnect_requested = false;
  uint16_t connection_handle = kInvalidConnectionHandle;
  uint32_t handshake_deadline = 0;
  uint32_t lease_deadline = 0;
  uint32_t reconnect_deadline = 0;
  bool authenticated_close = false;
  portENTER_CRITICAL(&ble_state_mux);
  connected = ble_connected;
  disconnect_requested = ble_disconnect_requested;
  connection_handle = active_connection_handle;
  handshake_deadline = connection_deadline_at;
  lease_deadline = session_lease_until;
  reconnect_deadline = reconnect_awake_until;
  authenticated_close = signed_session_closed;
  portEXIT_CRITICAL(&ble_state_mux);
  const bool handshake_active = deadlinePending(handshake_deadline, now);
  const bool lease_active = deadlinePending(lease_deadline, now);
  const bool reconnect_active = deadlinePending(reconnect_deadline, now);

  if (connected &&
      (disconnect_requested || (!handshake_active && !lease_active))) {
    Serial.printf("ble=disconnecting handle=%u reason=%s\n", connection_handle,
                  disconnect_requested ? "signed_close" : "lease_expired");
    if (ble_server != nullptr &&
        connection_handle != kInvalidConnectionHandle) {
      ble_server->disconnect(connection_handle);
    }
    delay(20);
    return;
  }
  // Sólo un MIM ya enrolado llega al ciclo BLE y puede entrar en deep sleep.
  if (claimed && !connected && !reconnect_active &&
      !running_image_pending_verification &&
      (authenticated_close ||
       now - advertising_started_at >=
           active_advertise_window_seconds * 1000UL)) {
    (void)enterDeepSleep();
  }
  delay(20);
}
