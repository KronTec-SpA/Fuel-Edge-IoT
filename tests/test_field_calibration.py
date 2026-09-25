"""Calibración por dos referencias y protección frente a pulsos neumáticos."""
import unittest
from fuel_edge.hardware.industrial_shields import IndustrialShieldsTankLevelReader
from fuel_edge.ocio_filter import OcioFilterConfig, OcioRange
from fuel_edge.tank_table import OcioHeightSignal, FIELD_CONVERSION

class Backend:
    INPUT=0
    raw=3329
    def init(self,*a,**kw): return 0
    def pin_mode(self,*a): return 0
    def analog_read(self,*a): return self.raw

def reader_for(backend,clock,filtered=True):
    v0,v1=1169*10/4095,3329*10/4095
    slope=(1220-440)/(v1-v0)
    offset=440-slope*v0
    return IndustrialShieldsTankLevelReader(
        pin='I0.2',version='RPIPLC_V6',model='RPIPLC_19R',capacity_liters=2662,
        signal_mode='0-10v',input_empty_volts=0,input_full_volts=9.8,sample_count=1,
        volume_conversion=FIELD_CONVERSION,ocio_height_signal=OcioHeightSignal('linear_height',offset,offset+9.8*slope),
        cycle_filter=OcioFilterConfig() if filtered else None,backend=backend,clock=lambda:clock[0])

class FieldCalibrationTests(unittest.TestCase):
    def test_both_observed_adc_anchors(self):
        backend,clock=Backend(),[0]
        reader=reader_for(backend,clock,False)
        backend.raw=1169
        self.assertEqual(reader.read_if_updated().level_liters,869)
        backend.raw=3329;clock[0]=61
        self.assertEqual(reader.read_if_updated().level_liters,2662)

    def test_full_adc_jitter_and_repeated_fifteen_second_pressure_spikes(self):
        backend,clock=Backend(),[0]
        reader=reader_for(backend,clock)
        published=[]
        for t in range(600):
            clock[0]=t
            backend.raw=3600 if t%180<15 else 3329+(t%3-1)
            reading=reader.read_if_updated()
            if reading: published.append(reading)
        self.assertGreater(len(published),3)
        self.assertTrue(all(p.level_liters==2662 for p in published))
        self.assertFalse(any(p.min_liters is not None for p in published))
        self.assertAlmostEqual(reader.ocio_height_signal.height_mm(3329*10/4095/9.8*100),1220)

    def test_real_persistent_drop_is_not_hidden_by_full_reference(self):
        backend,clock=Backend(),[0]
        reader=reader_for(backend,clock)
        levels=[]
        for t in range(500):
            clock[0]=t
            backend.raw=3329 if t<200 else 3329-20*(3329-1169)/(1220-440)
            p=reader.read_if_updated()
            if p: levels.append(p.level_liters)
        self.assertEqual(levels[0],2662)
        self.assertLess(levels[-1],2640)

    def test_two_adc_modes_inside_one_height_step_publish_a_point(self):
        reader=reader_for(Backend(),[0],False)
        reading=reader._publish_range(OcioRange(3328*10/4095/9.8*100,3330*10/4095/9.8*100),0)
        self.assertEqual(reading.level_liters,2662)
        self.assertIsNone(reading.min_liters)
        self.assertEqual(reader.quality_update()['quality'],'valid')
