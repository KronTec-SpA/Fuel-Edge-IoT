"""Entrega durable de telemetría edge al aplicativo web local."""

from __future__ import annotations

import json
from time import monotonic
from threading import Event, Thread
from typing import Callable
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

from .config import WebSyncConfig
from .storage import EventStore


WEB_TOPICS = (
    "web/fuel-movement",
    "web/level-reading",
    "web/alert",
    "web/status",
    "web/power-event",
)
ENDPOINTS = {
    "web/fuel-movement": "/api/fuel-history/movements",
    "web/level-reading": "/api/fuel-history/readings",
    "web/alert": "/api/alerts/edge",
    "web/status": "/api/fuel-history/status",
    "web/power-event": "/api/system-settings/power-events/edge",
}


class WebSyncWorker:
    """Vacía sólo la cola web; los eventos quedan pendientes durante caídas."""

    def __init__(
        self,
        store: EventStore,
        config: WebSyncConfig,
        sensor_key: str,
        on_error: Callable[[BaseException], None] | None = None,
    ) -> None:
        if len(sensor_key) < 24:
            raise ValueError("la clave de sincronización web es demasiado corta")
        self.store = store
        self.config = config
        self._sensor_key = sensor_key
        self._stop = Event()
        self._wake = Event()
        self._thread: Thread | None = None
        self._on_error = on_error
        self._next_prune_at = 0.0

    def start(self) -> None:
        if self._thread is not None:
            raise RuntimeError("la sincronización web ya está iniciada")
        self._thread = Thread(target=self._run, name="fuel-edge-web-sync", daemon=True)
        self._thread.start()

    def wake(self) -> None:
        self._wake.set()

    def close(self, timeout: float = 5.0) -> None:
        self._stop.set()
        self._wake.set()
        if self._thread is not None:
            self._thread.join(timeout)
            if self._thread.is_alive():
                raise RuntimeError("la sincronización web no se detuvo a tiempo")
            self._thread = None

    def run_once(self) -> int:
        if monotonic() >= self._next_prune_at:
            self.store.prune_outbox()
            self._next_prune_at = monotonic() + 24 * 60 * 60
        delivered = 0
        for event_id, topic, payload in self.store.pending(WEB_TOPICS, limit=100):
            try:
                self._deliver(topic, payload)
            except HTTPError as error:
                status = int(error.code)
                if status in {400, 404, 405, 413, 422}:
                    self.store.mark_failed(event_id, f"http_{status}")
                else:
                    self.store.mark_retry(event_id, f"http_{status}", self.config.retry_seconds)
            except (URLError, TimeoutError, OSError) as error:
                self.store.mark_retry(
                    event_id,
                    f"transport_{type(error).__name__}",
                    self.config.retry_seconds,
                )
            except (TypeError, ValueError) as error:
                self.store.mark_failed(event_id, f"payload_{type(error).__name__}")
            else:
                self.store.mark_sent(event_id)
                delivered += 1
        return delivered

    def _run(self) -> None:
        while not self._stop.is_set():
            try:
                self.run_once()
            except BaseException as error:
                if isinstance(error, (KeyboardInterrupt, SystemExit)):
                    raise
                if self._on_error is not None:
                    self._on_error(error)
            self._wake.wait(self.config.retry_seconds)
            self._wake.clear()

    def _deliver(self, topic: str, payload: dict[str, object]) -> None:
        endpoint = ENDPOINTS.get(topic)
        if endpoint is None:
            raise ValueError(f"topic web no soportado: {topic}")
        encoded = json.dumps(payload, separators=(",", ":"), sort_keys=True).encode("utf-8")
        if len(encoded) > 64 * 1024:
            raise ValueError("payload web excede 64 KiB")
        request = Request(
            f"{self.config.base_url}{endpoint}",
            data=encoded,
            method="POST",
            headers={
                "Content-Type": "application/json",
                "X-Edge-Sensor-Key": self._sensor_key,
                "User-Agent": "fuel-edge/0.1",
            },
        )
        with urlopen(request, timeout=self.config.request_timeout_seconds) as response:
            if not 200 <= response.status < 300:
                raise HTTPError(request.full_url, response.status, "respuesta inválida", response.headers, None)
            response.read(4096)


def read_web_sensor_key(path) -> str:
    if path.is_symlink():
        raise PermissionError("web_sync.sensor_key_path no puede ser un enlace simbólico")
    stat = path.stat()
    if stat.st_mode & 0o077:
        raise PermissionError("web_sync.sensor_key_path debe tener permisos 0600")
    if not path.is_file():
        raise PermissionError("web_sync.sensor_key_path debe ser un archivo regular")
    value = path.read_text(encoding="utf-8").strip()
    if len(value) < 24 or len(value) > 256:
        raise ValueError("web_sync.sensor_key_path contiene una clave inválida")
    return value
