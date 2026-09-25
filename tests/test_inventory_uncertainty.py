import json,unittest
from datetime import timedelta
from fuel_edge.inventory_uncertainty import comparison,expanded_bounds,OCIO_ERROR_MM
from fuel_edge.tank_table import FIELD_CURVE_ID,field_volume_liters
import test_inventory_monitor as fixtures

CAL=json.dumps({'curveId':FIELD_CURVE_ID})

class UncertaintyTests(unittest.TestCase):
    def test_expands_both_observed_extremes_not_the_midpoint(self):
        a,b=field_volume_liters(510),field_volume_liters(520)
        low,high=expanded_bounds(a,b)
        self.assertLess(low,a);self.assertGreater(high,b)
        self.assertAlmostEqual(low,field_volume_liters(510-OCIO_ERROR_MM-5),delta=.001)
        self.assertAlmostEqual(high,field_volume_liters(520+OCIO_ERROR_MM+5),delta=.001)

    def test_twenty_liters_inside_measurement_error_do_not_become_minimum_loss(self):
        r=comparison(CAL,(2662,2662),(2642,2642),0)
        self.assertLess(r['differenceBounds']['minLiters'],0)
        self.assertGreater(r['differenceBounds']['maxLiters'],20)

    def test_alarm_after_error_and_real_k24_are_both_accounted_for(self):
        r=comparison(CAL,(2662,2662),(2462,2462),20)
        self.assertGreater(r['differenceBounds']['minLiters'],20)
        self.assertEqual(r['k24ErrorLiters'],.2)
        self.assertEqual(r['densityKgL'],.8375)
        self.assertTrue(r['densityVerified'])
        self.assertEqual(r['densitySource'],'field_measurement_20260909')
        self.assertAlmostEqual(r['ocioErrorMm'],40/.8375)

    def test_domain_edges_are_physical_bounds_not_extrapolation(self):
        self.assertEqual(expanded_bounds(182,182)[0],0)
        self.assertEqual(expanded_bounds(2662,2662)[1],2662)
        self.assertIsNone(comparison('legacy',(100,100),(80,80),0))

class LocalUncertaintyTests(unittest.TestCase):
    setUp=fixtures.InventoryMonitorTests.setUp
    tearDown=fixtures.InventoryMonitorTests.tearDown
    monitor=fixtures.InventoryMonitorTests.monitor
    plateau=fixtures.InventoryMonitorTests.plateau
    observe=fixtures.InventoryMonitorTests.observe
    checks=fixtures.InventoryMonitorTests.checks
    def test_local_drop_and_restart_use_error_budget(self):
        monitor=self.monitor(calibration_id=CAL)
        self.plateau(monitor,2000,0)
        initial_checks=len(self.checks())
        self.plateau(monitor,1980,180)
        self.assertEqual(len(self.checks()),initial_checks)
        self.plateau(monitor,1600,360)
        self.assertEqual(self.checks()[-1]['reason'],'unmetered_drop')
        self.assertIn('uncertainty',self.checks()[-1])
        restored=self.monitor(600,calibration_id=CAL)
        self.plateau(restored,1590,610)
        self.assertEqual(self.checks()[-1]['status'],'within_uncertainty')
