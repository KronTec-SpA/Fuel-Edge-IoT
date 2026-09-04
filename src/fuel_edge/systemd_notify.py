"""Notificaciones mínimas de disponibilidad y watchdog para systemd.

No se depende de ``python-systemd`` porque la imagen del PLC debe poder
instalarse completamente offline.  Fuera de una unidad ``Type=notify`` todas
las operaciones son no-op.
"""

from __future__ import annotations

import os
import socket
from collections.abc import Mapping
from time import monotonic


class SystemdNotifier:
    """Envía ``READY``, ``WATCHDOG`` y ``STOPPING`` sin afectar al control.

    Un fallo del socket de notificación nunca debe derribar el proceso. Si el
    watchdog está activo, systemd detectará por sí mismo que dejó de recibir
    latidos y reiniciará la unidad.
    """

    def __init__(
        self,
        environment: Mapping[str, str] | None = None,
        *,
        process_id: int | None = None,
    ) -> None:
        env = os.environ if environment is None else environment
        self._process_id = os.getpid() if process_id is None else process_id
        self._address = _notify_address(env.get("NOTIFY_SOCKET"))
        self._watchdog_interval = _watchdog_interval(
            env, process_id=self._process_id
        )
        self._next_watchdog_at = 0.0

    @property
    def enabled(self) -> bool:
        return self._address is not None

    @property
    def watchdog_enabled(self) -> bool:
        return self.enabled and self._watchdog_interval is not None

    def ready(self, status: str = "Controlador operativo") -> bool:
        """Marca la unidad lista sólo después de inicializar sus componentes."""

        fields = ["READY=1"]
        if status:
            fields.append(f"STATUS={_single_line(status)}")
        return self._send(*fields)

    def watchdog(self, *, now: float | None = None) -> bool:
        """Emite como máximo un latido por cada mitad del intervalo acordado."""

        if not self.watchdog_enabled:
            return False
        current = monotonic() if now is None else now
        if current < self._next_watchdog_at:
            return False
        assert self._watchdog_interval is not None
        sent = self._send("WATCHDOG=1")
        # No martillar un socket roto. Si el envío falla, systemd vence el
        # watchdog y recupera la unidad con Restart=always.
        self._next_watchdog_at = current + self._watchdog_interval / 2
        return sent

    def stopping(self, status: str = "Deteniendo controlador") -> bool:
        fields = ["STOPPING=1"]
        if status:
            fields.append(f"STATUS={_single_line(status)}")
        return self._send(*fields)

    def _send(self, *fields: str) -> bool:
        if self._address is None:
            return False
        payload = "\n".join(fields).encode("utf-8")
        try:
            with socket.socket(socket.AF_UNIX, socket.SOCK_DGRAM) as notifier:
                notifier.sendto(payload, self._address)
        except OSError:
            return False
        return True


def _notify_address(raw_address: str | None) -> str | bytes | None:
    if not raw_address:
        return None
    if raw_address.startswith("@"):  # namespace abstracto de Linux
        return b"\0" + raw_address[1:].encode("utf-8")
    if raw_address.startswith("/"):
        return raw_address
    return None


def _watchdog_interval(
    environment: Mapping[str, str], *, process_id: int
) -> float | None:
    watchdog_pid = environment.get("WATCHDOG_PID")
    if watchdog_pid:
        try:
            if int(watchdog_pid) != process_id:
                return None
        except ValueError:
            return None
    try:
        microseconds = int(environment.get("WATCHDOG_USEC", "0"))
    except ValueError:
        return None
    if microseconds <= 0:
        return None
    return microseconds / 1_000_000


def _single_line(value: str) -> str:
    return value.replace("\n", " ").replace("\r", " ")
