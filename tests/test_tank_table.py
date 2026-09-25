import json
import math
from pathlib import Path
import unittest

from fuel_edge.tank_table import FM2500_POINTS, FM2500_CURVE_ID, OcioHeightSignal, fm2500_volume_liters
from fuel_edge.tank_table import FIELD_CONVERSION, FIELD_FILL_POINTS, FIELD_CURVE_ID, field_volume_liters, table_volume_liters


class ManufacturerTankTableTests(unittest.TestCase):
    def test_all_published_points_match_verified_reference_exactly(self):
        source = json.loads((Path(__file__).resolve().parents[1] / 'docs/bfm02500dg-manual-4-2008.json').read_text())
        self.assertEqual(len(source['points']), 14)
        self.assertEqual(FM2500_POINTS, tuple((p['heightMm'], p['volumeLiters']) for p in source['points']))
        for point in source['points']:
            self.assertEqual(fm2500_volume_liters(point['heightMm']), point['volumeLiters'])

    def test_intermediate_values_and_monotonicity_without_overshoot(self):
        for h, v in ((440, 869), (450, 895), (460, 922)):
            self.assertEqual(fm2500_volume_liters(h), v)
        previous = fm2500_volume_liters(135)
        for h in range(136, 1126):
            value = fm2500_volume_liters(h)
            self.assertGreater(value, previous)
            self.assertLessEqual(value, 2497)
            previous = value

    def test_no_extrapolation_to_empty_nominal_full_or_outside_limits(self):
        for h in (0, 134.999, 1125.001, 1255, math.nan, math.inf, -math.inf):
            with self.subTest(height=h), self.assertRaises(ValueError):
                fm2500_volume_liters(h)

    def test_electrical_mapping_must_be_explicit_and_cover_table(self):
        for mapping in (OcioHeightSignal(), OcioHeightSignal('volume', 0, 4000),
                        OcioHeightSignal('linear_height', None, 4000),
                        OcioHeightSignal('linear_height', 1000, 0),
                        OcioHeightSignal('linear_height', 0, math.nan),
                        OcioHeightSignal('linear_height', 0, 1000)):
            with self.subTest(mapping=mapping), self.assertRaises(ValueError):
                mapping.validate()
        # Ejemplo matemático; no acredita el ajuste del OCIO instalado.
        mapping = OcioHeightSignal('linear_height', 0, 4000)
        self.assertEqual(mapping.height_mm(11.25), 450)
        for value in (-1, 101, math.nan):
            with self.assertRaises(ValueError):
                mapping.height_mm(value)

    def test_calibration_identity_changes_with_signal_scale(self):
        a = OcioHeightSignal('linear_height', 0, 4000).calibration_metadata()
        b = OcioHeightSignal('linear_height', 0, 2000).calibration_metadata()
        self.assertEqual(a['curveId'], FM2500_CURVE_ID)
        self.assertNotEqual(a, b)

    def test_controlled_fill_all_ten_points_and_linear_interpolation(self):
        expected = [(440,869),(510,1069),(580,1269),(660,1469),(730,1669),
                    (810,1869),(890,2069),(970,2269),(1070,2469),(1220,2662)]
        self.assertEqual(list(FIELD_FILL_POINTS), expected)
        for h, v in expected:
            self.assertEqual(field_volume_liters(h), v)
            self.assertEqual(table_volume_liters(FIELD_CONVERSION, h), v)
        self.assertAlmostEqual(field_volume_liters(475), 969)
        self.assertEqual(field_volume_liters(385), 726)
        values = [field_volume_liters(h) for h in range(135,1221)]
        self.assertEqual(values, sorted(values))
        self.assertNotEqual(FIELD_CURVE_ID, FM2500_CURVE_ID)
        self.assertEqual(fm2500_volume_liters(810), 1816)  # Fabricante intacto.

    def test_full_point_only_absorbs_substep_adc_noise_not_an_extra_step(self):
        for h in (1219.6,1220,1220.4,1224.9):
            self.assertEqual(table_volume_liters(FIELD_CONVERSION,h),2662)
        for h in (1225,1230,1300,134,math.nan,math.inf):
            with self.assertRaises(ValueError): table_volume_liters(FIELD_CONVERSION,h)
        for h in (1230,1220.1):
            with self.assertRaises(ValueError): field_volume_liters(h)
        self.assertLess(table_volume_liters(FIELD_CONVERSION,1210),2662)


if __name__ == '__main__':
    unittest.main()
