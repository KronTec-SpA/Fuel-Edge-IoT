#!/usr/bin/env python3
"""Sincroniza un MIM ya aprovisionado con el header privado del validador."""

from __future__ import annotations

import argparse
from pathlib import Path
import re


MODULE_ID = re.compile(r'#define EQUIPMENT_MODULE_ID "([A-Za-z0-9][A-Za-z0-9._-]{0,62})"')
MODULE_SECRET = re.compile(
    r"static const unsigned char EQUIPMENT_MODULE_SECRET\[32\] = \{(.*?)\};",
    re.DOTALL,
)
BYTE = re.compile(r"0x([0-9a-fA-F]{2})")
TRUSTED_BLOCK = re.compile(
    r"static const TrustedEquipmentSecret TRUSTED_EQUIPMENT(?:\[\]|\[1\]) = \{.*?\};\n"
    r"#define TRUSTED_EQUIPMENT_COUNT \d+",
    re.DOTALL,
)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--equipment-header", type=Path, required=True)
    parser.add_argument("--validator-header", type=Path, required=True)
    args = parser.parse_args()

    equipment = args.equipment_header.read_text(encoding="utf-8")
    module_match = MODULE_ID.search(equipment)
    secret_match = MODULE_SECRET.search(equipment)
    if module_match is None or secret_match is None:
        raise ValueError("header privado del MIM inválido")
    secret = [int(value, 16) for value in BYTE.findall(secret_match.group(1))]
    if len(secret) != 32:
        raise ValueError("la clave del MIM debe contener exactamente 32 bytes")
    rows = [
        "            " + ", ".join(f"0x{value:02x}" for value in secret[offset:offset + 8]) + ","
        for offset in range(0, 32, 8)
    ]
    replacement = (
        "static const TrustedEquipmentSecret TRUSTED_EQUIPMENT[] = {\n"
        "    {\n"
        f'        "{module_match.group(1)}",\n'
        "        {\n" + "\n".join(rows) + "\n        },\n"
        "    },\n"
        "};\n"
        "#define TRUSTED_EQUIPMENT_COUNT 1"
    )
    validator = args.validator_header.read_text(encoding="utf-8")
    updated, count = TRUSTED_BLOCK.subn(replacement, validator, count=1)
    if count != 1:
        raise ValueError("no se encontró el registro del validador")
    args.validator_header.write_text(updated, encoding="utf-8")
    args.validator_header.chmod(0o600)
    print(f"validator_equipment_header_synced module={module_match.group(1)}")


if __name__ == "__main__":
    main()
