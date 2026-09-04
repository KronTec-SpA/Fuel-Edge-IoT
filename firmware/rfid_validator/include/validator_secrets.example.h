#pragma once

// Copiar como include/validator_secrets.h. No versionar el archivo real.
#define WIFI_SSID "red-del-fundo"
#define WIFI_PASSWORD "reemplazar"
#define NTP_SERVER "ntp.fundo.internal"
#define MQTT_URI "mqtts://mqtt.fundo.internal:8883"
#define SITE_ID "concha-y-toro-piloto"
#define MODULE_ID "rpiplc-19r-01"
#define VALIDATOR_ID "validator-01"

// Cableado del Arduino Nano ESP32. El RC522 trabaja a 3,3 V; no conectarlo a
// 5 V. IRQ queda sin conectar. El buzzer usado en el montaje es activo.
#define RFID_SS_PIN D10       // RC522 SDA/SS
#define RFID_RST_PIN D5       // RC522 RST
#define BUZZER_PIN D8         // Buzzer I/O
#define BUZZER_ACTIVE_HIGH 1  // Cambiar a 0 si el módulo es activo en LOW
#define BUZZER_PASSIVE 1      // Genera una onda cuadrada en vez de HIGH fijo
#define BUZZER_FREQUENCY_HZ 4000

static const char MQTT_CA_CERT[] = R"PEM(
-----BEGIN CERTIFICATE-----
REEMPLAZAR
-----END CERTIFICATE-----
)PEM";

static const char MQTT_CLIENT_CERT[] = R"PEM(
-----BEGIN CERTIFICATE-----
REEMPLAZAR
-----END CERTIFICATE-----
)PEM";

static const char MQTT_CLIENT_KEY[] = R"PEM(
-----BEGIN PRIVATE KEY-----
REEMPLAZAR
-----END PRIVATE KEY-----
)PEM";

// Enrolamiento físico MIFARE Classic: el sector 1 se personaliza con claves
// derivadas por tarjeta. El modo simulado queda deshabilitado en producción.
#define VALIDATOR_MIFARE_CLASSIC_CARD 1
#define VALIDATOR_SIMULATED_CARD 0
#define SIMULATED_CREDENTIAL_ID "card-01"
static const unsigned char CARD_MASTER_SECRET[32] = {
    0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07,
    0x08, 0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x0e, 0x0f,
    0x10, 0x11, 0x12, 0x13, 0x14, 0x15, 0x16, 0x17,
    0x18, 0x19, 0x1a, 0x1b, 0x1c, 0x1d, 0x1e, 0x1f,
};

// Registro local de módulos BLE admitidos. Cada clave debe coincidir con la
// clave única inyectada en el firmware del módulo de equipo correspondiente.
// La confianza se ata al module_id estable; el equipment_id se asigna por BLE
// y la Raspberry decide si esa asignación está autorizada.
static const TrustedEquipmentSecret TRUSTED_EQUIPMENT[] = {
    {
        "equipment-module-0001",
        {
            0x70, 0x4f, 0x1c, 0xa2, 0x86, 0x9d, 0x53, 0x18,
            0xb1, 0x35, 0x7a, 0xe4, 0x2d, 0x91, 0x6c, 0x08,
            0x39, 0xf5, 0x62, 0xab, 0xc7, 0x10, 0xde, 0x44,
            0x8e, 0x23, 0x59, 0xf0, 0x6b, 0xd4, 0x17, 0x9a,
        },
    },
};
#define TRUSTED_EQUIPMENT_COUNT 1

// Debe calibrarse en la zona real de carga. No representa porcentaje.
#define BLE_RSSI_THRESHOLD -70
#define BLE_RSSI_SAMPLE_COUNT 5
// Cubre los 30 s de deep sleep del MIM más arranque, anuncio y conexión.
#define BLE_SCAN_TIMEOUT_SECONDS 40
