from __future__ import annotations

import unittest
from pathlib import Path
import re
import xml.etree.ElementTree as ET

from fuel_edge.main import MAX_BOUNDED_CONTROL_OPERATION_SECONDS


PROJECT_ROOT = Path(__file__).resolve().parents[1]


class DeployHardeningTests(unittest.TestCase):
    def test_local_web_name_is_published_without_replacing_ip_access(self) -> None:
        setup = (PROJECT_ROOT / "deploy/setup-local-web-name.sh").read_text(
            encoding="utf-8"
        )
        nginx = (
            PROJECT_ROOT / "deploy/nginx/fuel-edge-web-http-local.conf"
        ).read_text(encoding="utf-8")
        avahi_service = PROJECT_ROOT / "deploy/avahi/fuel-edge-web.service"

        self.assertIn("host_label=${1:-fueledge}", setup)
        self.assertIn("dns_name=${2:-fueledge.conchaytoro}", setup)
        self.assertIn("hostnamectl set-hostname \"$host_label\"", setup)
        self.assertIn("systemctl enable --now avahi-daemon", setup)
        self.assertIn("MDNS_NAME=active", setup)
        self.assertIn("IP_FALLBACK=active", setup)
        self.assertIn("DNS_NAME=requires_local_dns", setup)
        self.assertIn("fueledge.local", nginx)
        self.assertIn("fueledge.conchaytoro", nginx)
        self.assertIn("10.10.10.20", nginx)

        root = ET.parse(avahi_service).getroot()
        service = root.find("service")
        self.assertIsNotNone(service)
        assert service is not None
        self.assertEqual(service.findtext("type"), "_http._tcp")
        self.assertEqual(service.findtext("port"), "80")

    def test_edge_service_recovers_crashes_and_hangs_without_start_limit(self) -> None:
        unit = (PROJECT_ROOT / "deploy/systemd/fuel-edge.service").read_text(
            encoding="utf-8"
        )

        for directive in (
            "Wants=mosquitto.service",
            "After=local-fs.target network-online.target mosquitto.service",
            "StartLimitIntervalSec=0",
            "Type=notify",
            "NotifyAccess=main",
            "Restart=always",
            "OOMPolicy=kill",
        ):
            self.assertIn(directive, unit)
        watchdog = re.search(r"^WatchdogSec=(\d+(?:\.\d+)?)$", unit, re.MULTILINE)
        self.assertIsNotNone(watchdog)
        assert watchdog is not None
        self.assertGreater(
            float(watchdog.group(1)),
            2 * MAX_BOUNDED_CONTROL_OPERATION_SECONDS,
        )

    def test_mosquitto_recovery_drop_in_is_installed_by_every_edge_installer(self) -> None:
        drop_in = (
            PROJECT_ROOT / "deploy/systemd/mosquitto-fuel-edge.conf"
        ).read_text(encoding="utf-8")
        self.assertIn("StartLimitIntervalSec=0", drop_in)
        self.assertIn("Restart=always", drop_in)

        for script_name in (
            "install.sh",
            "first-boot-install.sh",
            "setup-validator-mqtt.sh",
        ):
            script = (PROJECT_ROOT / "deploy" / script_name).read_text(
                encoding="utf-8"
            )
            with self.subTest(script=script_name):
                self.assertIn("mosquitto-fuel-edge.conf", script)
                self.assertIn("fuel-edge-recovery.conf", script)

        for script_name in ("install.sh", "first-boot-install.sh"):
            script = (PROJECT_ROOT / "deploy" / script_name).read_text(
                encoding="utf-8"
            )
            with self.subTest(watchdog_package_guard=script_name):
                self.assertIn(
                    "from fuel_edge.systemd_notify import SystemdNotifier", script
                )

    def test_validator_auxiliary_services_never_exhaust_restart_attempts(self) -> None:
        for unit_name in (
            "fuel-validator-ota.service",
            "fuel-equipment-enrollment.service",
        ):
            with self.subTest(unit=unit_name):
                unit = (PROJECT_ROOT / "deploy" / "systemd" / unit_name).read_text(
                    encoding="utf-8"
                )
                self.assertIn("StartLimitIntervalSec=0", unit)
                self.assertIn("Restart=always", unit)

    def test_mqtt_setup_checks_service_mtls_and_acl(self) -> None:
        script = (PROJECT_ROOT / "deploy/setup-validator-mqtt.sh").read_text(
            encoding="utf-8"
        )
        self.assertIn("systemctl is-active --quiet mosquitto", script)
        self.assertIn("mosquitto_pub -h 127.0.0.1 -p 8883", script)
        self.assertIn("validator-health-probe/challenge", script)

    def test_private_wifi_reconnects_forever_without_power_saving(self) -> None:
        script = (PROJECT_ROOT / "deploy/setup-validator-wifi-ap.sh").read_text(
            encoding="utf-8"
        )
        self.assertIn("connection.autoconnect-retries 0", script)
        self.assertIn("802-11-wireless.powersave 2", script)

    def test_ups_hook_records_power_loss_with_a_bounded_runtime(self) -> None:
        hook = (PROJECT_ROOT / "deploy/rpishutdown/pre-poweroff").read_text(
            encoding="utf-8"
        )
        self.assertIn("timeout 4s", hook)
        self.assertIn("fuel_edge.power_events", hook)
        self.assertIn("record-loss --source ups_gpio24", hook)
        self.assertTrue(hook.rstrip().endswith("exit 0"))

        for script_name in ("install.sh", "first-boot-install.sh"):
            script = (PROJECT_ROOT / "deploy" / script_name).read_text(
                encoding="utf-8"
            )
            with self.subTest(installer=script_name):
                self.assertIn("deploy/rpishutdown/pre-poweroff", script)
                self.assertIn("fuel_edge.power_events", script)


if __name__ == "__main__":
    unittest.main()
