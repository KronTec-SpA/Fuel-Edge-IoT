import json
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

from fuel_edge.ocio_filter import OcioFilterConfig, OcioTemporalFilter, OcioRange
from fuel_edge.hardware.industrial_shields import AnalogInputError, IndustrialShieldsTankLevelReader
from fuel_edge.inventory_monitor import InventoryMonitor
from fuel_edge.storage import EventStore
from fuel_edge.tank_geometry import HorizontalTankGeometry


class AnalogBackend:
    INPUT = 0
    value = 0

    def init(self, *args, **kwargs):
        return 0

    def pin_mode(self, *args):
        return 0

    def analog_read(self, *args):
        return self.value


class OcioFilterTests(unittest.TestCase):
    def run_signal(self, signal, seconds=900):
        filt = OcioTemporalFilter(OcioFilterConfig())
        return [filt.add(t, signal(t)) for t in range(seconds)]

    def test_fifteen_second_pressure_pulses_never_become_inventory(self):
        # Se prueban varias fases, incluido arranque en plena sobrepresión.
        for phase in (0, 17, 59):
            with self.subTest(phase=phase):
                output = self.run_signal(lambda t: 45 if (t+phase) % 120 < 15 else 40)
                accepted = [x for x in output if x is not None]
                self.assertGreater(len(accepted), 100)
                self.assertEqual(set(accepted), {40})
                for t, value in enumerate(output):
                    if (t+phase) % 120 < 15:
                        self.assertIsNone(value)

    def test_alternating_ten_mm_levels_are_not_averaged_into_fake_precision(self):
        cylinder = HorizontalTankGeometry(overall_length_mm=1924)
        low, high = [cylinder.volume_liters(h) / 25 for h in (440, 450)]
        for dwell in (1, 10, 30):
            output = self.run_signal(lambda t: high if (t//dwell) % 2 else low)
            accepted = [value for value in output if value is not None]
            self.assertGreater(len(accepted), 100)
            self.assertTrue(all(isinstance(value, OcioRange) and value.low == low and value.high == high for value in accepted))

    def test_true_twenty_liter_loss_survives_the_filter_and_pressure_cycles(self):
        output = self.run_signal(lambda t: (40 if t < 400 else 39.2) + (4 if t % 120 < 15 else 0))
        self.assertEqual({v for v in output[:400] if v is not None}, {40})
        self.assertEqual({v for v in output[550:] if v is not None}, {39.2})
        self.assertTrue(all(v is None for v in output[400:490]))

    def test_bursts_and_sampling_gaps_cannot_supply_a_fake_time_window(self):
        filt = OcioTemporalFilter(OcioFilterConfig())
        for _ in range(1000):
            self.assertIsNone(filt.add(0, 40))
        self.assertEqual(len(filt.samples), 1)
        for t in (60, 120, 180, 240):
            self.assertIsNone(filt.add(t, 40))
        self.assertEqual(len(filt.samples), 1)

    def test_normal_adc_noise_is_accepted_without_rounding_to_ten_mm(self):
        output = self.run_signal(lambda t: 40 + (t % 5 - 2) * .015)
        self.assertAlmostEqual(output[-1], 40, delta=.015)

    def test_high_duty_cycle_or_longer_transient_is_pending_not_falsely_stable(self):
        output = self.run_signal(lambda t: 44 if t % 60 < 15 else 40)
        self.assertTrue(all(value is None or isinstance(value, OcioRange) for value in output))
        output = self.run_signal(lambda t: 44 if 350 <= t < 420 else 40)
        self.assertNotIn(44, output)

    def test_actual_reader_to_inventory_with_15s_pulses_does_not_raise_false_theft(self):
        self.pipeline(theft=False)

    def test_quality_reports_pressure_validation_and_failure_without_inventing_levels(self):
        backend, clock = AnalogBackend(), [0]
        reader = IndustrialShieldsTankLevelReader(
            pin="I0.2", version="RPIPLC_V6", model="RPIPLC_19R", capacity_liters=2500,
            signal_mode="0-10v", input_empty_volts=0, input_full_volts=9.8,
            sample_count=1, cycle_filter=OcioFilterConfig(), backend=backend, clock=lambda: clock[0])
        backend.value = .4*9.8/10*4095
        self.assertIsNone(reader.read_if_updated())
        self.assertEqual(reader.quality_update()["quality"], "warming_up")
        self.assertIsNone(reader.quality_update())
        for t in range(1, 151):
            clock[0] = t
            reader.read_if_updated()
        self.assertEqual(reader.quality_update()["quality"], "valid")
        for t in range(151, 166):
            clock[0] = t
            backend.value = .44*9.8/10*4095
            self.assertIsNone(reader.read_if_updated())
        self.assertEqual(reader.quality_update()["quality"], "settling")
        clock[0] = 166
        backend.value = float("nan")
        with self.assertRaises(AnalogInputError):
            reader.read_if_updated()
        self.assertEqual(reader.quality_update()["quality"], "unavailable")
        clock[0] = 167
        backend.value = .4*9.8/10*4095
        self.assertIsNone(reader.read_if_updated())
        self.assertEqual(reader.quality_update()["quality"], "warming_up")

    def test_persistent_range_remains_live_through_inventory_and_delivery(self):
        backend, clock = AnalogBackend(), [0]
        reader = IndustrialShieldsTankLevelReader(
            pin="I0.2", version="RPIPLC_V6", model="RPIPLC_19R", capacity_liters=2500,
            signal_mode="0-10v", input_empty_volts=0, input_full_volts=9.8,
            sample_count=1, cycle_filter=OcioFilterConfig(), backend=backend, clock=lambda: clock[0])
        start = datetime(2026, 9, 8, tzinfo=timezone.utc)
        with tempfile.TemporaryDirectory() as directory:
            store = EventStore(Path(directory)/"edge.db")
            monitor = InventoryMonitor(store, site_id="site", capacity_liters=2500,
                pulses_per_liter=100, calibration_id="range-v1", k24_enabled=True, now=start)
            for t in range(1800):
                clock[0] = t
                backend.value = (40 if (t//10)%2 else 39)/100*9.8/10*4095
                reading = reader.read_if_updated()
                at = start + timedelta(seconds=t)
                monitor.tick(at)
                if reading:
                    self.assertEqual((reading.min_liters, reading.max_liters), (975, 1000))
                    monitor.observe(reading.level_liters, at.isoformat(), idle=True, now=at,
                                    min_liters=reading.min_liters, max_liters=reading.max_liters)
                    store.enqueue_tank_level(level_liters=reading.level_liters, occurred_at=at.isoformat(),
                                             min_liters=reading.min_liters, max_liters=reading.max_liters)
            state = store.inventory_state("site")
            self.assertIsNone(state["pending"])
            self.assertEqual(state["balanceAnchor"]["levelRange"], {"minLiters": 975, "maxLiters": 1000})
            self.assertGreater((datetime.fromisoformat(state["baseline"]["occurredAt"])-start).total_seconds(), 1700)
            levels = [json.loads(r[0]) for r in store.connection.execute("SELECT payload FROM outbox WHERE topic='web/level-reading'")]
            self.assertTrue(all("levelLiters" not in x and "levelRange" in x for x in levels))
            checks = [json.loads(r[0]) for r in store.connection.execute("SELECT payload FROM inventory_checks")]
            self.assertEqual(len(checks), 1)  # sólo el primer anclaje, sin alarmas por inestabilidad
            store.close()

    def test_two_level_range_excludes_a_third_pressure_peak(self):
        output = self.run_signal(lambda t: 45 if t%120<15 else 40 if (t//10)%2 else 39)
        ranges = [v for v in output if isinstance(v, OcioRange)]
        self.assertGreater(len(ranges), 0)
        self.assertTrue(all(v.low == 39 and v.high == 40 for v in ranges))
        self.assertTrue(all(output[t] is None for t in range(len(output)) if t%120<15))

    def test_actual_reader_to_inventory_detects_external_loss_amid_air_pulses(self):
        self.pipeline(theft=True)

    def pipeline(self, *, theft):
        backend, clock = AnalogBackend(), [0]
        reader = IndustrialShieldsTankLevelReader(
            pin="I0.2", version="RPIPLC_V6", model="RPIPLC_19R",
            capacity_liters=2500, signal_mode="0-10v", input_empty_volts=0,
            input_full_volts=9.8, sample_count=1, cycle_filter=OcioFilterConfig(),
            backend=backend, clock=lambda: clock[0],
        )
        start = datetime(2026, 9, 8, tzinfo=timezone.utc)
        with tempfile.TemporaryDirectory() as directory:
            store = EventStore(Path(directory)/"edge.db")
            monitor = InventoryMonitor(store, site_id="site", capacity_liters=2500,
                pulses_per_liter=100, calibration_id="cycle-filter-v1", k24_enabled=True, now=start)
            levels = []
            for t in range(1000):
                clock[0] = t
                liters = 980 if theft and t >= 420 else 1000
                backend.value = (liters/25 + (4 if t % 120 < 15 else 0)) / 100 * 9.8 / 10 * 4095
                reading = reader.read_if_updated()
                at = start + timedelta(seconds=t)
                monitor.tick(at)
                if reading:
                    levels.append(reading.level_liters)
                    monitor.observe(reading.level_liters, at.isoformat(), idle=True, now=at)
                store.record_ocio_diagnostics(reader.drain_diagnostics())
            store.record_ocio_diagnostics(reader.drain_diagnostics(force=True))
            alerts = [json.loads(r[0]) for r in store.connection.execute("SELECT payload FROM outbox WHERE topic='web/alert'")]
            losses = [a for a in alerts if "robo o fuga" in a["title"] or "extracción durante" in a["title"]]
            self.assertEqual(len(losses), 1 if theft else 0)
            self.assertLessEqual(max(levels), 1000)
            self.assertEqual(levels[-1], 980 if theft else 1000)
            diagnostics = [json.loads(r[0]) for r in store.connection.execute("SELECT payload FROM ocio_signal_diagnostics")]
            self.assertEqual(len(diagnostics), 1000)
            self.assertGreater(max(s["rawPercent"] for s in diagnostics), 40)
            self.assertIn("settling", {s["quality"] for s in diagnostics})
            store.close()

    def test_filter_configuration_rejects_values_that_erase_the_metastability_guard(self):
        for kwargs in ({"band_percent": 2}, {"window_seconds": 15}, {"quiet_seconds": 0},
                       {"support_fraction": .5}, {"enabled": "yes"}, {"window_seconds": float("nan")}):
            with self.assertRaises(ValueError):
                OcioFilterConfig(**kwargs)
