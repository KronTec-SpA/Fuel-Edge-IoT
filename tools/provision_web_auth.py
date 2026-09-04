#!/usr/bin/env python3
"""Genera la configuración de autenticación sin persistir credenciales legibles."""

from __future__ import annotations

import argparse
import base64
import getpass
import hashlib
import hmac
import os
import secrets
import tempfile
import unicodedata
from pathlib import Path


ITERATIONS = 600_000


def _base64url(value: bytes) -> str:
    return base64.urlsafe_b64encode(value).rstrip(b"=").decode("ascii")


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Crea un archivo 0600 con hashes y secretos para el acceso web edge."
    )
    parser.add_argument("--email", required=True, help="correo de la cuenta maestra")
    parser.add_argument(
        "--output",
        type=Path,
        default=Path("/etc/fuel-edge/web-auth.env"),
        help="archivo de salida (predeterminado: /etc/fuel-edge/web-auth.env)",
    )
    parser.add_argument("--force", action="store_true", help="reemplazar el archivo existente")
    parser.add_argument(
        "--recovery-output",
        type=Path,
        help="archivo 0600 opcional donde guardar el código de recuperación para custodia offline",
    )
    parser.add_argument(
        "--sensor-key-output",
        type=Path,
        default=Path("/etc/fuel-edge/web-sensor.key"),
        help="archivo 0600 compartido sólo con el agente edge",
    )
    return parser


def main() -> None:
    args = _parser().parse_args()
    output = args.output.resolve()
    sensor_key_output = args.sensor_key_output.resolve()
    protected_outputs = [(output, "acceso web"), (sensor_key_output, "canal edge")]
    if args.recovery_output:
        protected_outputs.append((args.recovery_output.resolve(), "código de recuperación"))
    for path, label in protected_outputs:
        if path.exists() and not args.force:
            raise SystemExit(f"{path} ya existe ({label}); usa --force sólo si deseas rotarlo.")
    email = unicodedata.normalize("NFKC", args.email.strip().lower())
    if "@" not in email:
        raise SystemExit("El correo no es válido.")
    password = getpass.getpass("Contraseña: ")
    confirmation = getpass.getpass("Repite la contraseña: ")
    if password != confirmation:
        raise SystemExit("Las contraseñas no coinciden.")
    if len(password) < 12:
        raise SystemExit("La contraseña debe tener al menos 12 caracteres.")

    email_pepper = secrets.token_bytes(32)
    session_secret = secrets.token_bytes(32)
    data_key = secrets.token_bytes(32)
    recovery_pepper = secrets.token_bytes(32)
    sensor_key = secrets.token_urlsafe(32)
    recovery_code = "-".join(
        "".join(secrets.choice("ABCDEFGHJKLMNPQRSTUVWXYZ23456789") for _ in range(4))
        for _ in range(5)
    )
    recovery_digest = hmac.new(
        recovery_pepper, recovery_code.replace("-", "").encode("ascii"), hashlib.sha256
    ).digest()
    salt = secrets.token_bytes(16)
    password_hash = hashlib.pbkdf2_hmac(
        "sha256",
        unicodedata.normalize("NFKC", password).encode("utf-8"),
        salt,
        ITERATIONS,
        dklen=32,
    )
    email_digest = hmac.new(email_pepper, email.encode("utf-8"), hashlib.sha256).digest()
    content = "\n".join(
        (
            f"AUTH_ADMIN_EMAIL_DIGEST={_base64url(email_digest)}",
            f"AUTH_ADMIN_PASSWORD_HASH=pbkdf2_sha256${ITERATIONS}${_base64url(salt)}${_base64url(password_hash)}",
            f"AUTH_EMAIL_PEPPER={_base64url(email_pepper)}",
            f"AUTH_SESSION_SECRET={_base64url(session_secret)}",
            f"AUTH_DATA_KEY={_base64url(data_key)}",
            f"AUTH_RECOVERY_PEPPER={_base64url(recovery_pepper)}",
            f"AUTH_ADMIN_RECOVERY_DIGEST={_base64url(recovery_digest)}",
            f"AUTH_BOOTSTRAP_VERSION={secrets.token_hex(16)}",
            "AUTH_SESSION_TTL_SECONDS=28800",
            f"FUEL_SENSOR_INGEST_KEY={sensor_key}",
            "FUEL_HISTORY_DEMO_SEED=false",
            "APP_DEMO_SEED=false",
            "",
        )
    )

    output.parent.mkdir(parents=True, exist_ok=True)
    file_descriptor, temporary_name = tempfile.mkstemp(prefix=".web-auth-", dir=output.parent)
    try:
        os.fchmod(file_descriptor, 0o600)
        with os.fdopen(file_descriptor, "w", encoding="utf-8") as handle:
            handle.write(content)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary_name, output)
        os.chmod(output, 0o600)
    except Exception:
        try:
            os.unlink(temporary_name)
        except FileNotFoundError:
            pass
        raise
    print(f"Acceso configurado de forma segura en {output} (modo 0600).")
    _atomic_secret(sensor_key_output, sensor_key + "\n", args.force)
    print(f"Canal Raspberry-web configurado en {sensor_key_output} (modo 0600).")
    if args.recovery_output:
        recovery_output = args.recovery_output.resolve()
        _atomic_secret(recovery_output, recovery_code + "\n", args.force)
        print(f"Código de recuperación guardado en {recovery_output} (modo 0600).")
    else:
        print("Código de recuperación (guardar offline y destruir esta salida):")
        print(recovery_code)


def _atomic_secret(path: Path, value: str, force: bool) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.exists() and not force:
        raise SystemExit(f"{path} ya existe; usa --force sólo si deseas rotar el canal edge.")
    file_descriptor, temporary_name = tempfile.mkstemp(prefix=f".{path.name}-", dir=path.parent)
    try:
        os.fchmod(file_descriptor, 0o600)
        with os.fdopen(file_descriptor, "w", encoding="utf-8") as handle:
            handle.write(value)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary_name, path)
        os.chmod(path, 0o600)
    except Exception:
        try:
            os.unlink(temporary_name)
        except FileNotFoundError:
            pass
        raise


if __name__ == "__main__":
    main()
