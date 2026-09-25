import importlib.util
from datetime import date
from pathlib import Path
import unittest
from zoneinfo import ZoneInfo


spec = importlib.util.spec_from_file_location(
    "ocio_field_analysis", Path(__file__).resolve().parents[1] / "tools" / "analyze_ocio_field.py"
)
analysis = importlib.util.module_from_spec(spec)
spec.loader.exec_module(analysis)


class OcioFieldAnalysisTests(unittest.TestCase):
    def test_exclusion_uses_chile_date_and_does_not_bridge_it(self):
        rows = [
            {"occurredAt": "2026-09-01T03:59:00Z", "levelLiters": 800},
            {"occurredAt": "2026-09-01T04:00:00Z", "levelLiters": 1500},
            {"occurredAt": "2026-09-02T03:59:59Z", "levelLiters": 100},
            {"occurredAt": "2026-09-02T04:00:00Z", "levelLiters": 700},
            {"occurredAt": "2026-09-02T04:01:00Z", "levelLiters": 701},
        ]
        result = analysis.summarize_series(rows, {date(2026, 9, 1)}, ZoneInfo("America/Santiago"))
        self.assertEqual(result["excludedByLocalDate"], {"2026-09-01": 2})
        self.assertEqual(result["retainedCount"], 3)
        self.assertEqual(result["adjacentPairsUnder180Seconds"], 1)
        self.assertEqual(result["absoluteChangeLiters"]["max"], 1)
        self.assertEqual(result["publicationGapSeconds"]["p90"], 60)

    def test_empty_excluded_day_still_breaks_gap_statistics(self):
        rows = [
            {"occurredAt": "2026-09-01T03:59:00Z", "levelLiters": 800},
            {"occurredAt": "2026-09-02T04:00:00Z", "levelLiters": 700},
        ]
        result = analysis.summarize_series(rows, {date(2026, 9, 1)}, ZoneInfo("America/Santiago"))
        self.assertIsNone(result["publicationGapSeconds"]["p50"])
        self.assertEqual(result["retainedCount"], 2)

    def test_new_boot_and_long_gap_are_not_fluctuation_pairs(self):
        rows = [
            {"occurredAt": "2026-09-08T12:00:00Z", "levelLiters": 800, "telemetrySessionId": "a"},
            {"occurredAt": "2026-09-08T12:01:00Z", "levelLiters": 700, "telemetrySessionId": "b"},
            {"occurredAt": "2026-09-08T12:10:00Z", "levelLiters": 600, "telemetrySessionId": "b"},
            {"occurredAt": "2026-09-08T12:11:00Z", "levelLiters": 601, "telemetrySessionId": "b"},
        ]
        result = analysis.summarize_series(rows, set(), ZoneInfo("America/Santiago"))
        self.assertEqual(result["adjacentPairsUnder180Seconds"], 1)
        self.assertEqual(result["absoluteChangeLiters"]["max"], 1)

    def test_exclusion_boundary_follows_santiago_summer_time(self):
        result = analysis.analyze({"capturedAt": "test", "hasRawDiagnostics": False, "edgeLevels": [], "webLevels": []}, {date(2026, 9, 8)}, ZoneInfo("America/Santiago"))
        self.assertEqual(result["excludedLocalDateIntervals"][0]["fromInclusive"], "2026-09-08T00:00:00-03:00")

    def test_rejects_ambiguous_timestamp_without_timezone(self):
        with self.assertRaises(ValueError):
            analysis.timestamp("2026-09-01T12:00:00")


if __name__ == "__main__":
    unittest.main()
