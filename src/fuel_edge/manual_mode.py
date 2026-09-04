"""Programación de modo manual solicitada por la aplicación web local."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
import json
from threading import Event, Lock, Thread
from typing import Callable, Protocol
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

from .config import WebSyncConfig
from .domain import EdgeState
from .service import FuelEdgeService


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
class ManualModeSchedule:
    schedule_id: str
    start_at: datetime
    end_at: datetime
    desired_active: bool
    status: str
    purpose: str = "manual"

    def __post_init__(self) -> None:
        if not self.schedule_id:
            raise ValueError("programación manual sin identificador")
        for value in (self.start_at, self.end_at):
            if value.tzinfo is None or value.utcoffset() is None:
                raise ValueError("las fechas del modo manual requieren zona horaria")
        if self.end_at <= self.start_at:
            raise ValueError("ventana de modo manual inválida")
        if self.purpose not in {"manual", "adoption_assisted"}:
            raise ValueError("propósito de modo manual inválido")


class ManualModeWeb(Protocol):
    def current_schedule(self) -> ManualModeSchedule | None: ...

    def report_state(
        self,
        schedule_id: str,
        state: str,
        error: str | None = None,
    ) -> None: ...


class ManualModeWebClient:
    def __init__(self, config: WebSyncConfig, sensor_key: str) -> None:
        self._base_url = config.base_url
        self._sensor_key = sensor_key
        self._timeout = config.request_timeout_seconds

    def current_schedule(self) -> ManualModeSchedule | None:
        body = self._request("/api/manual-mode/edge/current", {})
        schedule = body.get("schedule")
        if schedule is None:
            return None
        if not isinstance(schedule, dict):
            raise ValueError("programación de modo manual inválida")
        schedule_id = schedule.get("id")
        start_at = schedule.get("startAt")
        end_at = schedule.get("endAt")
        desired = schedule.get("desiredActive")
        status = schedule.get("status")
        purpose = schedule.get("purpose", "manual")
        if (
            not isinstance(schedule_id, str)
            or not isinstance(start_at, str)
            or not isinstance(end_at, str)
            or not isinstance(desired, bool)
            or not isinstance(status, str)
            or not isinstance(purpose, str)
        ):
            raise ValueError("campos de programación manual inválidos")
        return ManualModeSchedule(
            schedule_id=schedule_id,
            start_at=datetime.fromisoformat(start_at.replace("Z", "+00:00")),
            end_at=datetime.fromisoformat(end_at.replace("Z", "+00:00")),
            desired_active=desired,
            status=status,
            purpose=purpose,
        )

    def report_state(
        self,
        schedule_id: str,
        state: str,
        error: str | None = None,
    ) -> None:
        payload: dict[str, object] = {"state": state}
        if error:
            payload["error"] = error
        self._request(
            f"/api/manual-mode/edge/{schedule_id}/state",
            payload,
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
                "User-Agent": "fuel-edge-manual-mode/0.1",
            },
        )
        with urlopen(request, timeout=self._timeout) as response:
            raw = response.read(16 * 1024)
        decoded = json.loads(raw) if raw else {}
        if not isinstance(decoded, dict):
            raise ValueError("respuesta de modo manual inválida")
        return decoded


class ManualModeCoordinator:
    """Reconcilia la ventana web con el relé físico sin cederle autoridad."""

    def __init__(
        self,
        web: ManualModeWeb,
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
        self._last_active_schedule_id: str | None = None

    def start(self) -> None:
        with self._lock:
            if self._thread is not None:
                return
            self._thread = Thread(
                target=self._run,
                name="fuel-edge-manual-mode",
                daemon=True,
            )
            self._thread.start()

    def close(self) -> None:
        self._stop.set()
        self.service.stop_manual_mode("service_stopping")
        with self._lock:
            thread = self._thread
        if thread is not None:
            thread.join(timeout=3.0)

    def refresh(self) -> bool:
        schedule = self.web.current_schedule()
        local_id = self.service.machine.manual_mode_schedule_id
        if schedule is not None and schedule.desired_active:
            if (
                self.service.machine.state is EdgeState.MANUAL_MODE
                and local_id == schedule.schedule_id
            ):
                self._last_active_schedule_id = schedule.schedule_id
                if schedule.status == "scheduled":
                    self.web.report_state(schedule.schedule_id, "active")
                    return True
                return False
            if self.service.machine.state is EdgeState.MANUAL_MODE:
                self.service.stop_manual_mode("schedule_replaced")
            self.service.start_manual_mode(
                schedule.schedule_id,
                ends_at=schedule.end_at.astimezone(timezone.utc),
                purpose=schedule.purpose,
            )
            self._last_active_schedule_id = schedule.schedule_id
            self.web.report_state(schedule.schedule_id, "active")
            return True

        completed_id = local_id or self._last_active_schedule_id
        if self.service.machine.state is EdgeState.MANUAL_MODE:
            reason = "cancelled" if schedule is None else "scheduled_end"
            self.service.stop_manual_mode(reason)
        if completed_id is not None:
            self.web.report_state(completed_id, "completed")
            self._last_active_schedule_id = None
            return True
        return False

    def _run(self) -> None:
        while not self._stop.is_set():
            try:
                self.refresh()
            except _EXPECTED_ERRORS as error:
                if self._on_error is not None:
                    self._on_error(error)
            if self._stop.wait(self.poll_seconds):
                break
