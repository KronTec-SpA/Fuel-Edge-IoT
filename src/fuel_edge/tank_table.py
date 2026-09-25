"""Curva BFM02500DG del manual Kingspan 4/2008, p. 27 (ES).

Valores aproximados del fabricante. La interpolación es una decisión de
software; no se extrapola ni se sustituye la curva por una geometría ideal.
Fuente y cotejo: docs/bfm02500dg-manual-4-2008.json.
"""

from bisect import bisect_left
from dataclasses import dataclass
from hashlib import sha256
from math import isfinite, floor


FM2500_POINTS = (
    (135.0, 182.0), (225.0, 363.0), (310.0, 545.0), (385.0, 726.0),
    (455.0, 908.0), (520.0, 1090.0), (605.0, 1271.0), (670.0, 1453.0),
    (740.0, 1634.0), (810.0, 1816.0), (890.0, 1998.0), (970.0, 2179.0),
    (1070.0, 2361.0), (1125.0, 2497.0),
)
FM2500_CURVE_ID = "kingspan-bfm02500dg-4-2008-linear-v1-" + sha256(repr(FM2500_POINTS).encode()).hexdigest()[:16]

# Aforo incremental informado por el operador, carga Copec del 09/09/2026.
# 869 L iniciales proceden de Kingspan; los incrementos los midió el surtidor.
# La última corrección del operador fija overflow en 1220 mm (no 1230 mm).
FIELD_CONVERSION = "fm2500_field_20260909"
FIELD_CAPACITY_LITERS = 2662.0
FIELD_FILL_POINTS = (
    (440.0, 869.0), (510.0, 1069.0), (580.0, 1269.0), (660.0, 1469.0),
    (730.0, 1669.0), (810.0, 1869.0), (890.0, 2069.0), (970.0, 2269.0),
    (1070.0, 2469.0), (1220.0, 2662.0),
)
FIELD_POINTS = tuple(p for p in FM2500_POINTS if p[0] < 440) + FIELD_FILL_POINTS
FIELD_CURVE_ID = "field-copec-20260909-linear-v1-" + sha256(repr(FIELD_POINTS).encode()).hexdigest()[:16]
HEIGHT_CONVERSIONS = {"fm2500_manufacturer", FIELD_CONVERSION}


def field_volume_liters(height_mm: float) -> float:
    """Interpolación por tramos; no extrapola bajo 135 mm ni sobre overflow."""
    if not isfinite(height_mm) or not FIELD_POINTS[0][0] <= height_mm <= FIELD_POINTS[-1][0]:
        raise ValueError("altura fuera de la tabla de terreno (135–1220 mm)")
    index = bisect_left([p[0] for p in FIELD_POINTS], height_mm)
    if FIELD_POINTS[index][0] == height_mm:
        return FIELD_POINTS[index][1]
    h0, v0 = FIELD_POINTS[index - 1]
    h1, v1 = FIELD_POINTS[index]
    return v0 + (v1-v0)*(height_mm-h0)/(h1-h0)


def table_volume_liters(conversion: str, height_mm: float) -> float:
    if conversion == FIELD_CONVERSION:
        # Aplicar sólo DESPUÉS del filtro temporal: reproducir la resolución de
        # 10 mm del OCIO sin presentar fluctuación subescalón del ADC como litros.
        # 1220 es un único punto de overflow, no una meseta 1220–1230 inventada.
        # La tolerancia de medio escalón sólo absorbe cuantización; no extrapola.
        if not isfinite(height_mm) or height_mm < 135 or height_mm >= 1225:
            raise ValueError("altura fuera del rango OCIO calibrado (135–1220 mm, resolución 10 mm)")
        return field_volume_liters(floor(height_mm/10+0.5)*10)
    if conversion == "fm2500_manufacturer":
        return fm2500_volume_liters(height_mm)
    raise ValueError("tabla de volumen desconocida")


def fm2500_volume_liters(height_mm: float) -> float:
    if not isfinite(height_mm) or not FM2500_POINTS[0][0] <= height_mm <= FM2500_POINTS[-1][0]:
        raise ValueError("altura fuera de la tabla BFM02500DG publicada (135–1125 mm)")
    index = bisect_left([p[0] for p in FM2500_POINTS], height_mm)
    if FM2500_POINTS[index][0] == height_mm:
        return FM2500_POINTS[index][1]
    h0, v0 = FM2500_POINTS[index - 1]
    h1, v1 = FM2500_POINTS[index]
    return v0 + (v1 - v0) * (height_mm - h0) / (h1 - h0)


@dataclass(frozen=True, slots=True)
class OcioHeightSignal:
    """Escalado confirmado de % de señal a altura; nunca % de volumen.

Los extremos son alturas correspondientes al cero y fondo eléctricos del
convertidor. No son necesariamente el fondo/techo físico del estanque.
"""

    output_mode: str = "unconfirmed"
    height_at_zero_percent_mm: float | None = None
    height_at_full_percent_mm: float | None = None

    def validate(self) -> None:
        low, high = self.height_at_zero_percent_mm, self.height_at_full_percent_mm
        if self.output_mode != "linear_height":
            raise ValueError("tabla BFM02500DG requiere confirmar salida OCIO lineal en altura")
        if low is None or high is None or not isfinite(low) or not isfinite(high) or not 0 <= low < high:
            raise ValueError("tabla BFM02500DG requiere extremos de altura de la señal confirmados")
        if low > FM2500_POINTS[0][0] or high < FM2500_POINTS[-1][0]:
            raise ValueError("el rango de altura de la señal debe cubrir la tabla publicada")

    def height_mm(self, percent: float) -> float:
        self.validate()
        if not isfinite(percent) or not 0 <= percent <= 100:
            raise ValueError("señal OCIO fuera de rango")
        return self.height_at_zero_percent_mm + percent / 100 * (
            self.height_at_full_percent_mm - self.height_at_zero_percent_mm
        )

    def calibration_metadata(self, conversion: str = "fm2500_manufacturer") -> dict:
        self.validate()
        return {"curveId": FIELD_CURVE_ID if conversion == FIELD_CONVERSION else FM2500_CURVE_ID,
                **({"heightResolutionMm": 10, "overflowHeightMm": 1220} if conversion == FIELD_CONVERSION else {}),
                "ocioOutputMode": self.output_mode,
                "heightAtZeroPercentMm": self.height_at_zero_percent_mm,
                "heightAtFullPercentMm": self.height_at_full_percent_mm}

    def signal_band_scale(self, conversion: str = "fm2500_manufacturer") -> float:
        """Convertir bandas en % de 2.500 L a % de señal, conservadoramente.

        La mayor pendiente publicada limita los litros que caben en una banda
        eléctrica a cualquier altura; no supone que altura y volumen sean lineales.
        """
        self.validate()
        points = FIELD_POINTS if conversion == FIELD_CONVERSION else FM2500_POINTS
        max_slope = max((v1-v0)/(h1-h0) for (h0,v0),(h1,v1) in zip(points, points[1:]))
        # Conservar las tolerancias históricas en litros (0,25 % = 6,25 L),
        # sin ampliarlas al aumentar la capacidad operativa a 2662 L.
        return 2500 / (max_slope * (self.height_at_full_percent_mm - self.height_at_zero_percent_mm))
