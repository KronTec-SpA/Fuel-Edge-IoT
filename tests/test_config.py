import tempfile
import unittest
from pathlib import Path

from fuel_edge.config import load_config


VALID_CONFIG = """
[identity]
module_id = "module-01"
site_id = "site-01"
[plc]
version = "RPIPLC_V6"
model = "RPIPLC_19R"
pump_relay = "R0.1"
[control]
start_timeout_seconds = 60
[k24]
pulses_per_liter = 100.0
[database]
path = "/tmp/fuel-edge-test.db"
"""


class ConfigTests(unittest.TestCase):
    def test_loads_selected_r01_and_safe_defaults(self) -> None:
        config = self._load(VALID_CONFIG)
        self.assertEqual(config.plc.pump_relay, "R0.1")
        self.assertEqual(config.plc.model, "RPIPLC_19R")
        self.assertEqual(config.control.k24_inactivity_seconds, 40)
        self.assertEqual(config.control.nfc_debounce_milliseconds, 300)
        self.assertEqual(config.control.nfc_presence_timeout_milliseconds, 2500)
        self.assertFalse(config.web_sync.enabled)
        self.assertFalse(config.tank_level.enabled)
        self.assertFalse(config.k24.enabled)

    def test_loads_physical_k24_input_and_rejects_analog_terminal(self) -> None:
        config = self._load(VALID_CONFIG.replace(
            "[k24]\npulses_per_liter = 100.0",
            '[k24]\nenabled = true\ninput_pin = "I0.0"\nactive_low = true\npoll_interval_milliseconds = 1.0\ndebounce_milliseconds = 1.5\npulses_per_liter = 100.0',
        ))
        self.assertTrue(config.k24.enabled)
        self.assertEqual(config.k24.input_pin, "I0.0")
        with self.assertRaisesRegex(ValueError, "I0.0 o I0.1"):
            self._load(VALID_CONFIG.replace(
                "[k24]\npulses_per_liter = 100.0",
                '[k24]\nenabled = true\ninput_pin = "I0.2"\npulses_per_liter = 100.0',
            ))

    def test_rejects_invalid_relay_name_before_hardware_access(self) -> None:
        with self.assertRaisesRegex(ValueError, "formato R0.1"):
            self._load(VALID_CONFIG.replace('"R0.1"', '"GPIO17"'))

    def test_requires_identity_and_positive_calibration(self) -> None:
        with self.assertRaisesRegex(ValueError, "module_id"):
            self._load(VALID_CONFIG.replace('module_id = "module-01"', 'module_id = ""'))
        with self.assertRaisesRegex(ValueError, "pulses_per_liter"):
            self._load(VALID_CONFIG.replace("100.0", "0"))

    def test_loads_enabled_mqtt_validator_configuration(self) -> None:
        config = self._load(
            VALID_CONFIG
            + """
[validator]
enabled = true
validator_id = "validator-01"
registry_path = "/etc/fuel-edge/validator-registry.toml"
proof_timeout_seconds = 5.0
[validator.mqtt]
host = "mqtt.internal"
port = 8883
ca_certificate = "/etc/fuel-edge/tls/ca.crt"
client_certificate = "/etc/fuel-edge/tls/rpi.crt"
client_key = "/etc/fuel-edge/tls/rpi.key"
"""
        )
        self.assertTrue(config.validator.enabled)
        self.assertEqual(config.validator.validator_id, "validator-01")
        self.assertEqual(config.validator.mqtt.host, "mqtt.internal")
        self.assertEqual(
            config.validator.equipment_registry_path,
            Path("/etc/fuel-edge/equipment-registry.toml"),
        )

    def test_rejects_timeouts_that_can_outlive_the_systemd_watchdog_budget(self) -> None:
        with self.assertRaisesRegex(ValueError, "proof_timeout_seconds"):
            self._load(
                VALID_CONFIG
                + """
[validator]
proof_timeout_seconds = 5.1
"""
            )
        with self.assertRaisesRegex(ValueError, "request_timeout_seconds"):
            self._load(
                VALID_CONFIG
                + """
[web_sync]
request_timeout_seconds = 5.1
"""
            )

    def test_enabled_validator_requires_complete_mqtt_configuration(self) -> None:
        with self.assertRaisesRegex(ValueError, "validator.mqtt"):
            self._load(
                VALID_CONFIG
                + """
[validator]
enabled = true
validator_id = "validator-01"
"""
            )

    def test_enabled_validator_rejects_topic_injection_in_identity(self) -> None:
        injected = (
            VALID_CONFIG.replace('site_id = "site-01"', 'site_id = "site/+"')
            + """
[validator]
enabled = true
validator_id = "validator-01"
[validator.mqtt]
host = "mqtt.internal"
ca_certificate = "ca.crt"
client_certificate = "rpi.crt"
client_key = "rpi.key"
"""
        )
        with self.assertRaisesRegex(ValueError, "identity.site_id"):
            self._load(injected)

    def test_accepts_only_local_web_sync_destination(self) -> None:
        config = self._load(VALID_CONFIG + """
[web_sync]
enabled = true
base_url = "http://127.0.0.1:8080"
sensor_key_path = "/tmp/web-sensor.key"
[tank_level]
enabled = true
reading_path = "/run/fuel-edge/level"
capacity_liters = 2500
""")
        self.assertTrue(config.web_sync.enabled)
        self.assertTrue(config.tank_level.enabled)
        with self.assertRaisesRegex(ValueError, "servicio local"):
            self._load(VALID_CONFIG + """
[web_sync]
enabled = true
base_url = "https://example.com"
""")

    def test_rejects_non_table_sections_cleanly(self) -> None:
        with self.assertRaisesRegex(ValueError, "tabla TOML"):
            self._load(
                'k24 = "broken"\n'
                + VALID_CONFIG.replace("[k24]\npulses_per_liter = 100.0\n", "")
            )

    def test_loads_installed_plc_analog_level_scaling(self) -> None:
        config = self._load(VALID_CONFIG + """
[tank_level]
enabled = true
source = "plc_analog"
telemetry_source = "PIUSI OCIO 4-20 mA vía convertidor 0-9.80 V"
capacity_liters = 2500
input_pin = "I0.2"
signal_mode = "0-10v"
input_empty_volts = 0
input_full_volts = 9.80
adc_full_scale = 4095
sample_count = 5
""")
        self.assertEqual(config.tank_level.source, "plc_analog")
        self.assertEqual(
            config.tank_level.telemetry_source,
            "PIUSI OCIO 4-20 mA vía convertidor 0-9.80 V",
        )
        self.assertEqual(config.tank_level.input_pin, "I0.2")
        self.assertEqual(config.tank_level.signal_mode, "0-10v")
        self.assertEqual(config.tank_level.input_empty_volts, 0)
        self.assertEqual(config.tank_level.input_full_volts, 9.80)
        self.assertEqual(config.tank_level.stability_seconds, 15)
        self.assertEqual(config.tank_level.stability_band_percent, 2)

    def test_rejects_unsafe_analog_configuration(self) -> None:
        with self.assertRaisesRegex(ValueError, "sample_count"):
            self._load(VALID_CONFIG + """
[tank_level]
source = "plc_analog"
sample_count = 4
""")
        with self.assertRaisesRegex(ValueError, "rango dentro de 0-10 V"):
            self._load(VALID_CONFIG + """
[tank_level]
source = "plc_analog"
input_empty_volts = 2
input_full_volts = 12
""")
        with self.assertRaisesRegex(ValueError, "I0.2, I0.3, I0.4 o I0.5"):
            self._load(VALID_CONFIG + """
[tank_level]
enabled = true
source = "plc_analog"
input_pin = "I0.0"
""")
        with self.assertRaisesRegex(ValueError, "stability_seconds"):
            self._load(VALID_CONFIG + """
[tank_level]
stability_seconds = -1
""")
        with self.assertRaisesRegex(ValueError, "stability_band_percent"):
            self._load(VALID_CONFIG + """
[tank_level]
stability_band_percent = 11
""")

    @staticmethod
    def _load(contents: str):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "config.toml"
            path.write_text(contents)
            return load_config(path)
