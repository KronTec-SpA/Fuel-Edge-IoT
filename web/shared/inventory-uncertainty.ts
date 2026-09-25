// Espejo validado de fuel_edge/inventory_uncertainty.py. No cambia las lecturas.
export type UncertaintyBounds={minLiters:number;maxLiters:number};
const CURVE_ID='field-copec-20260909-linear-v1-b0a652dc4528beeb';
const POINTS=[[135,182],[225,363],[310,545],[385,726],[440,869],[510,1069],
  [580,1269],[660,1469],[730,1669],[810,1869],[890,2069],[970,2269],[1070,2469],[1220,2662]];
// 837,5 kg/m³ medidos en terreno y confirmados el 2026-09-09.
const DENSITY=0.8375, ERROR_MM=4000*.01/DENSITY, HALF_STEP_MM=5;
function height(liters:number){
  if(liters<182||liters>2662)throw new Error('Volumen fuera de tabla');
  for(let i=1;i<POINTS.length;i++){
    const [h0,v0]=POINTS[i-1],[h1,v1]=POINTS[i];
    if(liters>=v0&&liters<=v1)return h0+(liters-v0)*(h1-h0)/(v1-v0);
  }
  throw new Error('Volumen sin tramo');
}
function volume(h:number){
  for(let i=1;i<POINTS.length;i++){
    const [h0,v0]=POINTS[i-1],[h1,v1]=POINTS[i];
    if(h>=h0&&h<=h1)return v0+(h-h0)*(v1-v0)/(h1-h0);
  }
  throw new Error('Altura sin tramo');
}
export function expandedOcioBounds(bounds:UncertaintyBounds):UncertaintyBounds{
  const lo=bounds.minLiters>=182?height(bounds.minLiters)-ERROR_MM-HALF_STEP_MM:-1;
  const hi=bounds.maxLiters>=182?height(bounds.maxLiters)+ERROR_MM+HALF_STEP_MM:135+ERROR_MM+HALF_STEP_MM;
  return {minLiters:Math.floor((lo<135?0:volume(lo))*1000)/1000,
    maxLiters:Math.ceil((hi>1220?2662:volume(hi))*1000)/1000};
}
export function comparisonUncertainty(calibrationId:string,initial:UncertaintyBounds,observed:UncertaintyBounds,metered:number,received=0){
  try {if(JSON.parse(calibrationId)?.curveId!==CURVE_ID)return null;}catch{return null;}
  const before=expandedOcioBounds(initial),measuredBounds=expandedOcioBounds(observed);
  const k24ErrorLiters=Math.abs(metered)*.01;
  const expectedBounds={minLiters:before.minLiters+received-metered-k24ErrorLiters,
    maxLiters:before.maxLiters+received-metered+k24ErrorLiters};
  return {policyId:'ocio-observed-plus-error-v1-density-8375',densityKgL:DENSITY,densityVerified:true,
    densitySource:'field_measurement_20260909',
    ocioErrorMm:ERROR_MM,quantizationHalfStepMm:HALF_STEP_MM,k24ErrorLiters,expectedBounds,measuredBounds,
    differenceBounds:{minLiters:Math.floor((expectedBounds.minLiters-measuredBounds.maxLiters)*1000)/1000,
      maxLiters:Math.ceil((expectedBounds.maxLiters-measuredBounds.minLiters)*1000)/1000}};
}
