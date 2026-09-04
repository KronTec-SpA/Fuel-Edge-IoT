#!/usr/bin/env python3
"""Conserva una lista explícita de MIM y respalda el registro anterior."""

from __future__ import annotations

import argparse
from datetime import datetime, timezone
import os
from pathlib import Path
import shutil
import stat
import tempfile
import tomllib


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--registry", type=Path, required=True)
    parser.add_argument("--keep", action="append", required=True)
    args = parser.parse_args()
    path = args.registry
    if path.is_symlink() or not path.is_file():
        raise SystemExit("el registro debe ser un archivo regular")
    if stat.S_IMODE(path.stat().st_mode) & 0o077:
        raise SystemExit("el registro debe tener permisos 0600")
    with path.open("rb") as source:
        modules = tomllib.load(source).get("modules", [])
    wanted = set(args.keep)
    selected = [item for item in modules if item.get("module_id") in wanted]
    found = {str(item.get("module_id")) for item in selected}
    if found != wanted or len(selected) != len(wanted):
        raise SystemExit("no se encontró exactamente una entrada por MIM solicitado")
    lines: list[str] = []
    for item in selected:
        module_id = str(item.get("module_id", ""))
        secret_hex = str(item.get("secret_hex", ""))
        active = item.get("active", True)
        if len(bytes.fromhex(secret_hex)) != 32 or not isinstance(active, bool):
            raise SystemExit(f"entrada inválida: {module_id}")
        lines.extend([
            "[[modules]]",
            f'module_id = "{module_id}"',
            f'secret_hex = "{secret_hex}"',
            f"active = {'true' if active else 'false'}",
            "",
        ])
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    backup = path.with_name(f"{path.name}.backup-{stamp}")
    shutil.copy2(path, backup)
    os.chmod(backup, 0o600)
    descriptor, temporary_name = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as output:
            output.write("\n".join(lines))
            output.flush()
            os.fsync(output.fileno())
        os.chmod(temporary_name, 0o600)
        os.replace(temporary_name, path)
    finally:
        if os.path.exists(temporary_name):
            os.unlink(temporary_name)
    print(
        f"registry_cleaned kept={len(selected)} removed={len(modules) - len(selected)} "
        f"backup={backup}"
    )


if __name__ == "__main__":
    main()
