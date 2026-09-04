import unittest

from fuel_edge.hardware.industrial_shields import (
    AnalogInputError,
    IndustrialShieldsK24Reader,
    IndustrialShieldsRelay,
    IndustrialShieldsTankLevelReader,
    RelayIOError,
)


class FakeRpiplc:
    OUTPUT = "output"
    HIGH = 1
    LOW = 0

    def __init__(self) -> None:
        self.calls = []
        self.write_result = 0

    def init(self, version, model, restart=False):
        self.calls.append(("init", version, model, restart))
        return 0

    def pin_mode(self, pin, mode):
        self.calls.append(("pin_mode", pin, mode))
        return 0

    def digital_write(self, pin, value):
        self.calls.append(("digital_write", pin, value))
        return self.write_result


class IndustrialShieldsRelayTests(unittest.TestCase):
    def test_r01_starts_low_then_can_close_and_open_circuit(self) -> None:
        backend = FakeRpiplc()
        relay = IndustrialShieldsRelay(backend=backend)

        self.assertEqual(
            backend.calls[:3],
            [
                ("init", "RPIPLC_V6", "RPIPLC_19R", False),
                ("pin_mode", "R0.1", "output"),
                ("digital_write", "R0.1", 0),
            ],
        )
        self.assertFalse(relay.is_energized)

        relay.energize()
        self.assertEqual(backend.calls[-1], ("digital_write", "R0.1", 1))
        self.assertTrue(relay.is_energized)

        relay.close()
        self.assertEqual(backend.calls[-1], ("digital_write", "R0.1", 0))
        self.assertFalse(relay.is_energized)

    def test_failed_write_does_not_claim_energized_state(self) -> None:
        backend = FakeRpiplc()
        relay = IndustrialShieldsRelay(backend=backend)
        backend.write_result = -1

        with self.assertRaises(RelayIOError):
            relay.energize()
        self.assertFalse(relay.is_energized)


class FakeDigitalInputBackend:
    INPUT = 0

    def __init__(self, values: list[int]) -> None:
        self.values = iter(values)
        self.calls: list[tuple[object, ...]] = []

    def init(self, version: str, model: str, *, restart: bool) -> int:
        self.calls.append(("init", version, model, restart))
        return 0

    def pin_mode(self, pin: str, mode: int) -> int:
        self.calls.append(("pin_mode", pin, mode))
        return 0

    def digital_read(self, pin: str) -> int:
        self.calls.append(("digital_read", pin))
        return next(self.values)


class IndustrialShieldsK24ReaderTests(unittest.TestCase):
    def test_counts_debounced_active_low_reed_edges(self) -> None:
        backend = FakeDigitalInputBackend([1, 0, 0, 1, 0])
        reader = IndustrialShieldsK24Reader(
            pin="I0.0",
            version="RPIPLC_V6",
            model="RPIPLC_19R",
            active_low=True,
            debounce_milliseconds=1.5,
            backend=backend,
            autostart=False,
        )

        self.assertTrue(reader.poll_once(0.001))
        self.assertFalse(reader.poll_once(0.0015))
        self.assertFalse(reader.poll_once(0.003))
        self.assertTrue(reader.poll_once(0.005))
        self.assertEqual(reader.drain_pulses(), 2)
        self.assertEqual(reader.drain_pulses(), 0)
        reader.close()

    def test_rejects_invalid_digital_level(self) -> None:
        with self.assertRaisesRegex(Exception, "nivel inválido"):
            IndustrialShieldsK24Reader(
                pin="I0.0", version="RPIPLC_V6", model="RPIPLC_19R",
                backend=FakeDigitalInputBackend([2]), autostart=False,
            )

class FakeAnalogBackend:
    INPUT = 0

    def __init__(self, values: list[int], *, init_result: int = 0) -> None:
        self.values = iter(values)
        self.init_result = init_result
        self.calls: list[tuple[object, ...]] = []

    def init(self, version: str, model: str, *, restart: bool) -> int:
        self.calls.append(("init", version, model, restart))
        return self.init_result

    def pin_mode(self, pin: str, mode: int) -> int:
        self.calls.append(("pin_mode", pin, mode))
        return 0

    def analog_read(self, pin: str) -> int:
        self.calls.append(("analog_read", pin))
        return next(self.values)


