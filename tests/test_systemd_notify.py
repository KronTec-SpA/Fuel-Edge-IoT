from __future__ import annotations

import unittest
from unittest.mock import patch

from fuel_edge.systemd_notify import SystemdNotifier


class RecordingSocket:
    sent: list[tuple[bytes, str | bytes]] = []

    def __init__(self, family: int, kind: int) -> None:
        self.family = family
        self.kind = kind

    def __enter__(self) -> RecordingSocket:
        return self

    def __exit__(self, *args: object) -> None:
        return None

    def sendto(self, payload: bytes, address: str | bytes) -> None:
        self.sent.append((payload, address))


class FailingSocket(RecordingSocket):
    def sendto(self, payload: bytes, address: str | bytes) -> None:
        raise OSError("socket de systemd no disponible")


class SystemdNotifierTests(unittest.TestCase):
    def setUp(self) -> None:
        RecordingSocket.sent = []

    def test_ready_watchdog_and_stopping_use_notify_socket(self) -> None:
        notifier = SystemdNotifier(
            {
                "NOTIFY_SOCKET": "/run/systemd/notify",
                "WATCHDOG_USEC": "20000000",
                "WATCHDOG_PID": "4321",
            },
            process_id=4321,
        )

        with patch("fuel_edge.systemd_notify.socket.socket", RecordingSocket):
            self.assertTrue(notifier.ready("Listo\npara operar"))
            self.assertTrue(notifier.watchdog(now=100.0))
            self.assertFalse(notifier.watchdog(now=109.9))
            self.assertTrue(notifier.watchdog(now=110.0))
            self.assertTrue(notifier.stopping())

        self.assertEqual(
            [payload for payload, _address in RecordingSocket.sent],
            [
                b"READY=1\nSTATUS=Listo para operar",
                b"WATCHDOG=1",
                b"WATCHDOG=1",
                b"STOPPING=1\nSTATUS=Deteniendo controlador",
            ],
        )
        self.assertTrue(
            all(address == "/run/systemd/notify" for _, address in RecordingSocket.sent)
        )

    def test_abstract_linux_socket_is_encoded_for_sendto(self) -> None:
        notifier = SystemdNotifier(
            {"NOTIFY_SOCKET": "@fuel-edge-notify"}, process_id=10
        )

        with patch("fuel_edge.systemd_notify.socket.socket", RecordingSocket):
            self.assertTrue(notifier.ready())

        self.assertEqual(RecordingSocket.sent[0][1], b"\0fuel-edge-notify")

    def test_watchdog_for_another_process_is_ignored(self) -> None:
        notifier = SystemdNotifier(
            {
                "NOTIFY_SOCKET": "/run/systemd/notify",
                "WATCHDOG_USEC": "20000000",
                "WATCHDOG_PID": "9999",
            },
            process_id=4321,
        )

        with patch("fuel_edge.systemd_notify.socket.socket", RecordingSocket):
            self.assertFalse(notifier.watchdog(now=100.0))

        self.assertEqual(RecordingSocket.sent, [])

    def test_missing_or_broken_notify_socket_never_crashes_control(self) -> None:
        disabled = SystemdNotifier({}, process_id=4321)
        self.assertFalse(disabled.ready())
        self.assertFalse(disabled.watchdog(now=100.0))

        enabled = SystemdNotifier(
            {"NOTIFY_SOCKET": "/run/systemd/notify"}, process_id=4321
        )
        with patch("fuel_edge.systemd_notify.socket.socket", FailingSocket):
            self.assertFalse(enabled.ready())
            self.assertFalse(enabled.stopping())


if __name__ == "__main__":
    unittest.main()
