"""Presentación de volúmenes; nunca modifica las mediciones almacenadas."""

from decimal import Decimal, ROUND_CEILING, ROUND_FLOOR, ROUND_HALF_UP


def format_liters_cl(liters: float, *, bound: str | None = None) -> str:
    """Un decimal, empate alejándose de cero; intervalos hacia afuera."""
    value = Decimal(str(liters))
    if not value.is_finite():
        return "—"
    rounding = {None: ROUND_HALF_UP, "lower": ROUND_FLOOR, "upper": ROUND_CEILING}[bound]
    rounded = value.quantize(Decimal("0.1"), rounding=rounding)
    if rounded == 0:
        rounded = abs(rounded)
    return f"{rounded:,.1f}".translate(str.maketrans({",": ".", ".": ","}))