class IndustrialShieldsTankLevelReaderTests(unittest.TestCase):
    def test_requires_a_stable_window_before_publishing_level_changes(self) -> None:
        levels = [50] * 4 + [60] * 3 + [50] * 4 + [40] * 4
        # El período deliberadamente no divide la ventana: reproduce la deriva
        # de ~0,253 s observada en el bucle real de la Raspberry.
        times = iter(value * 1.01 for value in range(len(levels)))
        reader = IndustrialShieldsTankLevelReader(
            pin="I0.2",
            version="RPIPLC_V6",
            model="RPIPLC_19R",
            capacity_liters=100,
            signal_mode="0-10v",
            input_empty_volts=0,
            input_full_volts=10,
            adc_full_scale=100,
            sample_count=1,
            stability_seconds=3,
            stability_band_percent=1,
            backend=FakeAnalogBackend(levels),
            clock=lambda: next(times),
        )

        readings = [reader.read_if_updated() for _ in levels]

        self.assertEqual(readings[3].level_liters, 50)
        self.assertTrue(all(reading is None for reading in readings[4:14]))
        self.assertEqual(readings[14].level_liters, 40)

    def test_scales_4_20ma_via_2_10v_to_percentage_and_liters(self) -> None:
        # 2457/4095*10 = 6 V: midpoint of 2-10 V => 50% => 1250 L.
        backend = FakeAnalogBackend([2457] * 5)
        reader = IndustrialShieldsTankLevelReader(
            pin="I0.2",
            version="RPIPLC_V6",
            model="RPIPLC_19R",
            capacity_liters=2500,
            signal_mode="4-20ma",
            input_empty_volts=2,
            input_full_volts=10,
            backend=backend,
        )
        reading = reader.read_if_updated()
        self.assertAlmostEqual(reading.level_liters, 1250.0, places=3)
        self.assertEqual(reading.source, "OCIO 4-20 mA")
        self.assertEqual(backend.calls[1], ("pin_mode", "I0.2", 0))

    def test_detects_open_4_20ma_loop_instead_of_reporting_empty(self) -> None:
        backend = FakeAnalogBackend([0] * 5)
        reader = IndustrialShieldsTankLevelReader(
            pin="I0.2",
            version="RPIPLC_V6",
            model="RPIPLC_19R",
            capacity_liters=2500,
            signal_mode="4-20ma",
            input_empty_volts=2,
            input_full_volts=10,
            backend=backend,
        )
        with self.assertRaisesRegex(AnalogInputError, "lazo OCIO abierto"):
            reader.read_if_updated()

    def test_scales_native_0_10v(self) -> None:
        backend = FakeAnalogBackend([2048])
        reader = IndustrialShieldsTankLevelReader(
            pin="I0.2",
            version="RPIPLC_V6",
            model="RPIPLC_19R",
            capacity_liters=2500,
            signal_mode="0-10v",
            input_empty_volts=0,
            input_full_volts=10,
            sample_count=1,
            backend=backend,
        )
        self.assertAlmostEqual(reader.read_if_updated().level_liters, 1250.305, places=3)

    def test_scales_installed_0_to_9_80v_calibration(self) -> None:
        # 9,80 V cae entre 4013 y 4014; 4014/4095*10 supera el fondo y satura a 100 %.
        backend = FakeAnalogBackend([0, 4014])
        reader = IndustrialShieldsTankLevelReader(
            pin="I0.2",
            version="RPIPLC_V6",
            model="RPIPLC_19R",
            capacity_liters=2500,
            signal_mode="0-10v",
            source_label="PIUSI OCIO 4-20 mA vía convertidor 0-9.80 V",
            input_empty_volts=0,
            input_full_volts=9.80,
            sample_count=1,
            deadband_percent=0,
            backend=backend,
        )
        self.assertEqual(reader.read_if_updated().level_liters, 0)
        full_reading = reader.read_if_updated()
        self.assertEqual(full_reading.level_liters, 2500)
        self.assertEqual(
            full_reading.source,
            "PIUSI OCIO 4-20 mA vía convertidor 0-9.80 V",
        )
