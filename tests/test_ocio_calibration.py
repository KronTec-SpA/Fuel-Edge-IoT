import json
import sqlite3
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
from urllib.error import HTTPError

from fuel_edge.ocio_calibration import OcioCalibrationCoordinator, restore_calibration, validate_command
from fuel_edge.hardware.industrial_shields import IndustrialShieldsTankLevelReader
from fuel_edge.ocio_filter import OcioFilterConfig
from fuel_edge.storage import EventStore
from fuel_edge.web_sync import WebSyncWorker


class AnalogBackend:
    INPUT = 0
    def init(self, *args, **kwargs): return 0
    def pin_mode(self, *args): return 0
    def analog_read(self, *args): return .4 * 9.8 / 10 * 4095


class OcioCalibrationTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.path = Path(self.directory.name) / 'edge.sqlite3'
        self.store = EventStore(self.path)
        self.clock = [0]
        self.reader = self.make_reader()
        self.command = dict(confirmationId='calibration-1', revision=1,
            fingerprint=self.reader.signal_calibration_id,
            calibratedAt=datetime.now(timezone.utc).isoformat())
        self.config = SimpleNamespace(base_url='http://localhost', request_timeout_seconds=1, retry_seconds=5)
        self.coordinator = OcioCalibrationCoordinator(self.config, 'x'*32,
            site_id='site', session_id='session', reader=self.reader)

    def tearDown(self):
        self.store.close()
        self.directory.cleanup()

    def make_reader(self, **extra):
        return IndustrialShieldsTankLevelReader(pin='I0.2', version='RPIPLC_V6', model='RPIPLC_19R',
            capacity_liters=2500, signal_mode='0-10v', input_empty_volts=0,
            input_full_volts=9.8, sample_count=1, ocio_calibration_pending=True,
            cycle_filter=OcioFilterConfig(), backend=AnalogBackend(), clock=lambda:self.clock[0], **extra)

    def test_validation_rejects_wrong_scaling_revision_and_date(self):
        self.assertEqual(validate_command(self.command,self.reader.signal_calibration_id),self.command)
        self.assertIsNone(validate_command(None,self.reader.signal_calibration_id))
        for change in [dict(fingerprint='another'),dict(revision=True),dict(revision=0),
                       dict(confirmationId='invalid/id'),dict(calibratedAt='2026-01-01'),
                       dict(calibratedAt=(datetime.now(timezone.utc)+timedelta(days=1)).isoformat())]:
            with self.subTest(change=change), self.assertRaises(ValueError):
                validate_command({**self.command,**change},self.reader.signal_calibration_id)

    def test_applies_only_at_rest_archives_reference_preserves_meter_and_restores(self):
        self.store.record_inventory_pulses(1800)
        baseline={'baseline':{'levelLiters':900},'evidence':'retain me'}
        self.store.save_inventory_state('site',baseline)
        self.coordinator._pending=self.command
        self.assertFalse(self.coordinator.apply_if_idle(self.store,idle=False))
        self.assertTrue(self.reader.ocio_calibration_pending)
        self.assertIsNone(self.store.ocio_calibration('site'))
        self.assertTrue(self.coordinator.apply_if_idle(self.store,idle=True))
        self.assertFalse(self.reader.ocio_calibration_pending)
        self.assertIsNone(self.store.inventory_state('site'))
        self.assertEqual(self.store.inventory_pulses(),1800)
        archived=self.store.connection.execute('SELECT previous_inventory_state FROM ocio_calibration_history').fetchone()[0]
        self.assertEqual(json.loads(archived),baseline)
        self.coordinator._pending=self.command
        self.assertFalse(self.coordinator.apply_if_idle(self.store,idle=True))
        self.assertEqual(self.store.connection.execute("SELECT count(*) FROM outbox WHERE topic='web/ocio-calibration-applied'").fetchone()[0],1)
        self.store.close(); self.store=EventStore(self.path)
        rebooted=self.make_reader()
        restore_calibration(self.store,'site',rebooted)
        self.assertFalse(rebooted.ocio_calibration_pending)
        self.assertEqual(rebooted.calibration_id,self.reader.calibration_id)
        rebooted.signal_calibration_id='level-'+'b'*64
        restore_calibration(self.store,'site',rebooted)
        self.assertTrue(rebooted.ocio_calibration_pending)

    def test_failed_durable_ack_rolls_back_certificate_and_reference(self):
        self.store.save_inventory_state('site',{'baseline':123})
        self.store.connection.execute("CREATE TRIGGER refuse_ack BEFORE INSERT ON outbox WHEN NEW.topic='web/ocio-calibration-applied' BEGIN SELECT RAISE(ABORT,'simulated full disk'); END")
        self.coordinator._pending=self.command
        with self.assertRaises(sqlite3.IntegrityError):
            self.coordinator.apply_if_idle(self.store,idle=True)
        self.assertTrue(self.reader.ocio_calibration_pending)
        self.assertIsNone(self.store.ocio_calibration('site'))
        self.assertEqual(self.store.inventory_state('site'),{'baseline':123})

    def test_recalibration_rejects_old_commands_and_preserves_previous_cycles(self):
        first,_=self.store.apply_ocio_calibration('site',self.command)
        self.store.save_inventory_state('site',{'baseline':900})
        second={**self.command,'confirmationId':'calibration-2','revision':2}
        self.store.apply_ocio_calibration('site',second)
        with self.assertRaises(ValueError): self.store.apply_ocio_calibration('site',self.command)
        with self.assertRaises(ValueError): self.store.apply_ocio_calibration('site',{**second,'fingerprint':'changed'})
        self.assertEqual(self.store.connection.execute('SELECT count(*) FROM ocio_calibration_history').fetchone()[0],2)
        self.assertEqual(self.store.ocio_calibration('site')['confirmationId'],'calibration-2')

    def test_confirmation_discards_precalibration_filter_samples(self):
        for t in range(151):
            self.clock[0]=t
            self.assertIsNone(self.reader.read_if_updated())
        self.reader.confirm_calibration('calibration-1')
        self.assertEqual(self.reader.quality_update()['quality'],'warming_up')
        self.clock[0]=151
        self.assertIsNone(self.reader.read_if_updated())
        readings=[]
        for t in range(152,310):
            self.clock[0]=t
            reading=self.reader.read_if_updated()
            if reading: readings.append(reading)
        self.assertTrue(readings)
        self.assertTrue(all(r.calibration_id==self.reader.calibration_id for r in readings))
        self.reader.confirm_calibration('calibration-1')
        self.assertTrue(self.reader._cycle_filter.samples)  # duplicate command cannot restart warmup

    def test_confirmation_is_delivered_by_existing_durable_web_outbox(self):
        self.store.apply_ocio_calibration('site',self.command)
        worker=WebSyncWorker(self.store,self.config,'x'*32)
        class Response:
            status=200
            def __enter__(self): return self
            def __exit__(self,*args): pass
            def read(self,*args): return b'{}'
        with patch('fuel_edge.web_sync.urlopen',return_value=Response()) as send:
            self.assertEqual(worker.run_once(),1)
        request=send.call_args.args[0]
        self.assertTrue(request.full_url.endswith('/ocio-calibration/applied'))
        self.assertEqual(json.loads(request.data)['confirmationId'],'calibration-1')

    def test_superseded_ack_is_retained_as_failed_instead_of_retrying_forever(self):
        self.store.apply_ocio_calibration('site',self.command)
        worker=WebSyncWorker(self.store,self.config,'x'*32)
        with patch('fuel_edge.web_sync.urlopen',side_effect=HTTPError('url',409,'superseded',{},None)):
            worker.run_once()
        row=self.store.connection.execute("SELECT discarded_at,last_error FROM outbox WHERE topic='web/ocio-calibration-applied'").fetchone()
        self.assertIsNotNone(row[0]); self.assertEqual(row[1],'http_409')
