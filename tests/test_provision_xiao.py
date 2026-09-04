from __future__ import annotations

from pathlib import Path
import subprocess
import sys
import tempfile
import tomllib
import unittest


ROOT = Path(__file__).resolve().parents[1]
PROVISION_XIAO = ROOT / "tools" / "provision_xiao.py"


class ProvisionXiaoTests(unittest.TestCase):
    def test_rejects_identifier_longer_than_firmware_limit(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            registry = root / "equipment-registry.toml"
            header = root / "equipment_secrets.h"
            too_long = "m" * 64

            completed = subprocess.run(
                [
                    sys.executable,
                    str(PROVISION_XIAO),
                    too_long,
                    "--header",
                    str(header),
                    "--registry",
                    str(registry),
                ],
                text=True,
                capture_output=True,
                check=False,
            )

            self.assertNotEqual(completed.returncode, 0)
            self.assertIn("module_id inválido", completed.stdout + completed.stderr)
            self.assertFalse(header.exists())
            self.assertFalse(registry.exists())

    def test_rejects_structurally_duplicate_module_id_without_mutating_files(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            registry = root / "equipment-registry.toml"
            header = root / "equipment_secrets.h"
            original = (
                "[[modules]]\n"
                'module_id="equipment-module-001"\n'
                f'secret_hex="{"00" * 32}"\n'
                "active=true\n"
            )
            registry.write_text(original, encoding="utf-8")
            registry.chmod(0o600)

            completed = subprocess.run(
                [
                    sys.executable,
                    str(PROVISION_XIAO),
                    "equipment-module-001",
                    "--header",
                    str(header),
                    "--registry",
                    str(registry),
                ],
                text=True,
                capture_output=True,
                check=False,
            )

            self.assertNotEqual(completed.returncode, 0)
            self.assertIn(
                "el module_id ya existe en el registro",
                completed.stdout + completed.stderr,
            )
            self.assertEqual(registry.read_text(encoding="utf-8"), original)
            self.assertFalse(header.exists())

    def test_appends_a_distinct_module_to_valid_toml(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            registry = root / "equipment-registry.toml"
            header = root / "equipment_secrets.h"
            registry.write_text(
                "[[modules]]\n"
                'module_id="equipment-module-001"\n'
                f'secret_hex="{"00" * 32}"\n'
                "active=true\n",
                encoding="utf-8",
            )
            registry.chmod(0o600)

            subprocess.run(
                [
                    sys.executable,
                    str(PROVISION_XIAO),
                    "equipment-module-002",
                    "--header",
                    str(header),
                    "--registry",
                    str(registry),
                ],
                text=True,
                capture_output=True,
                check=True,
            )

            with registry.open("rb") as source:
                modules = tomllib.load(source)["modules"]
            self.assertEqual(
                [module["module_id"] for module in modules],
                ["equipment-module-001", "equipment-module-002"],
            )
            self.assertTrue(header.is_file())
            generated = header.read_text(encoding="utf-8")
            self.assertIn("#define CONFIG_BUTTON_PIN D1", generated)
            self.assertIn(
                "#define OPERATIONAL_ADVERTISE_WINDOW_SECONDS 60", generated
            )
            self.assertIn("#define BLE_TX_POWER_DBM 20", generated)
            self.assertNotIn("BATTERY", generated)


if __name__ == "__main__":
    unittest.main()
