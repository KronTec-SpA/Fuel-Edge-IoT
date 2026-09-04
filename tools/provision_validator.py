#!/usr/bin/env python3
"""Genera el header privado del validador a partir de Wi-Fi y certificados."""

from __future__ import annotations

import argparse
import os
from pathlib import Path
import re
import tomllib


IDENTIFIER = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$")


def _text(path: Path, name: str) -> str:
    value = path.read_text(encoding="utf-8").strip()
    if not value:
        raise ValueError(f"{name} está vacío")
    return value


def _c_string(value: str) -> str:
    return '"' + value.replace("\\", "\\\\").replace('"', '\\"') + '"'


def _trusted_equipment(path: Path) -> tuple[str, int]:
    with path.open("rb") as source:
        raw = tomllib.load(source)
    modules = raw.get("modules")
    if not isinstance(modules, list) or not modules:
        raise ValueError("equipment-registry.toml debe contener al menos un [[modules]]")
    entries: list[str] = []
    seen: set[str] = set()
    for row in modules:
        if not isinstance(row, dict):
            raise ValueError("entrada de módulo inválida")
        module_id = str(row.get("module_id", "")).strip()
        if not IDENTIFIER.fullmatch(module_id) or module_id in seen:
            raise ValueError("module_id de equipo inválido o duplicado")
        seen.add(module_id)
        secret = bytes.fromhex(str(row.get("secret_hex", "")))
        if len(secret) != 32 or row.get("active", True) is not True:
            raise ValueError(f"módulo {module_id} inactivo o con clave inválida")
        rows = [
            "            " + ", ".join(f"0x{value:02x}" for value in secret[offset:offset + 8]) + ","
            for offset in range(0, 32, 8)
        ]
        entries.append(
            "    {\n"
            f"        {_c_string(module_id)},\n"
            "        {\n" + "\n".join(rows) + "\n        },\n"
            "    },"
        )
    declaration = (
        "static const TrustedEquipmentSecret TRUSTED_EQUIPMENT[] = {\n"
        + "\n".join(entries)
        + "\n};"
    )
    return declaration, len(entries)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--wifi-settings", type=Path, required=True)
    parser.add_argument("--ca", type=Path, required=True)
    parser.add_argument("--cert", type=Path, required=True)
    parser.add_argument("--key", type=Path, required=True)
    parser.add_argument("--mqtt-uri", required=True)
    parser.add_argument("--equipment-registry", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()

    wifi_rows = args.wifi_settings.read_text(encoding="utf-8").splitlines()
    if len(wifi_rows) != 2 or not wifi_rows[0] or not wifi_rows[1]:
        raise ValueError("wifi-settings debe contener SSID y contraseña en dos líneas")
    ca = _text(args.ca, "CA")
    cert = _text(args.cert, "certificado")
    key = _text(args.key, "clave")
    trusted_equipment, trusted_count = _trusted_equipment(args.equipment_registry)
    header = f'''#pragma once

#define WIFI_SSID {_c_string(wifi_rows[0])}
#define WIFI_PASSWORD {_c_string(wifi_rows[1])}
#define NTP_SERVER "10.42.0.1"
#define MQTT_URI {_c_string(args.mqtt_uri)}
#define SITE_ID "concha-y-toro-piloto"
#define MODULE_ID "rpiplc-19r-01"
#define VALIDATOR_ID "validator-01"

#define RFID_SS_PIN D10
#define RFID_RST_PIN D9
#define BUZZER_PIN D8
#define BUZZER_ACTIVE_HIGH 1
#define BUZZER_PASSIVE 1
#define BUZZER_FREQUENCY_HZ 4000

static const char MQTT_CA_CERT[] = R"PEM(
{ca}
)PEM";
static const char MQTT_CLIENT_CERT[] = R"PEM(
{cert}
)PEM";
static const char MQTT_CLIENT_KEY[] = R"PEM(
{key}
)PEM";

// Enrolamiento físico MIFARE Classic. El modo simulado queda deshabilitado.
#define VALIDATOR_MIFARE_CLASSIC_CARD 1
#define VALIDATOR_SIMULATED_CARD 0
#define SIMULATED_CREDENTIAL_ID "card-01"
static const unsigned char CARD_MASTER_SECRET[32] = {{
    0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07,
    0x08, 0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x0e, 0x0f,
    0x10, 0x11, 0x12, 0x13, 0x14, 0x15, 0x16, 0x17,
    0x18, 0x19, 0x1a, 0x1b, 0x1c, 0x1d, 0x1e, 0x1f,
}};

{trusted_equipment}
#define TRUSTED_EQUIPMENT_COUNT {trusted_count}
#define BLE_RSSI_THRESHOLD -70
#define BLE_RSSI_SAMPLE_COUNT 5
#define BLE_SCAN_TIMEOUT_SECONDS 40
'''
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(header, encoding="utf-8")
    os.chmod(args.output, 0o600)
    print(f"validator_secrets creado: {args.output}")


if __name__ == "__main__":
    main()
