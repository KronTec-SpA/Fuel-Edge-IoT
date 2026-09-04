#include <Arduino.h>
#include <ArduinoJson.h>
#include <MFRC522.h>
#include <NimBLEDevice.h>
#include <Preferences.h>
#include <SPI.h>
#include <WiFi.h>
#include <esp_heap_caps.h>
#include <esp_http_client.h>
#include <esp_idf_version.h>
#include <esp_ota_ops.h>
#include <esp_partition.h>
#include <esp_system.h>
#include <mqtt_client.h>
#include <mbedtls/base64.h>
#include <mbedtls/md.h>
#include <mbedtls/sha256.h>
#include <mbedtls/version.h>
#include <time.h>

#include <equipment_ble_protocol.h>

#if !defined(CONFIG_BOOTLOADER_APP_ROLLBACK_ENABLE) || \
    CONFIG_BOOTLOADER_APP_ROLLBACK_ENABLE != 1
#error "The RFID validator requires ESP-IDF bootloader app rollback"
#endif

struct TrustedEquipmentSecret {
  char module_id[64];
  uint8_t secret[32];
};

#if __has_include("../include/validator_secrets.h")
#include "../include/validator_secrets.h"
#elif __has_include("validator_secrets.h")
#include "validator_secrets.h"
#else
#define WIFI_SSID ""
#define WIFI_PASSWORD ""
#define NTP_SERVER ""
#define MQTT_URI ""
#define SITE_ID "development-site"
#define MODULE_ID "development-module"
#define VALIDATOR_ID "validator-01"
#define VALIDATOR_MIFARE_CLASSIC_CARD 1
#define VALIDATOR_SIMULATED_CARD 0
#define SIMULATED_CREDENTIAL_ID ""
static const char MQTT_CA_CERT[] = "";
static const char MQTT_CLIENT_CERT[] = "";
static const char MQTT_CLIENT_KEY[] = "";
static const unsigned char CARD_MASTER_SECRET[32] = {};
static const TrustedEquipmentSecret TRUSTED_EQUIPMENT[1] = {};
#define TRUSTED_EQUIPMENT_COUNT 0
#define BLE_RSSI_THRESHOLD -70
#define BLE_RSSI_SAMPLE_COUNT 5
#define BLE_SCAN_TIMEOUT_SECONDS 40
#endif

// Cableado del validador Arduino Nano ESP32. Estos valores se pueden
// sobrescribir desde validator_secrets.h si cambia el montaje físico.
#ifndef RFID_SS_PIN
#define RFID_SS_PIN D10
#endif
#ifndef RFID_RST_PIN
#define RFID_RST_PIN D5
#endif
#ifndef BUZZER_PIN
#define BUZZER_PIN D8
#endif
#ifndef BUZZER_ACTIVE_HIGH
#define BUZZER_ACTIVE_HIGH 1
#endif
#ifndef BUZZER_PASSIVE
#define BUZZER_PASSIVE 1
#endif
#ifndef BUZZER_FREQUENCY_HZ
#define BUZZER_FREQUENCY_HZ 4000
#endif
#ifndef VALIDATOR_ALLOW_LEGACY_EQUIPMENT
#define VALIDATOR_ALLOW_LEGACY_EQUIPMENT 0
#endif
#if VALIDATOR_ALLOW_LEGACY_EQUIPMENT != 0 && \
    VALIDATOR_ALLOW_LEGACY_EQUIPMENT != 1
#error "VALIDATOR_ALLOW_LEGACY_EQUIPMENT must be 0 or 1"
#endif

