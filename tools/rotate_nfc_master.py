#!/usr/bin/env python3
"""Rota la raíz NFC y genera el registro privado correspondiente del RPi."""

from __future__ import annotations

import argparse
import os
from pathlib import Path
import re
import secrets


SECRET_BLOCK = re.compile(
    r"static const unsigned char CARD_MASTER_SECRET\[32\] = \{.*?\};",
    re.DOTALL,
)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--validator-header", type=Path, required=True)
    parser.add_argument("--registry-output", type=Path, required=True)
    args = parser.parse_args()
    secret = secrets.token_bytes(32)
    rows = [
        "    " + ", ".join(f"0x{value:02x}" for value in secret[offset:offset + 8]) + ","
        for offset in range(0, 32, 8)
    ]
    replacement = (
        "static const unsigned char CARD_MASTER_SECRET[32] = {\n"
        + "\n".join(rows)
        + "\n};"
    )
    source = args.validator_header.read_text(encoding="utf-8")
    updated, count = SECRET_BLOCK.subn(replacement, source, count=1)
    if count != 1:
        raise ValueError("no se encontró CARD_MASTER_SECRET en el header")
    args.validator_header.write_text(updated, encoding="utf-8")
    args.validator_header.chmod(0o600)

    args.registry_output.parent.mkdir(parents=True, exist_ok=True)
    descriptor = os.open(
        args.registry_output,
        os.O_WRONLY | os.O_CREAT | os.O_EXCL,
        0o600,
    )
    with os.fdopen(descriptor, "w", encoding="utf-8") as target:
        target.write(
            "# Raíz privada usada exclusivamente para enrolamiento físico NFC.\n"
            "[[credentials]]\n"
            'credential_id = "card-01"\n'
            'operator_id = "nfc-enrollment-bootstrap"\n'
            f'secret_hex = "{secret.hex()}"\n'
            "credential_active = true\n"
            "operator_active = true\n"
            "is_master = false\n"
        )
        target.flush()
        os.fsync(target.fileno())
    print("nfc_master_rotated registry_mode=0600")


if __name__ == "__main__":
    main()
