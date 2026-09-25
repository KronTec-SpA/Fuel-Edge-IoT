"""Encola los diagnósticos OCIO aún conservados, sin fabricar lecturas antiguas.

Ejecutar con el servicio edge detenido antes del primer inicio de la nueva
versión. La cola es durable y reejecutar no duplica los mismos lotes.
"""
import argparse
import json
from pathlib import Path

from fuel_edge.storage import EventStore


def backfill(path: Path, site_id: str) -> int:
    store = EventStore(path)
    try:
        cursor = 0
        count = 0
        while True:
            rows = store.connection.execute(
                "SELECT id,payload FROM ocio_signal_diagnostics WHERE id>? ORDER BY id LIMIT 30", (cursor,)
            ).fetchall()
            if not rows:
                return count
            samples = [json.loads(row[1]) for row in rows]
            samples = [s for s in samples if isinstance(s.get('volts'), (int, float)) and isinstance(s.get('rawAdc'), (int, float))]
            if samples:
                store.enqueue('web/voltage-readings', {
                    'siteId': site_id, 'telemetrySessionId': 'legacy-local',
                    'source': 'OCIO', 'samples': samples,
                }, dedupe_key=f"web/voltage-backfill:{site_id}:{rows[0][0]}:{rows[-1][0]}")
                count += len(samples)
            cursor = rows[-1][0]
    finally:
        store.close()


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('database', type=Path)
    parser.add_argument('--site-id', required=True)
    args = parser.parse_args()
    if not args.database.is_file():
        parser.error('La base debe existir.')
    print(f"Muestras históricas encoladas: {backfill(args.database, args.site_id)}")
