import json
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import patch
from urllib.error import URLError

from fuel_edge.config import WebSyncConfig
from fuel_edge.storage import EventStore
from fuel_edge.web_sync import WebSyncWorker


class VoltageHistoryTests(unittest.TestCase):
    def test_backlog_does_not_delay_current_operational_events(self):
        with tempfile.TemporaryDirectory() as directory:
            store = EventStore(Path(directory) / 'edge.db')
            try:
                for i in range(110):
                    store.enqueue('web/voltage-readings', {'samples': [i]})
                store.enqueue('web/status', {'state': 'locked'})
                worker = WebSyncWorker(store, WebSyncConfig(enabled=True), 's' * 32)
                with patch.object(worker, '_deliver') as deliver:
                    self.assertEqual(worker.run_once(), 11)
                    self.assertEqual(deliver.call_args_list[0].args[0], 'web/status')
                    self.assertEqual(len(store.pending(('web/voltage-readings',), limit=1000)), 100)
            finally:
                store.close()

    def test_durable_batches_survive_local_retention_and_retry(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'edge.db'
            store = EventStore(path)
            start = datetime(2026, 9, 9, tzinfo=timezone.utc)
            samples = [dict(occurredAt=(start + timedelta(seconds=i)).isoformat(),
                            volts=8.129426, rawAdc=3329, quality='valid') for i in range(65)]
            store.record_ocio_diagnostics(samples, site_id='concha-y-toro-piloto', telemetry_session_id='boot-1')
            store.record_ocio_diagnostics(samples, site_id='concha-y-toro-piloto', telemetry_session_id='boot-1')
            self.assertEqual([len(event[2]['samples']) for event in store.pending(('web/voltage-readings',))], [30, 30, 5])
            store.record_ocio_diagnostics([dict(samples[0], occurredAt=(start + timedelta(days=2)).isoformat())])
            self.assertEqual(store.connection.execute('SELECT COUNT(*) FROM ocio_signal_diagnostics').fetchone()[0], 1)
            store.close()
            store = EventStore(path)
            try:
                worker = WebSyncWorker(store, WebSyncConfig(enabled=True, retry_seconds=1), 's' * 32)
                with patch('fuel_edge.web_sync.urlopen', side_effect=URLError('offline')):
                    self.assertEqual(worker.run_once(), 0)
                self.assertEqual(store.connection.execute("SELECT COUNT(*) FROM outbox WHERE topic='web/voltage-readings' AND sent_at IS NULL AND discarded_at IS NULL").fetchone()[0], 3)
                store.connection.execute('UPDATE outbox SET next_attempt_at=NULL')
                store.connection.commit()
                class Response:
                    status = 200
                    def __enter__(self): return self
                    def __exit__(self, *_): pass
                    def read(self, *_): return b'{}'
                with patch('fuel_edge.web_sync.urlopen', return_value=Response()) as deliver:
                    self.assertEqual(worker.run_once(), 3)
                    requests = [call.args[0] for call in deliver.call_args_list]
                    self.assertTrue(all(r.full_url.endswith('/api/fuel-history/voltages') for r in requests))
                    restored = [s for request in requests for s in json.loads(request.data)['samples']]
                    self.assertEqual(restored, samples)
                self.assertEqual(worker.run_once(), 0)
            finally:
                store.close()


if __name__ == '__main__':
    unittest.main()
