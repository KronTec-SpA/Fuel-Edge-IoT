"""Registro durable de cortes detectados por la UPS del Raspberry PLC."""

from __future__ import annotations

import argparse
import json
from datetime import datetime, timezone
from pathlib import Path

from .storage import EventStore


DEFAULT_DATABASE = Path("/var/lib/fuel-edge/edge.db")


def current_boot_id() -> str | None:
    try:
        value = Path("/proc/sys/kernel/random/boot_id").read_text(encoding="ascii").strip()
    except OSError:
        return None
    return value or None


def boot_started_at() -> str:
    try:
        for line in Path("/proc/stat").read_text(encoding="ascii").splitlines():
            if line.startswith("btime "):
                seconds = int(line.split(maxsplit=1)[1])
                return datetime.fromtimestamp(seconds, timezone.utc).isoformat()
    except (OSError, ValueError):
        pass
    return datetime.now(timezone.utc).isoformat()


def reconcile_power_restoration(store: EventStore, site_id: str) -> dict[str, object] | None:
    return store.close_open_power_loss(
        site_id=site_id,
        restored_at=boot_started_at(),
        restore_boot_id=current_boot_id(),
    )


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Registra eventos de suministro eléctrico")
    parser.add_argument("--database", type=Path, default=DEFAULT_DATABASE)
    subparsers = parser.add_subparsers(dest="command", required=True)

    subparsers.add_parser("init", help="Inicializa el almacenamiento eléctrico")

    loss = subparsers.add_parser("record-loss", help="Registra una pérdida detectada por la UPS")
    loss.add_argument("--lost-at")
    loss.add_argument("--source", default="ups_gpio24", choices=("ups_gpio24",))

    imported = subparsers.add_parser("import-outage", help="Importa un corte confirmado")
    imported.add_argument("--site-id", required=True)
    imported.add_argument("--lost-at", required=True)
    imported.add_argument("--restored-at", required=True)
    imported.add_argument(
        "--source",
        default="operator_confirmed",
        choices=("operator_confirmed", "reconstructed"),
    )
    imported.add_argument("--loss-boot-id")
    imported.add_argument("--restore-boot-id")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    store = EventStore(args.database)
    try:
        if args.command == "init":
            result: dict[str, object] = {"status": "ready", "database": str(args.database)}
        elif args.command == "record-loss":
            lost_at = args.lost_at or datetime.now(timezone.utc).isoformat()
            event_id = store.record_power_loss(
                lost_at=lost_at,
                source=args.source,
                loss_boot_id=current_boot_id(),
            )
            result = {"status": "recorded", "id": event_id, "lostAt": lost_at}
        elif args.command == "import-outage":
            event = store.record_completed_power_outage(
                site_id=args.site_id,
                lost_at=args.lost_at,
                restored_at=args.restored_at,
                source=args.source,
                loss_boot_id=args.loss_boot_id,
                restore_boot_id=args.restore_boot_id,
            )
            result = {"status": "imported", "event": event}
        else:  # pragma: no cover - argparse impide este camino
            raise RuntimeError("comando eléctrico desconocido")
    finally:
        store.close()
    print(json.dumps(result, ensure_ascii=False, separators=(",", ":")), flush=True)
    return 0


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
