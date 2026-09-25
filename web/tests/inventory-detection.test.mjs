import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createLocalD1} from '../runtime/local-d1.mjs';

const context={waitUntil(){},passThroughOnException(){}};
const FIELD=JSON.stringify({curveId:'field-copec-20260909-linear-v1-b0a652dc4528beeb'});
async function harness(run,field=false){
  const dir=await mkdtemp(join(tmpdir(),'inventory-policy-v2-'));
  const db=createLocalD1(join(dir,'db.sqlite3'));globalThis.__FUEL_EDGE_LOCAL_DB__=db;
  const worker=(await import(`../dist/server/index.js?policy=${Math.random()}`)).default;
  const env={FUEL_SENSOR_INGEST_KEY:'policy-v2-only-test-key-123456789',FUEL_SITE_ID:'site'};
  const origin=Date.parse('2026-09-01T12:00:00Z');
  const anchor={id:'fixed',levelLiters:field?2662:1000,pulses:0,occurredAt:new Date(origin).toISOString(),
    calibrationId:field?FIELD:'test',capacityLiters:2662,pulsesPerLiter:100};
  const make=(minute,level,pulses=0,extra={})=>({id:`sample-${minute}`,siteId:'site',anchor,occurredAt:new Date(origin+minute*60000).toISOString(),
    measuredLiters:level,pulsesTotal:pulses,calibrationId:anchor.calibrationId,pulsesPerLiter:100,meterHealthy:true,...extra});
  const post=async body=>{const r=await worker.fetch(new Request('http://localhost/api/inventory-balance/edge',{method:'POST',headers:{'content-type':'application/json','x-edge-sensor-key':env.FUEL_SENSOR_INGEST_KEY},body:JSON.stringify(body)}),env,context);const j=await r.json();assert.equal(r.status,201,JSON.stringify(j));return j;};
  const send=(minute,level,pulses=0,extra={})=>post(make(minute,level,pulses,extra));
  const series=async(start,end,level,pulses=0)=>{let last;for(let i=start;i<=end;i++)last=await send(i,typeof level==='function'?level(i):level,typeof pulses==='function'?pulses(i):pulses);return last;};
  const alerts=async()=> (await db.prepare('SELECT * FROM system_alerts ORDER BY rowid').all()).results;
  try{await send(0,anchor.levelLiters);await run({db,send,series,post,make,alerts,worker,env,anchor});}
  finally{delete globalThis.__FUEL_EDGE_LOCAL_DB__;db.close();await rm(dir,{recursive:true,force:true});}
}

test('una caída grave necesita tres muestras; reintentos no aceleran ni duplican',()=>harness(async({send,post,make,alerts})=>{
  await send(1,800);await post(make(1,800));await post(make(1,800));assert.equal((await alerts()).length,0);
  await send(2,800);assert.equal((await alerts()).length,0);
  await send(3,800);const a=await alerts();assert.equal(a.length,1);assert.equal(a[0].priority,'urgent');
  await send(4,700);await send(5,700);assert.equal((await alerts()).length,1);
}));

test('caída transitoria no notifica; escalón persistente genera un solo incidente',()=>harness(async({series,send,alerts})=>{
  await series(1,9,1000);await send(10,950);await series(11,29,1000);assert.equal((await alerts()).length,0);
  await series(30,50,950);const a=await alerts();assert.equal(a.length,1);assert.equal(a[0].priority,'high');
  await series(51,80,920);assert.equal((await alerts()).length,1);
}));

test('descensos pequeños acumulados mantienen el ancla y finalmente alertan',()=>harness(async({series,alerts,anchor})=>{
  const result=await series(1,80,i=>1000-Math.floor(i/10)*5);
  assert.equal(result.anchor.levelLiters,anchor.levelLiters);assert.equal((await alerts()).length,1);
  assert.equal(result.latest.observedDifferenceLiters,40);
}));

test('consumo autorizado y errores de medición conservadores no se convierten en pérdida',()=>harness(async({series,alerts})=>{
  await series(1,30,i=>2662-i*2,i=>i*200);assert.equal((await alerts()).length,0);
  await series(31,60,2582,6000);assert.equal((await alerts()).length,0); // 20 L dentro del margen real.
},true));

test('gran pérdida real de la curva de terreno alerta y conserva márgenes',()=>harness(async({series,alerts})=>{
  const result=await series(1,3,2262);assert.equal((await alerts()).length,1);
  assert.equal((await alerts())[0].priority,'urgent');assert.ok(result.latest.uncertainty);
},true));

