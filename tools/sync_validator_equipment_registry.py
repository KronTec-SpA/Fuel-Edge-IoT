#!/usr/bin/env python3
"""Sincroniza módulos confiables de la Raspberry al header privado del validador."""

from __future__ import annotations

import argparse
from pathlib import Path
import re
import tomllib


IDENTIFIER = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$")
BLOCK = re.compile(
    r"static const TrustedEquipmentSecret TRUSTED_EQUIPMENT(?:\[\]|\[1\]) = \{.*?\};\n"
    r"#define TRUSTED_EQUIPMENT_COUNT \d+",
    re.DOTALL,
)


def render(path: Path) -> tuple[str, int]:
    with path.open("rb") as source:
        raw = tomllib.load(source)
    modules = raw.get("modules")
    if not isinstance(modules, list) or not modules:
        raise ValueError("el registro debe contener al menos un [[modules]]")
    entries: list[str] = []
    seen: set[str] = set()
    for row in modules:
        if not isinstance(row, dict):
            raise ValueError("entrada de módulo inválida")
        module_id = str(row.get("module_id", "")).strip()
        if not IDENTIFIER.fullmatch(module_id) or module_id in seen:
            raise ValueError("module_id inválido o duplicado")
        seen.add(module_id)
        secret = bytes.fromhex(str(row.get("secret_hex", "")))
        if len(secret) != 32 or row.get("active", True) is not True:
            raise ValueError(f"módulo {module_id} inactivo o con clave inválida")
        secret_rows = [
            "            " + ", ".join(f"0x{value:02x}" for value in secret[offset:offset + 8]) + ","
            for offset in range(0, 32, 8)
        ]
        entries.append(
            "    {\n"
            f'        "{module_id}",\n'
            "        {\n" + "\n".join(secret_rows) + "\n        },\n"
            "    },"
        )
    rendered = (
        "static const TrustedEquipmentSecret TRUSTED_EQUIPMENT[] = {\n"
        + "\n".join(entries)
        + "\n};\n"
        + f"#define TRUSTED_EQUIPMENT_COUNT {len(entries)}"
    )
    return rendered, len(entries)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--registry", type=Path, required=True)
    parser.add_argument("--header", type=Path, required=True)
    args = parser.parse_args()
    replacement, count = render(args.registry)
    source = args.header.read_text(encoding="utf-8")
    updated, substitutions = BLOCK.subn(replacement, source, count=1)
    if substitutions != 1:
        raise ValueError("no se encontró el registro de equipos en el header")
    args.header.write_text(updated, encoding="utf-8")
    args.header.chmod(0o600)
    print(f"validator_equipment_registry_synced modules={count}")


if __name__ == "__main__":
    main()
