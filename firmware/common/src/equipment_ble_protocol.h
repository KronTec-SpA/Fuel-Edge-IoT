#pragma once

#include <stddef.h>
#include <stdint.h>

namespace fuel_equipment_ble {

// BLE 4 elimina por contrato la telemetría de batería. El cambio de tamaño del
// anuncio y del JSON de identidad es deliberadamente incompatible con v3 para
// que ningún extremo interprete un byte reservado como una medición real.
constexpr uint8_t kProtocolVersion = 4;
constexpr size_t kChallengeSize = 32;
constexpr size_t kModuleNonceSize = 32;
constexpr size_t kResponseTagSize = 32;
// Respuesta wire: nonce aleatorio generado por el MIM || tag HMAC. El nonce
// del MIM impide volver a abrir una conexión con un desafío capturado y
// reutilizar comandos de sesión antiguos.
constexpr size_t kResponseSize = kModuleNonceSize + kResponseTagSize;

// El NUL final forma parte del dominio HMAC para separar este protocolo de
// cualquier otro uso de la misma clave del módulo.
constexpr char kHmacDomain[] = "fuel-edge/equipment/v1";

constexpr char kServiceUuid[] = "e0f10001-7c61-4a9c-9f54-6f2f30c8d001";
constexpr char kIdentityUuid[] = "e0f10002-7c61-4a9c-9f54-6f2f30c8d001";
constexpr char kChallengeUuid[] = "e0f10003-7c61-4a9c-9f54-6f2f30c8d001";
constexpr char kResponseUuid[] = "e0f10004-7c61-4a9c-9f54-6f2f30c8d001";
constexpr char kSessionControlUuid[] = "e0f10005-7c61-4a9c-9f54-6f2f30c8d001";
constexpr char kClaimUuid[] = "e0f10006-7c61-4a9c-9f54-6f2f30c8d001";

constexpr char kClaimHmacDomain[] = "fuel-edge/equipment/claim/v1";
constexpr size_t kClaimNonceSize = 16;
constexpr size_t kClaimTagSize = 32;
constexpr size_t kMaximumClaimValueLength = 63;

// Manufacturer data BLE: magic, versión y flags. El MIM no mide batería.
constexpr uint8_t kAdvertisementMagic0 = 0x46;  // F
constexpr uint8_t kAdvertisementMagic1 = 0x45;  // E
constexpr size_t kAdvertisementSize = 4;
constexpr uint8_t kFlagConfigured = 1U << 0;
constexpr uint8_t kFlagEnrollmentReady = 1U << 2;

// Los comandos de sesión también se autentican. Probar sólo la identidad del
// MIM no demuestra que quien escribe hold-awake sea un validador autorizado;
// sin este MAC cualquier central BLE cercana podría mantenerlo despierto hasta
// agotar su batería. El tag cubre el desafío de la conexión, la identidad, el
// encabezado y un contador estrictamente creciente.
constexpr char kSessionHmacDomain[] = "fuel-edge/equipment/session/v1";
constexpr uint8_t kSessionCommandVersion = 1;
constexpr uint8_t kCommandHoldAwake = 1;
constexpr uint8_t kCommandCloseSession = 2;
constexpr size_t kSessionCommandHeaderSize = 8;
constexpr size_t kSessionTagSize = 32;
constexpr size_t kSessionCommandSize =
    kSessionCommandHeaderSize + kSessionTagSize;
constexpr uint16_t kMaximumHoldSeconds = 30;

inline void encodeSessionCommandHeader(
    uint8_t command, uint16_t seconds, uint32_t sequence,
    uint8_t output[kSessionCommandHeaderSize]) {
  if (seconds > kMaximumHoldSeconds) seconds = kMaximumHoldSeconds;
  output[0] = kSessionCommandVersion;
  output[1] = command;
  output[2] = static_cast<uint8_t>(seconds >> 8);
  output[3] = static_cast<uint8_t>(seconds & 0xff);
  output[4] = static_cast<uint8_t>(sequence >> 24);
  output[5] = static_cast<uint8_t>(sequence >> 16);
  output[6] = static_cast<uint8_t>(sequence >> 8);
  output[7] = static_cast<uint8_t>(sequence);
}

inline uint16_t decodeHoldSeconds(
    const uint8_t input[kSessionCommandHeaderSize]) {
  return static_cast<uint16_t>((static_cast<uint16_t>(input[2]) << 8) |
                               input[3]);
}

inline uint32_t decodeSessionSequence(
    const uint8_t input[kSessionCommandHeaderSize]) {
  return (static_cast<uint32_t>(input[4]) << 24) |
         (static_cast<uint32_t>(input[5]) << 16) |
         (static_cast<uint32_t>(input[6]) << 8) |
         static_cast<uint32_t>(input[7]);
}

}  // namespace fuel_equipment_ble
