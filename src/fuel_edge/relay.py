"""Contrato de salida para el relé que habilita el contactor de la bomba."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Protocol


class PumpRelay(Protocol):
    """Puerto local; una implementación física debe fallar en estado desenergizado."""

    @property
    def is_energized(self) -> bool: ...

    def energize(self) -> None: ...

    def deenergize(self) -> None: ...


@dataclass(slots=True)
class MemoryPumpRelay:
    """Relé de simulación para desarrollo y pruebas."""

    _energized: bool = False

    @property
    def is_energized(self) -> bool:
        return self._energized

    def energize(self) -> None:
        self._energized = True

    def deenergize(self) -> None:
        self._energized = False
