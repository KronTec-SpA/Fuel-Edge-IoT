import os
import tempfile
import unittest
from pathlib import Path

from fuel_edge.tank_level import TankLevelFileReader


class TankLevelFileReaderTests(unittest.TestCase):
    def test_reads_each_valid_version_once(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "level"
            path.write_text("1450.25\n", encoding="ascii")
            reader = TankLevelFileReader(path, 2500)
            reading = reader.read_if_updated()
            self.assertEqual(reading.level_liters, 1450.25)
            self.assertIsNone(reader.read_if_updated())
            path.write_text("1460\n", encoding="ascii")
            os.utime(path, ns=(path.stat().st_atime_ns, path.stat().st_mtime_ns + 1_000_000))
            self.assertEqual(reader.read_if_updated().level_liters, 1460)

    def test_rejects_invalid_and_symlinked_readings(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "source"
            source.write_text("2600", encoding="ascii")
            reader = TankLevelFileReader(source, 2500)
            with self.assertRaisesRegex(ValueError, "capacidad"):
                reader.read_if_updated()
            link = Path(directory) / "link"
            link.symlink_to(source)
            with self.assertRaisesRegex(ValueError, "archivo regular"):
                TankLevelFileReader(link, 2500).read_if_updated()
