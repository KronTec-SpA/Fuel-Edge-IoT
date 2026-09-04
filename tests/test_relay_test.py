from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from fuel_edge.domain import EdgeEvent, FuelEdgeMachine
from fuel_edge.relay_test import RelayTestCommand, RelayTestCoordinator
from fuel_edge.service import FuelEdgeService, RelayTestResult
from fuel_edge.storage import EventStore


class FakeRelayTestWeb:
    def __init__(self) -> None:
        self.commands = [RelayTestCommand("relay-test-01", 25)]
        self.results: list[tuple[str, RelayTestResult]] = []

    def next_command(self) -> RelayTestCommand | None:
        return self.commands.pop(0) if self.commands else None

    def result(self, command_id: str, result: RelayTestResult) -> None:
        self.results.append((command_id, result))


class ImmediateRelayTestService:
    def __init__(self) -> None:
        self.commands: list[tuple[str, int]] = []

    def run_relay_test(
        self, command_id: str, *, duration_seconds: int, stop_event=None
    ) -> RelayTestResult:
        self.commands.append((command_id, duration_seconds))
        return RelayTestResult(
            True,
            None,
            "2026-08-16T12:00:00+00:00",
            "2026-08-16T12:00:10+00:00",
        )

    def abort_relay_test(self, reason: str = "cancelled") -> None:
        return None


class RelayTestCoordinatorTests(unittest.TestCase):
    def test_delivers_the_requested_bounded_enable_time(self) -> None:
        with self.assertRaisesRegex(ValueError, "duración"):
            RelayTestCommand("relay-test-01", 4)
        with self.assertRaisesRegex(ValueError, "duración"):
            RelayTestCommand("relay-test-01", 61)

        web = FakeRelayTestWeb()
        service = ImmediateRelayTestService()
        coordinator = RelayTestCoordinator(web, service)  # type: ignore[arg-type]

        self.assertTrue(coordinator.refresh())

        self.assertEqual(service.commands, [("relay-test-01", 25)])
        self.assertEqual(len(web.results), 1)
        self.assertTrue(web.results[0][1].success)

    def test_real_service_rejects_test_while_point_is_not_locked(self) -> None:
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        store = EventStore(Path(temporary.name) / "edge.db")
        self.addCleanup(store.close)
        service = FuelEdgeService(FuelEdgeMachine(), store, pulses_per_liter=100)

        with self.assertRaisesRegex(RuntimeError, "bloqueado"):
            service.run_relay_test("relay-test-01")

    def test_real_service_requires_k24_protection(self) -> None:
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        store = EventStore(Path(temporary.name) / "edge.db")
        self.addCleanup(store.close)
        machine = FuelEdgeMachine()
        machine.apply(EdgeEvent.ASSIGN, module_id="rpi-01", site_id="fundo-01")
        service = FuelEdgeService(
            machine,
            store,
            pulses_per_liter=100,
            k24_enabled=False,
        )

        with self.assertRaisesRegex(RuntimeError, "K24 debe estar habilitado"):
            service.run_relay_test("relay-test-01")


if __name__ == "__main__":
    unittest.main()
