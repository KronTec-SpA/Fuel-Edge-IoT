"""Salida de relé mediante python3-librpiplc de Industrial Shields."""

from __future__ import annotations

from collections import deque
from datetime import datetime, timezone
from math import isfinite
from statistics import median
from threading import Event, Lock, Thread
from time import monotonic, sleep
from typing import Any

from ..tank_level import TankLevelReading


class RelayIOError(RuntimeError):
    """La biblioteca del PLC rechazó una operación sobre el relé."""


class AnalogInputError(RuntimeError):
    """La entrada analógica no entregó una señal utilizable y segura."""


class PulseInputError(RuntimeError):
    """La entrada de pulsos K24 dejó de ser legible."""


class IndustrialShieldsRelay:
    """Controla un relé integrado y lo inicializa siempre en LOW.

    El equipo instalado es REF 012002000100, V6, con librpiplc 4.1.0 y
    python3-librpiplc 4.0.1. Se usa RPIPLC_V6, RPIPLC_19R y R0.1.
    """

    def __init__(
        self,
        pin: str = "R0.1",
        version: str = "RPIPLC_V6",
        model: str = "RPIPLC_19R",
        *,
        backend: Any | None = None,
    ) -> None:
        if backend is None:
            try:
                from librpiplc import rpiplc as backend
            except (ImportError, OSError) as exc:
                raise RelayIOError("python3-librpiplc no está disponible") from exc

        self._backend = backend
        self.pin = pin
        self.version = version
        self.model = model
        self._energized = False

        init_result = self._backend.init(self.version, self.model, restart=False)
        if init_result not in (0, 1):
            raise RelayIOError(f"falló rpiplc.init: rc={init_result}")
        self._require_success(
            self._backend.pin_mode(self.pin, self._backend.OUTPUT), "pin_mode"
        )
        # Estado seguro obligatorio antes de aceptar eventos de aplicación.
        self.deenergize()

    @property
    def is_energized(self) -> bool:
        """Estado ordenado al relé; no sustituye realimentación eléctrica."""
        return self._energized

    def energize(self) -> None:
        self._require_success(
            self._backend.digital_write(self.pin, self._backend.HIGH), "digital_write(HIGH)"
        )
        self._energized = True

    def deenergize(self) -> None:
        self._require_success(
            self._backend.digital_write(self.pin, self._backend.LOW), "digital_write(LOW)"
        )
        self._energized = False

    def close(self) -> None:
        """Deja LOW; no desinicializa globalmente otros canales del PLC."""
        self.deenergize()

    @staticmethod
    def _require_success(result: int, operation: str) -> None:
        if result != 0:
            raise RelayIOError(f"{operation} falló: rc={result}")


class IndustrialShieldsK24Reader:
    """Cuenta flancos del contacto Reed K24 en un hilo de alta frecuencia."""

    def __init__(
        self,
        *,
        pin: str,
        version: str,
        model: str,
        active_low: bool = True,
        poll_interval_milliseconds: float = 1.0,
        debounce_milliseconds: float = 1.5,
        backend: Any | None = None,
        autostart: bool = True,
    ) -> None:
        if backend is None:
            try:
                from librpiplc import rpiplc as backend
            except (ImportError, OSError) as exc:
                raise PulseInputError("python3-librpiplc no está disponible") from exc
        self._backend = backend
        self.pin = pin
        self.active_low = active_low
        self.poll_interval_seconds = poll_interval_milliseconds / 1000.0
        self.debounce_seconds = debounce_milliseconds / 1000.0
        self._lock = Lock()
        self._stop = Event()
        self._thread: Thread | None = None
        self._count = 0
        self._last_active = False
        self._last_pulse_at = float("-inf")
        self._error: BaseException | None = None

        init_result = self._backend.init(version, model, restart=False)
        if init_result not in (0, 1):
            raise PulseInputError(f"falló rpiplc.init: rc={init_result}")
        if self._backend.pin_mode(self.pin, self._backend.INPUT) != 0:
            raise PulseInputError("pin_mode del K24 falló")
        initial = self._read_active()
        self._last_active = initial
        if autostart:
            self.start()

    def start(self) -> None:
        if self._thread is not None:
            raise RuntimeError("el contador K24 ya está iniciado")
        self._thread = Thread(target=self._run, name="fuel-edge-k24", daemon=True)
        self._thread.start()

    def drain_pulses(self) -> int:
        with self._lock:
            if self._error is not None:
                raise PulseInputError("falló la lectura digital del K24") from self._error
            count = self._count
            self._count = 0
            return count

    def poll_once(self, now: float | None = None) -> bool:
        active = self._read_active()
        timestamp = monotonic() if now is None else now
        counted = False
        with self._lock:
            if active and not self._last_active and timestamp - self._last_pulse_at >= self.debounce_seconds:
                self._count += 1
                self._last_pulse_at = timestamp
                counted = True
            self._last_active = active
        return counted

    def close(self, timeout: float = 2.0) -> None:
        self._stop.set()
        if self._thread is not None:
            self._thread.join(timeout)
            if self._thread.is_alive():
                raise PulseInputError("el contador K24 no se detuvo")
            self._thread = None

    def _read_active(self) -> bool:
        value = self._backend.digital_read(self.pin)
        if value not in (0, 1):
            raise PulseInputError("digital_read del K24 devolvió un nivel inválido")
        return value == 0 if self.active_low else value == 1

    def _run(self) -> None:
        try:
            while not self._stop.is_set():
                self.poll_once()
                sleep(self.poll_interval_seconds)
        except BaseException as error:
            with self._lock:
                self._error = error


