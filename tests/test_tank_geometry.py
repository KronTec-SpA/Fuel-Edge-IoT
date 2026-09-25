import math
import unittest

from fuel_edge.tank_geometry import HorizontalTankGeometry


class TankGeometryTests(unittest.TestCase):
    def setUp(self):
        self.tank = HorizontalTankGeometry()

    def test_empty_half_full_and_symmetry(self):
        self.assertEqual(self.tank.volume_liters(0), 0)
        self.assertAlmostEqual(self.tank.volume_liters(627.5), 1250)
        self.assertAlmostEqual(self.tank.volume_liters(1255), 2500)
        for h in range(0, 1256, 5):
            self.assertAlmostEqual(self.tank.volume_liters(h)
                                   + self.tank.volume_liters(1255-h), 2500)

    def test_geometric_capacity_is_not_the_nominal_capacity(self):
        r = 627.5
        expected = (math.pi*r*r*1924 + 4*math.pi*168*r*r/3) / 1e6
        self.assertAlmostEqual(self.tank.geometric_capacity_liters, expected)
        self.assertGreater(expected, 2500)

    def test_matches_independent_numerical_horizontal_slice_integration(self):
        for h in (440, 450, 460, 1000, 1255):
            step = h / 20000
            numerical = 0
            for i in range(20000):
                z = (i + 0.5)*step - 627.5
                chord = 2*math.sqrt(max(0, 627.5**2-z*z))
                heads_slice = math.pi*168*627.5*(1-z*z/627.5**2)
                numerical += (1924*chord + heads_slice)*step/1e6
            self.assertAlmostEqual(self.tank.volume_liters(h, normalized=False), numerical, delta=0.001)

    def test_monotonicity_inverse_and_twenty_liter_loss(self):
        previous = -1
        for h in range(0, 1256):
            v = self.tank.volume_liters(h)
            self.assertGreater(v, previous)
            self.assertAlmostEqual(self.tank.height_mm(v), h, places=5)
            previous = v
        v = self.tank.volume_liters(450)
        drop = 450 - self.tank.height_mm(v-20)
        self.assertGreater(drop, 8)
        self.assertLess(drop, 9)

    def test_local_sensitivity_agrees_with_finite_difference(self):
        h, dh = 450, 0.001
        numeric = (self.tank.volume_liters(h+dh)-self.tank.volume_liters(h-dh))/(2*dh)
        self.assertAlmostEqual(self.tank.liters_per_mm(h), numeric, places=6)

    def test_output_modes_do_not_apply_geometry_twice(self):
        self.assertEqual(self.tank.ocio_volume_liters(50, output_mode="configured_tank_volume"), 1250)
        self.assertAlmostEqual(
            self.tank.ocio_volume_liters(11.25, output_mode="unconfigured_height_4000mm"),
            self.tank.volume_liters(450),
        )
        with self.assertRaises(ValueError):
            self.tank.ocio_volume_liters(50, output_mode="unconfigured_height_4000mm")
        cylinder = HorizontalTankGeometry(overall_length_mm=1924)
        for h in (0, 440, 450, 460, 627.5, 1000, 1255):
            percent = cylinder.volume_liters(h)/25
            corrected = self.tank.ocio_volume_liters(percent, output_mode="configured_horizontal_cylinder")
            self.assertAlmostEqual(corrected, self.tank.volume_liters(h), places=6)

    def test_invalid_values_are_rejected(self):
        for value in (-1, 1256, math.nan, math.inf):
            with self.assertRaises(ValueError):
                self.tank.volume_liters(value)
        with self.assertRaises(ValueError):
            HorizontalTankGeometry(overall_length_mm=100)
