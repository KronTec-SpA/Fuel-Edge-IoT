#pragma once

#define EQUIPMENT_NETWORK_PROVISIONED 0

// Red de enrolamiento local ofrecida por la Raspberry del terreno. Todos los
// MIM de una instalación comparten estas credenciales WPA2, pero conservan una
// identidad y una clave HMAC de fábrica diferentes.
#define ENROLLMENT_WIFI_SSID "FuelEdge-RPi"
#define ENROLLMENT_WIFI_PASSWORD "REEMPLAZAR-CON-CLAVE-DEL-AP"
#define ENROLLMENT_SERVER_URL "http://10.42.0.1:8788"
