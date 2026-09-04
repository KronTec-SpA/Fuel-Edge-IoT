#pragma once

#define EQUIPMENT_PROVISIONED 0

// Copiar como include/equipment_secrets.h. La clave real es única por módulo,
// se inyecta en fábrica y no se modifica desde el portal web.
#define EQUIPMENT_MODULE_ID "equipment-module-0001"
#define FACTORY_EQUIPMENT_ID ""
static const unsigned char EQUIPMENT_MODULE_SECRET[32] = {
    0x70, 0x4f, 0x1c, 0xa2, 0x86, 0x9d, 0x53, 0x18,
    0xb1, 0x35, 0x7a, 0xe4, 0x2d, 0x91, 0x6c, 0x08,
    0x39, 0xf5, 0x62, 0xab, 0xc7, 0x10, 0xde, 0x44,
    0x8e, 0x23, 0x59, 0xf0, 0x6b, 0xd4, 0x17, 0x9a,
};

// WPA2 del AP temporal y HTTP Basic del portal. Usar al menos 12 caracteres.
#define PROVISIONING_AP_PASSWORD "REEMPLAZAR-CLAVE-UNICA"

// Pulsador normalmente abierto entre D1/GPIO3 y GND. INPUT_PULLUP mantiene D1
// alto y una pulsación lo lleva a LOW para despertar desde deep sleep.
#define CONFIG_BUTTON_PIN D1

// Cada click abre una ventana BLE fija de 60 s. No existen wakes periódicos.
// +20 dBm es el máximo contractual del ESP32-C3 para anuncios y conexión.
#define OPERATIONAL_ADVERTISE_WINDOW_SECONDS 60
#define BLE_TX_POWER_DBM 20
