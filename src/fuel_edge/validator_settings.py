"""Sincroniza la calibración Bluetooth local con el validador por MQTT/TLS."""

from __future__ import annotations

from dataclasses import dataclass
import json
from threading import Event, Thread
from time import monotonic
from typing import Callable, Protocol
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

from .config import WebSyncConfig


@dataclass(frozen=True, slots=True)
class BluetoothSettings:
    rssi_threshold: int
    revision: int

    def __post_init__(self) -> None:
        if not -100 <= self.rssi_threshold <= -35:
            raise ValueError("rssi_threshold debe estar entre -100 y -35 dBm")
        if self.revision < 1:
            raise ValueError("revision Bluetooth inválida")


class ValidatorConfigTransport(Protocol):
    def publish_runtime_config(
        self, validator_id: str, rssi_threshold: int, revision: int
    ) -> None: ...

    def set_config_status_handler(
        self, handler: Callable[[str, int, int], None]
    ) -> None: ...


class ValidatorSettingsWebClient:
    def __init__(self, config: WebSyncConfig, sensor_key: str) -> None:
        self._base_url = config.base_url
        self._sensor_key = sensor_key
        self._timeout = config.request_timeout_seconds

    def current(self) -> BluetoothSettings:
        body = self._request("/api/system-settings/bluetooth/current", {})
        settings = body.get("settings")
        if not isinstance(settings, dict):
            raise ValueError("configuración Bluetooth local inválida")
        return BluetoothSettings(
            rssi_threshold=int(settings.get("rssiThreshold")),
            revision=int(settings.get("revision")),
        )

    def applied(self, settings: BluetoothSettings) -> None:
        self._request("/api/system-settings/bluetooth/applied", {
            "rssiThreshold": settings.rssi_threshold,
            "revision": settings.revision,
        })

    def observation(self, module_id: str, rssi: int) -> None:
        self._request("/api/system-settings/bluetooth/observation", {
            "moduleId": module_id,
            "rssi": rssi,
        })

    def _request(self, path: str, payload: dict[str, object]) -> dict[str, object]:
        encoded = json.dumps(payload, separators=(",", ":")).encode("utf-8")
        request = Request(
            f"{self._base_url}{path}",
            data=encoded,
            method="POST",
            headers={
                "Content-Type": "application/json",
                "X-Edge-Sensor-Key": self._sensor_key,
                "User-Agent": "fuel-edge-validator-settings/0.2",
            },
        )
        with urlopen(request, timeout=self._timeout) as response:
            decoded = json.loads(response.read(16 * 1024))
        if not isinstance(decoded, dict):
            raise ValueError("respuesta de calibración Bluetooth inválida")
        return decoded


class ValidatorSettingsCoordinator:
    def __init__(
        self,
        web: ValidatorSettingsWebClient,
        transport: ValidatorConfigTransport,
        validator_id: str,
        *,
        poll_seconds: float = 2.0,
        on_error: Callable[[BaseException], None] | None = None,
    ) -> None:
        self.web = web
        self.transport = transport
        self.validator_id = validator_id
        self.poll_seconds = poll_seconds
        self._on_error = on_error
        self._stop = Event()
        self._thread: Thread | None = None
        self._last_published: BluetoothSettings | None = None
        self._last_publish_at = 0.0
        self.transport.set_config_status_handler(self._applied)

    def start(self) -> None:
        if self._thread is not None:
            raise RuntimeError("la sincronización Bluetooth ya está iniciada")
        self._thread = Thread(target=self._run, name="fuel-edge-validator-settings", daemon=True)
        self._thread.start()

    def close(self, timeout: float = 5.0) -> None:
        self._stop.set()
        if self._thread is not None:
            self._thread.join(timeout)
            if self._thread.is_alive():
                raise RuntimeError("la sincronización Bluetooth no se detuvo a tiempo")
            self._thread = None

    def refresh(self) -> BluetoothSettings:
        settings = self.web.current()
        now = monotonic()
        if settings != self._last_published or now - self._last_publish_at >= 10.0:
            self.transport.publish_runtime_config(
                self.validator_id, settings.rssi_threshold, settings.revision
            )
            self._last_published = settings
            self._last_publish_at = now
        return settings

    def record_observation(self, module_id: str, rssi: int) -> None:
        try:
            self.web.observation(module_id, rssi)
        except (HTTPError, URLError, OSError, TimeoutError, TypeError, ValueError) as error:
            self._report(error)

    def _applied(self, validator_id: str, rssi_threshold: int, revision: int) -> None:
        if validator_id != self.validator_id:
            return
        try:
            self.web.applied(BluetoothSettings(rssi_threshold, revision))
        except (HTTPError, URLError, OSError, TimeoutError, TypeError, ValueError) as error:
            self._report(error)

    def _run(self) -> None:
        while not self._stop.is_set():
            try:
                self.refresh()
            except (HTTPError, URLError, OSError, TimeoutError, TypeError, ValueError, RuntimeError) as error:
                self._report(error)
            self._stop.wait(self.poll_seconds)

    def _report(self, error: BaseException) -> None:
        if self._on_error is not None:
            self._on_error(error)
