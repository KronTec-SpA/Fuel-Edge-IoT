from __future__ import annotations

import os
import tempfile
import unittest
from pathlib import Path

from fuel_edge.validator_registry import load_validator_registry


REGISTRY = """
[[credentials]]
credential_id = "card-01"
operator_id = "operator-01"
secret_hex = "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f"
credential_active = true
operator_active = true
is_master = false

[[equipment]]
equipment_id = "tractor-01"
active = true
assignment_valid_until = "2027-01-01T00:00:00+00:00"

[[associations]]
operator_id = "operator-01"
equipment_id = "tractor-01"
active = true
"""


class ValidatorRegistryTests(unittest.TestCase):
    def test_loads_private_credentials_and_local_association(self) -> None:
        path = self._write(REGISTRY, 0o600)

        registry = load_validator_registry(path)

        credential = registry.credentials.get("card-01")
        self.assertIsNotNone(credential)
        self.assertEqual(credential.operator_id, "operator-01")
        evidence = registry.directory.resolve_equipment(
            "operator-01",
            type(
                "Observation",
                (),
                {
                    "equipment_id": "tractor-01",
                    "present": True,
                    "authenticated": True,
                },
            )(),
        )
        self.assertTrue(evidence.association_active)

    def test_rejects_registry_readable_by_group_or_others(self) -> None:
        path = self._write(REGISTRY, 0o644)
        with self.assertRaises(PermissionError):
            load_validator_registry(path)

    def test_rejects_more_than_one_active_master(self) -> None:
        second_master = REGISTRY.replace(
            "is_master = false", "is_master = true"
        ) + REGISTRY.replace(
            'credential_id = "card-01"', 'credential_id = "card-02"'
        ).replace("is_master = false", "is_master = true")
        path = self._write(second_master, 0o600)
        with self.assertRaisesRegex(ValueError, "maestra activa"):
            load_validator_registry(path)

    def _write(self, contents: str, mode: int) -> Path:
        directory = tempfile.mkdtemp()
        self.addCleanup(lambda: __import__("shutil").rmtree(directory))
        path = Path(directory) / "registry.toml"
        path.write_text(contents)
        os.chmod(path, mode)
        return path


if __name__ == "__main__":
    unittest.main()
