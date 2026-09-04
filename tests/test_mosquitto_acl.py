from pathlib import Path
import unittest


ROOT = Path(__file__).resolve().parents[1]
ENROLLMENT_WRITE = (
    "topic write fuel-edge/v1/concha-y-toro-piloto/rpiplc-19r-01/"
    "validators/+/enrollment"
)
ENROLLMENT_READ = (
    "topic read fuel-edge/v1/concha-y-toro-piloto/rpiplc-19r-01/"
    "validators/validator-01/enrollment"
)
REGISTRY_WRITE = (
    "topic write fuel-edge/v1/concha-y-toro-piloto/rpiplc-19r-01/"
    "validators/+/registry"
)
REGISTRY_READ = (
    "topic read fuel-edge/v1/concha-y-toro-piloto/rpiplc-19r-01/"
    "validators/validator-01/registry"
)
OTA_COMMAND_WRITE = (
    "topic write fuel-edge/v1/concha-y-toro-piloto/rpiplc-19r-01/"
    "validators/+/ota/command"
)
OTA_COMMAND_READ = (
    "topic read fuel-edge/v1/concha-y-toro-piloto/rpiplc-19r-01/"
    "validators/validator-01/ota/command"
)
OTA_STATUS_WRITE = (
    "topic write fuel-edge/v1/concha-y-toro-piloto/rpiplc-19r-01/"
    "validators/validator-01/ota/status"
)


class MosquittoAclTests(unittest.TestCase):
    def test_production_acl_allows_enrollment_window(self) -> None:
        acl = (ROOT / "deploy/mosquitto/acl.example").read_text(encoding="utf-8")

        self.assertIn(ENROLLMENT_WRITE, acl)
        self.assertIn(ENROLLMENT_READ, acl)

    def test_incremental_acl_allows_enrollment_window(self) -> None:
        acl = (ROOT / "deploy/mosquitto/acl.bluetooth-calibration").read_text(
            encoding="utf-8"
        )

        self.assertIn(ENROLLMENT_WRITE, acl)
        self.assertIn(ENROLLMENT_READ, acl)

    def test_only_rpi_writes_registry_and_validator_reads_it(self) -> None:
        for relative in (
            "deploy/mosquitto/acl.example",
            "deploy/mosquitto/acl.bluetooth-calibration",
        ):
            acl = (ROOT / relative).read_text(encoding="utf-8")
            self.assertIn(REGISTRY_WRITE, acl)
            self.assertIn(REGISTRY_READ, acl)

    def test_ota_command_is_one_way_and_status_returns_to_rpi(self) -> None:
        for relative in (
            "deploy/mosquitto/acl.example",
            "deploy/mosquitto/acl.bluetooth-calibration",
        ):
            acl = (ROOT / relative).read_text(encoding="utf-8")
            self.assertIn(OTA_COMMAND_WRITE, acl)
            self.assertIn(OTA_COMMAND_READ, acl)
            self.assertIn(OTA_STATUS_WRITE, acl)
