import tempfile
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch
from urllib.error import HTTPError, URLError

from fuel_edge.config import WebSyncConfig
from fuel_edge.storage import EventStore
from fuel_edge.web_sync import WebSyncWorker, read_web_sensor_key


class _Response:
    status = 201
    headers = {}

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False

    def read(self, _limit):
        return b"{}"


class WebSyncWorkerTests(unittest.TestCase):
    def setUp(self) -> None:
        self.directory = tempfile.TemporaryDirectory()
        self.store = EventStore(Path(self.directory.name) / "edge.db")
        self.config = WebSyncConfig(enabled=True, retry_seconds=1)
        self.worker = WebSyncWorker(self.store, self.config, "s" * 32)

    def tearDown(self) -> None:
        self.store.close()
        self.directory.cleanup()

    @patch("fuel_edge.web_sync.urlopen", return_value=_Response())
    def test_delivers_and_marks_event_once(self, call: MagicMock) -> None:
        self.store.enqueue_tank_level(level_liters=1200, occurred_at="2026-08-10T10:00:00Z")
        self.assertEqual(self.worker.run_once(), 1)
        self.assertEqual(self.store.pending(("web/level-reading",)), [])
        request = call.call_args.args[0]
        self.assertEqual(request.full_url, "http://127.0.0.1:8080/api/fuel-history/readings")
        self.assertEqual(request.get_header("X-edge-sensor-key"), "s" * 32)

    @patch("fuel_edge.web_sync.urlopen", side_effect=URLError("offline"))
    def test_keeps_event_pending_after_transport_failure(self, _call: MagicMock) -> None:
        event_id = self.store.enqueue_tank_level(level_liters=1200, occurred_at="2026-08-10T10:00:00Z")
        self.assertEqual(self.worker.run_once(), 0)
        row = self.store.connection.execute(
            "SELECT sent_at,attempt_count,last_error FROM outbox WHERE id=?", (event_id,)
        ).fetchone()
        self.assertEqual(row[0], None)
        self.assertEqual(row[1], 1)
        self.assertIn("transport_URLError", row[2])

    @patch("fuel_edge.web_sync.urlopen", side_effect=HTTPError("url", 422, "bad", {}, None))
    def test_quarantines_permanently_invalid_event(self, _call: MagicMock) -> None:
        event_id = self.store.enqueue_tank_level(level_liters=1200, occurred_at="2026-08-10T10:00:00Z")
        self.worker.run_once()
        row = self.store.connection.execute(
            "SELECT discarded_at,last_error FROM outbox WHERE id=?", (event_id,)
        ).fetchone()
        self.assertIsNotNone(row[0])
        self.assertEqual(row[1], "http_422")

    def test_sensor_key_requires_private_regular_file(self) -> None:
        path = Path(self.directory.name) / "key"
        path.write_text("x" * 32, encoding="utf-8")
        path.chmod(0o600)
        self.assertEqual(read_web_sensor_key(path), "x" * 32)
        path.chmod(0o644)
        with self.assertRaisesRegex(PermissionError, "0600"):
            read_web_sensor_key(path)

    @patch("fuel_edge.web_sync.urlopen", return_value=_Response())
    def test_delivers_coalesced_runtime_status(self, call: MagicMock) -> None:
        self.store.enqueue_latest("web/status", {"state": "locked"}, "web/status:latest")
        self.assertEqual(self.worker.run_once(), 1)
        self.assertEqual(call.call_args.args[0].full_url, "http://127.0.0.1:8080/api/fuel-history/status")

    @patch("fuel_edge.web_sync.urlopen", return_value=_Response())
    def test_delivers_completed_power_outage(self, call: MagicMock) -> None:
        self.store.record_completed_power_outage(
            site_id="fundo-prueba",
            lost_at="2026-08-24T23:20:03+00:00",
            restored_at="2026-08-25T01:18:05+00:00",
        )
        self.assertEqual(self.worker.run_once(), 1)
        self.assertEqual(
            call.call_args.args[0].full_url,
            "http://127.0.0.1:8080/api/system-settings/power-events/edge",
        )
