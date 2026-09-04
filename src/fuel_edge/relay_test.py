"""Prueba de mantenimiento de R0.1 solicitada por la web local."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
import json
from threading import Event, Lock, Thread
from typing import Callable, Protocol
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

from .config import WebSyncConfig
from .domain import (
    PUMP_TEST_DEFAULT_DURATION_SECONDS,
    PUMP_TEST_MAX_DURATION_SECONDS,
    PUMP_TEST_MIN_DURATION_SECONDS,
)
from .service import (
    FuelEdgeService,
    RelayTestResult,
)


_EXPECTED_ERRORS = (
    HTTPError,
    URLError,
    OSError,
    RuntimeError,
    TimeoutError,
    TypeError,
    ValueError,
)


@dataclass(frozen=True, slots=True)
class RelayTestCommand:
    command_id: str
    duration_seconds: int = PUMP_TEST_DEFAULT_DURATION_SECONDS

    def __post_init__(self) -> None:
        if not self.command_id:
            raise ValueError("comando de prueba de relé sin identificador")
        if not PUMP_TEST_MIN_DURATION_SECONDS <= self.duration_seconds <= PUMP_TEST_MAX_DURATION_SECONDS:
            raise ValueError("duración de prueba de bomba inválida")


class RelayTestWeb(Protocol):
    def next_command(self) -> RelayTestCommand | None: ...

    def result(self, command_id: str, result: RelayTestResult) -> None: ...


class RelayTestWebClient:
    def __init__(self, config: WebSyncConfig, sensor_key: str) -> None:
        self._base_url = config.base_url
        self._sensor_key = sensor_key
        self._timeout = config.request_timeout_seconds

    def next_command(self) -> RelayTestCommand | None:
        body = self._request("/api/relay-test/commands/next", {})
        command = body.get("command")
        if command is None:
            return None
        if not isinstance(command, dict):
            raise ValueError("comando de prueba de relé inválido")
        command_id = command.get("id")
        duration = command.get("durationSeconds")
        if not isinstance(command_id, str) or not isinstance(duration, int):
            raise ValueError("campos de prueba de relé inválidos")
        return RelayTestCommand(command_id, duration)

    def result(self, command_id: str, result: RelayTestResult) -> None:
        self._request(
            f"/api/relay-test/commands/{command_id}/result",
            {
                "success": result.success,
                "error": result.error,
                "startedAt": result.started_at,
                "completedAt": result.completed_at,
            },
        )

    def _request(self, path: str, payload: dict[str, object]) -> dict[str, object]:
        encoded = json.dumps(payload, separators=(",", ":")).encode("utf-8")
        request = Request(
            f"{self._base_url}{path}",
            data=encoded,
            method="POST",
            headers={
                "Content-Type": "application/json",
                "X-Edge-Sensor-Key": self._sensor_key,
                "User-Agent": "fuel-edge-relay-test/0.1",
            },
        )
        with urlopen(request, timeout=self._timeout) as response:
            raw = response.read(16 * 1024)
        decoded = json.loads(raw) if raw else {}
        if not isinstance(decoded, dict):
            raise ValueError("respuesta de prueba de relé inválida")
        return decoded


class RelayTestCoordinator:
    """Sondea comandos, los ejecuta localmente y reintenta entregar el resultado."""

    def __init__(
        self,
        web: RelayTestWeb,
        service: FuelEdgeService,
        *,
        poll_seconds: float = 1.0,
        on_error: Callable[[BaseException], None] | None = None,
    ) -> None:
        if poll_seconds <= 0:
            raise ValueError("poll_seconds debe ser positivo")
        self.web = web
        self.service = service
        self.poll_seconds = poll_seconds
        self._on_error = on_error
        self._stop = Event()
        self._lock = Lock()
        self._thread: Thread | None = None
        self._pending_result: tuple[str, RelayTestResult] | None = None

    def start(self) -> None:
        with self._lock:
            if self._thread is not None:
                return
            self._thread = Thread(
                target=self._run,
                name="fuel-edge-relay-test",
                daemon=True,
            )
            self._thread.start()

    def close(self) -> None:
        self._stop.set()
        self.service.abort_relay_test("service_stopping")
        with self._lock:
            thread = self._thread
        if thread is not None:
            thread.join(timeout=3.0)

    def refresh(self) -> bool:
        """Procesa a lo sumo un resultado o un comando; útil también en pruebas."""

        pending = self._pending_result
        if pending is not None:
            self.web.result(*pending)
            self._pending_result = None
            return True
        command = self.web.next_command()
        if command is None:
            return False
        try:
            result = self.service.run_relay_test(
                command.command_id,
                duration_seconds=command.duration_seconds,
                stop_event=self._stop,
            )
        except _EXPECTED_ERRORS as error:
            now = datetime.now(timezone.utc).isoformat()
            result = RelayTestResult(
                success=False,
                error=str(error)[:200] or type(error).__name__,
                started_at=now,
                completed_at=now,
            )
        self._pending_result = (command.command_id, result)
        try:
            self.web.result(command.command_id, result)
        except _EXPECTED_ERRORS:
            raise
        else:
            self._pending_result = None
        return True

    def _run(self) -> None:
        while not self._stop.is_set():
            try:
                self.refresh()
            except _EXPECTED_ERRORS as error:
                if self._on_error is not None:
                    self._on_error(error)
            if self._stop.wait(self.poll_seconds):
                break
