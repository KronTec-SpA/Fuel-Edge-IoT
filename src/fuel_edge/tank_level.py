"""Puente seguro y neutral para lecturas producidas por el adaptador OCIO."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
from math import isfinite
from pathlib import Path


@dataclass(frozen=True, slots=True)
class TankLevelReading:
    level_liters: float
    occurred_at: str
    source: str = "OCIO"
    min_liters: float | None = None
    max_liters: float | None = None
    calibration_id: str | None = None


class TankLevelFileReader:
    """Consume cada versión del archivo una sola vez sin seguir enlaces simbólicos."""

    def __init__(self, path: Path, capacity_liters: float) -> None:
        self.path = path
        self.capacity_liters = capacity_liters
        self._last_signature: tuple[int, int] | None = None

    def read_if_updated(self) -> TankLevelReading | None:
        try:
            stat = self.path.stat()
        except FileNotFoundError:
            return None
        if self.path.is_symlink() or not self.path.is_file():
            raise ValueError("la lectura de nivel debe ser un archivo regular")
        if stat.st_size > 64:
            raise ValueError("la lectura de nivel excede 64 bytes")
        signature = (stat.st_mtime_ns, stat.st_size)
        if signature == self._last_signature:
            return None
        self._last_signature = signature
        raw = self.path.read_text(encoding="ascii").strip()
        try:
            level = float(raw)
        except ValueError as error:
            raise ValueError("la lectura de nivel no es numérica") from error
        if not isfinite(level) or not 0 <= level <= self.capacity_liters:
            raise ValueError("la lectura de nivel está fuera de la capacidad del estanque")
        occurred_at = datetime.fromtimestamp(stat.st_mtime, timezone.utc).isoformat()
        return TankLevelReading(round(level, 3), occurred_at)
