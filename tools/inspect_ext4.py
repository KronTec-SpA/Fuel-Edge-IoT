#!/usr/bin/env python3
"""Read selected metadata from the Raspberry PLC ext4 partition image."""

from __future__ import annotations

import sys
import stat
from pathlib import Path

from dissect.extfs.extfs import ExtFS
from dissect.util.stream import RangeStream


ROOTFS_OFFSET = 545_259_520
ROOTFS_SIZE = 19_454_230_528


def read_text(fs: ExtFS, path: str) -> str | None:
    try:
        return fs.get(path).open().read().decode("utf-8", errors="replace")
    except Exception:
        return None


def list_dir(fs: ExtFS, path: str) -> list[str]:
    try:
        return sorted(entry.filename for entry in fs.get(path).iterdir())
    except Exception:
        return []


def print_tree(fs: ExtFS, path: str, depth: int = 3, prefix: str = "") -> None:
    if depth < 0:
        return
    try:
        entries = sorted(fs.get(path).iterdir(), key=lambda entry: entry.filename)
    except Exception:
        return
    for entry in entries:
        if entry.filename in (".", ".."):
            continue
        child_path = f"{path.rstrip('/')}/{entry.filename}"
        print(f"{prefix}{entry.filename}")
        if stat.S_ISDIR(entry.filetype):
            print_tree(fs, child_path, depth - 1, prefix + "  ")


def main() -> int:
    if len(sys.argv) != 2:
        print(f"Usage: {Path(sys.argv[0]).name} IMAGE", file=sys.stderr)
        return 2

    image = Path(sys.argv[1])
    with image.open("rb") as raw:
        fs = ExtFS(RangeStream(raw, ROOTFS_OFFSET, ROOTFS_SIZE))
        print(f"filesystem={fs.type} uuid={fs.uuid} label={fs.volume_name!r}")

        for path in (
            "/etc/hostname",
            "/etc/os-release",
            "/etc/passwd",
            "/etc/dhcpcd.conf",
            "/etc/network/interfaces",
        ):
            value = read_text(fs, path)
            if value is not None:
                print(f"\n--- {path} ---")
                print(value.rstrip())

        for path in (
            "/home",
            "/opt",
            "/usr/local/bin",
            "/etc/systemd/system",
            "/etc/NetworkManager/system-connections",
        ):
            entries = list_dir(fs, path)
            if entries:
                print(f"\n--- {path}/ ---")
                print("\n".join(entries))

        print("\n--- /home/pi tree ---")
        print_tree(fs, "/home/pi", depth=4)

        for path in (
            "/etc/NetworkManager/system-connections/eth0-1.nmconnection",
            "/etc/NetworkManager/system-connections/eth1-1.nmconnection",
        ):
            value = read_text(fs, path)
            if value is not None:
                print(f"\n--- {path} ---")
                print(value.rstrip())

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
