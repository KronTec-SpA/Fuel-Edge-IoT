"""Filtro temporal de la señal OCIO; no supone una fase fija del compresor."""

from collections import deque
from dataclasses import dataclass
from math import isfinite
from statistics import median


@dataclass(frozen=True)
class OcioFilterConfig:
    enabled: bool = True
    window_seconds: float = 120.0
    quiet_seconds: float = 15.0
    band_percent: float = 0.25
    support_fraction: float = 0.8

    def __post_init__(self):
        if not isinstance(self.enabled, bool):
            raise ValueError("cycle_filter_enabled debe ser boolean")
        if not all(isfinite(v) for v in (self.window_seconds, self.quiet_seconds,
                                         self.band_percent, self.support_fraction)):
            raise ValueError("parámetros del filtro OCIO deben ser finitos")
        if not 30 <= self.window_seconds <= 600:
            raise ValueError("cycle_window_seconds debe estar entre 30 y 600")
        if not 5 <= self.quiet_seconds <= self.window_seconds / 2:
            raise ValueError("cycle_quiet_seconds debe estar entre 5 y media ventana")
        if not 0 < self.band_percent <= 0.5:
            raise ValueError("cycle_band_percent debe estar entre 0 y 0.5")
        if not 0.75 <= self.support_fraction <= 1:
            raise ValueError("cycle_support_fraction debe estar entre 0.75 y 1")


@dataclass(frozen=True)
class OcioRange:
    low: float
    high: float


class OcioTemporalFilter:
    SAMPLE_SECONDS = 1.0
    MAX_GAP_SECONDS = 2.5

    def __init__(self, config: OcioFilterConfig):
        self.config = config
        self.samples: deque[tuple[float, float]] = deque()
        self.status = "warming_up"
        self.support = 0.0

    def reset(self):
        self.samples.clear()
        self.status = "warming_up"
        self.support = 0.0

    def add(self, at: float, percent: float) -> float | OcioRange | None:
        if self.samples and at - self.samples[-1][0] < self.SAMPLE_SECONDS:
            return None  # muchas llamadas juntas no dan evidencia temporal
        if self.samples and at - self.samples[-1][0] > self.MAX_GAP_SECONDS:
            self.reset()  # una pausa no equivale a señal estable
        self.samples.append((at, percent))
        cutoff = at - self.config.window_seconds
        while len(self.samples) > 1 and self.samples[1][0] <= cutoff:
            self.samples.popleft()
        if at - self.samples[0][0] < self.config.window_seconds:
            self.status = "warming_up"
            return None
        # Exigir cobertura además de duración; evita inventar una ventana con
        # unos pocos puntos separados por pausas del controlador.
        if len(self.samples) < 0.9 * (self.config.window_seconds / self.SAMPLE_SECONDS):
            self.status = "insufficient_coverage"
            return None
        ordered = sorted(value for _, value in self.samples)
        left, best = 0, []
        for right, value in enumerate(ordered):
            while value - ordered[left] > self.config.band_percent:
                left += 1
            if right - left + 1 > len(best):
                best = ordered[left:right+1]
        self.support = len(best) / len(ordered)
        if self.support < self.config.support_fraction:
            remaining = [v for v in ordered if v < best[0] or v > best[-1]]
            left, second = 0, []
            for right, value in enumerate(remaining):
                while value - remaining[left] > self.config.band_percent:
                    left += 1
                if right-left+1 > len(second):
                    second = remaining[left:right+1]
            groups = sorted([best, second], key=lambda g: g[0] if g else float("inf"))
            if second and min(len(best), len(second))/len(ordered) >= 0.2 and (
                len(best)+len(second))/len(ordered) >= self.config.support_fraction:
                def group(value):
                    for index, values in enumerate(groups):
                        if values[0] <= value <= values[-1]:
                            return index
                    return None
                sequence = [group(v) for _, v in self.samples]
                members = [g for g in sequence if g is not None]
                switches = sum(a != b for a, b in zip(members, members[1:]))
                recent = [group(v) for t, v in self.samples if t >= at-self.config.quiet_seconds]
                # Dos mesetas que alternan varias veces, no la mezcla temporal
                # de un único descenso/llenado. Una tercera excursión de aire
                # sigue bloqueando la publicación hasta terminar el reposo.
                if switches >= 3 and all(g is not None for g in recent):
                    self.status = "range"
                    self.support = (len(best)+len(second))/len(ordered)
                    return OcioRange(groups[0][0], groups[1][-1])
            self.status = "ambiguous_levels"
            return None
        candidate = float(median(best))
        quiet = [value for time, value in self.samples if time >= at - self.config.quiet_seconds]
        # El último punto, y todo el tramo de reposo, deben pertenecer a la
        # meseta elegida: no publicar la mediana vieja mientras está subiendo,
        # cayendo o en el pulso de presión.
        if any(abs(value-candidate) > self.config.band_percent / 2 for value in quiet):
            self.status = "settling"
            return None
        self.status = "valid"
        return candidate
