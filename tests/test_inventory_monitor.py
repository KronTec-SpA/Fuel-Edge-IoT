import json
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

from fuel_edge.domain import FuelEdgeMachine
from fuel_edge.inventory_monitor import InventoryMonitor
from fuel_edge.relay import MemoryPumpRelay
from fuel_edge.service import FuelEdgeService
from fuel_edge.storage import EventStore


class InventoryMonitorTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.path = Path(self.temp.name) / "edge.db"
        self.store = EventStore(self.path)
        self.start = datetime(2026, 9, 8, tzinfo=timezone.utc)

    def tearDown(self):
        self.store.close()
        self.temp.cleanup()

    def monitor(self, seconds=0, **kwargs):
        return InventoryMonitor(
            self.store, site_id="site", capacity_liters=2500,
            pulses_per_liter=100, calibration_id=kwargs.pop("calibration_id", "cal1"),
            k24_enabled=kwargs.pop("k24_enabled", True),
            now=self.start + timedelta(seconds=seconds), **kwargs,
        )

    def observe(self, monitor, level, seconds, idle=True):
        at = self.start + timedelta(seconds=seconds)
        monitor.observe(level, at.isoformat(), idle=idle, now=at)

    def plateau(self, monitor, level, seconds):
        for delta in (0, 60, 120):
            self.observe(monitor, level, seconds + delta)

    def baseline(self):
        monitor = self.monitor()
        self.plateau(monitor, 1000, 0)
        return monitor

    def checks(self):
        return [json.loads(row[0]) for row in self.store.connection.execute(
            "SELECT payload FROM inventory_checks ORDER BY rowid"
        )]

    def alerts(self):
        return [json.loads(row[0]) for row in self.store.connection.execute(
            "SELECT payload FROM outbox WHERE topic='web/alert' ORDER BY id"
        )]

    def test_twenty_liters_without_hose_is_a_persistent_suspicion_after_restart(self):
        self.baseline()
        self.store.close()
        self.store = EventStore(self.path)
        monitor = self.monitor(3600)
        self.plateau(monitor, 980, 3600)
        check = self.checks()[-1]
        self.assertEqual(check["status"], "suspected_loss")
        self.assertEqual(check["differenceLiters"], 20)
        self.assertEqual(check["meteredLiters"], 0)
        self.assertEqual(check["baseline"]["levelLiters"], 1000)
        self.assertEqual(self.alerts()[-1]["priority"], "high")
        self.assertIn("no confirma robo", self.alerts()[-1]["detail"])
        self.plateau(monitor, 980, 3780)
        self.assertEqual(len(self.checks()), 2)

    def test_powered_unmetered_drop_is_alarmed_locally_without_network(self):
        monitor = self.baseline()
        self.plateau(monitor, 980, 180)
        self.assertEqual(self.checks()[-1]["reason"], "unmetered_drop")
        self.assertEqual(self.checks()[-1]["differenceLiters"], 20)
        self.assertIn("robo o fuga", self.alerts()[-1]["title"])
        self.plateau(monitor, 980, 360)
        self.assertEqual(len(self.alerts()), 2)

    def test_fixed_accounting_anchor_survives_small_losses_and_restart(self):
        monitor = self.baseline()
        anchor = self.store.inventory_state("site")["balanceAnchor"]
        for i in range(1, 5):
            self.plateau(monitor, 1000 - 5 * i, i * 180)
        samples = [json.loads(row[0]) for row in self.store.connection.execute(
            "SELECT payload FROM inventory_balance_samples ORDER BY rowid")]
        self.assertEqual(samples[-1]["measuredLiters"], 980)
        self.assertTrue(all(sample["anchor"] == anchor for sample in samples))
        self.store.close()
        self.store = EventStore(self.path)
        self.plateau(self.monitor(3600), 960, 3600)
        self.assertEqual(self.store.inventory_state("site")["balanceAnchor"], anchor)
        queued = self.store.connection.execute(
            "SELECT COUNT(*) FROM outbox WHERE topic='web/inventory-balance'").fetchone()[0]
        self.assertGreater(queued, 4)

    def test_unhealthy_meter_cannot_approve_restart_balance(self):
        self.baseline()
        monitor = self.monitor(3600)
        for second in (3600, 3660, 3720):
            at = self.start + timedelta(seconds=second)
            monitor.observe(1000, at.isoformat(), idle=True, meter_healthy=False, now=at)
        self.assertEqual(self.checks()[-1]["status"], "unverifiable")

    def test_measured_consumption_is_subtracted_even_before_transaction_closes(self):
        self.baseline()
        self.store.record_inventory_pulses(3000)
        monitor = self.monitor(3600)
        self.plateau(monitor, 970, 3600)
        self.assertEqual(self.checks()[-1]["status"], "within_operational_band")
        self.assertEqual(self.checks()[-1]["meteredLiters"], 30)

    def test_external_loss_remains_after_crediting_hose_consumption(self):
        self.baseline()
        self.store.record_inventory_pulses(3000)
        self.plateau(self.monitor(3600), 950, 3600)
        self.assertEqual(self.checks()[-1]["differenceLiters"], 20)

    def test_ten_liter_variation_does_not_raise_loss_alarm(self):
        self.baseline()
        self.plateau(self.monitor(3600), 990, 3600)
        self.assertEqual(self.checks()[-1]["status"], "within_operational_band")
        self.assertEqual(len(self.alerts()), 1)  # instalación sin referencia

    def test_gray_band_preserves_reference_and_times_out_once(self):
        self.baseline()
        monitor = self.monitor(3600)
        self.plateau(monitor, 985, 3600)
        state = self.store.inventory_state("site")
        self.assertEqual(state["pending"]["baseline"]["levelLiters"], 1000)
        for second in (3900, 3901, 3902):
            monitor.tick(self.start + timedelta(seconds=second))
        self.assertEqual(self.checks()[-1]["status"], "unverifiable")
        self.assertEqual(len(self.alerts()), 2)
        self.plateau(monitor, 980, 3960)
        self.assertEqual(self.checks()[-1]["status"], "suspected_loss")

    def test_second_restart_does_not_replace_pending_original_reference(self):
        self.baseline()
        monitor = self.monitor(3600)
        self.observe(monitor, 980, 3600)
        first_id = self.store.inventory_state("site")["pending"]["id"]
        monitor = self.monitor(3660)
        self.plateau(monitor, 980, 3660)
        self.assertEqual(self.checks()[-1]["id"], first_id)
        self.assertEqual(self.checks()[-1]["differenceLiters"], 20)

    def test_unstable_level_and_active_pump_cannot_be_approved(self):
        self.baseline()
        monitor = self.monitor(3600)
        for second, level in ((3600, 980), (3660, 1020), (3720, 980)):
            self.observe(monitor, level, second)
        self.assertEqual(len(self.checks()), 1)
        for second in (3780, 3840, 3900):
            self.observe(monitor, 980, second, idle=False)
        self.assertEqual(len(self.checks()), 1)
        monitor.tick(self.start + timedelta(seconds=3900))
        self.assertEqual(self.checks()[-1]["status"], "unverifiable")

    def test_burst_duplicate_stale_and_future_readings_cannot_complete_check(self):
        self.baseline()
        monitor = self.monitor(3600)
        for second in (0, 60, 120, 3600, 3600, 3601, 3602):
            self.observe(monitor, 980, second)
        monitor.observe(980, (self.start + timedelta(seconds=4000)).isoformat(),
                        idle=True, now=self.start + timedelta(seconds=3602))
        self.assertEqual(len(self.checks()), 1)

    def test_telemetry_gap_is_checked_without_a_power_hook(self):
        monitor = self.baseline()
        monitor.tick(self.start + timedelta(seconds=301))
        self.plateau(monitor, 980, 360)
        self.assertEqual(self.checks()[-1]["reason"], "level_gap")
        self.assertEqual(self.checks()[-1]["status"], "suspected_loss")

    def test_calibration_change_and_missing_k24_are_unverifiable(self):
        for options in ({"calibration_id": "changed"}, {"k24_enabled": False}):
            with self.subTest(options=options):
                self.baseline()
                self.plateau(self.monitor(3600, **options), 980, 3600)
                self.assertEqual(self.checks()[-1]["status"], "unverifiable")

    def test_positive_difference_is_not_automatically_a_receipt(self):
        self.baseline()
        self.plateau(self.monitor(3600), 1100, 3600)
        self.assertEqual(self.checks()[-1]["status"], "unverified_increase")
        self.assertEqual(self.alerts()[-1]["title"], "Aumento de inventario durante interrupción")

    def test_pulses_during_sampling_restart_the_stability_window(self):
        self.baseline()
        monitor = self.monitor(3600)
        self.observe(monitor, 980, 3600)
        self.observe(monitor, 980, 3660)
        self.store.record_inventory_pulses(100)
        self.observe(monitor, 979, 3720)
        self.assertEqual(len(self.checks()), 1)
        self.observe(monitor, 979, 3780)
        self.observe(monitor, 979, 3840)
        self.assertEqual(self.checks()[-1]["differenceLiters"], 20)

    def test_service_records_total_before_unauthorized_incident_is_closed(self):
        service = FuelEdgeService(FuelEdgeMachine(relay=MemoryPumpRelay()),
                                  self.store, pulses_per_liter=100)
        service.assign("module", "site")
        service.record_k24_pulse(2000)
        self.assertEqual(self.store.inventory_pulses(), 2000)
        self.store.close()
        self.store = EventStore(self.path)
        self.assertEqual(self.store.inventory_pulses(), 2000)


if __name__ == "__main__":
    unittest.main()
