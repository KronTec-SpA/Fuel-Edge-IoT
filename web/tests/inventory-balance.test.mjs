import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createLocalD1 } from "../runtime/local-d1.mjs";

const key="inventory-balance-test-sensor-key";
const context={waitUntil(){},passThroughOnException(){}};
async function harness(run, anchorOverride={}){
  const dir=await mkdtemp(join(tmpdir(),"inventory-balance-"));
  const db=createLocalD1(join(dir,"db.sqlite3"));globalThis.__FUEL_EDGE_LOCAL_DB__=db;
  const worker=(await import(`../dist/server/index.js?balance=${Date.now()}-${Math.random()}`)).default;
  const env={FUEL_SENSOR_INGEST_KEY:key,FUEL_SITE_ID:"site"};
  const post=body=>worker.fetch(new Request("http://localhost/api/inventory-balance/edge",{
    method:"POST",headers:{"content-type":"application/json","x-edge-sensor-key":key},body:JSON.stringify(body)
  }),env,context);
  const anchor={id:"balance-fixed",levelLiters:1000,pulses:0,occurredAt:"2026-08-28T12:00:00.000Z",
    calibrationId:"cal1",capacityLiters:2500,pulsesPerLiter:100,...anchorOverride};
  const sample=(id,date,level,pulses=0,extra={})=>({id,siteId:"site",anchor,occurredAt:date,
    measuredLiters:level,pulsesTotal:pulses,calibrationId:anchor.calibrationId,pulsesPerLiter:anchor.pulsesPerLiter,meterHealthy:true,...extra});
  const send=async body=>{const r=await post(body);const json=await r.json();assert.equal(r.status,201,JSON.stringify(json));return json;};
  try {await send(sample("initial",anchor.occurredAt,anchor.levelLiters,anchor.pulses));await run({db,post,send,sample,worker,env});}
  finally {delete globalThis.__FUEL_EDGE_LOCAL_DB__;db.close();await rm(dir,{recursive:true,force:true});}
}
const alerts=async db=>(await db.prepare("SELECT id,priority,title FROM system_alerts ORDER BY rowid").all()).results;

test("cotas de oscilación más error: conserva el faltante sin notificar una muestra aislada",()=>harness(async({db,send,sample})=>{
  const first=await send(sample('field-20','2026-09-09T12:00:00Z',2642,4229));
  assert.equal(first.latest.status,'within_uncertainty');
  assert.equal(first.latest.observedDifferenceLiters,20);
  assert.ok(first.latest.differenceRange.minLiters<0);
  assert.equal((await alerts(db)).length,0);
  const loss=await send(sample('field-200','2026-09-09T12:05:00Z',2462,6029,{measuredRange:{minLiters:2450,maxLiters:2470}}));
  assert.equal(loss.latest.meteredLiters,20);
  assert.equal(loss.latest.uncertainty.k24ErrorLiters,.2);
  assert.ok(loss.latest.uncertainty.measuredBounds.minLiters<2450);
  assert.ok(loss.latest.uncertainty.measuredBounds.maxLiters>2470);
  assert.ok(loss.latest.differenceRange.minLiters>=20);
  assert.equal(loss.latest.status,'suspected_loss');
  assert.equal((await alerts(db)).length,0);
  const identity=loss.anchor.id;
  const back=await send(sample('field-return','2026-09-09T12:10:00Z',2642,6029));
  assert.equal(back.latest.status,'within_uncertainty');assert.equal(back.anchor.id,identity);
  assert.equal((await alerts(db)).length,0); // No se confirmó persistencia del descenso.
},{levelLiters:2662,pulses:4229,capacityLiters:2662,pulsesPerLiter:90,
  calibrationId:JSON.stringify({curveId:'field-copec-20260909-linear-v1-b0a652dc4528beeb'})}));

test("el intervalo evita alarmar por el promedio y conserva el faltante mínimo",()=>harness(async({db,send,sample})=>{
  let result=await send(sample("range-overlap","2026-08-31T12:00:00Z",985,0,{measuredRange:{minLiters:960,maxLiters:1010}}));
  assert.equal(result.latest.differenceLiters,null);
  assert.deepEqual(result.latest.differenceRange,{minLiters:-10,maxLiters:40});
  assert.equal((await alerts(db)).length,0);
  result=await send(sample("range-loss","2026-09-01T12:00:00Z",967.5,0,{measuredRange:{minLiters:955,maxLiters:980}}));
  assert.deepEqual(result.latest.differenceRange,{minLiters:20,maxLiters:45});
  assert.equal((await alerts(db)).length,0);
  assert.equal(result.latest.status,"suspected_loss");
  assert.deepEqual(result.daily.at(-1).measuredRange,{minLiters:955,maxLiters:980});
}));

test("rechaza límites invertidos, fuera de capacidad y que excluyen el valor interno",()=>harness(async({post,sample})=>{
  for(const range of [{minLiters:1000,maxLiters:900},{minLiters:-1,maxLiters:1000},{minLiters:900,maxLiters:2501},{minLiters:900,maxLiters:950}]){
    assert.equal((await post(sample("bad-range","2026-08-31T12:00:00Z",980,0,{measuredRange:range}))).status,400);
  }
}));