namespace {

constexpr size_t kBinarySize = 32;
constexpr size_t kMaxMessageSize = 8192;
// Al reconectar pueden llegar juntos config, enrolamiento, registro MIM y OTA,
// más una republicación periódica mientras loop() drena el lote retenido. Ocho
// espacios conservan el buzón acotado sin convertir ese arranque normal en una
// falsa saturación fail-safe.
constexpr size_t kMqttInboxCapacity = 8;
constexpr size_t kMaximumBleCandidates = 32;
constexpr size_t kMaximumTrustedEquipment = 32;
constexpr uint32_t kEquipmentRegistryMagic = 0x46454d52;  // FEMR
constexpr uint16_t kEquipmentRegistrySchema = 1;
constexpr char kFirmwareVersion[] = "0.6.3";
constexpr char kOtaBaseUrl[] = "https://10.42.0.1:8443/";
constexpr size_t kMaximumOtaImageSize = 3 * 1024 * 1024;
constexpr unsigned long kOtaValidationMilliseconds = 90000;
constexpr unsigned long kOtaDeferredRetryMilliseconds = 5000;
constexpr char kRfidProtocolDomain[] = "fuel-edge/rfid/v1";
constexpr char kMifareKeyDomain[] = "fuel-edge/mifare/v1";
constexpr byte kMifareDataBlock = 4;
constexpr byte kMifareTrailerBlock = 7;
constexpr byte kMifareMarker[8] = {'F', 'U', 'E', 'L', 'N', 'F', 'C', '2'};
constexpr unsigned long kEquipmentLossMilliseconds = 20000;
constexpr unsigned long kEquipmentKeepAliveMilliseconds = 5000;
constexpr unsigned long kEquipmentReconnectMilliseconds = 2000;
constexpr unsigned long kEquipmentLinkWindowMilliseconds = 60000;
constexpr unsigned long kEquipmentPresenceHeartbeatMilliseconds = 1000;
constexpr unsigned long kProactiveScanSliceMilliseconds = 350;
constexpr unsigned long kProactiveScanIntervalMilliseconds = 150;
constexpr uint16_t kEquipmentHoldSeconds = 30;
static_assert(kEquipmentLinkWindowMilliseconds == 60000,
              "la ventana MIM/RFID debe durar exactamente 60 segundos");
constexpr unsigned long kCardPresentationValidityMilliseconds = 60000;
constexpr unsigned long kCardPresencePollMilliseconds = 100;
constexpr unsigned long kCardRemovalDebounceMilliseconds = 300;
constexpr unsigned long kCardPresenceHeartbeatMilliseconds = 1000;
constexpr uint8_t kCardOperationAttempts = 4;
constexpr unsigned long kCardOperationRetryMilliseconds = 35;
constexpr unsigned long kWifiInitialConnectMilliseconds = 30000;
constexpr unsigned long kWifiReconnectMilliseconds = 10000;
constexpr unsigned long kMqttReconnectMilliseconds = 15000;
constexpr uint8_t kLegacyEquipmentProtocolVersion = 2;
constexpr size_t kLegacyEquipmentResponseSize = 32;
constexpr size_t kLegacyEquipmentHoldCommandSize = 3;
constexpr size_t kLegacyEquipmentCloseCommandSize = 1;

enum class EquipmentSessionMode : uint8_t {
  None,
  Legacy32,
  SignedV4,
};

enum class AuthorizationPhase : uint8_t {
  Idle,
  CredentialPreflight,
  EquipmentValidation,
};

enum class DeferredMqttMessageType : uint8_t {
  Challenge,
  Decision,
  Config,
  Enrollment,
  EquipmentRegistry,
  OtaCommand,
};

enum class MqttInboxState : uint8_t {
  Empty,
  Ready,
  Processing,
};

struct PendingMqttMessage {
  volatile MqttInboxState state = MqttInboxState::Empty;
  uint32_t sequence = 0;
  DeferredMqttMessageType type = DeferredMqttMessageType::Challenge;
  size_t length = 0;
  char* payload = nullptr;
};

// El reset se controla explícitamente: MFRC522::PCD_Init() cambia a INPUT el
// pin de reset que recibe en el constructor y puede dejar NRSTPD flotando. Un
// nivel bajo en ese pin apaga por completo el lector.
MFRC522 rfid_reader(RFID_SS_PIN, MFRC522::UNUSED_PIN);

struct ScanCandidate {
  String address;
  uint8_t address_type = BLE_ADDR_PUBLIC;
  int samples[BLE_RSSI_SAMPLE_COUNT];
  size_t sample_count = 0;
};

struct StoredEquipmentRegistry {
  uint32_t magic;
  uint16_t schema;
  uint16_t count;
  char generation[65];
  TrustedEquipmentSecret entries[kMaximumTrustedEquipment];
};

struct OtaCommand {
  char version[16];
  char url[160];
  char sha256[65];
  char nonce[33];
  size_t size;
};

esp_mqtt_client_handle_t mqtt_client = nullptr;
bool mqtt_online = false;
String active_session;
String topic_root;
String challenge_topic;
String proof_topic;
String presentation_topic;
String decision_topic;
String equipment_topic;
String credential_topic;
String config_topic;
String config_status_topic;
String enrollment_topic;
String equipment_registry_topic;
String equipment_registry_status_topic;
String ota_command_topic;
String ota_status_topic;
int ble_rssi_threshold = BLE_RSSI_THRESHOLD;
uint32_t ble_config_revision = 0;
bool enrollment_window_active = false;
TrustedEquipmentSecret trusted_equipment[kMaximumTrustedEquipment];
TrustedEquipmentSecret staged_equipment_registry[kMaximumTrustedEquipment];
StoredEquipmentRegistry equipment_registry_storage;
size_t trusted_equipment_count = 0;
String equipment_registry_generation;
bool equipment_registry_persisted = false;
OtaCommand ota_command = {};
volatile bool ota_command_pending = false;
bool ota_update_running = false;
bool ota_mqtt_stopped = false;
bool ota_failure_status_pending = false;
char ota_failure_detail[32] = {};
bool running_image_pending_verification = false;
unsigned long ota_validation_deadline = 0;
unsigned long ota_retry_at = 0;
char ota_boot_target[16] = {};
char ota_boot_nonce[33] = {};
char ota_boot_previous_partition[17] = {};
bool ota_receipt_pending = false;
bool ota_receipt_ack_deferred = false;
bool ota_rolled_back = false;
bool ota_boot_state_invalid = false;

NimBLEClient* equipment_client = nullptr;
NimBLERemoteCharacteristic* equipment_session_control = nullptr;
String active_equipment_address;
uint8_t active_equipment_address_type = BLE_ADDR_PUBLIC;
String active_equipment_module_id;
String active_equipment_id;
int active_equipment_rssi = -127;
bool equipment_authenticated = false;
bool authorized_equipment_session = false;
AuthorizationPhase authorization_phase = AuthorizationPhase::Idle;
EquipmentSessionMode equipment_session_mode = EquipmentSessionMode::None;
bool equipment_session_signing_ready = false;
uint32_t equipment_session_sequence = 0;
uint8_t equipment_session_challenge[fuel_equipment_ble::kChallengeSize] = {};
uint8_t equipment_session_module_nonce[fuel_equipment_ble::kModuleNonceSize] = {};
uint8_t equipment_session_secret[32] = {};
bool equipment_loss_pending = false;
unsigned long equipment_lost_since = 0;
unsigned long next_equipment_keepalive = 0;
unsigned long next_equipment_reconnect = 0;
bool equipment_waiting_for_card = false;
unsigned long equipment_link_deadline = 0;
unsigned long next_equipment_presence = 0;
unsigned long next_proactive_equipment_scan = 0;
String equipment_link_session;
bool physical_card_pending = false;
unsigned long physical_card_seen_at = 0;
String physical_card_uid;
String physical_credential_id;
bool credential_presence_monitoring = false;
bool credential_loss_pending = false;
unsigned long credential_absent_since = 0;
unsigned long next_card_presence_poll = 0;
unsigned long next_credential_heartbeat = 0;
bool rfid_ready = false;
unsigned long next_rfid_recovery = 0;
unsigned long next_hardware_status = 0;
unsigned long next_wifi_reconnect = 0;
unsigned long next_mqtt_reconnect = 0;
wl_status_t last_wifi_status = WL_IDLE_STATUS;
PendingMqttMessage mqtt_inbox[kMqttInboxCapacity];
portMUX_TYPE mqtt_inbox_mutex = portMUX_INITIALIZER_UNLOCKED;
uint32_t mqtt_inbox_sequence = 0;
volatile bool mqtt_connect_pending = false;
volatile bool mqtt_disconnect_pending = false;
volatile bool mqtt_connection_target_online = false;
volatile bool mqtt_inbox_failure_pending = false;
volatile uint32_t mqtt_inbox_failure_count = 0;
volatile bool mqtt_error_pending = false;
int mqtt_error_type = 0;
int mqtt_error_esp = 0;
int mqtt_error_tls = 0;
int mqtt_error_verify = 0;
int mqtt_error_errno = 0;

void startMqtt();
bool clearOtaBootMetadata();

void setBuzzer(bool active) {
  digitalWrite(BUZZER_PIN,
               active == static_cast<bool>(BUZZER_ACTIVE_HIGH) ? HIGH : LOW);
}

void beep(uint8_t count, unsigned long on_milliseconds,
          unsigned long off_milliseconds = 80) {
  for (uint8_t index = 0; index < count; ++index) {
#if BUZZER_PASSIVE
    tone(BUZZER_PIN, BUZZER_FREQUENCY_HZ);
#else
    setBuzzer(true);
#endif
    delay(on_milliseconds);
#if BUZZER_PASSIVE
    noTone(BUZZER_PIN);
#endif
    setBuzzer(false);
    if (index + 1 < count) delay(off_milliseconds);
  }
}

void playStartupMelody() {
#if BUZZER_PASSIVE
  // Arpegio de Do mayor ascendente: C7, E7, G7, C8.
  constexpr uint16_t frequencies[] = {2093, 2637, 3136, 4186};
  constexpr uint16_t durations[] = {160, 160, 160, 260};
  for (size_t index = 0; index < 4; ++index) {
    tone(BUZZER_PIN, frequencies[index]);
    delay(durations[index]);
    noTone(BUZZER_PIN);
    setBuzzer(false);
    if (index < 3) delay(55);
  }
#else
  beep(4, 120, 55);
#endif
}

void playMasterChime() {
#if BUZZER_PASSIVE
  // Fanfarria breve: Sol6, Do7, Mi7, Sol7. Es distinta del arpegio de arranque
  // y de los bips operacionales, sin prolongar la autorización de emergencia.
  constexpr uint16_t frequencies[] = {1568, 2093, 2637, 3136};
  constexpr uint16_t durations[] = {75, 90, 100, 170};
  for (size_t index = 0; index < 4; ++index) {
    tone(BUZZER_PIN, frequencies[index]);
    delay(durations[index]);
    noTone(BUZZER_PIN);
    setBuzzer(false);
    if (index < 3) delay(25);
  }
#else
  // Un buzzer activo no puede cambiar de nota; conserva una firma rítmica
  // inequívoca de dos destellos cortos y un cierre más largo.
  beep(2, 70, 35);
  delay(30);
  beep(1, 170);
#endif
}

bool supportedRfidVersion(byte version) {
  return version == 0x88 || version == 0x90 || version == 0x91 ||
         version == 0x92;
}

bool initializeRfidReader() {
  for (uint8_t attempt = 1; attempt <= 4; ++attempt) {
    // El DFU del Nano puede reiniciar el ESP32 sin descargar por completo el
    // módulo externo. Forzar el RST físico evita dejar el MFRC522 a mitad de
    // una transacción SPI anterior.
    pinMode(RFID_RST_PIN, OUTPUT);
    digitalWrite(RFID_RST_PIN, LOW);
    delay(50);
    digitalWrite(RFID_RST_PIN, HIGH);
    delay(100);
    rfid_reader.PCD_Init();
    // PCD_Init no administra RFID_RST_PIN: conservarlo activamente alto evita
    // que NRSTPD quede flotante y vuelva a apagar el lector.
    pinMode(RFID_RST_PIN, OUTPUT);
    digitalWrite(RFID_RST_PIN, HIGH);
    delay(100);
    const byte version = rfid_reader.PCD_ReadRegister(MFRC522::VersionReg);
    if (supportedRfidVersion(version)) {
      Serial.printf("rfid=ready attempt=%u version=0x%02x\n", attempt, version);
      return true;
    }
    Serial.printf("rfid=retry attempt=%u version=0x%02x\n", attempt, version);
    delay(150);
  }
  Serial.println("rfid=unavailable retrying_in_background");
  return false;
}

String uidAsHex(const MFRC522::Uid& uid) {
  String encoded;
  encoded.reserve(uid.size * 2);
  const char digits[] = "0123456789abcdef";
  for (byte index = 0; index < uid.size; ++index) {
    encoded += digits[(uid.uidByte[index] >> 4) & 0x0f];
    encoded += digits[uid.uidByte[index] & 0x0f];
  }
  return encoded;
}

void clearPhysicalCard() {
  physical_card_pending = false;
  physical_card_seen_at = 0;
  physical_card_uid.clear();
  physical_credential_id.clear();
  credential_presence_monitoring = false;
  credential_loss_pending = false;
  credential_absent_since = 0;
  next_card_presence_poll = 0;
  next_credential_heartbeat = 0;
  authorization_phase = AuthorizationPhase::Idle;
}

bool validIdentifier(const String& value) {
  if (value.isEmpty() || value.length() > 63) return false;
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

bool decode32(const char* encoded, uint8_t output[kBinarySize]) {
  if (encoded == nullptr) return false;
  String normalized(encoded);
  normalized.replace('-', '+');
  normalized.replace('_', '/');
  size_t output_length = 0;
  const int result = mbedtls_base64_decode(
      output, kBinarySize, &output_length,
      reinterpret_cast<const unsigned char*>(normalized.c_str()),
      normalized.length());
  return result == 0 && output_length == kBinarySize;
}

bool encode32(const uint8_t input[kBinarySize], char output[48]) {
  size_t output_length = 0;
  const int result = mbedtls_base64_encode(
      reinterpret_cast<unsigned char*>(output), 48, &output_length, input,
      kBinarySize);
  if (result != 0 || output_length >= 48) return false;
  output[output_length] = '\0';
  return true;
}

bool constantTimeEqual(const uint8_t* left, const uint8_t* right, size_t size) {
  uint8_t difference = 0;
  for (size_t index = 0; index < size; ++index) {
    difference |= left[index] ^ right[index];
  }
  return difference == 0;
}

bool cardResponse(const String& credential_id,
                  const uint8_t challenge[kBinarySize],
                  uint8_t response[kBinarySize]) {
  const mbedtls_md_info_t* info = mbedtls_md_info_from_type(MBEDTLS_MD_SHA256);
  if (info == nullptr) return false;
  mbedtls_md_context_t context;
  mbedtls_md_init(&context);
  bool ok = mbedtls_md_setup(&context, info, 1) == 0;
  ok = ok && mbedtls_md_hmac_starts(
                 &context, CARD_MASTER_SECRET,
                 sizeof(CARD_MASTER_SECRET)) == 0;
  ok = ok && mbedtls_md_hmac_update(
                 &context,
                 reinterpret_cast<const unsigned char*>(kRfidProtocolDomain),
                 sizeof(kRfidProtocolDomain)) == 0;
  ok = ok && mbedtls_md_hmac_update(
                 &context,
                 reinterpret_cast<const unsigned char*>(credential_id.c_str()),
                 credential_id.length()) == 0;
  const uint8_t separator = 0;
  ok = ok && mbedtls_md_hmac_update(&context, &separator, 1) == 0;
  ok = ok && mbedtls_md_hmac_update(&context, challenge, kBinarySize) == 0;
  ok = ok && mbedtls_md_hmac_finish(&context, response) == 0;
  mbedtls_md_free(&context);
  return ok;
}

#if VALIDATOR_MIFARE_CLASSIC_CARD
bool supportedMifareCard() {
  const MFRC522::PICC_Type type = rfid_reader.PICC_GetType(rfid_reader.uid.sak);
  return type == MFRC522::PICC_TYPE_MIFARE_MINI ||
         type == MFRC522::PICC_TYPE_MIFARE_1K ||
         type == MFRC522::PICC_TYPE_MIFARE_4K;
}

bool selectPendingCard() {
  byte atqa[2] = {};
  byte atqa_size = sizeof(atqa);
  const MFRC522::StatusCode wake_status = rfid_reader.PICC_WakeupA(atqa, &atqa_size);
  if (wake_status != MFRC522::STATUS_OK &&
      wake_status != MFRC522::STATUS_COLLISION) {
    return false;
  }
  if (!rfid_reader.PICC_ReadCardSerial()) {
    rfid_reader.PCD_StopCrypto1();
    return false;
  }
  if (!supportedMifareCard()) {
    const MFRC522::PICC_Type type =
        rfid_reader.PICC_GetType(rfid_reader.uid.sak);
    Serial.printf("rfid=unsupported_card type=%u sak=0x%02x uid=%s\n",
                  static_cast<unsigned int>(type), rfid_reader.uid.sak,
                  uidAsHex(rfid_reader.uid).c_str());
    rfid_reader.PICC_HaltA();
    rfid_reader.PCD_StopCrypto1();
    return false;
  }
  const bool matches = uidAsHex(rfid_reader.uid) == physical_card_uid;
  if (!matches) {
    rfid_reader.PICC_HaltA();
    rfid_reader.PCD_StopCrypto1();
  }
  return matches;
}

bool deriveMifareKeys(MFRC522::MIFARE_Key& key_a, MFRC522::MIFARE_Key& key_b) {
  const mbedtls_md_info_t* info = mbedtls_md_info_from_type(MBEDTLS_MD_SHA256);
  if (info == nullptr) return false;
  uint8_t derived[kBinarySize];
  mbedtls_md_context_t context;
  mbedtls_md_init(&context);
  bool ok = mbedtls_md_setup(&context, info, 1) == 0;
  ok = ok && mbedtls_md_hmac_starts(
                 &context, CARD_MASTER_SECRET,
                 sizeof(CARD_MASTER_SECRET)) == 0;
  ok = ok && mbedtls_md_hmac_update(
                 &context,
                 reinterpret_cast<const unsigned char*>(kMifareKeyDomain),
                 sizeof(kMifareKeyDomain)) == 0;
  ok = ok && mbedtls_md_hmac_update(&context, rfid_reader.uid.uidByte,
                                    rfid_reader.uid.size) == 0;
  ok = ok && mbedtls_md_hmac_finish(&context, derived) == 0;
  mbedtls_md_free(&context);
  if (!ok) return false;
  memcpy(key_a.keyByte, derived, MFRC522::MF_KEY_SIZE);
  memcpy(key_b.keyByte, derived + MFRC522::MF_KEY_SIZE, MFRC522::MF_KEY_SIZE);
  return true;
}

void buildMifareMarker(byte marker[16]) {
  memset(marker, 0, 16);
  memcpy(marker, kMifareMarker, sizeof(kMifareMarker));
  marker[8] = rfid_reader.uid.size;
  memcpy(marker + 9, rfid_reader.uid.uidByte,
         min(static_cast<byte>(7), rfid_reader.uid.size));
}

bool authenticateMifare(const MFRC522::MIFARE_Key& key) {
  MFRC522::MIFARE_Key mutable_key = key;
  return rfid_reader.PCD_Authenticate(
             MFRC522::PICC_CMD_MF_AUTH_KEY_A, kMifareDataBlock, &mutable_key,
             &rfid_reader.uid) == MFRC522::STATUS_OK;
}

bool readMifareMarker(const MFRC522::MIFARE_Key& key) {
  if (!authenticateMifare(key)) return false;
  byte expected[16];
  byte actual[18];
  byte size = sizeof(actual);
  buildMifareMarker(expected);
  return rfid_reader.MIFARE_Read(kMifareDataBlock, actual, &size) ==
             MFRC522::STATUS_OK &&
         constantTimeEqual(expected, actual, sizeof(expected));
}

void haltSelectedCard() {
  // Después de una autenticación MIFARE Classic, la PICC sólo acepta HLTA
  // cifrado. Crypto1 debe permanecer activo hasta que HALT haya sido enviado;
  // si se detiene antes, la tarjeta puede quedar ACTIVE y no responder al WUPA
  // del siguiente sondeo, simulando una retirada aunque siga sobre el lector.
  rfid_reader.PICC_HaltA();
  rfid_reader.PCD_StopCrypto1();
}

bool personalizeMifareCard(const MFRC522::MIFARE_Key& key_a,
                           const MFRC522::MIFARE_Key& key_b) {
  MFRC522::MIFARE_Key default_key;
  memset(default_key.keyByte, 0xff, MFRC522::MF_KEY_SIZE);
  if (!authenticateMifare(default_key)) return false;

  byte marker[16];
  buildMifareMarker(marker);
  if (rfid_reader.MIFARE_Write(kMifareDataBlock, marker, sizeof(marker)) !=
      MFRC522::STATUS_OK) {
    return false;
  }
  byte trailer[16];
  memcpy(trailer, key_a.keyByte, MFRC522::MF_KEY_SIZE);
  trailer[6] = 0xff;
  trailer[7] = 0x07;
  trailer[8] = 0x80;
  trailer[9] = 0x69;
  memcpy(trailer + 10, key_b.keyByte, MFRC522::MF_KEY_SIZE);
  if (rfid_reader.MIFARE_Write(kMifareTrailerBlock, trailer, sizeof(trailer)) !=
      MFRC522::STATUS_OK) {
    return false;
  }
  haltSelectedCard();
  if (!selectPendingCard()) return false;
  return readMifareMarker(key_a);
}

bool mifareCardReady(bool enrollment, bool identification = false) {
  if (!physical_card_pending || physical_card_uid.isEmpty()) return false;
  for (uint8_t attempt = 1; attempt <= kCardOperationAttempts; ++attempt) {
    if (!selectPendingCard()) {
      if (attempt < kCardOperationAttempts) delay(kCardOperationRetryMilliseconds);
      continue;
    }
    MFRC522::MIFARE_Key key_a;
    MFRC522::MIFARE_Key key_b;
    bool ready = deriveMifareKeys(key_a, key_b);
    if (ready) {
      ready = readMifareMarker(key_a);
      if (!ready && enrollment) {
        // Reinicia limpiamente la selección antes de probar la clave de fábrica.
        // Esto también conserva el orden HLTA -> StopCrypto1 si la lectura previa
        // sí alcanzó a activar Crypto1 pero falló la comprobación del marcador.
        haltSelectedCard();
        if (!selectPendingCard()) {
          if (attempt < kCardOperationAttempts) {
            delay(kCardOperationRetryMilliseconds);
          }
          continue;
        }
        ready = personalizeMifareCard(key_a, key_b);
      } else if (!ready && identification) {
        // Identificar una tarjeta nueva no debe enrolarla ni escribir sectores.
        // La clave de fábrica sólo confirma que el UID proviene de una tarjeta
        // MIFARE presente físicamente; el HMAC posterior autentica al validador.
        haltSelectedCard();
        if (!selectPendingCard()) {
          if (attempt < kCardOperationAttempts) {
            delay(kCardOperationRetryMilliseconds);
          }
          continue;
        }
        MFRC522::MIFARE_Key default_key;
        memset(default_key.keyByte, 0xff, MFRC522::MF_KEY_SIZE);
        ready = authenticateMifare(default_key);
      }
    }
    haltSelectedCard();
    if (ready) {
      Serial.printf("rfid=card_authenticated attempt=%u enrollment=%s\n", attempt,
                    enrollment ? "true" : "false");
      return true;
    }
    if (attempt < kCardOperationAttempts) delay(kCardOperationRetryMilliseconds);
  }
  Serial.printf("rfid=card_authentication_failed enrollment=%s uid=%s\n",
                enrollment ? "true" : "false", physical_card_uid.c_str());
  return false;
}
#endif

bool secureCardRespond(const uint8_t challenge[kBinarySize], String& credential_id,
                       uint8_t response[kBinarySize], bool enrollment,
                       bool identification = false) {
#if VALIDATOR_MIFARE_CLASSIC_CARD
  if (physical_card_pending && mifareCardReady(enrollment, identification)) {
    credential_id = String("nfc-") + physical_card_uid;
    return cardResponse(credential_id, challenge, response);
  }
#endif
#if VALIDATOR_SIMULATED_CARD
  credential_id = SIMULATED_CREDENTIAL_ID;
  return cardResponse(credential_id, challenge, response);
#else
  (void)challenge;
  (void)credential_id;
  (void)response;
  (void)enrollment;
  (void)identification;
  return false;
#endif
}

bool publishJson(const String& topic, JsonDocument& document,
                 bool retain = false) {
  char payload[1024];
  const size_t length = serializeJson(document, payload, sizeof(payload));
  if (length == 0 || length >= sizeof(payload) || mqtt_client == nullptr) {
    return false;
  }
  return esp_mqtt_client_publish(mqtt_client, topic.c_str(), payload,
                                 static_cast<int>(length), 1, retain) >= 0;
}

void newSession(char output[33]) {
  for (size_t index = 0; index < 16; ++index) {
    const uint8_t value = static_cast<uint8_t>(esp_random());
    snprintf(output + (index * 2), 3, "%02x", value);
  }
  output[32] = '\0';
}

bool utcNow(char output[32]) {
  const time_t now = time(nullptr);
  if (now < 1704067200) return false;
  struct tm utc_time;
  gmtime_r(&now, &utc_time);
  return strftime(output, 32, "%Y-%m-%dT%H:%M:%SZ", &utc_time) > 0;
}

bool equipmentAdvertisement(const NimBLEAdvertisedDevice& device) {
  if (!device.haveManufacturerData()) return false;
  const std::string data = device.getManufacturerData();
  if (data.size() < fuel_equipment_ble::kAdvertisementSize) return false;
  const uint8_t* bytes = reinterpret_cast<const uint8_t*>(data.data());
  if (bytes[0] != fuel_equipment_ble::kAdvertisementMagic0 ||
      bytes[1] != fuel_equipment_ble::kAdvertisementMagic1) {
    return false;
  }
  if (bytes[2] == fuel_equipment_ble::kProtocolVersion) {
    return (bytes[3] & fuel_equipment_ble::kFlagConfigured) != 0;
  }
#if VALIDATOR_ALLOW_LEGACY_EQUIPMENT == 1
  if (bytes[2] == kLegacyEquipmentProtocolVersion && data.size() >= 5) {
    return (bytes[4] & fuel_equipment_ble::kFlagConfigured) != 0;
  }
#endif
  return false;
}

ScanCandidate* findCandidate(ScanCandidate candidates[kMaximumBleCandidates],
                             size_t& count, const String& address) {
  for (size_t index = 0; index < count; ++index) {
    if (candidates[index].address == address) return &candidates[index];
  }
  if (count >= kMaximumBleCandidates) return nullptr;
  candidates[count].address = address;
  return &candidates[count++];
}

int medianRssi(ScanCandidate& candidate) {
  for (size_t left = 0; left < candidate.sample_count; ++left) {
    for (size_t right = left + 1; right < candidate.sample_count; ++right) {
      if (candidate.samples[right] < candidate.samples[left]) {
        const int temporary = candidate.samples[left];
        candidate.samples[left] = candidate.samples[right];
        candidate.samples[right] = temporary;
      }
    }
  }
  return candidate.samples[candidate.sample_count / 2];
}

bool decodeHexSecret(const char* encoded, uint8_t output[32]) {
  if (encoded == nullptr || strlen(encoded) != 64) return false;
  for (size_t index = 0; index < 32; ++index) {
    const char high = encoded[index * 2];
    const char low = encoded[index * 2 + 1];
    auto nibble = [](char value) -> int {
      if (value >= '0' && value <= '9') return value - '0';
      if (value >= 'a' && value <= 'f') return value - 'a' + 10;
      return -1;
    };
    const int high_value = nibble(high);
    const int low_value = nibble(low);
    if (high_value < 0 || low_value < 0) return false;
    output[index] = static_cast<uint8_t>((high_value << 4) | low_value);
  }
  return true;
}

bool validRegistryGeneration(const char* generation) {
  if (generation == nullptr || strlen(generation) != 64) return false;
  for (size_t index = 0; index < 64; ++index) {
    const char value = generation[index];
    if (!((value >= '0' && value <= '9') ||
          (value >= 'a' && value <= 'f'))) return false;
  }
  return true;
}

bool computeRegistryGeneration(const TrustedEquipmentSecret* entries,
                               size_t count, char output[65]) {
  const mbedtls_md_info_t* info = mbedtls_md_info_from_type(MBEDTLS_MD_SHA256);
  if (info == nullptr) return false;
  mbedtls_md_context_t context;
  mbedtls_md_init(&context);
  uint8_t digest[32];
  const uint8_t separator = 0;
  bool ok = mbedtls_md_setup(&context, info, 0) == 0;
  ok = ok && mbedtls_md_starts(&context) == 0;
  for (size_t index = 0; ok && index < count; ++index) {
    const size_t length = strnlen(entries[index].module_id, 64);
    ok = length > 0 && length < 64;
    ok = ok && mbedtls_md_update(
                   &context,
                   reinterpret_cast<const unsigned char*>(entries[index].module_id),
                   length) == 0;
    ok = ok && mbedtls_md_update(&context, &separator, 1) == 0;
    ok = ok && mbedtls_md_update(&context, entries[index].secret,
                                 sizeof(entries[index].secret)) == 0;
  }
  ok = ok && mbedtls_md_finish(&context, digest) == 0;
  mbedtls_md_free(&context);
  if (!ok) return false;
  const char digits[] = "0123456789abcdef";
  for (size_t index = 0; index < sizeof(digest); ++index) {
    output[index * 2] = digits[digest[index] >> 4];
    output[index * 2 + 1] = digits[digest[index] & 0x0f];
  }
  output[64] = '\0';
  return true;
}

bool validEquipmentRegistry(const TrustedEquipmentSecret* entries, size_t count,
                            const char* generation) {
  if (count > kMaximumTrustedEquipment ||
      !validRegistryGeneration(generation)) return false;
  for (size_t index = 0; index < count; ++index) {
    if (entries[index].module_id[63] != '\0' ||
        !validIdentifier(String(entries[index].module_id)) ||
        (index > 0 && strcmp(entries[index - 1].module_id,
                             entries[index].module_id) >= 0)) {
      return false;
    }
    uint8_t aggregate = 0;
    for (uint8_t value : entries[index].secret) aggregate |= value;
    if (aggregate == 0) return false;
  }
  char computed[65];
  return computeRegistryGeneration(entries, count, computed) &&
         strcmp(computed, generation) == 0;
}

void activateEquipmentRegistry(const TrustedEquipmentSecret* entries,
                               size_t count, const char* generation,
                               bool persisted) {
  memset(trusted_equipment, 0, sizeof(trusted_equipment));
  if (count > 0) {
    memcpy(trusted_equipment, entries,
           count * sizeof(TrustedEquipmentSecret));
  }
  trusted_equipment_count = count;
  equipment_registry_generation = generation;
  equipment_registry_persisted = persisted;
}

bool persistEquipmentRegistry(const TrustedEquipmentSecret* entries,
                              size_t count, const char* generation) {
  memset(&equipment_registry_storage, 0, sizeof(equipment_registry_storage));
  equipment_registry_storage.magic = kEquipmentRegistryMagic;
  equipment_registry_storage.schema = kEquipmentRegistrySchema;
  equipment_registry_storage.count = static_cast<uint16_t>(count);
  strlcpy(equipment_registry_storage.generation, generation,
          sizeof(equipment_registry_storage.generation));
  if (count > 0) {
    memcpy(equipment_registry_storage.entries, entries,
           count * sizeof(TrustedEquipmentSecret));
  }
  Preferences preferences;
  if (!preferences.begin("validator-mims", false)) return false;
  const size_t written = preferences.putBytes(
      "registry", &equipment_registry_storage,
      sizeof(equipment_registry_storage));
  preferences.end();
  return written == sizeof(equipment_registry_storage);
}

void loadEquipmentRegistry() {
  Preferences preferences;
  bool loaded = false;
  if (preferences.begin("validator-mims", true)) {
    if (preferences.getBytesLength("registry") ==
            sizeof(equipment_registry_storage) &&
        preferences.getBytes("registry", &equipment_registry_storage,
                             sizeof(equipment_registry_storage)) ==
            sizeof(equipment_registry_storage) &&
        equipment_registry_storage.magic == kEquipmentRegistryMagic &&
        equipment_registry_storage.schema == kEquipmentRegistrySchema &&
        validEquipmentRegistry(equipment_registry_storage.entries,
                               equipment_registry_storage.count,
                               equipment_registry_storage.generation)) {
      activateEquipmentRegistry(equipment_registry_storage.entries,
                                equipment_registry_storage.count,
                                equipment_registry_storage.generation, true);
      loaded = true;
    }
    preferences.end();
  }
  if (!loaded) {
    const size_t factory_count =
        min(static_cast<size_t>(TRUSTED_EQUIPMENT_COUNT),
            kMaximumTrustedEquipment);
    memset(staged_equipment_registry, 0, sizeof(staged_equipment_registry));
    for (size_t index = 0; index < factory_count; ++index) {
      staged_equipment_registry[index] = TRUSTED_EQUIPMENT[index];
    }
    char generation[65];
    if (!computeRegistryGeneration(staged_equipment_registry, factory_count,
                                   generation)) {
      strlcpy(generation,
              "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
              sizeof(generation));
    }
    activateEquipmentRegistry(staged_equipment_registry, factory_count,
                              generation, false);
  }
  Serial.printf("registry=ready modules=%u source=%s generation=%.12s\n",
                static_cast<unsigned int>(trusted_equipment_count),
                equipment_registry_persisted ? "mqtt" : "factory",
                equipment_registry_generation.c_str());
}

const TrustedEquipmentSecret* trustedEquipment(const String& module_id) {
  for (size_t index = 0; index < trusted_equipment_count; ++index) {
    if (module_id == trusted_equipment[index].module_id) {
      return &trusted_equipment[index];
    }
  }
  return nullptr;
}

bool buildExpectedEquipmentResponse(
    const TrustedEquipmentSecret& trusted, const String& module_id,
    const String& equipment_id,
    const uint8_t challenge[fuel_equipment_ble::kChallengeSize],
    const uint8_t module_nonce[fuel_equipment_ble::kModuleNonceSize],
    uint8_t response_tag[fuel_equipment_ble::kResponseTagSize]) {
  const mbedtls_md_info_t* info = mbedtls_md_info_from_type(MBEDTLS_MD_SHA256);
  if (info == nullptr) return false;
  mbedtls_md_context_t context;
  mbedtls_md_init(&context);
  bool ok = mbedtls_md_setup(&context, info, 1) == 0;
  ok = ok && mbedtls_md_hmac_starts(&context, trusted.secret,
                                    sizeof(trusted.secret)) == 0;
  ok = ok && mbedtls_md_hmac_update(
                 &context,
                 reinterpret_cast<const unsigned char*>(
                     fuel_equipment_ble::kHmacDomain),
                 sizeof(fuel_equipment_ble::kHmacDomain)) == 0;
  ok = ok && mbedtls_md_hmac_update(
                 &context,
                 reinterpret_cast<const unsigned char*>(module_id.c_str()),
                 module_id.length()) == 0;
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

#if VALIDATOR_ALLOW_LEGACY_EQUIPMENT == 1
bool buildExpectedLegacyEquipmentResponse(
    const TrustedEquipmentSecret& trusted, const String& module_id,
    const String& equipment_id,
    const uint8_t challenge[fuel_equipment_ble::kChallengeSize],
    uint8_t response_tag[kLegacyEquipmentResponseSize]) {
  const mbedtls_md_info_t* info = mbedtls_md_info_from_type(MBEDTLS_MD_SHA256);
  if (info == nullptr) return false;
  mbedtls_md_context_t context;
  mbedtls_md_init(&context);
  bool ok = mbedtls_md_setup(&context, info, 1) == 0;
  ok = ok && mbedtls_md_hmac_starts(&context, trusted.secret,
                                    sizeof(trusted.secret)) == 0;
  ok = ok && mbedtls_md_hmac_update(
                 &context,
                 reinterpret_cast<const unsigned char*>(
                     fuel_equipment_ble::kHmacDomain),
                 sizeof(fuel_equipment_ble::kHmacDomain)) == 0;
  ok = ok && mbedtls_md_hmac_update(
                 &context,
                 reinterpret_cast<const unsigned char*>(module_id.c_str()),
                 module_id.length()) == 0;
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
  ok = ok && mbedtls_md_hmac_finish(&context, response_tag) == 0;
  mbedtls_md_free(&context);
  return ok;
}
#endif

bool buildEquipmentSessionTag(
    const String& module_id, const String& equipment_id,
    const uint8_t secret[32],
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
  ok = ok && mbedtls_md_hmac_starts(&context, secret, 32) == 0;
  ok = ok && mbedtls_md_hmac_update(
                 &context,
                 reinterpret_cast<const uint8_t*>(
                     fuel_equipment_ble::kSessionHmacDomain),
                 sizeof(fuel_equipment_ble::kSessionHmacDomain)) == 0;
  ok = ok && mbedtls_md_hmac_update(
                 &context,
                 reinterpret_cast<const uint8_t*>(module_id.c_str()),
                 module_id.length()) == 0;
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

void clearEquipmentSessionSigningContext() {
  equipment_session_mode = EquipmentSessionMode::None;
  equipment_session_signing_ready = false;
  equipment_session_sequence = 0;
  memset(equipment_session_challenge, 0,
         sizeof(equipment_session_challenge));
  memset(equipment_session_module_nonce, 0,
         sizeof(equipment_session_module_nonce));
  memset(equipment_session_secret, 0, sizeof(equipment_session_secret));
}

void destroyEquipmentClient() {
  equipment_session_control = nullptr;
  if (equipment_client != nullptr) {
    if (equipment_client->isConnected()) equipment_client->disconnect();
    NimBLEDevice::deleteClient(equipment_client);
    equipment_client = nullptr;
  }
  clearEquipmentSessionSigningContext();
}

bool sendEquipmentHold();

bool authenticateEquipmentAddress(const String& address, int rssi,
                                  uint8_t address_type,
                                  const String& expected_module = "",
                                  const String& expected_equipment = "") {
  destroyEquipmentClient();
  equipment_client = NimBLEDevice::createClient();
  if (equipment_client == nullptr ||
      !equipment_client->connect(NimBLEAddress(
          std::string(address.c_str()), address_type))) {
    destroyEquipmentClient();
    return false;
  }
  NimBLERemoteService* service =
      equipment_client->getService(fuel_equipment_ble::kServiceUuid);
  if (service == nullptr) {
    destroyEquipmentClient();
    return false;
  }
  NimBLERemoteCharacteristic* identity =
      service->getCharacteristic(fuel_equipment_ble::kIdentityUuid);
  NimBLERemoteCharacteristic* challenge_characteristic =
      service->getCharacteristic(fuel_equipment_ble::kChallengeUuid);
  NimBLERemoteCharacteristic* response_characteristic =
      service->getCharacteristic(fuel_equipment_ble::kResponseUuid);
  NimBLERemoteCharacteristic* session_control =
      service->getCharacteristic(fuel_equipment_ble::kSessionControlUuid);
  if (identity == nullptr || challenge_characteristic == nullptr ||
      response_characteristic == nullptr || session_control == nullptr) {
    destroyEquipmentClient();
    return false;
  }

  const std::string identity_payload = identity->readValue();
  JsonDocument identity_document;
  if (deserializeJson(identity_document, identity_payload) !=
      DeserializationError::Ok) {
    destroyEquipmentClient();
    return false;
  }
  const int identity_protocol_version = identity_document["version"].as<int>();
  bool supported_identity_protocol =
      identity_protocol_version == fuel_equipment_ble::kProtocolVersion;
#if VALIDATOR_ALLOW_LEGACY_EQUIPMENT == 1
  supported_identity_protocol =
      supported_identity_protocol ||
      identity_protocol_version == kLegacyEquipmentProtocolVersion;
#endif
  if (!supported_identity_protocol) {
    destroyEquipmentClient();
    return false;
  }
  const String module_id = identity_document["module_id"].as<String>();
  const String equipment_id = identity_document["equipment_id"].as<String>();
  if (!validIdentifier(module_id) || !validIdentifier(equipment_id) ||
      (!expected_module.isEmpty() && module_id != expected_module) ||
      (!expected_equipment.isEmpty() && equipment_id != expected_equipment)) {
    destroyEquipmentClient();
    return false;
  }
  const TrustedEquipmentSecret* trusted =
      trustedEquipment(module_id);
  if (trusted == nullptr) {
    destroyEquipmentClient();
    return false;
  }

  uint8_t challenge[fuel_equipment_ble::kChallengeSize];
  esp_fill_random(challenge, sizeof(challenge));
  if (!challenge_characteristic->writeValue(challenge, sizeof(challenge), true)) {
    destroyEquipmentClient();
    return false;
  }
  const std::string response = response_characteristic->readValue();
  EquipmentSessionMode negotiated_mode = EquipmentSessionMode::None;
  uint8_t negotiated_module_nonce[fuel_equipment_ble::kModuleNonceSize] = {};
  if (response.size() == fuel_equipment_ble::kResponseSize) {
    const uint8_t* response_bytes =
        reinterpret_cast<const uint8_t*>(response.data());
    const uint8_t* module_nonce = response_bytes;
    const uint8_t* response_tag =
        response_bytes + fuel_equipment_ble::kModuleNonceSize;
    uint8_t expected_response_tag[fuel_equipment_ble::kResponseTagSize];
    if (!buildExpectedEquipmentResponse(*trusted, module_id, equipment_id,
                                        challenge, module_nonce,
                                        expected_response_tag) ||
        !constantTimeEqual(response_tag, expected_response_tag,
                           sizeof(expected_response_tag))) {
      Serial.printf(
          "equipment=authentication_failed mode=signed_v4 reason=hmac module_id=%s\n",
          module_id.c_str());
      destroyEquipmentClient();
      return false;
    }
    memcpy(negotiated_module_nonce, module_nonce,
           sizeof(negotiated_module_nonce));
    negotiated_mode = EquipmentSessionMode::SignedV4;
  } else if (response.size() == kLegacyEquipmentResponseSize) {
#if VALIDATOR_ALLOW_LEGACY_EQUIPMENT == 1
    uint8_t expected_legacy_response[kLegacyEquipmentResponseSize];
    if (!buildExpectedLegacyEquipmentResponse(
            *trusted, module_id, equipment_id, challenge,
            expected_legacy_response) ||
        !constantTimeEqual(
            reinterpret_cast<const uint8_t*>(response.data()),
            expected_legacy_response, sizeof(expected_legacy_response))) {
      Serial.printf(
          "equipment=authentication_failed mode=legacy_32 reason=hmac module_id=%s\n",
          module_id.c_str());
      destroyEquipmentClient();
      return false;
    }
    negotiated_mode = EquipmentSessionMode::Legacy32;
#else
    Serial.printf(
        "equipment=authentication_failed mode=legacy_32 reason=compatibility_disabled module_id=%s\n",
        module_id.c_str());
    destroyEquipmentClient();
    return false;
#endif
  } else {
    // Vacío (timeout), truncado o cualquier longitud no contractual se rechaza.
    // Nunca se reinterpreta una respuesta v4 inválida como una prueba legacy.
    Serial.printf(
        "equipment=authentication_failed reason=response_size bytes=%u module_id=%s\n",
        static_cast<unsigned int>(response.size()), module_id.c_str());
    destroyEquipmentClient();
    return false;
  }

  // El RSSI que decide la distancia se mide ya conectado. Así no obligamos al
  // MIM a permanecer anunciando durante varios ciclos antes de autenticarlo.
  int connected_samples[BLE_RSSI_SAMPLE_COUNT];
  size_t connected_count = 0;
  for (size_t index = 0; index < BLE_RSSI_SAMPLE_COUNT; ++index) {
    const int sample = equipment_client->getRssi();
    // NimBLE devuelve 0 cuando falla la consulta; no debe interpretarse como
    // una señal extraordinariamente fuerte ni superar el umbral de distancia.
    if (sample >= -127 && sample < 0) {
      connected_samples[connected_count++] = sample;
    }
    delay(80);
  }
  if (connected_count > 0) {
    for (size_t left = 0; left < connected_count; ++left) {
      for (size_t right = left + 1; right < connected_count; ++right) {
        if (connected_samples[right] < connected_samples[left]) {
          const int temporary = connected_samples[left];
          connected_samples[left] = connected_samples[right];
          connected_samples[right] = temporary;
        }
      }
    }
    rssi = connected_samples[connected_count / 2];
  }
  if (rssi < ble_rssi_threshold) {
    Serial.printf("equipment=outside_zone rssi=%d threshold=%d\n", rssi,
                  ble_rssi_threshold);
    destroyEquipmentClient();
    return false;
  }

  equipment_session_control = session_control;
  active_equipment_address = address;
  active_equipment_address_type = address_type;
  active_equipment_module_id = module_id;
  active_equipment_id = equipment_id;
  active_equipment_rssi = rssi;
  memcpy(equipment_session_challenge, challenge,
         sizeof(equipment_session_challenge));
  equipment_session_mode = negotiated_mode;
  equipment_session_sequence = 0;
  if (equipment_session_mode == EquipmentSessionMode::SignedV4) {
    memcpy(equipment_session_module_nonce, negotiated_module_nonce,
           sizeof(equipment_session_module_nonce));
    memcpy(equipment_session_secret, trusted->secret,
           sizeof(equipment_session_secret));
    equipment_session_signing_ready = true;
  }
  Serial.printf(
      "equipment=session_protocol mode=%s legacy_compatibility=%s module_id=%s equipment_id=%s\n",
      equipment_session_mode == EquipmentSessionMode::Legacy32 ? "legacy_32"
                                                                : "signed_v4",
      equipment_session_mode == EquipmentSessionMode::Legacy32 ? "active"
                                                                : "unused",
      module_id.c_str(), equipment_id.c_str());
  // La primera concesión se emite inmediatamente. En el modo de 64 bytes va
  // firmada; el formato legacy sólo existe en el binario migratorio explícito.
  if (!sendEquipmentHold()) {
    destroyEquipmentClient();
    return false;
  }
  equipment_authenticated = true;
  return true;
}

bool scanAndAuthenticateEquipment(
    unsigned long timeout_milliseconds = BLE_SCAN_TIMEOUT_SECONDS * 1000UL) {
  ScanCandidate candidates[kMaximumBleCandidates];
  size_t candidate_count = 0;
  NimBLEScan* scan = NimBLEDevice::getScan();
  scan->setActiveScan(true);
  scan->setInterval(45);
  scan->setWindow(30);
  const unsigned long scan_deadline = millis() + timeout_milliseconds;
  while (static_cast<long>(scan_deadline - millis()) > 0) {
    const unsigned long remaining = scan_deadline - millis();
    const uint32_t scan_slice =
        static_cast<uint32_t>(min(remaining, 1000UL));
    NimBLEScanResults results = scan->getResults(scan_slice, false);
    for (int index = 0; index < results.getCount(); ++index) {
      const NimBLEAdvertisedDevice* device = results.getDevice(index);
      if (device == nullptr) continue;
      if (!equipmentAdvertisement(*device)) continue;
      const String address(device->getAddress().toString().c_str());
      ScanCandidate* candidate =
          findCandidate(candidates, candidate_count, address);
      if (candidate == nullptr ||
          candidate->sample_count >= BLE_RSSI_SAMPLE_COUNT) {
        continue;
      }
      candidate->samples[candidate->sample_count++] = device->getRSSI();
      candidate->address_type = device->getAddressType();
    }
    scan->clearResults();
    // Conectar de inmediato es importante: el MIM ahorra batería y su ventana
    // de anuncios puede ser corta. El filtrado estable se hace conectado.
    if (candidate_count > 0) break;
  }

  ScanCandidate* selected = nullptr;
  int selected_rssi = -128;
  for (size_t index = 0; index < candidate_count; ++index) {
    ScanCandidate& candidate = candidates[index];
    if (candidate.sample_count == 0) continue;
    const int median = medianRssi(candidate);
    if (median > selected_rssi) {
      selected = &candidate;
      selected_rssi = median;
    }
  }
  if (selected == nullptr) return false;
  return authenticateEquipmentAddress(selected->address, selected_rssi,
                                      selected->address_type);
}

bool sendEquipmentSessionCommand(uint8_t operation, uint16_t seconds) {
  if (equipment_session_control == nullptr || equipment_client == nullptr ||
      !equipment_client->isConnected() || !equipment_session_signing_ready ||
      equipment_session_mode != EquipmentSessionMode::SignedV4 ||
      equipment_session_sequence == UINT32_MAX ||
      (operation == fuel_equipment_ble::kCommandHoldAwake &&
       (seconds == 0 || seconds > fuel_equipment_ble::kMaximumHoldSeconds)) ||
      (operation == fuel_equipment_ble::kCommandCloseSession && seconds != 0) ||
      (operation != fuel_equipment_ble::kCommandHoldAwake &&
       operation != fuel_equipment_ble::kCommandCloseSession)) {
    return false;
  }
  const uint32_t sequence = equipment_session_sequence + 1;
  uint8_t command[fuel_equipment_ble::kSessionCommandSize] = {};
  fuel_equipment_ble::encodeSessionCommandHeader(operation, seconds, sequence,
                                                  command);
  if (!buildEquipmentSessionTag(
          active_equipment_module_id, active_equipment_id,
          equipment_session_secret, equipment_session_challenge,
          equipment_session_module_nonce, command,
          command + fuel_equipment_ble::kSessionCommandHeaderSize)) {
    return false;
  }
  if (!equipment_session_control->writeValue(command, sizeof(command), true)) {
    return false;
  }
  equipment_session_sequence = sequence;
  return true;
}

#if VALIDATOR_ALLOW_LEGACY_EQUIPMENT == 1
bool sendLegacyEquipmentSessionCommand(uint8_t operation, uint16_t seconds) {
  if (equipment_session_control == nullptr || equipment_client == nullptr ||
      !equipment_client->isConnected() ||
      equipment_session_mode != EquipmentSessionMode::Legacy32) {
    return false;
  }
  if (operation == fuel_equipment_ble::kCommandHoldAwake) {
    if (seconds == 0 || seconds > fuel_equipment_ble::kMaximumHoldSeconds) {
      return false;
    }
    uint8_t command[kLegacyEquipmentHoldCommandSize] = {
        operation, static_cast<uint8_t>(seconds >> 8),
        static_cast<uint8_t>(seconds)};
    return equipment_session_control->writeValue(command, sizeof(command), true);
  }
  if (operation == fuel_equipment_ble::kCommandCloseSession && seconds == 0) {
    const uint8_t command[kLegacyEquipmentCloseCommandSize] = {operation};
    return equipment_session_control->writeValue(command, sizeof(command), true);
  }
  return false;
}
#endif

bool sendEquipmentHold() {
#if VALIDATOR_ALLOW_LEGACY_EQUIPMENT == 1
  if (equipment_session_mode == EquipmentSessionMode::Legacy32) {
    return sendLegacyEquipmentSessionCommand(
        fuel_equipment_ble::kCommandHoldAwake, kEquipmentHoldSeconds);
  }
#endif
  return sendEquipmentSessionCommand(fuel_equipment_ble::kCommandHoldAwake,
                                     kEquipmentHoldSeconds);
}

void closeEquipmentSession() {
  if (equipment_session_control != nullptr && equipment_client != nullptr &&
      equipment_client->isConnected()) {
#if VALIDATOR_ALLOW_LEGACY_EQUIPMENT == 1
    if (equipment_session_mode == EquipmentSessionMode::Legacy32) {
      sendLegacyEquipmentSessionCommand(
          fuel_equipment_ble::kCommandCloseSession, 0);
    } else
#endif
        if (equipment_session_mode == EquipmentSessionMode::SignedV4) {
      sendEquipmentSessionCommand(
          fuel_equipment_ble::kCommandCloseSession, 0);
    }
  }
  destroyEquipmentClient();
  equipment_authenticated = false;
  authorized_equipment_session = false;
  equipment_lost_since = 0;
  next_equipment_keepalive = 0;
  next_equipment_reconnect = 0;
  equipment_waiting_for_card = false;
  equipment_link_deadline = 0;
  next_equipment_presence = 0;
  equipment_link_session.clear();
}

bool publishCredentialPresence(bool present, bool authenticated,
                               unsigned long absent_milliseconds) {
  if (!mqtt_online || active_session.isEmpty() ||
      physical_credential_id.isEmpty()) {
    return false;
  }
  char occurred_at[32];
  if (!utcNow(occurred_at)) return false;
  JsonDocument document;
  document["version"] = 1;
  document["type"] = "credential.presence";
  document["validator_id"] = VALIDATOR_ID;
  document["session_id"] = active_session;
  document["credential_id"] = physical_credential_id;
  document["present"] = present;
  document["authenticated"] = authenticated;
  document["absent_for_milliseconds"] = absent_milliseconds;
  document["occurred_at"] = occurred_at;
  return publishJson(credential_topic, document);
}

void closeAfterCredentialLoss(unsigned long absent_milliseconds) {
  if (!publishCredentialPresence(false, false, absent_milliseconds)) return;
  Serial.printf("rfid=removed confirmed_milliseconds=%lu\n",
                absent_milliseconds);
  beep(2, 70, 70);
  closeEquipmentSession();
  active_session.clear();
  active_equipment_address.clear();
  active_equipment_module_id.clear();
  active_equipment_id.clear();
  clearPhysicalCard();
  digitalWrite(LED_BUILTIN, LOW);
}

void maintainCredentialPresence() {
  if (!credential_presence_monitoring || active_session.isEmpty()) return;
  const unsigned long now = millis();
  if (credential_loss_pending) {
    closeAfterCredentialLoss(
        credential_absent_since == 0 ? kCardRemovalDebounceMilliseconds
                                     : now - credential_absent_since);
    return;
  }
  if (static_cast<long>(now - next_card_presence_poll) < 0) return;
  next_card_presence_poll = now + kCardPresencePollMilliseconds;

  const bool heartbeat_due =
      static_cast<long>(now - next_credential_heartbeat) >= 0;
  bool present = false;
#if VALIDATOR_MIFARE_CLASSIC_CARD
  if (heartbeat_due) {
    // El heartbeat vuelve a autenticar el sector; los sondeos intermedios sólo
    // comprueban el mismo UID para detectar la retirada con baja latencia.
    present = mifareCardReady(false);
  } else {
    present = selectPendingCard();
    if (present) {
      haltSelectedCard();
    }
  }
#elif VALIDATOR_SIMULATED_CARD
  present = true;
#endif

  if (present) {
    credential_absent_since = 0;
    if (heartbeat_due) {
      if (publishCredentialPresence(true, true, 0)) {
        next_credential_heartbeat = now + kCardPresenceHeartbeatMilliseconds;
      }
    }
    return;
  }
  if (credential_absent_since == 0) credential_absent_since = now;
  const unsigned long absent_milliseconds = now - credential_absent_since;
  if (absent_milliseconds >= kCardRemovalDebounceMilliseconds) {
    credential_loss_pending = true;
    closeAfterCredentialLoss(absent_milliseconds);
  }
}

bool publishEquipmentPresenceState(bool present, bool authenticated,
                                   unsigned long lost_for_seconds,
                                   const char* phase) {
  const String& session_id =
      active_session.isEmpty() ? equipment_link_session : active_session;
  if (!mqtt_online || session_id.isEmpty() ||
      active_equipment_module_id.isEmpty() || active_equipment_id.isEmpty()) {
    return false;
  }
  char occurred_at[32];
  if (!utcNow(occurred_at)) return false;
  JsonDocument document;
  document["version"] = 1;
  document["type"] = "equipment.presence";
  document["validator_id"] = VALIDATOR_ID;
  document["session_id"] = session_id;
  document["module_id"] = active_equipment_module_id;
  document["equipment_id"] = active_equipment_id;
  document["present"] = present;
  document["authenticated"] = authenticated;
  document["lost_for_seconds"] = lost_for_seconds;
  document["rssi"] = active_equipment_rssi;
  document["phase"] = phase;
  const unsigned long now = millis();
  document["link_window_remaining_seconds"] =
      equipment_waiting_for_card &&
              static_cast<long>(equipment_link_deadline - now) > 0
          ? (equipment_link_deadline - now + 999UL) / 1000UL
          : 0;
  document["occurred_at"] = occurred_at;
  return publishJson(equipment_topic, document);
}

bool refreshConnectedEquipmentRssi() {
  if (equipment_client == nullptr || !equipment_client->isConnected()) {
    return false;
  }
  const int sample = equipment_client->getRssi();
  // getRssi() usa 0 como centinela de error. Conservamos la última muestra
  // válida si esa lectura puntual falla, evitando saltos falsos en el mapa.
  if (sample < -127 || sample >= 0) return false;
  active_equipment_rssi = sample;
  return true;
}

void clearActiveEquipmentIdentity() {
  active_equipment_address.clear();
  active_equipment_module_id.clear();
  active_equipment_id.clear();
  active_equipment_rssi = -127;
}

void expireEquipmentLinkWindow(const char* reason) {
  (void)publishEquipmentPresenceState(false, false, 0, reason);
  Serial.printf("equipment=link_window_closed reason=%s\n", reason);
  closeEquipmentSession();
  clearActiveEquipmentIdentity();
  clearPhysicalCard();
  active_session.clear();
  next_proactive_equipment_scan = millis() + kProactiveScanIntervalMilliseconds;
}

void maintainProactiveEquipmentDiscovery() {
  const unsigned long now = millis();
  if (!mqtt_online || enrollment_window_active || ota_update_running ||
      ota_command_pending || !active_session.isEmpty() ||
      physical_card_pending || credential_presence_monitoring ||
      authorized_equipment_session || equipment_waiting_for_card ||
      equipment_client != nullptr || trusted_equipment_count == 0 ||
      static_cast<long>(now - next_proactive_equipment_scan) < 0) {
    return;
  }
  next_proactive_equipment_scan =
      now + kProactiveScanSliceMilliseconds + kProactiveScanIntervalMilliseconds;
  if (!scanAndAuthenticateEquipment(kProactiveScanSliceMilliseconds)) return;

  char link_session[33];
  newSession(link_session);
  equipment_link_session = link_session;
  equipment_waiting_for_card = true;
  authorized_equipment_session = false;
  equipment_link_deadline = millis() + kEquipmentLinkWindowMilliseconds;
  equipment_lost_since = 0;
  next_equipment_reconnect = 0;
  next_equipment_keepalive = millis() + kEquipmentKeepAliveMilliseconds;
  next_equipment_presence = 0;
  Serial.printf(
      "equipment=link_window_open module_id=%s equipment_id=%s seconds=%lu rssi=%d\n",
      active_equipment_module_id.c_str(), active_equipment_id.c_str(),
      kEquipmentLinkWindowMilliseconds / 1000UL, active_equipment_rssi);
  (void)publishEquipmentPresenceState(true, true, 0, "waiting_tag");
}

bool publishEquipmentLoss() {
  if (!publishEquipmentPresenceState(
          false, false, kEquipmentLossMilliseconds / 1000UL, "lost")) {
    return false;
  }

  Serial.println("equipment=lost confirmed_seconds=20");
  equipment_loss_pending = false;
  closeEquipmentSession();
  active_session.clear();
  clearActiveEquipmentIdentity();
  clearPhysicalCard();
  digitalWrite(LED_BUILTIN, LOW);
  return true;
}

void maintainEquipmentSession() {
  const unsigned long now = millis();
  if (equipment_waiting_for_card &&
      static_cast<long>(now - equipment_link_deadline) >= 0) {
    expireEquipmentLinkWindow("tag_timeout");
    return;
  }
  if (equipment_loss_pending) {
    publishEquipmentLoss();
    return;
  }
  if (equipment_client != nullptr && !equipment_client->isConnected()) {
    // Una desconexión invalida nonces, secuencia y modo incluso mientras aún se
    // espera la decisión MQTT. Una reconexión siempre debe autenticarse de cero.
    destroyEquipmentClient();
  }
  if ((!authorized_equipment_session && !equipment_waiting_for_card) ||
      active_equipment_address.isEmpty()) {
    return;
  }
  if (equipment_client != nullptr && equipment_client->isConnected()) {
    if (equipment_lost_since != 0) {
      equipment_lost_since = 0;
      Serial.println("equipment=presence_restored");
    }
    if (static_cast<long>(now - next_equipment_keepalive) >= 0) {
      if (!sendEquipmentHold()) {
        destroyEquipmentClient();
      }
      next_equipment_keepalive = now + kEquipmentKeepAliveMilliseconds;
    }
    if (static_cast<long>(now - next_equipment_presence) >= 0) {
      (void)refreshConnectedEquipmentRssi();
      (void)publishEquipmentPresenceState(
          true, true, 0,
          equipment_waiting_for_card ? "waiting_tag" : "authorized");
      next_equipment_presence =
          now + kEquipmentPresenceHeartbeatMilliseconds;
    }
    return;
  }
  if (equipment_lost_since == 0) {
    equipment_lost_since = now;
    next_equipment_reconnect = now;
    Serial.println("equipment=presence_unstable");
  }
  if (now - equipment_lost_since >= kEquipmentLossMilliseconds) {
    equipment_loss_pending = true;
    publishEquipmentLoss();
    return;
  }
  if (static_cast<long>(now - next_equipment_reconnect) >= 0) {
    const String address = active_equipment_address;
    const String module_id = active_equipment_module_id;
    const String equipment_id = active_equipment_id;
    if (authenticateEquipmentAddress(address, active_equipment_rssi,
                                     active_equipment_address_type, module_id,
                                     equipment_id)) {
      equipment_lost_since = 0;
      next_equipment_keepalive = millis() + kEquipmentKeepAliveMilliseconds;
    }
    next_equipment_reconnect = now + kEquipmentReconnectMilliseconds;
  }
}

void publishPresentation(bool include_equipment = false) {
  if (!mqtt_online || !active_session.isEmpty()) return;
  char session[33];
  char occurred_at[32];
  if (!utcNow(occurred_at)) {
    Serial.println("presentation=blocked clock_not_synchronized");
    return;
  }
  newSession(session);
  active_session = session;
  authorization_phase = include_equipment
                            ? AuthorizationPhase::EquipmentValidation
                            : AuthorizationPhase::CredentialPreflight;
  // El camino normal reutiliza la sesión HMAC que la búsqueda proactiva ya
  // mantiene viva. El escaneo largo queda sólo como compatibilidad si una
  // tarjeta llega antes del primer ciclo de búsqueda en segundo plano.
  if (include_equipment &&
      (equipment_client == nullptr || !equipment_client->isConnected() ||
       !equipment_authenticated)) {
    equipment_authenticated = scanAndAuthenticateEquipment();
  } else if (!include_equipment) {
    equipment_authenticated = false;
  }

  JsonDocument document;
  document["version"] = 1;
  document["type"] = "rfid.presentation";
  document["validator_id"] = VALIDATOR_ID;
  document["session_id"] = active_session;
  if (equipment_authenticated) {
    JsonObject equipment = document["equipment"].to<JsonObject>();
    equipment["module_id"] = active_equipment_module_id;
    equipment["equipment_id"] = active_equipment_id;
    equipment["present"] = true;
    equipment["authenticated"] = true;
    equipment["rssi"] = active_equipment_rssi;
  } else {
    document["equipment"] = nullptr;
  }
  document["occurred_at"] = occurred_at;
  if (!publishJson(presentation_topic, document)) {
    closeEquipmentSession();
    active_session.clear();
  }
}

bool readCardForPresentation() {
  if (!enrollment_window_active) {
    // En autorizaciones normales sólo una entrada nueva al campo inicia una
    // sesión. Así un rechazo no se repite indefinidamente mientras el usuario
    // mantiene la tarjeta sobre el lector.
    return rfid_reader.PICC_IsNewCardPresent() &&
           rfid_reader.PICC_ReadCardSerial();
  }

  // La consulta web puede abrirse unas décimas después de que el usuario
  // apoyó el tag. PICC_IsNewCardPresent() usa REQA y no ve una tarjeta que ya
  // quedó en HALT por esa primera presentación. WUPA la despierta y permite
  // consumirla sin exigir retirarla y acercarla dos o tres veces.
  byte atqa[2] = {};
  byte atqa_size = sizeof(atqa);
  const MFRC522::StatusCode wake_status =
      rfid_reader.PICC_WakeupA(atqa, &atqa_size);
  if (wake_status != MFRC522::STATUS_OK &&
      wake_status != MFRC522::STATUS_COLLISION) {
    return false;
  }
  if (rfid_reader.PICC_ReadCardSerial()) return true;
  rfid_reader.PCD_StopCrypto1();
  return false;
}

void pollPhysicalCard() {
  if (!rfid_ready || !active_session.isEmpty() ||
      !readCardForPresentation()) {
    return;
  }

  physical_card_uid = uidAsHex(rfid_reader.uid);
  physical_card_pending = true;
  physical_card_seen_at = millis();
  const MFRC522::PICC_Type card_type =
      rfid_reader.PICC_GetType(rfid_reader.uid.sak);
  Serial.printf("rfid=card_detected uid=%s type=%u sak=0x%02x enrollment=%s\n",
                physical_card_uid.c_str(), static_cast<unsigned int>(card_type),
                rfid_reader.uid.sak,
                enrollment_window_active ? "true" : "false");

  // Libera el bus y deja la llave en HALT durante el intercambio MQTT. Si la
  // Raspberry exige equipo, el validador la mantendrá pendiente durante BLE y
  // volverá a despertarla con un desafío fresco.
  rfid_reader.PICC_HaltA();
  rfid_reader.PCD_StopCrypto1();
  beep(1, 70);
  const bool link_window_active =
      equipment_waiting_for_card && equipment_authenticated &&
      equipment_client != nullptr && equipment_client->isConnected() &&
      static_cast<long>(equipment_link_deadline - millis()) > 0;
  publishPresentation(link_window_active);
  if (active_session.isEmpty()) clearPhysicalCard();
}

void handleChallenge(const char* payload, size_t length) {
  JsonDocument document;
  if (deserializeJson(document, payload, length) != DeserializationError::Ok) return;
  if (document["version"].as<int>() != 1 ||
      document["type"].as<String>() != "rfid.challenge" ||
      document["validator_id"].as<String>() != VALIDATOR_ID ||
      document["session_id"].as<String>() != active_session) {
    return;
  }

  uint8_t challenge[kBinarySize];
  uint8_t response[kBinarySize];
  String credential_id;
  const bool challenge_valid =
      decode32(document["challenge"].as<const char*>(), challenge);
  const bool card_still_valid =
      !physical_card_pending ||
      millis() - physical_card_seen_at <= kCardPresentationValidityMilliseconds;
  const String purpose = document["purpose"] | "authorization";
  const bool enrollment = purpose == "enrollment";
  const bool identification = purpose == "identification";
  if (!enrollment && !identification && purpose != "authorization") return;
  const bool credential_present = challenge_valid && card_still_valid &&
                                  secureCardRespond(challenge, credential_id,
                                                    response, enrollment,
                                                    identification);
  if (credential_present) physical_credential_id = credential_id;
  if (!credential_present) {
    Serial.printf(
        "rfid=proof_unavailable challenge=%s card_valid=%s purpose=%s uid=%s\n",
        challenge_valid ? "valid" : "invalid",
        card_still_valid ? "true" : "false", purpose.c_str(),
        physical_card_uid.c_str());
  }

  JsonDocument proof;
  proof["version"] = 1;
  proof["type"] = "rfid.proof";
  proof["validator_id"] = VALIDATOR_ID;
  proof["session_id"] = active_session;
  proof["credential_present"] = credential_present;
  if (credential_present) {
    char challenge_b64[48];
    char response_b64[48];
    if (!encode32(challenge, challenge_b64) ||
        !encode32(response, response_b64)) {
      return;
    }
    proof["credential_id"] = credential_id;
    proof["challenge"] = challenge_b64;
    proof["response"] = response_b64;
  }
  publishJson(proof_topic, proof);
}

void handleDecision(const char* payload, size_t length) {
  JsonDocument document;
  if (deserializeJson(document, payload, length) != DeserializationError::Ok) return;
  if (document["version"].as<int>() != 1 ||
      document["type"].as<String>() != "rfid.decision" ||
      document["validator_id"].as<String>() != VALIDATOR_ID ||
      document["session_id"].as<String>() != active_session) {
    return;
  }
  const bool allowed = document["allowed"] | false;
  const String reason = document["reason"] | "";
  const bool enrollment_completed = reason == "enrollment_completed";
  const bool enrollment_pending_sync = reason == "enrollment_pending_sync";
  const bool equipment_preflight_required =
      !allowed && reason == "equipment_required" &&
      authorization_phase == AuthorizationPhase::CredentialPreflight &&
      !enrollment_window_active;
  digitalWrite(LED_BUILTIN, allowed ? HIGH : LOW);
  Serial.printf("decision=%s reason=%s state=%s\n", allowed ? "allowed" : "denied",
                reason.c_str(), document["state"] | "");

  if (equipment_preflight_required) {
    // La prueba NFC ya fue válida y la Raspberry confirmó que no es maestra.
    // Esta rama se consume una sola vez: la nueva sesión queda marcada como
    // EquipmentValidation, por lo que otro equipment_required termina en
    // rechazo normal y nunca inicia un bucle de escaneos.
    Serial.printf("authorization=equipment_required scanning_mim timeout=%u\n",
                  static_cast<unsigned int>(BLE_SCAN_TIMEOUT_SECONDS));
    active_session.clear();
    closeEquipmentSession();
    publishPresentation(true);
    if (active_session.isEmpty()) {
      beep(3, 70, 70);
      clearPhysicalCard();
    }
    return;
  }

  const bool master_authorized =
      allowed && !equipment_authenticated &&
      authorization_phase == AuthorizationPhase::CredentialPreflight;
  if (master_authorized) {
    Serial.println("authorization=master fast_path=true equipment_scan=false");
    playMasterChime();
  } else if (allowed) {
    beep(1, 250);
  } else if (enrollment_completed) {
    // El relé permanece bloqueado, pero dos tonos largos distinguen claramente
    // un enrolamiento exitoso de un rechazo de autorización.
    beep(2, 180, 90);
  } else if (enrollment_pending_sync) {
    // La lectura y personalización fueron correctas; la Raspberry reintentará
    // el acuse web sin pedir que se vuelva a presentar la tarjeta.
    beep(2, 90, 80);
  } else {
    beep(3, 70, 70);
  }
  if (allowed && !physical_credential_id.isEmpty()) {
    credential_presence_monitoring = true;
    credential_absent_since = 0;
    next_card_presence_poll = millis();
    next_credential_heartbeat = millis();
    if (equipment_authenticated) {
      authorized_equipment_session = true;
      equipment_waiting_for_card = false;
      equipment_link_deadline = 0;
      equipment_link_session.clear();
      equipment_lost_since = 0;
      next_equipment_keepalive = millis() + kEquipmentKeepAliveMilliseconds;
      next_equipment_presence = 0;
    }
    return;
  }
  const bool retry_tag_within_link_window =
      !allowed && equipment_waiting_for_card &&
      authorization_phase == AuthorizationPhase::EquipmentValidation &&
      static_cast<long>(equipment_link_deadline - millis()) > 0;
  if (retry_tag_within_link_window) {
    // Una tarjeta rechazada no desperdicia el clic del operador. El enlace
    // criptográfico con el MIM continúa sólo hasta el deadline original y
    // permite presentar otra credencial sin extender la ventana de 60 s.
    active_session.clear();
    clearPhysicalCard();
    next_equipment_presence = 0;
    (void)publishEquipmentPresenceState(true, true, 0, "waiting_tag");
    return;
  }
  clearPhysicalCard();
  closeEquipmentSession();
  active_session.clear();
}

void publishConfigStatus() {
  if (!mqtt_online || ble_config_revision == 0) return;
  JsonDocument status;
  status["version"] = 1;
  status["type"] = "validator.config.status";
  status["validator_id"] = VALIDATOR_ID;
  status["ble_rssi_threshold"] = ble_rssi_threshold;
  status["revision"] = ble_config_revision;
  const byte rfid_version = rfid_reader.PCD_ReadRegister(MFRC522::VersionReg);
  status["rfid_ready"] = rfid_ready;
  status["rfid_version"] = rfid_version;
  status["firmware"] = kFirmwareVersion;
  if (publishJson(config_status_topic, status, true)) {
    Serial.printf("config=applied ble_rssi_threshold=%d revision=%lu\n",
                  ble_rssi_threshold,
                  static_cast<unsigned long>(ble_config_revision));
  }
}

void handleConfig(const char* payload, size_t length) {
  JsonDocument document;
  if (deserializeJson(document, payload, length) != DeserializationError::Ok ||
      document["version"].as<int>() != 1 ||
      document["type"].as<String>() != "validator.config" ||
      document["validator_id"].as<String>() != VALIDATOR_ID) {
    return;
  }
  const int threshold = document["ble_rssi_threshold"] | 0;
  const uint32_t revision = document["revision"] | 0;
  if (threshold < -100 || threshold > -35 || revision == 0 ||
      revision < ble_config_revision) {
    return;
  }
  ble_rssi_threshold = threshold;
  ble_config_revision = revision;
  publishConfigStatus();
}

void handleEnrollmentWindow(const char* payload, size_t length) {
  if (length == 0) {
    // MQTT usa un payload retenido vacío como tombstone. Para enrolamiento es
    // un cierre válido, no corrupción del buzón ni motivo para reconectar.
    enrollment_window_active = false;
    Serial.println("enrollment_window=inactive retained_cleared=true");
    return;
  }
  JsonDocument document;
  if (deserializeJson(document, payload, length) != DeserializationError::Ok ||
      document["version"].as<int>() != 1 ||
      document["type"].as<String>() != "validator.enrollment.window" ||
      document["validator_id"].as<String>() != VALIDATOR_ID ||
      !document["active"].is<bool>()) {
    return;
  }
  enrollment_window_active = document["active"].as<bool>();
  Serial.printf("enrollment_window=%s\n",
                enrollment_window_active ? "active" : "inactive");
}

bool parseFirmwareVersion(const char* version, uint16_t output[3]) {
  if (version == nullptr || strlen(version) == 0 || strlen(version) > 15) {
    return false;
  }
  unsigned int major = 0, minor = 0, patch = 0;
  char trailing = '\0';
  if (sscanf(version, "%u.%u.%u%c", &major, &minor, &patch, &trailing) != 3 ||
      major > 999 || minor > 999 || patch > 999) {
    return false;
  }
  output[0] = static_cast<uint16_t>(major);
  output[1] = static_cast<uint16_t>(minor);
  output[2] = static_cast<uint16_t>(patch);
  return true;
}

bool newerFirmwareVersion(const char* candidate) {
  uint16_t current[3], target[3];
  if (!parseFirmwareVersion(kFirmwareVersion, current) ||
      !parseFirmwareVersion(candidate, target)) return false;
  for (size_t index = 0; index < 3; ++index) {
    if (target[index] != current[index]) return target[index] > current[index];
  }
  return false;
}

bool validLowerHex(const char* value, size_t length) {
  if (value == nullptr || strlen(value) != length) return false;
  for (size_t index = 0; index < length; ++index) {
    if (!((value[index] >= '0' && value[index] <= '9') ||
          (value[index] >= 'a' && value[index] <= 'f'))) return false;
  }
  return true;
}

bool publishOtaStatus(const char* state, const char* detail,
                      const char* target_version = nullptr,
                      const char* nonce = nullptr) {
  if (!mqtt_online || ota_status_topic.isEmpty()) return false;
  JsonDocument status;
  status["version"] = 1;
  status["type"] = "validator.ota.status";
  status["validator_id"] = VALIDATOR_ID;
  status["state"] = state;
  status["detail"] = detail;
  status["current_firmware"] = kFirmwareVersion;
  if (target_version != nullptr && target_version[0] != '\0') {
    status["target_firmware"] = target_version;
  }
  if (nonce != nullptr && nonce[0] != '\0') status["nonce"] = nonce;
  status["rollback_pending"] = running_image_pending_verification;
  return publishJson(ota_status_topic, status, true);
}

void publishPendingOtaFailure() {
  if (!ota_failure_status_pending || !mqtt_online) return;
  if (publishOtaStatus("failed", ota_failure_detail, ota_command.version,
                       ota_command.nonce)) {
    ota_failure_status_pending = false;
    ota_failure_detail[0] = '\0';
  }
}

bool publishPendingOtaReceipt() {
  if (!ota_receipt_pending) return false;
  if (ota_rolled_back) {
    return publishOtaStatus("rolled_back", "bootloader_recovery",
                            ota_boot_target, ota_boot_nonce);
  } else if (ota_boot_state_invalid) {
    return publishOtaStatus("failed", "bootloader_rollback_unavailable",
                            ota_boot_target, ota_boot_nonce);
  } else if (running_image_pending_verification) {
    return publishOtaStatus("validating", "health_check", ota_boot_target,
                            ota_boot_nonce);
  }
  return publishOtaStatus("healthy", "health_confirmed", ota_boot_target,
                          ota_boot_nonce);
}

void acknowledgeOtaReceipt() {
  if (!ota_receipt_pending) return;
  if (running_image_pending_verification) {
    // La limpieza retenida del publicador no puede borrar la correlación de
    // una imagen que todavía está en la ventana de validación. Se persiste el
    // ACK para aplicarlo justo después de publicar el resultado terminal.
    ota_receipt_ack_deferred = true;
    Preferences ota_preferences;
    bool stored = false;
    if (ota_preferences.begin("validator-ota", false)) {
      stored = ota_preferences.putBool("ack-pending", true) > 0;
      ota_preferences.end();
    }
    Serial.printf("ota=receipt_ack deferred=validation_pending stored=%s\n",
                  stored ? "true" : "false");
    return;
  }
  char acknowledged_target[sizeof(ota_boot_target)];
  char acknowledged_nonce[sizeof(ota_boot_nonce)];
  strlcpy(acknowledged_target, ota_boot_target, sizeof(acknowledged_target));
  strlcpy(acknowledged_nonce, ota_boot_nonce, sizeof(acknowledged_nonce));
  const bool cleared = clearOtaBootMetadata();
  Serial.printf("ota=receipt_ack target=%s nonce=%.12s cleared=%s\n",
                acknowledged_target, acknowledged_nonce,
                cleared ? "true" : "false");
}

void handleOtaCommand(const char* payload, size_t length) {
  if (length == 0) {
    acknowledgeOtaReceipt();
    return;
  }
  JsonDocument document;
  if (deserializeJson(document, payload, length) != DeserializationError::Ok ||
      document["version"].as<int>() != 1 ||
      document["type"].as<String>() != "validator.ota.command" ||
      document["validator_id"].as<String>() != VALIDATOR_ID) {
    publishOtaStatus("rejected", "invalid_envelope");
    return;
  }

  const char* target_version = document["firmware"];
  const char* url = document["url"];
  const char* sha256 = document["sha256"];
  const char* nonce = document["nonce"];
  const size_t image_size = document["size"] | 0;
  const String expected_url = String(kOtaBaseUrl) + VALIDATOR_ID + "/firmware.bin";
  uint16_t parsed[3];
  if (!parseFirmwareVersion(target_version, parsed) || url == nullptr ||
      String(url) != expected_url || !validLowerHex(sha256, 64) ||
      !validLowerHex(nonce, 32) || image_size == 0 ||
      image_size > kMaximumOtaImageSize) {
    publishOtaStatus("rejected", "invalid_manifest", target_version, nonce);
    return;
  }
  if (ota_receipt_pending) {
    if (strcmp(target_version, ota_boot_target) == 0 &&
        strcmp(nonce, ota_boot_nonce) == 0) {
      // La orden retenida original puede llegar justo después de CONNECTED.
      // Repite el recibo terminal, no vuelve a descargar la misma imagen.
      publishPendingOtaReceipt();
    } else {
      publishOtaStatus("deferred", "receipt_unacknowledged", target_version,
                       nonce);
    }
    return;
  }
  if (!newerFirmwareVersion(target_version)) {
    publishOtaStatus("current", "version_not_newer", target_version, nonce);
    return;
  }
  if (ota_update_running) {
    publishOtaStatus("deferred", "update_in_progress", target_version, nonce);
    return;
  }

  memset(&ota_command, 0, sizeof(ota_command));
  strlcpy(ota_command.version, target_version, sizeof(ota_command.version));
  strlcpy(ota_command.url, url, sizeof(ota_command.url));
  strlcpy(ota_command.sha256, sha256, sizeof(ota_command.sha256));
  strlcpy(ota_command.nonce, nonce, sizeof(ota_command.nonce));
  ota_command.size = image_size;
  ota_command_pending = true;
  ota_retry_at = 0;
  publishOtaStatus("queued", "waiting_for_safe_idle", ota_command.version,
                   ota_command.nonce);
}

bool otaSafeToStart() {
  return mqtt_online && WiFi.status() == WL_CONNECTED &&
         active_session.isEmpty() && !physical_card_pending &&
         !credential_presence_monitoring && !authorized_equipment_session &&
         !equipment_waiting_for_card && equipment_client == nullptr &&
         !equipment_loss_pending;
}

void digestAsHex(const uint8_t digest[32], char output[65]) {
  const char digits[] = "0123456789abcdef";
  for (size_t index = 0; index < 32; ++index) {
    output[index * 2] = digits[digest[index] >> 4];
    output[index * 2 + 1] = digits[digest[index] & 0x0f];
  }
  output[64] = '\0';
}

int sha256Start(mbedtls_sha256_context* context) {
#if MBEDTLS_VERSION_MAJOR >= 3
  return mbedtls_sha256_starts(context, 0);
#else
  return mbedtls_sha256_starts_ret(context, 0);
#endif
}

int sha256Update(mbedtls_sha256_context* context, const uint8_t* input,
                 size_t length) {
#if MBEDTLS_VERSION_MAJOR >= 3
  return mbedtls_sha256_update(context, input, length);
#else
  return mbedtls_sha256_update_ret(context, input, length);
#endif
}

int sha256Finish(mbedtls_sha256_context* context, uint8_t output[32]) {
#if MBEDTLS_VERSION_MAJOR >= 3
  return mbedtls_sha256_finish(context, output);
#else
  return mbedtls_sha256_finish_ret(context, output);
#endif
}

void failOtaUpdate(const char* detail, esp_http_client_handle_t client,
                   esp_ota_handle_t ota_handle, bool ota_started) {
  if (ota_started) esp_ota_abort(ota_handle);
  if (client != nullptr) {
    esp_http_client_close(client);
    esp_http_client_cleanup(client);
  }
  ota_update_running = false;
  strlcpy(ota_failure_detail, detail, sizeof(ota_failure_detail));
  ota_failure_status_pending = true;
  if (ota_mqtt_stopped && mqtt_client != nullptr) {
    const esp_err_t resume_result = esp_mqtt_client_start(mqtt_client);
    ota_mqtt_stopped = false;
    Serial.printf("ota=mqtt_resume result=0x%x heap=%u largest=%u\n",
                  static_cast<unsigned int>(resume_result),
                  static_cast<unsigned int>(ESP.getFreeHeap()),
                  static_cast<unsigned int>(
                      heap_caps_get_largest_free_block(MALLOC_CAP_8BIT)));
    if (resume_result != ESP_OK) {
      esp_mqtt_client_destroy(mqtt_client);
      mqtt_client = nullptr;
      next_mqtt_reconnect = 0;
    }
  }
  publishPendingOtaFailure();
  Serial.printf("ota=failed detail=%s target=%s\n", detail,
                ota_command.version);
}

void performOtaUpdate() {
  ota_command_pending = false;
  if (!otaSafeToStart()) {
    ota_command_pending = true;
    ota_retry_at = millis() + kOtaDeferredRetryMilliseconds;
    publishOtaStatus("deferred", "active_or_offline", ota_command.version,
                     ota_command.nonce);
    return;
  }
  ota_update_running = true;
  publishOtaStatus("downloading", "https_mtls", ota_command.version,
                   ota_command.nonce);
  Serial.printf("ota=downloading target=%s bytes=%u\n", ota_command.version,
                static_cast<unsigned int>(ota_command.size));

  // MQTT y HTTPS con autenticación mutua necesitan cada uno su propio contexto
  // mbedTLS. Detener MQTT durante la descarga libera por completo su tarea y
  // transporte; ante un error se inicia de nuevo y el resultado OTA pendiente
  // se publica al reconectar. La autorización física ya está cerrada porque
  // otaSafeToStart() sólo permite entrar desde reposo seguro.
  delay(250);
  const esp_err_t mqtt_stop_result = esp_mqtt_client_stop(mqtt_client);
  if (mqtt_stop_result != ESP_OK) {
    Serial.printf("ota=mqtt_pause_failed result=0x%x\n",
                  static_cast<unsigned int>(mqtt_stop_result));
    failOtaUpdate("mqtt_pause", nullptr, 0, false);
    return;
  }
  ota_mqtt_stopped = true;
  mqtt_online = false;
  Serial.printf("ota=mqtt_paused heap=%u minimum=%u largest=%u\n",
                static_cast<unsigned int>(ESP.getFreeHeap()),
                static_cast<unsigned int>(ESP.getMinFreeHeap()),
                static_cast<unsigned int>(
                    heap_caps_get_largest_free_block(MALLOC_CAP_8BIT)));

  esp_http_client_config_t http_config = {};
  http_config.url = ota_command.url;
  http_config.cert_pem = MQTT_CA_CERT;
  http_config.client_cert_pem = MQTT_CLIENT_CERT;
  http_config.client_key_pem = MQTT_CLIENT_KEY;
  http_config.method = HTTP_METHOD_GET;
  http_config.timeout_ms = 15000;
  http_config.disable_auto_redirect = true;
  http_config.skip_cert_common_name_check = false;
  http_config.buffer_size = 2048;
  http_config.buffer_size_tx = 1024;
  http_config.user_agent = "fuel-validator-ota/1";
  esp_http_client_handle_t client = esp_http_client_init(&http_config);
  esp_ota_handle_t ota_handle = 0;
  bool ota_started = false;
  const esp_err_t open_result =
      client == nullptr ? ESP_ERR_NO_MEM : esp_http_client_open(client, 0);
  if (open_result != ESP_OK) {
    int tls_error = 0;
    int tls_flags = 0;
    const esp_err_t tls_result =
        client == nullptr
            ? ESP_ERR_INVALID_ARG
            : esp_http_client_get_and_clear_last_tls_error(
                  client, &tls_error, &tls_flags);
    Serial.printf(
        "ota=https_connect_failed open=%s tls_result=0x%x tls=-0x%x "
        "verify=0x%x errno=%d heap=%u minimum=%u largest=%u\n",
        esp_err_to_name(open_result), static_cast<unsigned int>(tls_result),
        static_cast<unsigned int>(tls_error < 0 ? -tls_error : tls_error),
        static_cast<unsigned int>(tls_flags),
        client == nullptr ? 0 : esp_http_client_get_errno(client),
        static_cast<unsigned int>(ESP.getFreeHeap()),
        static_cast<unsigned int>(ESP.getMinFreeHeap()),
        static_cast<unsigned int>(
            heap_caps_get_largest_free_block(MALLOC_CAP_8BIT)));
    failOtaUpdate("https_connect", client, ota_handle, ota_started);
    return;
  }
  const int headers = esp_http_client_fetch_headers(client);
  const int status = esp_http_client_get_status_code(client);
  const int content_length = esp_http_client_get_content_length(client);
  if (headers < 0 || status != HttpStatus_Ok || content_length <= 0 ||
      static_cast<size_t>(content_length) != ota_command.size ||
      static_cast<size_t>(content_length) > kMaximumOtaImageSize) {
    failOtaUpdate("https_response", client, ota_handle, ota_started);
    return;
  }
  const esp_partition_t* target = esp_ota_get_next_update_partition(nullptr);
  if (target == nullptr || ota_command.size > target->size ||
      esp_ota_begin(target, ota_command.size, &ota_handle) != ESP_OK) {
    failOtaUpdate("partition", client, ota_handle, ota_started);
    return;
  }
  ota_started = true;

  mbedtls_sha256_context sha;
  mbedtls_sha256_init(&sha);
  bool sha_ok = sha256Start(&sha) == 0;
  uint8_t buffer[4096];
  size_t total = 0;
  while (sha_ok && total < ota_command.size) {
    const size_t remaining = ota_command.size - total;
    const int received = esp_http_client_read(
        client, reinterpret_cast<char*>(buffer),
        static_cast<int>(min(remaining, sizeof(buffer))));
    if (received <= 0 || total + static_cast<size_t>(received) > ota_command.size) {
      sha_ok = false;
      break;
    }
    sha_ok = sha256Update(&sha, buffer, received) == 0 &&
             esp_ota_write(ota_handle, buffer, received) == ESP_OK;
    total += static_cast<size_t>(received);
    delay(1);
  }
  uint8_t digest[32] = {};
  sha_ok = sha_ok && sha256Finish(&sha, digest) == 0;
  mbedtls_sha256_free(&sha);
  char downloaded_sha256[65];
  digestAsHex(digest, downloaded_sha256);
  if (!sha_ok || total != ota_command.size ||
      !esp_http_client_is_complete_data_received(client) ||
      strcmp(downloaded_sha256, ota_command.sha256) != 0) {
    failOtaUpdate("sha256_or_length", client, ota_handle, ota_started);
    return;
  }
  if (esp_ota_end(ota_handle) != ESP_OK) {
    ota_started = false;
    failOtaUpdate("image_validation", client, ota_handle, ota_started);
    return;
  }
  ota_started = false;
  esp_http_client_close(client);
  esp_http_client_cleanup(client);
  client = nullptr;

  // La identidad de versión está ligada al manifiesto autenticado y a su hash
  // completo. Arduino conserva un app_desc genérico del core, por lo que no se
  // usa ese texto como fuente de verdad para la versión de producto.
  const esp_partition_t* previous = esp_ota_get_running_partition();
  if (previous == nullptr || previous == target || previous->label[0] == '\0') {
    failOtaUpdate("rollback_partition", client, ota_handle, ota_started);
    return;
  }
  Preferences ota_preferences;
  if (!ota_preferences.begin("validator-ota", false)) {
    failOtaUpdate("metadata_storage", client, ota_handle, ota_started);
    return;
  }
  const size_t target_written =
      ota_preferences.putString("target", ota_command.version);
  const size_t nonce_written =
      ota_preferences.putString("nonce", ota_command.nonce);
  const size_t previous_written =
      ota_preferences.putString("previous", previous->label);
  ota_preferences.end();
  if (target_written == 0 || nonce_written == 0 || previous_written == 0) {
    clearOtaBootMetadata();
    failOtaUpdate("metadata_storage", client, ota_handle, ota_started);
    return;
  }

  // El recibo se confirma en NVS antes de cambiar otadata. Si se corta la
  // energía, nunca puede arrancar el binario nuevo sin target+nonce. Además,
  // NEW demuestra que la biblioteca app_update fue compilada con rollback.
  esp_ota_img_states_t target_state = ESP_OTA_IMG_UNDEFINED;
  if (esp_ota_set_boot_partition(target) != ESP_OK ||
      esp_ota_get_state_partition(target, &target_state) != ESP_OK ||
      target_state != ESP_OTA_IMG_NEW) {
    esp_ota_set_boot_partition(previous);
    clearOtaBootMetadata();
    failOtaUpdate("rollback_state", client, ota_handle, ota_started);
    return;
  }
  publishOtaStatus("restarting", "image_verified", ota_command.version,
                   ota_command.nonce);
  Serial.printf("ota=verified target=%s sha256=%.12s rebooting=true\n",
                ota_command.version, ota_command.sha256);
  delay(750);
  ESP.restart();
}

void initializeOtaRollbackState() {
  Preferences ota_preferences;
  if (ota_preferences.begin("validator-ota", true)) {
    const String target = ota_preferences.getString("target", "");
    const String nonce = ota_preferences.getString("nonce", "");
    const String previous = ota_preferences.getString("previous", "");
    ota_receipt_ack_deferred =
        ota_preferences.getBool("ack-pending", false);
    strlcpy(ota_boot_target, target.c_str(), sizeof(ota_boot_target));
    strlcpy(ota_boot_nonce, nonce.c_str(), sizeof(ota_boot_nonce));
    strlcpy(ota_boot_previous_partition, previous.c_str(),
            sizeof(ota_boot_previous_partition));
    ota_preferences.end();
  }
  const bool metadata_present =
      ota_boot_target[0] != '\0' || ota_boot_nonce[0] != '\0';
  if (!metadata_present) {
    if (ota_receipt_ack_deferred) clearOtaBootMetadata();
    return;
  }
  uint16_t parsed_version[3];
  if (!parseFirmwareVersion(ota_boot_target, parsed_version) ||
      !validLowerHex(ota_boot_nonce, 32)) {
    Serial.println("ota=receipt_invalid action=cleared");
    clearOtaBootMetadata();
    return;
  }
  ota_receipt_pending = true;

  const esp_partition_t* running = esp_ota_get_running_partition();
  esp_ota_img_states_t state = ESP_OTA_IMG_UNDEFINED;
  const esp_err_t state_result =
      running == nullptr ? ESP_ERR_NOT_FOUND
                         : esp_ota_get_state_partition(running, &state);
  running_image_pending_verification =
      state_result == ESP_OK && state == ESP_OTA_IMG_PENDING_VERIFY;
  ota_rolled_back = strcmp(ota_boot_target, kFirmwareVersion) != 0;
  if (running_image_pending_verification) {
    ota_validation_deadline = millis() + kOtaValidationMilliseconds;
    Serial.printf("ota=validating firmware=%s deadline_seconds=%lu\n",
                  kFirmwareVersion, kOtaValidationMilliseconds / 1000);
  } else if (ota_rolled_back) {
    Serial.printf("ota=rolled_back target=%s running=%s\n", ota_boot_target,
                  kFirmwareVersion);
  } else if (state_result != ESP_OK || state != ESP_OTA_IMG_VALID) {
    // Con rollback habilitado el bootloader cambia NEW a PENDING_VERIFY antes
    // de entrar a setup(). Ver NEW/UNDEFINED aquí prueba que el bootloader
    // físico es antiguo o que otadata no es confiable: se falla cerrado.
    ota_boot_state_invalid = true;
    ota_validation_deadline = millis();
    Serial.printf("ota=invalid_boot_state state=%u result=0x%x\n",
                  static_cast<unsigned int>(state),
                  static_cast<unsigned int>(state_result));
  }
}

bool clearOtaBootMetadata() {
  Preferences ota_preferences;
  bool cleared = false;
  if (ota_preferences.begin("validator-ota", false)) {
    cleared = ota_preferences.clear();
    ota_preferences.end();
  }
  if (!cleared) {
    Serial.println("ota=receipt_clear_failed");
    return false;
  }
  ota_boot_target[0] = '\0';
  ota_boot_nonce[0] = '\0';
  ota_boot_previous_partition[0] = '\0';
  ota_receipt_pending = false;
  ota_receipt_ack_deferred = false;
  ota_rolled_back = false;
  ota_boot_state_invalid = false;
  return true;
}

void completeDeferredOtaReceiptAck() {
  if (!ota_receipt_ack_deferred || running_image_pending_verification) return;
  Serial.printf("ota=receipt_ack completed=terminal target=%s nonce=%.12s\n",
                ota_boot_target, ota_boot_nonce);
  clearOtaBootMetadata();
}

void confirmRunningOtaImageIfHealthy() {
  if (!running_image_pending_verification || !mqtt_online || !rfid_ready ||
      WiFi.status() != WL_CONNECTED) return;
  const esp_err_t result = esp_ota_mark_app_valid_cancel_rollback();
  if (result == ESP_OK) {
    running_image_pending_verification = false;
    const bool reported =
        publishOtaStatus("healthy", "health_confirmed", ota_boot_target,
                         ota_boot_nonce);
    Serial.printf("ota=healthy firmware=%s rollback=false\n", kFirmwareVersion);
    if (reported) completeDeferredOtaReceiptAck();
  } else {
    Serial.printf("ota=validation_failed result=0x%x\n",
                  static_cast<unsigned int>(result));
  }
}

void rollbackRunningOtaImage(const char* reason) {
  publishOtaStatus("rolling_back", reason, ota_boot_target, ota_boot_nonce);
  Serial.printf("ota=rollback reason=%s\n", reason);
  delay(250);

  // Con un bootloader moderno esta llamada no retorna. Si el bootloader físico
  // es antiguo o otadata está dañada, la partición anterior persistida permite
  // una última recuperación explícita sin aceptar la imagen como saludable.
  const esp_err_t rollback_result =
      esp_ota_mark_app_invalid_rollback_and_reboot();
  Serial.printf("ota=rollback_api_failed result=0x%x\n",
                static_cast<unsigned int>(rollback_result));
  const esp_partition_t* running = esp_ota_get_running_partition();
  const esp_partition_t* previous = nullptr;
  if (ota_boot_previous_partition[0] != '\0') {
    previous = esp_partition_find_first(ESP_PARTITION_TYPE_APP,
                                        ESP_PARTITION_SUBTYPE_ANY,
                                        ota_boot_previous_partition);
  }
  if (previous == nullptr || previous == running) {
    previous = esp_ota_get_next_update_partition(nullptr);
  }
  if (previous != nullptr && previous != running &&
      esp_ota_set_boot_partition(previous) == ESP_OK) {
    Serial.printf("ota=rollback_fallback partition=%s\n", previous->label);
    delay(250);
    ESP.restart();
  }
  Serial.println("ota=rollback_fallback_failed fail_safe=offline");
}

void rollbackUnhealthyOtaImageIfExpired() {
  if (!running_image_pending_verification || ota_validation_deadline == 0 ||
      static_cast<long>(millis() - ota_validation_deadline) < 0) return;
  ota_validation_deadline = 0;
  rollbackRunningOtaImage("health_timeout");
}

void publishEquipmentRegistryStatus() {
  if (!mqtt_online || equipment_registry_generation.length() != 64) return;
  JsonDocument status;
  status["version"] = 1;
  status["type"] = "validator.equipment.registry.status";
  status["validator_id"] = VALIDATOR_ID;
  status["generation"] = equipment_registry_generation;
  status["module_count"] = trusted_equipment_count;
  status["capacity"] = kMaximumTrustedEquipment;
  status["persisted"] = equipment_registry_persisted;
  status["firmware"] = kFirmwareVersion;
  if (publishJson(equipment_registry_status_topic, status, true)) {
    Serial.printf("registry=ack modules=%u persisted=%s generation=%.12s\n",
                  static_cast<unsigned int>(trusted_equipment_count),
                  equipment_registry_persisted ? "true" : "false",
                  equipment_registry_generation.c_str());
  }
}

void rejectEquipmentRegistry(const char* reason) {
  Serial.printf("registry=rejected reason=%s\n", reason);
}

void handleEquipmentRegistry(const char* payload, size_t length) {
  JsonDocument document;
  if (deserializeJson(document, payload, length) != DeserializationError::Ok ||
      document["version"].as<int>() != 1 ||
      document["type"].as<String>() != "validator.equipment.registry" ||
      document["validator_id"].as<String>() != VALIDATOR_ID) {
    rejectEquipmentRegistry("envelope");
    return;
  }
  const char* generation = document["generation"];
  JsonArrayConst modules = document["modules"].as<JsonArrayConst>();
  if (!validRegistryGeneration(generation) || modules.isNull() ||
      modules.size() > kMaximumTrustedEquipment) {
    rejectEquipmentRegistry("limits");
    return;
  }

  memset(staged_equipment_registry, 0, sizeof(staged_equipment_registry));
  size_t count = 0;
  for (JsonObjectConst module : modules) {
    const char* module_id = module["module_id"];
    const char* secret_hex = module["secret_hex"];
    if (module_id == nullptr || strlen(module_id) > 63 ||
        !validIdentifier(String(module_id)) ||
        (count > 0 && strcmp(staged_equipment_registry[count - 1].module_id,
                             module_id) >= 0) ||
        !decodeHexSecret(secret_hex,
                         staged_equipment_registry[count].secret)) {
      rejectEquipmentRegistry("module");
      return;
    }
    strlcpy(staged_equipment_registry[count].module_id, module_id,
            sizeof(staged_equipment_registry[count].module_id));
    ++count;
  }
  if (!validEquipmentRegistry(staged_equipment_registry, count, generation)) {
    rejectEquipmentRegistry("generation");
    return;
  }
  if (!persistEquipmentRegistry(staged_equipment_registry, count, generation)) {
    rejectEquipmentRegistry("storage");
    return;
  }
  activateEquipmentRegistry(staged_equipment_registry, count, generation, true);
  Serial.printf("registry=updated modules=%u generation=%.12s\n",
                static_cast<unsigned int>(count), generation);
  publishEquipmentRegistryStatus();
}

bool mqttTopicEquals(const esp_mqtt_event_handle_t event,
                     const String& expected) {
  return event->topic != nullptr && event->topic_len == expected.length() &&
         memcmp(event->topic, expected.c_str(), expected.length()) == 0;
}

void markMqttInboxFailure() {
  portENTER_CRITICAL(&mqtt_inbox_mutex);
  mqtt_inbox_failure_count = mqtt_inbox_failure_count + 1;
  mqtt_inbox_failure_pending = true;
  portEXIT_CRITICAL(&mqtt_inbox_mutex);
}

void queueMqttConnectionChange(bool online) {
  portENTER_CRITICAL(&mqtt_inbox_mutex);
  mqtt_connection_target_online = online;
  if (online) {
    mqtt_connect_pending = true;
  } else {
    // Sticky: una reconexión posterior nunca borra el cierre fail-safe que
    // corresponde a una desconexión ya confirmada por esp-mqtt.
    mqtt_disconnect_pending = true;
  }
  portEXIT_CRITICAL(&mqtt_inbox_mutex);
}

bool queueMqttMessage(DeferredMqttMessageType type, const char* payload,
                      size_t length) {
  const bool empty_ota_ack =
      type == DeferredMqttMessageType::OtaCommand && length == 0;
  const bool empty_enrollment_reset =
      type == DeferredMqttMessageType::Enrollment && length == 0;
  if ((!empty_ota_ack && !empty_enrollment_reset &&
       (payload == nullptr || length == 0)) ||
      length > kMaxMessageSize) {
    markMqttInboxFailure();
    return false;
  }

  // Reservar el máximo de 8 KiB en cada uno de los ocho slots consume la
  // memoria que mbedTLS necesita antes de que pueda existir tráfico MQTT.
  // La copia se completa antes de publicar el puntero bajo el mutex, de modo
  // que loop() nunca observa un payload parcial y el uso queda acotado al
  // tamaño real del lote recibido.
  char* payload_copy = static_cast<char*>(malloc(length + 1));
  if (payload_copy == nullptr) {
    markMqttInboxFailure();
    return false;
  }
  if (length > 0) memcpy(payload_copy, payload, length);
  payload_copy[length] = '\0';

  int selected = -1;
  portENTER_CRITICAL(&mqtt_inbox_mutex);
  for (size_t index = 0; index < kMqttInboxCapacity; ++index) {
    if (mqtt_inbox[index].state == MqttInboxState::Empty) {
      mqtt_inbox[index].sequence = ++mqtt_inbox_sequence;
      mqtt_inbox[index].type = type;
      mqtt_inbox[index].payload = payload_copy;
      mqtt_inbox[index].length = length;
      mqtt_inbox[index].state = MqttInboxState::Ready;
      selected = static_cast<int>(index);
      break;
    }
  }
  portEXIT_CRITICAL(&mqtt_inbox_mutex);
  if (selected < 0) {
    free(payload_copy);
    markMqttInboxFailure();
    return false;
  }

  return true;
}

void deferMqttError(esp_mqtt_event_handle_t event) {
  if (event->error_handle == nullptr) return;
  portENTER_CRITICAL(&mqtt_inbox_mutex);
  mqtt_error_type = event->error_handle->error_type;
  mqtt_error_esp = event->error_handle->esp_tls_last_esp_err;
  mqtt_error_tls = event->error_handle->esp_tls_stack_err;
  mqtt_error_verify = event->error_handle->esp_tls_cert_verify_flags;
  mqtt_error_errno = event->error_handle->esp_transport_sock_errno;
  mqtt_error_pending = true;
  portEXIT_CRITICAL(&mqtt_inbox_mutex);
}

esp_err_t onMqttEvent(esp_mqtt_event_handle_t event) {
  switch (event->event_id) {
    case MQTT_EVENT_CONNECTED:
      esp_mqtt_client_subscribe(mqtt_client, challenge_topic.c_str(), 1);
      esp_mqtt_client_subscribe(mqtt_client, decision_topic.c_str(), 1);
      esp_mqtt_client_subscribe(mqtt_client, config_topic.c_str(), 1);
      esp_mqtt_client_subscribe(mqtt_client, enrollment_topic.c_str(), 1);
      esp_mqtt_client_subscribe(mqtt_client, equipment_registry_topic.c_str(), 1);
      esp_mqtt_client_subscribe(mqtt_client, ota_command_topic.c_str(), 1);
      queueMqttConnectionChange(true);
      break;
    case MQTT_EVENT_DISCONNECTED:
      queueMqttConnectionChange(false);
      break;
    case MQTT_EVENT_DATA: {
      if (event->total_data_len == 0 && event->data_len == 0) {
        if (mqttTopicEquals(event, ota_command_topic)) {
          queueMqttMessage(DeferredMqttMessageType::OtaCommand, nullptr, 0);
        } else if (mqttTopicEquals(event, enrollment_topic)) {
          queueMqttMessage(DeferredMqttMessageType::Enrollment, nullptr, 0);
        } else {
          markMqttInboxFailure();
        }
        break;
      }
      if (event->total_data_len != event->data_len || event->data_len <= 0 ||
          event->data_len > kMaxMessageSize) {
        markMqttInboxFailure();
        break;
      }
      if (mqttTopicEquals(event, challenge_topic)) {
        queueMqttMessage(DeferredMqttMessageType::Challenge, event->data,
                         event->data_len);
      } else if (mqttTopicEquals(event, decision_topic)) {
        queueMqttMessage(DeferredMqttMessageType::Decision, event->data,
                         event->data_len);
      } else if (mqttTopicEquals(event, config_topic)) {
        queueMqttMessage(DeferredMqttMessageType::Config, event->data,
                         event->data_len);
      } else if (mqttTopicEquals(event, enrollment_topic)) {
        queueMqttMessage(DeferredMqttMessageType::Enrollment, event->data,
                         event->data_len);
      } else if (mqttTopicEquals(event, equipment_registry_topic)) {
        queueMqttMessage(DeferredMqttMessageType::EquipmentRegistry,
                         event->data, event->data_len);
      } else if (mqttTopicEquals(event, ota_command_topic)) {
        queueMqttMessage(DeferredMqttMessageType::OtaCommand, event->data,
                         event->data_len);
      }
      break;
    }
    case MQTT_EVENT_ERROR:
      deferMqttError(event);
      break;
    default:
      break;
  }
  return ESP_OK;
}

void mqttEventAdapter(void*, esp_event_base_t, int32_t, void* event_data) {
  if (event_data != nullptr) {
    onMqttEvent(static_cast<esp_mqtt_event_handle_t>(event_data));
  }
}

void applyMqttConnectionChange() {
  bool connect_pending = false;
  bool disconnect_pending = false;
  bool target_online = false;
  portENTER_CRITICAL(&mqtt_inbox_mutex);
  connect_pending = mqtt_connect_pending;
  disconnect_pending = mqtt_disconnect_pending;
  target_online = mqtt_connection_target_online;
  mqtt_connect_pending = false;
  mqtt_disconnect_pending = false;
  portEXIT_CRITICAL(&mqtt_inbox_mutex);
  if (disconnect_pending) {
    mqtt_online = false;
    enrollment_window_active = false;
    // Sin MQTT la Raspberry deja vencer el permiso RFID en 2,5 s. El cierre se
    // ejecuta aquí, en loop(), para no cruzar NimBLE con la tarea esp-mqtt.
    active_session.clear();
    closeEquipmentSession();
    clearPhysicalCard();
    digitalWrite(LED_BUILTIN, LOW);
    next_mqtt_reconnect = millis() + kMqttReconnectMilliseconds;
    Serial.println("mqtt=disconnected");
  }

  // Si CONNECTED y DISCONNECTED llegaron antes de que loop() pudiera correr,
  // siempre se aplicó primero el cierre. Sólo recupera online si el último
  // estado observado fue realmente conectado.
  if (!connect_pending || !target_online) return;

  mqtt_online = true;
  next_mqtt_reconnect = 0;
  Serial.println("mqtt=connected");
  publishEquipmentRegistryStatus();
  bool terminal_receipt_published = false;
  if (ota_receipt_pending) {
    const bool terminal_receipt = !running_image_pending_verification;
    const bool receipt_published = publishPendingOtaReceipt();
    terminal_receipt_published = terminal_receipt && receipt_published;
  } else if (!ota_failure_status_pending) {
    publishOtaStatus("ready", "idle");
  }
  publishPendingOtaFailure();
  confirmRunningOtaImageIfHealthy();
  if (terminal_receipt_published) completeDeferredOtaReceiptAck();
}

bool applyMqttInboxFailSafe() {
  bool pending = false;
  uint32_t failures = 0;
  char* discarded[kMqttInboxCapacity] = {};
  size_t discarded_count = 0;
  portENTER_CRITICAL(&mqtt_inbox_mutex);
  pending = mqtt_inbox_failure_pending;
  failures = mqtt_inbox_failure_count;
  mqtt_inbox_failure_pending = false;
  if (pending) {
    for (size_t index = 0; index < kMqttInboxCapacity; ++index) {
      if (mqtt_inbox[index].state != MqttInboxState::Processing) {
        if (mqtt_inbox[index].payload != nullptr) {
          discarded[discarded_count++] = mqtt_inbox[index].payload;
          mqtt_inbox[index].payload = nullptr;
        }
        mqtt_inbox[index].length = 0;
        mqtt_inbox[index].state = MqttInboxState::Empty;
      }
    }
  }
  portEXIT_CRITICAL(&mqtt_inbox_mutex);
  for (size_t index = 0; index < discarded_count; ++index) {
    free(discarded[index]);
  }
  if (!pending) return false;

  // Perder una decisión o un desafío no puede dejar una autorización viva.
  // Cierra en seguro y fuerza una reconexión que vuelve a entregar retenidos.
  mqtt_online = false;
  enrollment_window_active = false;
  active_session.clear();
  closeEquipmentSession();
  clearPhysicalCard();
  digitalWrite(LED_BUILTIN, LOW);
  Serial.printf("mqtt=inbox_failure count=%lu fail_safe=closed\n",
                static_cast<unsigned long>(failures));
  if (mqtt_client != nullptr) esp_mqtt_client_disconnect(mqtt_client);
  next_mqtt_reconnect = millis() + kMqttReconnectMilliseconds;
  return true;
}

void reportDeferredMqttError() {
  bool pending = false;
  int error_type = 0, esp_error = 0, tls_error = 0, verify = 0,
      socket_errno = 0;
  portENTER_CRITICAL(&mqtt_inbox_mutex);
  pending = mqtt_error_pending;
  if (pending) {
    error_type = mqtt_error_type;
    esp_error = mqtt_error_esp;
    tls_error = mqtt_error_tls;
    verify = mqtt_error_verify;
    socket_errno = mqtt_error_errno;
    mqtt_error_pending = false;
  }
  portEXIT_CRITICAL(&mqtt_inbox_mutex);
  if (!pending) return;
  Serial.printf("mqtt=error type=%d esp=0x%x tls=-0x%x verify=0x%x errno=%d\n",
                error_type, static_cast<unsigned int>(esp_error),
                static_cast<unsigned int>(-tls_error),
                static_cast<unsigned int>(verify), socket_errno);
}

void dispatchMqttMessage(PendingMqttMessage& message) {
  switch (message.type) {
    case DeferredMqttMessageType::Challenge:
      handleChallenge(message.payload, message.length);
      break;
    case DeferredMqttMessageType::Decision:
      handleDecision(message.payload, message.length);
      break;
    case DeferredMqttMessageType::Config:
      handleConfig(message.payload, message.length);
      break;
    case DeferredMqttMessageType::Enrollment:
      handleEnrollmentWindow(message.payload, message.length);
      break;
    case DeferredMqttMessageType::EquipmentRegistry:
      handleEquipmentRegistry(message.payload, message.length);
      break;
    case DeferredMqttMessageType::OtaCommand:
      handleOtaCommand(message.payload, message.length);
      break;
  }
}

void processDeferredMqttEvents() {
  applyMqttConnectionChange();
  reportDeferredMqttError();
  if (applyMqttInboxFailSafe()) return;

  // Un mensaje por vuelta mantiene baja la latencia del lector y del enlace BLE.
  int selected = -1;
  uint32_t oldest_sequence = UINT32_MAX;
  portENTER_CRITICAL(&mqtt_inbox_mutex);
  for (size_t index = 0; index < kMqttInboxCapacity; ++index) {
    if (mqtt_inbox[index].state == MqttInboxState::Ready &&
        mqtt_inbox[index].sequence <= oldest_sequence) {
      selected = static_cast<int>(index);
      oldest_sequence = mqtt_inbox[index].sequence;
    }
  }
  if (selected >= 0) {
    mqtt_inbox[selected].state = MqttInboxState::Processing;
  }
  portEXIT_CRITICAL(&mqtt_inbox_mutex);
  if (selected < 0) return;

  dispatchMqttMessage(mqtt_inbox[selected]);
  char* processed_payload = nullptr;
  portENTER_CRITICAL(&mqtt_inbox_mutex);
  processed_payload = mqtt_inbox[selected].payload;
  mqtt_inbox[selected].payload = nullptr;
  mqtt_inbox[selected].length = 0;
  mqtt_inbox[selected].state = MqttInboxState::Empty;
  portEXIT_CRITICAL(&mqtt_inbox_mutex);
  free(processed_payload);
}

bool connectWifi(unsigned long timeout_milliseconds = 0) {
  WiFi.onEvent([](arduino_event_id_t event, arduino_event_info_t info) {
    if (event == ARDUINO_EVENT_WIFI_STA_DISCONNECTED) {
      Serial.printf("wifi=event disconnected reason=%u\n",
                    info.wifi_sta_disconnected.reason);
    } else if (event == ARDUINO_EVENT_WIFI_STA_GOT_IP) {
      Serial.println("wifi=event got_ip");
    }
  });
  WiFi.mode(WIFI_STA);
  WiFi.persistent(false);
  WiFi.setAutoReconnect(true);
  WiFi.setSleep(false);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  const unsigned long effective_timeout =
      timeout_milliseconds == 0 ? kWifiInitialConnectMilliseconds
                                : timeout_milliseconds;
  const unsigned long deadline = millis() + effective_timeout;
  while (WiFi.status() != WL_CONNECTED) {
    if (static_cast<long>(millis() - deadline) >= 0) {
      Serial.println("\nwifi=initial_timeout");
      return false;
    }
    delay(500);
    Serial.print('.');
  }
  last_wifi_status = WL_CONNECTED;
  next_wifi_reconnect = 0;
  Serial.printf("\nwifi=connected ip=%s\n", WiFi.localIP().toString().c_str());
  return true;
}

void maintainWifiConnection() {
  const wl_status_t status = WiFi.status();
  if (status == WL_CONNECTED) {
    if (last_wifi_status != WL_CONNECTED) {
      Serial.printf("wifi=reconnected ip=%s\n", WiFi.localIP().toString().c_str());
    }
    last_wifi_status = status;
    next_wifi_reconnect = 0;
    return;
  }

  if (last_wifi_status == WL_CONNECTED) {
    Serial.printf("wifi=disconnected status=%d\n", static_cast<int>(status));
  }
  last_wifi_status = status;
  if (next_wifi_reconnect != 0 &&
      static_cast<long>(millis() - next_wifi_reconnect) < 0) {
    return;
  }

  Serial.printf("wifi=reconnecting status=%d\n", static_cast<int>(status));
  // WiFi.begin() por sí solo puede dejar el ESP32-S3 indefinidamente en
  // WL_DISCONNECTED después de una caída del AP. Reiniciar el driver libera
  // ese estado sin reiniciar el validador ni tocar la sesión RFID.
  WiFi.disconnect(true, false);
  delay(100);
  WiFi.mode(WIFI_STA);
  WiFi.setAutoReconnect(true);
  WiFi.setSleep(false);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  next_wifi_reconnect = millis() + kWifiReconnectMilliseconds;
}

void maintainMqttConnection() {
  if (mqtt_online || WiFi.status() != WL_CONNECTED) {
    return;
  }
  const unsigned long now = millis();
  if (next_mqtt_reconnect != 0 &&
      static_cast<long>(now - next_mqtt_reconnect) < 0) {
    return;
  }
  if (mqtt_client == nullptr) {
    startMqtt();
    if (mqtt_client == nullptr) {
      next_mqtt_reconnect = now + kMqttReconnectMilliseconds;
    }
    return;
  }
  const esp_err_t result = esp_mqtt_client_reconnect(mqtt_client);
  Serial.printf("mqtt=reconnect_requested result=0x%x\n",
                static_cast<unsigned int>(result));
  next_mqtt_reconnect = now + kMqttReconnectMilliseconds;
}

void reportConfiguredWifiVisibility() {
  const int network_count = WiFi.scanNetworks(false, true);
  int target_rssi = -127;
  int target_channel = 0;
  for (int index = 0; index < network_count; ++index) {
    if (WiFi.SSID(index) == WIFI_SSID && WiFi.RSSI(index) > target_rssi) {
      target_rssi = WiFi.RSSI(index);
      target_channel = WiFi.channel(index);
    }
  }
  Serial.printf("wifi=scan networks=%d target=%s rssi=%d channel=%d\n",
                network_count, target_channel == 0 ? "missing" : "visible",
                target_rssi, target_channel);
  WiFi.scanDelete();
}

void startMqtt() {
  esp_mqtt_client_config_t config = {};
#if ESP_IDF_VERSION_MAJOR >= 5
  config.broker.address.uri = MQTT_URI;
  config.broker.verification.certificate = MQTT_CA_CERT;
  config.broker.verification.skip_cert_common_name_check = false;
  config.credentials.client_id = VALIDATOR_ID;
  config.credentials.authentication.certificate = MQTT_CLIENT_CERT;
  config.credentials.authentication.key = MQTT_CLIENT_KEY;
  config.session.disable_clean_session = true;
  config.session.keepalive = 30;
  config.network.reconnect_timeout_ms = kMqttReconnectMilliseconds;
  config.network.timeout_ms = 10000;
  config.buffer.size = kMaxMessageSize;
  config.buffer.out_size = kMaxMessageSize;
#else
  config.uri = MQTT_URI;
  config.client_id = VALIDATOR_ID;
  config.disable_clean_session = true;
  config.keepalive = 30;
  config.buffer_size = kMaxMessageSize;
  config.out_buffer_size = kMaxMessageSize;
  config.cert_pem = MQTT_CA_CERT;
  config.client_cert_pem = MQTT_CLIENT_CERT;
  config.client_key_pem = MQTT_CLIENT_KEY;
  config.skip_cert_common_name_check = false;
#endif
  mqtt_client = esp_mqtt_client_init(&config);
  if (mqtt_client == nullptr) {
    Serial.println("mqtt=init_failed");
    next_mqtt_reconnect = millis() + kMqttReconnectMilliseconds;
    return;
  }
  const esp_err_t event_result = esp_mqtt_client_register_event(
      mqtt_client, MQTT_EVENT_ANY, mqttEventAdapter, nullptr);
  if (event_result != ESP_OK) {
    Serial.printf("mqtt=event_registration_failed result=0x%x\n",
                  static_cast<unsigned int>(event_result));
    esp_mqtt_client_destroy(mqtt_client);
    mqtt_client = nullptr;
    next_mqtt_reconnect = millis() + kMqttReconnectMilliseconds;
    return;
  }
  const esp_err_t result = esp_mqtt_client_start(mqtt_client);
  if (result != ESP_OK) {
    Serial.printf("mqtt=start_failed result=0x%x\n",
                  static_cast<unsigned int>(result));
    esp_mqtt_client_destroy(mqtt_client);
    mqtt_client = nullptr;
    next_mqtt_reconnect = millis() + kMqttReconnectMilliseconds;
    return;
  }
  next_mqtt_reconnect = millis() + kMqttReconnectMilliseconds;
}

}  // namespace

void setup() {
  Serial.begin(115200);
  initializeOtaRollbackState();
  if (ota_boot_state_invalid) {
    rollbackRunningOtaImage("bootloader_state");
  }
  pinMode(LED_BUILTIN, OUTPUT);
  digitalWrite(LED_BUILTIN, LOW);
  pinMode(BUZZER_PIN, OUTPUT);
  setBuzzer(false);
  delay(250);
  SPI.begin(D13, D12, D11, D10);
  rfid_ready = initializeRfidReader();
  loadEquipmentRegistry();
  Serial.printf("equipment=legacy_compatibility enabled=%s\n",
                VALIDATOR_ALLOW_LEGACY_EQUIPMENT == 1 ? "true" : "false");
  // Confirmación audible de que el firmware arrancó y los periféricos fueron
  // inicializados. También funciona aunque todavía falte la configuración MQTT.
  playStartupMelody();
  topic_root = String("fuel-edge/v1/") + SITE_ID + "/" + MODULE_ID +
               "/validators/" + VALIDATOR_ID;
  challenge_topic = topic_root + "/challenge";
  proof_topic = topic_root + "/proof";
  presentation_topic = topic_root + "/presentation";
  decision_topic = topic_root + "/decision";
  equipment_topic = topic_root + "/equipment";
  credential_topic = topic_root + "/credential";
  config_topic = topic_root + "/config";
  config_status_topic = topic_root + "/config/status";
  enrollment_topic = topic_root + "/enrollment";
  equipment_registry_topic = topic_root + "/registry";
  equipment_registry_status_topic = topic_root + "/registry/status";
  ota_command_topic = topic_root + "/ota/command";
  ota_status_topic = topic_root + "/ota/status";

  if (strlen(WIFI_SSID) == 0 || strlen(MQTT_URI) == 0) {
    Serial.println("config=missing copy validator_secrets.example.h");
    return;
  }
  NimBLEDevice::init("");
  if (!NimBLEDevice::setPower(20)) {
    Serial.println("ble=tx_power_failed requested_dbm=20");
    delay(1000);
    ESP.restart();
    return;
  }
  Serial.printf("ble=tx_power configured_dbm=20 actual_dbm=%d\n",
                NimBLEDevice::getPower());
  const bool wifi_connected = connectWifi(kWifiInitialConnectMilliseconds);
  if (!wifi_connected && running_image_pending_verification) {
    rollbackRunningOtaImage("wifi_initial_timeout");
  }
  configTime(0, 0, NTP_SERVER);
  if (wifi_connected) {
    Serial.print("ntp=waiting");
    const unsigned long ntp_deadline = millis() + 15000;
    while (time(nullptr) < 1704067200 && millis() < ntp_deadline) {
      delay(250);
      Serial.print('.');
    }
    Serial.println(time(nullptr) >= 1704067200 ? " synchronized" : " unavailable");
  } else {
    Serial.println("ntp=deferred wifi_offline=true");
  }
  startMqtt();
  Serial.println("Acople el llavero RFID y mantengalo sobre el RC522.");
}

void loop() {
  processDeferredMqttEvents();
  if (!rfid_ready && static_cast<long>(millis() - next_rfid_recovery) >= 0) {
    rfid_ready = initializeRfidReader();
    next_rfid_recovery = millis() + 2000;
  }
  if (Serial.available()) {
    const char command = Serial.read();
    if (command == 'p' && VALIDATOR_SIMULATED_CARD) {
      publishPresentation();
    } else if (command == 'b') {
      playStartupMelody();
    } else if (command == 'w') {
      reportConfiguredWifiVisibility();
    } else if (command == 's') {
      Serial.printf(
          "status firmware=%s wifi=%s ip=%s mqtt=%s session=%s enrollment=%s clock=%lld rfid=0x%02x ble_rssi_threshold=%d revision=%lu mims=%u registry=%.12s ota=%s rollback=%s mqtt_inbox_failures=%lu\n",
          kFirmwareVersion,
          WiFi.status() == WL_CONNECTED ? "connected" : "disconnected",
          WiFi.localIP().toString().c_str(), mqtt_online ? "connected" : "disconnected",
          active_session.isEmpty() ? "idle" : "active",
          enrollment_window_active ? "active" : "inactive",
          static_cast<long long>(time(nullptr)),
          rfid_reader.PCD_ReadRegister(MFRC522::VersionReg), ble_rssi_threshold,
          static_cast<unsigned long>(ble_config_revision),
          static_cast<unsigned int>(trusted_equipment_count),
          equipment_registry_generation.c_str(),
          ota_update_running ? "updating" : ota_command_pending ? "queued" : "idle",
          running_image_pending_verification ? "pending" : "healthy",
          static_cast<unsigned long>(mqtt_inbox_failure_count));
    }
  }
  maintainWifiConnection();
  if (!ota_update_running) maintainMqttConnection();
  confirmRunningOtaImageIfHealthy();
  rollbackUnhealthyOtaImageIfExpired();
  if (ota_command_pending && !ota_update_running &&
      (ota_retry_at == 0 || static_cast<long>(millis() - ota_retry_at) >= 0)) {
    performOtaUpdate();
  }
  if (mqtt_online && ble_config_revision > 0 &&
      static_cast<long>(millis() - next_hardware_status) >= 0) {
    publishConfigStatus();
    next_hardware_status = millis() + 5000;
  }
  if (!ota_update_running) {
    maintainProactiveEquipmentDiscovery();
    pollPhysicalCard();
    maintainCredentialPresence();
    maintainEquipmentSession();
  }
  delay(20);
}
