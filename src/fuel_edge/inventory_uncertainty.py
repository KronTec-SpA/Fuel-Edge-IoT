"""Cotas observadas + presupuesto explícito de error; no cambia el inventario.

Perfil OCIO M0073B: FS=4000 mm de agua; exactitud 1 % FS.
Densidad medida en terreno: 837,5 kg/m³ = 0,8375 kg/L (2026-09-09).
No sumar otra vez 0,5 % de repetibilidad a exactitud + oscilación observada.
No es un certificado metrológico del conjunto sensor/aforo/convertidor.
"""
import json
from math import floor, ceil
from .tank_table import FIELD_CURVE_ID, FIELD_POINTS, FIELD_CAPACITY_LITERS, field_volume_liters

POLICY_ID = 'ocio-observed-plus-error-v1-density-8375'
DENSITY_KG_L = 0.8375
OCIO_ERROR_MM = 4000 * .01 / DENSITY_KG_L
QUANTIZATION_HALF_STEP_MM = 5.0
K24_ERROR_FRACTION = .01

def applies(calibration_id: str) -> bool:
    try:return json.loads(calibration_id).get('curveId') == FIELD_CURVE_ID
    except (ValueError,AttributeError,TypeError):return False

def height_for_volume(liters: float) -> float:
    if liters < FIELD_POINTS[0][1] or liters > FIELD_CAPACITY_LITERS:
        raise ValueError('volumen fuera de la tabla aforada/publicada')
    for (h0,v0),(h1,v1) in zip(FIELD_POINTS,FIELD_POINTS[1:]):
        if v0 <= liters <= v1:return h0+(liters-v0)*(h1-h0)/(v1-v0)
    raise ValueError('volumen sin tramo')

def expanded_bounds(low: float, high: float) -> tuple[float,float]:
    """Ampliar los dos extremos, sin centrar ni promediar la oscilación.

    Fuera del aforo no extrapolar: abrir la cota al límite físico 0/capacidad.
    Redondeo hacia afuera conserva el carácter conservador del intervalo.
    """
    padding=OCIO_ERROR_MM+QUANTIZATION_HALF_STEP_MM
    lo=height_for_volume(low)-padding if low>=FIELD_POINTS[0][1] else -1
    hi=height_for_volume(high)+padding if high>=FIELD_POINTS[0][1] else FIELD_POINTS[0][0]+padding
    lower=0.0 if lo<FIELD_POINTS[0][0] else field_volume_liters(lo)
    upper=FIELD_CAPACITY_LITERS if hi>FIELD_POINTS[-1][0] else field_volume_liters(hi)
    return floor(lower*1000)/1000,ceil(upper*1000)/1000

def comparison(calibration_id: str, initial: tuple[float,float], observed: tuple[float,float],
               metered: float, received: float = 0) -> dict | None:
    if not applies(calibration_id):return None
    before_low,before_high=expanded_bounds(*initial)
    low,high=expanded_bounds(*observed)
    meter_error=abs(metered)*K24_ERROR_FRACTION
    expected_low=before_low+received-metered-meter_error
    expected_high=before_high+received-metered+meter_error
    return {'policyId':POLICY_ID,'densityKgL':DENSITY_KG_L,'densityVerified':True,
        'densitySource':'field_measurement_20260909',
        'ocioErrorMm':OCIO_ERROR_MM,'quantizationHalfStepMm':QUANTIZATION_HALF_STEP_MM,
        'k24ErrorLiters':meter_error,
        'expectedBounds':{'minLiters':expected_low,'maxLiters':expected_high},
        'measuredBounds':{'minLiters':low,'maxLiters':high},
        'differenceBounds':{'minLiters':floor((expected_low-high)*1000)/1000,
                            'maxLiters':ceil((expected_high-low)*1000)/1000}}
