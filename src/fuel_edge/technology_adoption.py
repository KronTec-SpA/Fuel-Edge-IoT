"""Sincronización durable de la política gradual de adopción tecnológica."""

from __future__ import annotations

from dataclasses import dataclass
import json
from threading import Event, Lock, Thread
from typing import Callable, Protocol
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

from .access import TechnologyAdoptionStage
from .config import WebSyncConfig
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
class TechnologyAdoptionPolicy:
    site_id: str
    stage: TechnologyAdoptionStage
    revision: int

    def __post_init__(self) -> None:
        if not self.site_id or self.revision <= 0:
            raise ValueError("política de adopción inválida")


class TechnologyAdoptionWeb(Protocol):
    def current_policy(self) -> TechnologyAdoptionPolicy: ...


class TechnologyAdoptionWebClient:
    def __init__(self, config: WebSyncConfig, sensor_key: str) -> None:
        self._base_url = config.base_url
        self._sensor_key = sensor_key
        self._timeout = config.request_timeout_seconds

    def current_policy(self) -> TechnologyAdoptionPolicy:
        request = Request(
            f"{self._base_url}/api/technology-adoption/edge/current",
            data=b"{}",
            method="POST",
            headers={
                "Content-Type": "application/json",
                "X-Edge-Sensor-Key": self._sensor_key,
                "User-Agent": "fuel-edge-technology-adoption/0.1",
            },
        )
        with urlopen(request, timeout=self._timeout) as response:
            raw = response.read(16 * 1024)
        body = json.loads(raw) if raw else {}
        policy = body.get("policy") if isinstance(body, dict) else None
        if not isinstance(policy, dict):
            raise ValueError("respuesta de adopción inválida")
        site_id = policy.get("siteId")
        stage = policy.get("stage")
        revision = policy.get("revision")
        if (
            not isinstance(site_id, str)
            or not isinstance(stage, str)
            or not isinstance(revision, int)
        ):
            raise ValueError("campos de política de adopción inválidos")
        return TechnologyAdoptionPolicy(
            site_id=site_id,
            stage=TechnologyAdoptionStage(stage),
            revision=revision,
        )


class TechnologyAdoptionCoordinator:
    """Actualiza el piso de evidencia sin intervenir una carga ya iniciada."""

    def __init__(
        self,
        web: TechnologyAdoptionWeb,
        service: FuelEdgeService,
        *,
        poll_seconds: float = 5.0,
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

    def start(self) -> None:
        with self._lock:
            if self._thread is not None:
                return
            self._thread = Thread(
                target=self._run,
                name="fuel-edge-technology-adoption",
                daemon=True,
            )
            self._thread.start()

    def close(self) -> None:
        self._stop.set()
        with self._lock:
            thread = self._thread
        if thread is not None:
            thread.join(timeout=3.0)

    def refresh(self) -> bool:
        policy = self.web.current_policy()
        if self.service.machine.site_id != policy.site_id:
            raise ValueError("la política de adopción pertenece a otro fundo")
        return self.service.update_technology_adoption_policy(
            policy.stage,
            policy.revision,
        ) is not None

    def _run(self) -> None:
        while not self._stop.is_set():
            try:
                self.refresh()
            except _EXPECTED_ERRORS as error:
                if self._on_error is not None:
                    self._on_error(error)
            if self._stop.wait(self.poll_seconds):
                break
