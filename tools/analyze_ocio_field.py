"""Resumen reproducible de una exportación OCIO; no conecta ni modifica la BD.

Las exclusiones son fechas civiles de la zona indicada. Nunca se calculan
diferencias entre muestras separadas por una fecha excluida o una nueva sesión.
Las diferencias son cambios observados, no una clasificación automática de ruido.
"""

from __future__ import annotations

import argparse
from collections import Counter
from datetime import date, datetime, timedelta
import hashlib
import json
from pathlib import Path
from zoneinfo import ZoneInfo


def timestamp(value: str) -> datetime:
    result = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if result.tzinfo is None:
        raise ValueError("La exportación debe indicar la zona de cada muestra")
    return result


def observed_quantile(values: list[float], fraction: float) -> float | None:
    """Cuantil observado inferior, sin interpolar lecturas inexistentes."""
    if not values:
        return None
    ordered = sorted(values)
    return round(ordered[int((len(ordered) - 1) * fraction)], 3)


def summarize_series(rows: list[dict], excluded: set[date], zone: ZoneInfo) -> dict:
    samples = sorted(((timestamp(r["occurredAt"]), r) for r in rows), key=lambda x: x[0])
    local_dates = [t.astimezone(zone).date() for t, _ in samples]
    excluded_counts = Counter(day for day in local_dates if day in excluded)
    kept = [(t, r) for (t, r), day in zip(samples, local_dates) if day not in excluded]
    gaps, changes = [], []
    for index in range(1, len(samples)):
        earlier_day, later_day = local_dates[index - 1:index + 1]
        if any(earlier_day <= day <= later_day for day in excluded):
            continue
        earlier_t, earlier = samples[index - 1]
        later_t, later = samples[index]
        if earlier.get("telemetrySessionId") != later.get("telemetrySessionId"):
            continue
        gap = (later_t - earlier_t).total_seconds()
        if gap > 0:
            gaps.append(gap)
        # Tres minutos: discontinuidades mayores no se consideran fluctuaciones.
        if 0 < gap <= 180:
            changes.append(abs(later["levelLiters"] - earlier["levelLiters"]))
    values = [r["levelLiters"] for _, r in kept]
    return {
        "originalCount": len(rows),
        "excludedByLocalDate": {d.isoformat(): excluded_counts[d] for d in sorted(excluded)},
        "retainedCount": len(kept),
        "from": kept[0][1]["occurredAt"] if kept else None,
        "to": kept[-1][1]["occurredAt"] if kept else None,
        "minLiters": min(values) if values else None,
        "maxLiters": max(values) if values else None,
        "adjacentPairsUnder180Seconds": len(changes),
        "publicationGapSeconds": {key: observed_quantile(gaps, q) for key, q in (("p50", .5), ("p90", .9))},
        "absoluteChangeLiters": {key: observed_quantile(changes, q) for key, q in (("p50", .5), ("p90", .9), ("p99", .99), ("max", 1))},
    }


def analyze(payload: dict, excluded: set[date], zone: ZoneInfo) -> dict:
    boundaries = []
    for day in sorted(excluded):
        start = datetime.combine(day, datetime.min.time(), zone)
        end = datetime.combine(day + timedelta(days=1), datetime.min.time(), zone)
        boundaries.append({"fromInclusive": start.isoformat(), "toExclusive": end.isoformat()})
    return {
        "capturedAt": payload["capturedAt"],
        "timezone": str(zone),
        "excludedLocalDateIntervals": boundaries,
        "hasRawDiagnostics": payload["hasRawDiagnostics"],
        "note": "Cambios observados; incluyen operaciones reales. No son una estimación aislada del ruido del sensor.",
        "edge": summarize_series(payload["edgeLevels"], excluded, zone),
        "web": summarize_series(payload["webLevels"], excluded, zone),
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("input", type=Path)
    parser.add_argument("--timezone", default="America/Santiago")
    parser.add_argument("--exclude-local-date", action="append", type=date.fromisoformat, default=[])
    args = parser.parse_args()
    raw = args.input.read_bytes()
    result = analyze(json.loads(raw), set(args.exclude_local_date), ZoneInfo(args.timezone))
    result["sourceSha256"] = hashlib.sha256(raw).hexdigest()
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
