"""Pulsos de entrada simulados con R0.1 permanentemente desenergizado."""
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

from fuel_edge.domain import EdgeEvent, FuelEdgeMachine
from fuel_edge.hardware.industrial_shields import (
    IndustrialShieldsK24Reader,
    IndustrialShieldsRelay,
)
from fuel_edge.service import FuelEdgeService
from fuel_edge.storage import EventStore


class BypassBackend:
    INPUT, OUTPUT, LOW, HIGH = 0, 1, 0, 1

    def __init__(self):
        self.input_level = 1
        self.writes = []

    def init(self, version, model, restart=False):
        return 0

    def pin_mode(self, pin, mode):
        return 0

    def digital_read(self, pin):
        return self.input_level

    def digital_write(self, pin, value):
        self.writes.append((pin, value))
        return 0


class PhysicalBypassTests(unittest.TestCase):
    def test_input_to_persistent_liters_without_energizing_relay(self):
        for control_fault in (False, True):
            with self.subTest(control_fault=control_fault), tempfile.TemporaryDirectory() as directory:
                backend = BypassBackend()
                relay = IndustrialShieldsRelay(backend=backend)
                store = EventStore(Path(directory) / 'edge.db')
                service = FuelEdgeService(FuelEdgeMachine(relay=relay), store, pulses_per_liter=90)
                service.assign('rpi-test', 'site-test')
                if control_fault:
                    service.apply(EdgeEvent.CONTROL_FAULT, reason='test')
                reader = IndustrialShieldsK24Reader(
                    pin='I0.0', version='RPIPLC_V6', model='RPIPLC_19R',
                    active_low=True, backend=backend, autostart=False,
                )
                started = datetime.now(timezone.utc)
                try:
                    # Dos lotes separados por una pausa corta: 900 pulsos = 10 L.
                    for batch in range(2):
                        for pulse in range(450):
                            timestamp = batch * 20 + pulse * .02
                            backend.input_level = 0
                            reader.poll_once(timestamp)
                            backend.input_level = 1
                            reader.poll_once(timestamp + .01)
                        count = reader.drain_pulses()
                        self.assertEqual(count, 450)
                        service.record_k24_pulse(count, at=started + timedelta(seconds=batch * 20))
                        self.assertFalse(relay.is_energized)
                        self.assertEqual(store.inventory_pulses(), (batch + 1) * 450)
                    service.tick(started + timedelta(seconds=59))
                    self.assertEqual(store.pending(('web/fuel-movement',)), [])
                    service.tick(started + timedelta(seconds=60))
                    movement = store.pending(('web/fuel-movement',))[0][2]
                    self.assertEqual(movement['liters'], 10)
                    self.assertTrue(movement['unauthorized'])
                    self.assertIsNone(movement['operatorId'])
                    self.assertIsNone(movement['equipmentId'])
                    self.assertEqual(store.connection.execute(
                        'SELECT pulses,liters,status FROM unauthorized_flow_incidents'
                    ).fetchone(), (900, 10.0, 'closed'))
                    self.assertTrue(backend.writes)
                    self.assertTrue(all(value == 0 for _, value in backend.writes))
                finally:
                    reader.close()
                    store.close()
                # El acumulador no depende de mantener la conexión SQLite abierta.
                reopened = EventStore(Path(directory) / 'edge.db')
                try:
                    self.assertEqual(reopened.inventory_pulses(), 900)
                finally:
                    reopened.close()