class IndustrialShieldsTankLevelReader:
    """Lee el OCIO en una entrada 0-10 V y lo escala a porcentaje y litros.

    En modo 4-20 mA la interfaz de campo debe convertir el lazo a 2-10 V.
    Esto conserva el cero vivo: una tensión inferior a 1.8 V se considera
    circuito abierto o falla, nunca un estanque vacío válido.
    """

    def __init__(
        self,
        *,
        pin: str,
        version: str,
        model: str,
        capacity_liters: float,
        signal_mode: str,
        input_empty_volts: float,
        input_full_volts: float,
        source_label: str | None = None,
        adc_full_scale: int = 4095,
        sample_count: int = 5,
        deadband_percent: float = 0.1,
        publish_interval_seconds: float = 60.0,
        stability_seconds: float = 0.0,
        stability_band_percent: float = 2.0,
        backend: Any | None = None,
        clock: Any = monotonic,
    ) -> None:
        if backend is None:
            try:
                from librpiplc import rpiplc as backend
            except (ImportError, OSError) as exc:
                raise AnalogInputError("python3-librpiplc no está disponible") from exc
        self._backend = backend
        self._clock = clock
        self.pin = pin
        self.capacity_liters = capacity_liters
        self.signal_mode = signal_mode
        self.source_label = source_label or (
            "OCIO 4-20 mA" if signal_mode == "4-20ma" else "OCIO 0-10 V"
        )
        self.input_empty_volts = input_empty_volts
        self.input_full_volts = input_full_volts
        self.adc_full_scale = adc_full_scale
        self.sample_count = sample_count
        self.deadband_percent = deadband_percent
        self.publish_interval_seconds = publish_interval_seconds
        self.stability_seconds = stability_seconds
        self.stability_band_percent = stability_band_percent
        self._stability_samples: deque[tuple[float, float]] = deque()
        self._last_percent: float | None = None
        self._last_published_at: float | None = None

        init_result = self._backend.init(version, model, restart=False)
        if init_result not in (0, 1):
            raise AnalogInputError(f"falló rpiplc.init: rc={init_result}")
        pin_result = self._backend.pin_mode(self.pin, self._backend.INPUT)
        if pin_result != 0:
            raise AnalogInputError(f"pin_mode falló: rc={pin_result}")

    def read_if_updated(self) -> TankLevelReading | None:
        samples = [self._read_raw() for _ in range(self.sample_count)]
        raw = float(median(samples))
        volts = raw * 10.0 / self.adc_full_scale

        if self.signal_mode == "4-20ma" and volts < 1.8:
            raise AnalogInputError("lazo OCIO abierto o bajo 3.6 mA")
        if volts < self.input_empty_volts:
            percent = 0.0
        elif volts > self.input_full_volts:
            percent = 100.0
        else:
            percent = (
                (volts - self.input_empty_volts)
                / (self.input_full_volts - self.input_empty_volts)
                * 100.0
            )

        now = float(self._clock())
        self._stability_samples.append((now, percent))
        if self.stability_seconds > 0:
            cutoff = now - self.stability_seconds
            # Conservar la muestra que cruza el borde de la ventana. Los ciclos
            # reales no caen exactamente en el mismo múltiplo del reloj; si se
            # eliminara también esa muestra, el intervalo quedaría siempre unas
            # milésimas por debajo de stability_seconds y nunca publicaría.
            while (
                len(self._stability_samples) > 1
                and self._stability_samples[1][0] <= cutoff
            ):
                self._stability_samples.popleft()
            window_span = now - self._stability_samples[0][0]
            window = [sample_percent for _, sample_percent in self._stability_samples]
            if (
                window_span < self.stability_seconds
                or max(window) - min(window) > self.stability_band_percent
            ):
                return None
            # Publicar el centro de la señal estable, no el último punto aislado.
            percent = float(median(window))
        else:
            self._stability_samples.clear()
        changed = (
            self._last_percent is None
            or abs(percent - self._last_percent) >= self.deadband_percent
        )
        due = (
            self._last_published_at is None
            or now - self._last_published_at >= self.publish_interval_seconds
        )
        if not changed and not due:
            return None
        self._last_percent = percent
        self._last_published_at = now
        liters = percent * self.capacity_liters / 100.0
        return TankLevelReading(
            level_liters=round(liters, 3),
            occurred_at=datetime.now(timezone.utc).isoformat(),
            source=self.source_label,
        )

    def _read_raw(self) -> float:
        try:
            value = float(self._backend.analog_read(self.pin))
        except Exception as exc:
            raise AnalogInputError("analog_read falló") from exc
        if not isfinite(value) or not 0 <= value <= self.adc_full_scale:
            raise AnalogInputError("lectura ADC fuera de rango")
        return value
