#!/usr/bin/env python3
"""Genera el header privado de la red de enrolamiento de una Raspberry."""

from __future__ import annotations

import argparse
from pathlib import Path


def c_string(value: str) -> str:
    return value.replace("\\", "\\\\").replace('"', '\\"')


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--settings",
        type=Path,
        required=True,
        help="copia protegida de /etc/fuel-edge/validator-ap.txt",
    )
    parser.add_argument("--header", type=Path, required=True)
    parser.add_argument("--server-url", default="http://10.42.0.1:8788")
    parser.add_argument("--force", action="store_true")
    args = parser.parse_args()
    if args.header.exists() and not args.force:
        raise SystemExit(f"no se sobrescribirá el header existente: {args.header}")
    lines = args.settings.read_text(encoding="utf-8").splitlines()
    if len(lines) < 2:
        raise SystemExit("validator-ap.txt incompleto")
    ssid, password = lines[0].strip(), lines[1].strip()
    if not 1 <= len(ssid.encode("utf-8")) <= 32:
        raise SystemExit("SSID de enrolamiento inválido")
    if not 8 <= len(password) <= 63:
        raise SystemExit("clave WPA2 de enrolamiento inválida")
    if args.server_url != "http://10.42.0.1:8788":
        raise SystemExit("la URL debe apuntar al servicio local de la Raspberry")
    header = (
        "#pragma once\n\n"
        "#define EQUIPMENT_NETWORK_PROVISIONED 1\n"
        f'#define ENROLLMENT_WIFI_SSID "{c_string(ssid)}"\n'
        f'#define ENROLLMENT_WIFI_PASSWORD "{c_string(password)}"\n'
        f'#define ENROLLMENT_SERVER_URL "{c_string(args.server_url)}"\n'
    )
    args.header.parent.mkdir(parents=True, exist_ok=True)
    args.header.write_text(header, encoding="utf-8")
    args.header.chmod(0o600)
    print(f"xiao_enrollment_network_configured ssid={ssid} header={args.header}")


if __name__ == "__main__":
    main()
