"""Gemelo geométrico FM2500: cilindro horizontal y dos fondos semielipsoidales.

Las cotas proceden del plano interior; la forma elipsoidal de los fondos y
la normalización a capacidad nominal son hipótesis, no un aforo certificado.
"""

from __future__ import annotations

from dataclasses import dataclass
from math import acos, isfinite, pi, sqrt


@dataclass(frozen=True, slots=True)
class HorizontalTankGeometry:
    diameter_mm: float = 1255.0
    straight_length_mm: float = 1924.0
    overall_length_mm: float = 2260.0
    nominal_capacity_liters: float = 2500.0

    def __post_init__(self) -> None:
        if not all(isfinite(v) and v > 0 for v in (
            self.diameter_mm, self.straight_length_mm,
            self.overall_length_mm, self.nominal_capacity_liters,
        )) or self.overall_length_mm < self.straight_length_mm:
            raise ValueError("geometría de estanque inválida")

    @property
    def radius_mm(self) -> float:
        return self.diameter_mm / 2

    @property
    def head_depth_mm(self) -> float:
        return (self.overall_length_mm - self.straight_length_mm) / 2

    @property
    def geometric_capacity_liters(self) -> float:
        return pi * self.radius_mm**2 * (
            self.straight_length_mm + 4 * self.head_depth_mm / 3
        ) / 1_000_000

    def volume_liters(self, height_mm: float, *, normalized: bool = True) -> float:
        """h desde el fondo; rechazar alturas imposibles, nunca saturarlas."""
        if not isfinite(height_mm) or not 0 <= height_mm <= self.diameter_mm:
            raise ValueError("nivel fuera de la altura del estanque")
        r, h = self.radius_mm, height_mm
        area = r*r * acos((r-h)/r) - (r-h) * sqrt(max(0, 2*r*h-h*h))
        heads = pi * self.head_depth_mm * (h*h - h*h*h/(3*r))
        volume = (self.straight_length_mm * area + heads) / 1_000_000
        if normalized:
            volume *= self.nominal_capacity_liters / self.geometric_capacity_liters
        return volume

    def height_mm(self, liters: float, *, normalized: bool = True) -> float:
        capacity = self.nominal_capacity_liters if normalized else self.geometric_capacity_liters
        if not isfinite(liters) or not 0 <= liters <= capacity:
            raise ValueError("volumen fuera de capacidad")
        if liters == 0:
            return 0.0
        if liters == capacity:
            return self.diameter_mm
        low, high = 0.0, self.diameter_mm
        for _ in range(60):
            mid = (low + high) / 2
            if self.volume_liters(mid, normalized=normalized) < liters:
                low = mid
            else:
                high = mid
        return (low + high) / 2

    def liters_per_mm(self, height_mm: float, *, normalized: bool = True) -> float:
        # Validar con el mismo dominio que el volumen.
        self.volume_liters(height_mm, normalized=normalized)
        r, h = self.radius_mm, height_mm
        derivative = (2*self.straight_length_mm*sqrt(max(0, 2*r*h-h*h))
                      + pi*self.head_depth_mm*(2*h-h*h/r)) / 1_000_000
        if normalized:
            derivative *= self.nominal_capacity_liters / self.geometric_capacity_liters
        return derivative

    def ocio_volume_liters(self, signal_percent: float, *, output_mode: str) -> float:
        """Manual PIUSI 018280000: con estanque => %; sin estanque => 0–4 m.

        Elegir el modo sólo después de verificar el equipo en terreno. Esta
        función no cambia la calibración activa ni supone cuál está instalado.
        """
        if not isfinite(signal_percent) or not 0 <= signal_percent <= 100:
            raise ValueError("señal OCIO fuera de rango")
        if output_mode == "configured_tank_volume":
            return signal_percent * self.nominal_capacity_liters / 100
        if output_mode == "configured_horizontal_cylinder":
            # Deshacer exclusivamente la curva del cilindro que aplica OCIO;
            # luego aplicar el modelo con fondos. No interpretar % como altura.
            cylinder = HorizontalTankGeometry(
                self.diameter_mm, self.straight_length_mm,
                self.straight_length_mm, self.nominal_capacity_liters,
            )
            height = cylinder.height_mm(signal_percent * self.nominal_capacity_liters / 100)
            return self.volume_liters(height)
        if output_mode == "unconfigured_height_4000mm":
            return self.volume_liters(signal_percent * 40)
        raise ValueError("modo de salida OCIO no confirmado")
