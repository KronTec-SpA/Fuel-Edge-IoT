import json
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

from fuel_edge.inventory_monitor import InventoryMonitor
from fuel_edge.storage import EventStore


class CustomerInventoryPolicyTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.store = EventStore(Path(self.temp.name)/'edge.db')
        self.start = datetime(2026,9,17,tzinfo=timezone.utc)
        self.monitor = InventoryMonitor(self.store,site_id='site',capacity_liters=2662,
            pulses_per_liter=90,calibration_id='cal1',k24_enabled=True,now=self.start,customer_policy=True)

    def tearDown(self):
        self.store.close()
        self.temp.cleanup()

    def at(self, seconds):
        return self.start+timedelta(seconds=seconds)

    def observe(self, seconds, level=1000):
        self.monitor.observe(level,self.at(seconds).isoformat(),idle=True,now=self.at(seconds))
        self.monitor.tick(self.at(seconds))
        self.monitor.publish_health(self.at(seconds))

    def test_publication_gap_recovers_without_customer_alarm(self):
        for t in [0,60,120,300,360,420]: self.observe(t)
        checks=[json.loads(r[0]) for r in self.store.connection.execute('SELECT payload FROM inventory_checks')]
        self.assertEqual(checks[-1]['status'],'within_operational_band')
        self.assertEqual(self.store.connection.execute("SELECT count(*) FROM outbox WHERE topic='web/alert'").fetchone()[0],0)

    def test_long_instability_is_one_durable_technical_incident(self):
        for t in [0,60,120]:self.observe(t)
        for t in [1080,1800,3600,7200]:
            self.monitor.tick(self.at(t));self.monitor.publish_health(self.at(t))
        health=self.store.inventory_state('site')['measurementHealth']
        self.assertEqual(health['episodes'],1)
        self.assertEqual(health['condition'],'active')
        identity=health['id']
        self.monitor=InventoryMonitor(self.store,site_id='site',capacity_liters=2662,pulses_per_liter=90,
            calibration_id='cal1',k24_enabled=True,now=self.at(7260),customer_policy=True)
        for t in range(7260,11101,60):self.observe(t)
        health=self.store.inventory_state('site')['measurementHealth']
        self.assertEqual(health['id'],identity)
        self.assertEqual(health['condition'],'recovered')
        self.assertEqual(self.store.connection.execute("SELECT count(*) FROM outbox WHERE topic='web/alert'").fetchone()[0],0)

    def test_loss_evidence_and_fixed_anchor_survive_without_duplicate_edge_alert(self):
        for t in [0,60,120]:self.observe(t)
        anchor=self.store.inventory_state('site')['balanceAnchor']
        for t in [180,240,300]:self.observe(t,700)
        checks=[json.loads(r[0]) for r in self.store.connection.execute('SELECT payload FROM inventory_checks')]
        self.assertEqual(checks[-1]['status'],'suspected_loss')
        self.assertEqual(self.store.inventory_state('site')['balanceAnchor'],anchor)
        self.assertGreater(self.store.connection.execute("SELECT count(*) FROM outbox WHERE topic='web/inventory-balance'").fetchone()[0],0)
        self.assertEqual(self.store.connection.execute("SELECT count(*) FROM outbox WHERE topic='web/alert'").fetchone()[0],0)