test('faltante residual moderado de terreno se confirma en dos ventanas y se agrupa',()=>harness(async({series,alerts})=>{
  await series(1,9,2662);
  await series(10,29,2462);assert.equal((await alerts()).length,0);
  await series(30,50,2462);assert.equal((await alerts()).length,1);
  assert.equal((await alerts())[0].priority,'high');
},true));

test('una interrupción o señal inválida rompe la confirmación rápida',()=>harness(async({send,alerts})=>{
  await send(1,800);await send(2,800,0,{meterHealthy:false});
  await send(10,800);await send(11,800);assert.equal((await alerts()).length,0);
  await send(12,800);assert.equal((await alerts()).length,1);
}));

test('recepción aprobada evita pérdida; una pendiente no oculta un faltante positivo',()=>harness(async({db,series,alerts})=>{
  await db.prepare(`INSERT INTO fuel_movements(id,movement_type,occurred_at,liters,opening_level_liters,closing_level_liters,source,reference_id,review_status)
    VALUES ('r','receipt','2026-09-01T12:00:30.000Z',100,1000,1100,'manual','r','approved')`).run();
  await series(1,20,1100);assert.equal((await alerts()).length,0);
  await db.prepare("UPDATE fuel_movements SET review_status='pending' WHERE id='r'").run();
  await series(21,50,700);assert.equal((await alerts()).length,1);
}));

test('K24 enfermo o contador decreciente no confirma ni acumula persistencia',()=>harness(async({send,series,alerts})=>{
  await send(1,800,20000);await send(2,700,100);await series(3,20,700,100);
  assert.equal((await alerts()).length,0);
  await send(21,700,20000,{meterHealthy:false});assert.equal((await alerts()).length,0);
}));

test('comparaciones 1/3/7 días usan ventanas compatibles y nunca cuentan como alarmas independientes',()=>harness(async({series,alerts})=>{
  for(const day of [0,4,6])await series(day*1440+1,day*1440+20,1000);
  const result=await series(7*1440+1,7*1440+21,950);
  const comparisons=result.detection.comparisons;
  for(const horizon of ['1d','3d','7d']){
    const d=comparisons.find(c=>c.channel===horizon);assert.equal(d.available,true);assert.equal(d.observed,50);
  }
  assert.equal((await alerts()).length,1);
}));

test('sin cobertura temporal no se fabrican ventanas estables',()=>harness(async({send,alerts})=>{
  for(const minute of [1,9,11,19,21,29,31,39])await send(minute,950);
  assert.equal((await alerts()).length,0);
}));

test('la recuperación actual impide confirmar ventanas antiguas de un descenso reversible',()=>harness(async({series,send,alerts})=>{
  await series(1,9,1000);await series(10,29,950);await send(30,1000);
  assert.equal((await alerts()).length,0);
}));

test('una resolución humana se conserva; un agravamiento importante sí genera otro incidente',()=>harness(async({db,series,alerts})=>{
  await series(1,3,800);const first=(await alerts())[0];
  await db.prepare("UPDATE system_alerts SET status='resolved',acknowledged_at='2026-09-01T12:03:00Z' WHERE id=?").bind(first.id).run();
  await series(4,10,i=>800-(i-3)*5);assert.equal((await alerts()).length,1);
  await series(11,13,680);const found=await alerts();assert.equal(found.length,2);assert.equal(found[0].status,'resolved');
}));

test('estado técnico se guarda separado de alarmas y rechaza otro sitio',()=>harness(async({worker,env,db,alerts})=>{
  const body={siteId:'site',occurredAt:'2026-09-01T12:00:00Z',policyId:'inventory-evidence-v2',incident:{condition:'active',episodes:1}};
  const send=body=>worker.fetch(new Request('http://localhost/api/inventory-balance/health',{method:'POST',headers:{'content-type':'application/json','x-edge-sensor-key':env.FUEL_SENSOR_INGEST_KEY},body:JSON.stringify(body)}),env,context);
  assert.equal((await send(body)).status,201);assert.equal((await alerts()).length,0);
  assert.equal((await send({...body,siteId:'other'})).status,400);
  assert.equal((await db.prepare('SELECT count(*) n FROM inventory_measurement_health').first()).n,1);
}));
