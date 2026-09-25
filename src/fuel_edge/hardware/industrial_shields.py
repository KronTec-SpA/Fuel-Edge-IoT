"""Salida de relé mediante python3-librpiplc de Industrial Shields."""

from __future__ import annotations

from collections import deque
from dataclasses import replace
from datetime import datetime, timezone
from hashlib import sha256
import json
from math import isfinite
from statistics import median
from threading import Event, Lock, Thread
from time import monotonic, sleep
from typing import Any

from ..tank_level import TankLevelReading
from ..tank_table import OcioHeightSignal, table_volume_liters, HEIGHT_CONVERSIONS, FIELD_CONVERSION, FIELD_CAPACITY_LITERS
from ..ocio_filter import OcioFilterConfig, OcioTemporalFilter, OcioRange


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
        stability_band_percent: float = 0.25,
        volume_conversion: str = "linear",
        ocio_height_signal: OcioHeightSignal = OcioHeightSignal(),
        ocio_calibration_pending: bool = False,
        cycle_filter: OcioFilterConfig | None = None,
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
        if volume_conversion not in {"linear", *HEIGHT_CONVERSIONS}:
            raise ValueError("conversión de volumen no soportada")
        if volume_conversion in HEIGHT_CONVERSIONS:
            expected_capacity = FIELD_CAPACITY_LITERS if volume_conversion == FIELD_CONVERSION else 2500
            if capacity_liters != expected_capacity:
                raise ValueError(f"{volume_conversion} requiere capacidad de {expected_capacity:g} L")
            ocio_height_signal.validate()
            if volume_conversion == FIELD_CONVERSION and ocio_height_signal.height_at_full_percent_mm < 1220:
                raise ValueError("la señal debe cubrir el overflow de 1220 mm")
        self.volume_conversion = volume_conversion
        self.ocio_height_signal = ocio_height_signal
        self.ocio_calibration_pending = ocio_calibration_pending
        if volume_conversion in HEIGHT_CONVERSIONS:
            # Mantener las bandas en litros al cambiar el significado de la
            # señal. 0,25 % de 4 m serían 10 mm y podrían ocultar unos 26 L.
            scale = ocio_height_signal.signal_band_scale(volume_conversion)
            self.deadband_percent *= scale
            self.stability_band_percent *= scale
            if cycle_filter:
                cycle_filter = replace(cycle_filter, band_percent=cycle_filter.band_percent * scale)
        calibration = {"conversion": volume_conversion, "capacity": capacity_liters,
                       "pin": pin, "signalMode": signal_mode,
                       "emptyVolts": input_empty_volts, "fullVolts": input_full_volts,
                       "adcFullScale": adc_full_scale}
        if volume_conversion in HEIGHT_CONVERSIONS:
            calibration.update(ocio_height_signal.calibration_metadata(volume_conversion))
        self.calibration_id = "level-" + sha256(json.dumps(calibration, sort_keys=True).encode()).hexdigest()
        self.signal_calibration_id = self.calibration_id
        self.confirmation_id: str | None = None
        self._stability_samples: deque[tuple[float, float]] = deque()
        self._last_percent: float | None = None
        self._last_published_at: float | None = None
        self._last_range: tuple[float, float] | None = None
        self._cycle_filter = OcioTemporalFilter(cycle_filter) if cycle_filter and cycle_filter.enabled else None
        self._last_sample_at: float | None = None
        self._diagnostics: list[dict] = []
        self._quality: dict | None = None
        self._quality_sent_at = -float("inf")
        self._quality_sent_status: str | None = None

        init_result = self._backend.init(version, model, restart=False)
        if init_result not in (0, 1):
            raise AnalogInputError(f"falló rpiplc.init: rc={init_result}")
        pin_result = self._backend.pin_mode(self.pin, self._backend.INPUT)
        if pin_result != 0:
            raise AnalogInputError(f"pin_mode falló: rc={pin_result}")

    def read_if_updated(self) -> TankLevelReading | None:
        now = float(self._clock())
        if (self._cycle_filter or self.ocio_calibration_pending) and self._last_sample_at is not None and now - self._last_sample_at < 1:
            return None
        self._last_sample_at = now
        try:
            samples = [self._read_raw() for _ in range(self.sample_count)]
        except AnalogInputError:
            self._quality = {"quality": "unavailable", "occurredAt": datetime.now(timezone.utc).isoformat()}
            if self._cycle_filter:
                self._cycle_filter.reset()
            self._stability_samples.clear()
            raise
        raw = float(median(samples))
        volts = raw * 10.0 / self.adc_full_scale

        if self.volume_conversion in HEIGHT_CONVERSIONS and not self.input_empty_volts <= volts <= self.input_full_volts:
            self._quality = {"quality": "unavailable", "occurredAt": datetime.now(timezone.utc).isoformat()}
            self._diagnostics.append({**self._quality, "rawAdc": raw, "volts": round(volts, 6), "calibrationId": self.calibration_id})
            self._diagnostics = self._diagnostics[-600:]
            if self._cycle_filter:
                self._cycle_filter.reset()
            self._stability_samples.clear()
            raise AnalogInputError("señal fuera del rango eléctrico confirmado para la tabla BFM02500DG")

        if self.signal_mode == "4-20ma" and volts < 1.8:
            self._quality = {"quality": "unavailable", "occurredAt": datetime.now(timezone.utc).isoformat()}
            self._diagnostics.append({**self._quality, "rawAdc": raw, "volts": round(volts, 6), "calibrationId": self.calibration_id})
            self._diagnostics = self._diagnostics[-600:]
            if self._cycle_filter:
                self._cycle_filter.reset()
            self._stability_samples.clear()
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

        if self.ocio_calibration_pending:
            # La tabla está seleccionada, pero aún no se verificó el significado
            # físico de la señal. Conservar ADC/filtro sin crear inventario válido.
            filtered = self._cycle_filter.add(now, percent) if self._cycle_filter else percent
            self._quality = {"quality": "calibration_pending", "occurredAt": datetime.now(timezone.utc).isoformat()}
            candidate_height = candidate_liters = None
            if isinstance(filtered, (int, float)) and self.volume_conversion in HEIGHT_CONVERSIONS:
                candidate_height = self.ocio_height_signal.height_mm(filtered)
                try:
                    candidate_liters = table_volume_liters(self.volume_conversion, candidate_height)
                except ValueError:
                    pass
            self._diagnostics.append({
                **self._quality, "rawAdc": raw, "volts": round(volts, 6),
                "rawPercent": round(percent, 6),
                "filterQuality": self._cycle_filter.status if self._cycle_filter else "unfiltered",
                "candidateHeightMm": candidate_height, "candidateVolumeLiters": candidate_liters,
                "volumeConversion": self.volume_conversion, "calibrationId": self.calibration_id,
            })
            self._diagnostics = self._diagnostics[-600:]
            return None

        if self._cycle_filter:
            filtered = self._cycle_filter.add(now, percent)
            self._quality = {"quality": self._cycle_filter.status, "occurredAt": datetime.now(timezone.utc).isoformat()}
            self._diagnostics.append({
                "occurredAt": datetime.now(timezone.utc).isoformat(),
                "rawAdc": raw, "volts": round(volts, 6),
                "rawPercent": round(percent, 6),
                "calibrationId": self.calibration_id,
                "acceptedPercent": filtered if isinstance(filtered, (int, float)) else None,
                "acceptedRange": {"low": filtered.low, "high": filtered.high} if isinstance(filtered, OcioRange) else None,
                "quality": self._cycle_filter.status,
                "support": round(self._cycle_filter.support, 4),
            })
            # También acotado si un consumidor externo no vacía el diagnóstico.
            self._diagnostics = self._diagnostics[-600:]
            if filtered is None:
                return None
            if isinstance(filtered, OcioRange):
                return self._publish_range(filtered, now)
            percent = filtered
            return self._publish(percent, now)
        self._quality = {"quality": "settling", "occurredAt": datetime.now(timezone.utc).isoformat()}
        self._diagnostics.append({**self._quality, "rawAdc": raw, "volts": round(volts, 6), "calibrationId": self.calibration_id})
        self._diagnostics = self._diagnostics[-600:]
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
        self._quality = {"quality": "valid", "occurredAt": datetime.now(timezone.utc).isoformat()}
        self._diagnostics[-1]["quality"] = "valid"
        return self._publish(percent, now)

    def confirm_calibration(self, confirmation_id: str) -> None:
        if self.confirmation_id == confirmation_id:
            return
        self.confirmation_id = confirmation_id
        self.ocio_calibration_pending = False
        self.calibration_id = 'level-' + sha256((self.signal_calibration_id+':'+confirmation_id).encode()).hexdigest()
        self._last_percent = self._last_published_at = self._last_range = None
        self._stability_samples.clear()
        if self._cycle_filter:
            self._cycle_filter.reset()
        self._quality = {"quality":"warming_up","occurredAt":datetime.now(timezone.utc).isoformat()}
        self._quality_sent_status = None

    def drain_diagnostics(self, *, force: bool = False) -> list[dict]:
        if len(self._diagnostics) < 30 and not force:
            return []
        result, self._diagnostics = self._diagnostics, []
        return result

    def quality_update(self) -> dict | None:
        now = float(self._clock())
        if not self._quality or (self._quality["quality"] == self._quality_sent_status and now-self._quality_sent_at < 5):
            return None
        self._quality_sent_at, self._quality_sent_status = now, self._quality["quality"]
        return dict(self._quality)

    def _publish(self, percent: float, now: float) -> TankLevelReading | None:
        # Validar antes de avanzar el estado de publicación. Una muestra fuera
        # de tabla no puede marcarse válida ni suprimir una recuperación posterior.
        liters = self._liters(percent)
        changed = (
            self._last_percent is None
            or self._last_range is not None
            or abs(percent - self._last_percent) >= self.deadband_percent
        )
        due = (
            self._last_published_at is None
            or now - self._last_published_at >= self.publish_interval_seconds
        )
        if not changed and not due:
            return None
        self._last_percent = percent
        self._last_range = None
        self._last_published_at = now
        return TankLevelReading(
            level_liters=round(liters, 3),
            occurred_at=datetime.now(timezone.utc).isoformat(),
            source=self.source_label,
            calibration_id=self.calibration_id,
        )

    def _liters(self, percent: float) -> float:
        if self.volume_conversion in HEIGHT_CONVERSIONS:
            try:
                height = self.ocio_height_signal.height_mm(percent)
                liters = table_volume_liters(self.volume_conversion, height)
                if self._diagnostics:
                    self._diagnostics[-1].update(acceptedHeightMm=height, acceptedVolumeLiters=liters,
                                                volumeConversion=self.volume_conversion)
                return liters
            except ValueError as error:
                self._quality = {"quality": "unavailable", "occurredAt": datetime.now(timezone.utc).isoformat()}
                if self._diagnostics:
                    self._diagnostics[-1]["quality"] = "unavailable"
                    self._diagnostics[-1]["conversionError"] = str(error)
                raise AnalogInputError(str(error)) from error
        return percent*self.capacity_liters/100

    def _publish_range(self, interval: OcioRange, now: float) -> TankLevelReading | None:
        low, high = round(self._liters(interval.low), 3), round(self._liters(interval.high), 3)
        if low == high:
            # Ambos grupos ADC pertenecen al mismo escalón físico de 10 mm.
            self._quality = {"quality": "valid", "occurredAt": datetime.now(timezone.utc).isoformat()}
            return self._publish((interval.low+interval.high)/2, now)
        bounds = (interval.low, interval.high)
        changed = self._last_range is None or any(abs(a-b) >= self.deadband_percent for a,b in zip(bounds, self._last_range))
        if not changed and self._last_published_at is not None and now-self._last_published_at < self.publish_interval_seconds:
            return None
        self._last_range, self._last_published_at = bounds, now
        return TankLevelReading((low+high)/2, datetime.now(timezone.utc).isoformat(), self.source_label, low, high, self.calibration_id)

    def _read_raw(self) -> float:
        try:
            value = float(self._backend.analog_read(self.pin))
        except Exception as exc:
            raise AnalogInputError("analog_read falló") from exc
        if not isfinite(value) or not 0 <= value <= self.adc_full_scale:
            raise AnalogInputError("lectura ADC fuera de rango")
        return value