test("robo hormiga: puntos diarios conservan 20/40/60 sin sustituir la confirmación temporal",()=>harness(async({db,send,sample})=>{
  const cases=[["mon","2026-08-31T12:00:00Z",980,20],["tue","2026-09-01T12:00:00Z",960,40],["wed","2026-09-02T12:00:00Z",940,60]];
  for(const [id,date,level,missing] of cases){const result=await send(sample(id,date,level));assert.equal(result.latest.differenceLiters,missing);assert.equal(result.anchor.levelLiters,1000);}
  const result=await send(sample("wed-again","2026-09-02T12:01:00Z",940));
  assert.deepEqual(result.daily.slice(-3).map(x=>x.differenceLiters),[20,40,60]);
  const found=await alerts(db);assert.equal(found.length,0);
}));

test("el mismo descenso con flujo K24 medido no genera una alerta de pérdida",()=>harness(async({db,send,sample})=>{
  const result=await send(sample("dispatch","2026-08-31T12:00:00Z",940,6000));
  assert.equal(result.latest.differenceLiters,0);assert.equal((await alerts(db)).length,0);
}));

test("las extracciones de 5 L también se acumulan hasta el umbral",()=>harness(async({db,send,sample})=>{
  for(let i=1;i<=4;i++){
    const result=await send(sample(`small-${i}`,`2026-08-31T12:0${i}:00Z`,1000-5*i));
    assert.equal(result.latest.differenceLiters,5*i);
  }
  assert.equal((await alerts(db)).length,0);
}));

test("recepciones aprobadas corrigen el balance; pendientes no ocultan un faltante",()=>harness(async({db,send,sample})=>{
  await db.prepare(`INSERT INTO fuel_movements(id,movement_type,occurred_at,liters,opening_level_liters,
    closing_level_liters,source,reference_id,review_status) VALUES ('receipt','receipt','2026-08-30T12:00:00.000Z',100,1000,1100,'manual','r1','approved')`).run();
  let result=await send(sample("after-receipt","2026-08-31T12:00:00Z",1080));
  assert.equal(result.latest.receivedLiters,100);assert.equal(result.latest.differenceLiters,20);
  await db.prepare("UPDATE fuel_movements SET liters=120,review_status='corrected' WHERE id='receipt'").run();
  result=await send(sample("corrected-receipt","2026-09-01T12:00:00Z",1080));
  assert.equal(result.latest.differenceLiters,40);
  await db.prepare("UPDATE fuel_movements SET review_status='pending' WHERE id='receipt'").run();
  result=await send(sample("pending-receipt","2026-09-02T12:00:00Z",980));
  assert.equal(result.latest.pendingReceipts,1);assert.equal(result.latest.receivedLiters,0);
  assert.equal(result.latest.differenceLiters,20);
  assert.equal(result.latest.status,"suspected_loss");
}));

test("duplicados, reinicio del emisor y muestras atrasadas no alteran el ancla ni duplican alertas",()=>harness(async({db,send,sample,post})=>{
  const body=sample("loss","2026-08-31T12:00:00Z",980);
  await send(body);await send(body);
  const late=await send(sample("late","2026-08-30T12:00:00Z",995));
  assert.equal(late.latest.differenceLiters,20);assert.equal((await alerts(db)).length,0);
  assert.equal((await post({...body,measuredLiters:900})).status,400);
  assert.equal((await post(sample("new-anchor","2026-09-01T12:00:00Z",960,0,{anchor:{...body.anchor,id:"silently-rebased",levelLiters:980}}))).status,400);
}));

test("ruido breve y puntos aislados no confirman una alarma",()=>harness(async({db,send,sample})=>{
  for(const [i,level] of [995,1005,980,982,979,990,980].entries())await send(sample(`noise-${i}`,`2026-08-31T12:0${i}:00Z`,level));
  assert.equal((await alerts(db)).length,0);
}));

test("cambio de calibración, contador reiniciado o K24 enfermo no certifican cuadratura",()=>harness(async({db,send,sample})=>{
  for(const [i,extra] of [{calibrationId:"cal2"},{meterHealthy:false},{pulsesPerLiter:90}].entries()){
    const result=await send(sample(`invalid-${i}`,`2026-08-31T12:0${i}:00Z`,1000,0,extra));
    assert.equal(result.latest.status,"unverifiable");assert.equal(result.latest.differenceLiters,null);
  }
  assert.equal((await alerts(db)).length,0);
}));

test("sin clave edge no se inyectan balances y sin sesión no se leen",()=>harness(async({worker,env})=>{
  const write=await worker.fetch(new Request("http://localhost/api/inventory-balance/edge",{method:"POST",body:"{}"}),env,context);
  const read=await worker.fetch(new Request("http://localhost/api/inventory-balance"),env,context);
  assert.equal(write.status,403);assert.equal(read.status,403);
}));

test("contador que retrocede aunque supere el ancla deja la cuadratura no verificable",()=>harness(async({send,sample})=>{
  await send(sample("valid-counter","2026-08-31T12:00:00Z",940,6000));
  const result=await send(sample("reset-counter","2026-09-01T12:00:00Z",940,100));
  assert.equal(result.latest.status,"unverifiable");
  assert.equal(result.latest.differenceLiters,null);
}));

test("consumo legítimo y robo externo simultáneos conservan 20/40/60 L de faltante",()=>harness(async({send,sample})=>{
  for(let i=1;i<=3;i++){
    const result=await send(sample(`mixed-${i}`,`2026-09-0${i}T12:00:00Z`,1000-120*i,10000*i));
    assert.equal(result.latest.meteredLiters,100*i);
    assert.equal(result.latest.differenceLiters,20*i);
  }
}));
