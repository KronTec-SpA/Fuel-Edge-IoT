"""Normaliza alertas K24 históricas a la notación numérica chilena."""

from __future__ import annotations

import json
import re
import sqlite3
import sys
from pathlib import Path


ALERT_TITLE = "Flujo de petróleo sin autorización"
LITERS_PATTERN = re.compile(r"\((\d+)\.(\d{3}) L\)")


def localize_detail(detail: str) -> str:
    return LITERS_PATTERN.sub(
        lambda match: f"({match.group(1)},{match.group(2)} L)", detail
    )


def backup_database(source_path: Path, backup_path: Path) -> None:
    source = sqlite3.connect(source_path)
    target = sqlite3.connect(backup_path)
    try:
        source.backup(target)
    finally:
        target.close()
        source.close()


def migrate_web_database(path: Path) -> int:
    connection = sqlite3.connect(path)
    connection.execute("PRAGMA busy_timeout = 5000")
    try:
        rows = connection.execute(
            "SELECT id,detail FROM system_alerts WHERE title=?", (ALERT_TITLE,)
        ).fetchall()
        updates = [
            (localized, alert_id)
            for alert_id, detail in rows
            if (localized := localize_detail(str(detail))) != detail
        ]
        connection.executemany(
            "UPDATE system_alerts SET detail=? WHERE id=?", updates
        )
        connection.commit()
        return len(updates)
    finally:
        connection.close()


def migrate_edge_outbox(path: Path) -> int:
    connection = sqlite3.connect(path)
    connection.execute("PRAGMA busy_timeout = 5000")
    try:
        rows = connection.execute(
            "SELECT id,payload FROM outbox WHERE topic='web/alert'"
        ).fetchall()
        updates: list[tuple[str, int]] = []
        for event_id, encoded in rows:
            payload = json.loads(encoded)
            if payload.get("title") != ALERT_TITLE:
                continue
            detail = str(payload.get("detail", ""))
            localized = localize_detail(detail)
            if localized == detail:
                continue
            payload["detail"] = localized
            updates.append(
                (json.dumps(payload, separators=(",", ":"), sort_keys=True), event_id)
            )
        connection.executemany("UPDATE outbox SET payload=? WHERE id=?", updates)
        connection.commit()
        return len(updates)
    finally:
        connection.close()


def main() -> None:
    if len(sys.argv) != 5:
        raise SystemExit(
            "uso: migrate_alert_liters_cl.py WEB_DB EDGE_DB WEB_BACKUP EDGE_BACKUP"
        )
    web_path, edge_path, web_backup, edge_backup = map(Path, sys.argv[1:])
    if web_backup.exists() or edge_backup.exists():
        raise SystemExit("los respaldos de destino ya existen")
    backup_database(web_path, web_backup)
    backup_database(edge_path, edge_backup)
    print(
        json.dumps(
            {
                "web_alerts_updated": migrate_web_database(web_path),
                "edge_outbox_events_updated": migrate_edge_outbox(edge_path),
            },
            sort_keys=True,
        )
    )


if __name__ == "__main__":
    main()
