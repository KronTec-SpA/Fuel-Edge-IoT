#!/usr/bin/env python3
"""Genera la identidad única que comparten un XIAO y su Raspberry autorizada."""

from __future__ import annotations

import argparse
from pathlib import Path
import re
import secrets
import tomllib


IDENTIFIER = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$")


def existing_module_ids(source: str) -> set[str]:
    if not source.strip():
        return set()
    try:
        registry = tomllib.loads(source)
    except tomllib.TOMLDecodeError as error:
        raise SystemExit("equipment-registry.toml contiene TOML inválido") from error
    modules = registry.get("modules", [])
    if not isinstance(modules, list):
        raise SystemExit("equipment-registry.toml debe contener [[modules]]")

    result: set[str] = set()
    for module in modules:
        if not isinstance(module, dict):
            raise SystemExit("equipment-registry.toml contiene una entrada inválida")
        module_id = module.get("module_id")
        if not isinstance(module_id, str) or not IDENTIFIER.fullmatch(module_id):
            raise SystemExit("equipment-registry.toml contiene un module_id inválido")
        if module_id in result:
            raise SystemExit("equipment-registry.toml contiene un module_id duplicado")
        result.add(module_id)
    return result


def main() -> None:
    parser = argparse.ArgumentParser(description="Provisionar identidad de fábrica para XIAO ESP32")
    parser.add_argument("module_id")
    parser.add_argument("--header", type=Path, required=True, help="equipment_secrets.h de salida")
    parser.add_argument("--registry", type=Path, required=True, help="equipment-registry.toml protegido")
    args = parser.parse_args()
    if not IDENTIFIER.fullmatch(args.module_id):
        raise SystemExit("module_id inválido")
    if args.header.exists():
        raise SystemExit(f"no se sobrescribirá el header existente: {args.header}")
    existing = args.registry.read_text(encoding="utf-8") if args.registry.exists() else ""
    if args.module_id in existing_module_ids(existing):
        raise SystemExit("el module_id ya existe en el registro")

    module_secret = secrets.token_bytes(32)
    portal_password = secrets.token_urlsafe(18)
    secret_rows = [
        "    " + ", ".join(f"0x{value:02x}" for value in module_secret[offset:offset + 8]) + ","
        for offset in range(0, len(module_secret), 8)
    ]
    header = f'''#pragma once

// Identidad única generada en fábrica. No compartir entre módulos.
#define EQUIPMENT_PROVISIONED 1
#define EQUIPMENT_MODULE_ID "{args.module_id}"
#define FACTORY_EQUIPMENT_ID ""
static const unsigned char EQUIPMENT_MODULE_SECRET[32] = {{
{chr(10).join(secret_rows)}
}};
#define PROVISIONING_AP_PASSWORD "{portal_password}"
#define CONFIG_BUTTON_PIN D1
#define OPERATIONAL_ADVERTISE_WINDOW_SECONDS 60
#define BLE_TX_POWER_DBM 20
'''
    args.header.parent.mkdir(parents=True, exist_ok=True)
    args.header.write_text(header, encoding="utf-8")
    args.header.chmod(0o600)

    args.registry.parent.mkdir(parents=True, exist_ok=True)
    separator = "" if not existing or existing.endswith("\n") else "\n"
    entry = (
        f'{separator}[[modules]]\nmodule_id = "{args.module_id}"\n'
        f'secret_hex = "{module_secret.hex()}"\nactive = true\n'
    )
    args.registry.write_text(existing + entry, encoding="utf-8")
    args.registry.chmod(0o600)
    print(f"provisioned={args.module_id} header={args.header} registry={args.registry}")


if __name__ == "__main__":
    main()
