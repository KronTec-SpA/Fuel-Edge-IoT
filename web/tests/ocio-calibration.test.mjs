import assert from 'node:assert/strict';
import { createHmac, pbkdf2Sync, randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import ts from 'typescript';
import { createLocalD1 } from '../runtime/local-d1.mjs';

const root='/api/system-settings/ocio-calibration', fingerprint='level-'+'a'.repeat(64);
const context={waitUntil(){},passThroughOnException(){}};
async function harness(run){
  const dir=await mkdtemp(join(tmpdir(),'ocio-calibration-'));
  const db=createLocalD1(join(dir,'db.sqlite3'));globalThis.__FUEL_EDGE_LOCAL_DB__=db;
  const worker=(await import(`../dist/server/index.js?calibration=${Date.now()}-${Math.random()}`)).default;
  const pepper=randomBytes(32),salt=randomBytes(16),password='calibration-only-test-password',email='calibration@example.test';
  const env={AUTH_ADMIN_EMAIL_DIGEST:createHmac('sha256',pepper).update(email).digest('base64url'),
    AUTH_ADMIN_PASSWORD_HASH:`pbkdf2_sha256$310000$${salt.toString('base64url')}$${pbkdf2Sync(password,salt,310000,32,'sha256').toString('base64url')}`,
    AUTH_EMAIL_PEPPER:pepper.toString('base64url'),AUTH_SESSION_SECRET:randomBytes(32).toString('base64url'),
    AUTH_BOOTSTRAP_VERSION:'calibration-tests-v1', AUTH_DATA_KEY:randomBytes(32).toString('base64url'),
    FUEL_SENSOR_INGEST_KEY:'calibration-only-edge-key-long-enough',FUEL_SITE_ID:'site'};
  let cookie='';
  const call=async(path=root,method='GET',body,headers={})=>{
    const r=await worker.fetch(new Request('http://localhost'+path,{method,
      headers:{origin:'http://localhost',cookie,'content-type':'application/json',...headers},
      ...(body===undefined?{}:{body:JSON.stringify(body)})}),env,context);
    return {status:r.status,body:await r.json(),response:r};
  };
  const edge=(suffix,body)=>call(root+suffix,'POST',body,{'x-edge-sensor-key':env.FUEL_SENSOR_INGEST_KEY});
  const report=()=>edge('/current',{siteId:'site',fingerprint,pending:true,telemetrySessionId:'session'});
  const confirm=(revision=0,intervalDays=365)=>call(root+'/confirm','POST',{expectedRevision:revision,intervalDays});
  const ack=c=>edge('/applied',{siteId:'site',fingerprint,confirmationId:c.confirmationId,revision:c.revision,appliedAt:new Date().toISOString()});
  const sample=(id,calibrationId='legacy',anchorId='old-anchor')=>{
    const occurredAt='2026-08-28T12:00:00.000Z';
    return {id,siteId:'site',occurredAt,calibrationId,measuredLiters:900,pulsesTotal:1800,pulsesPerLiter:90,meterHealthy:true,
      anchor:{id:anchorId,levelLiters:900,pulses:1800,occurredAt,calibrationId,capacityLiters:2500,pulsesPerLiter:90}};
  };
  const balance=b=>call('/api/inventory-balance/edge','POST',b,{'x-edge-sensor-key':env.FUEL_SENSOR_INGEST_KEY});
  try {
    const login=await call('/api/auth/login','POST',{email,password});assert.equal(login.status,200);
    cookie=login.response.headers.get('set-cookie').split(';',1)[0];
    await run({db,call,edge,report,confirm,ack,sample,balance,env});
  } finally {delete globalThis.__FUEL_EDGE_LOCAL_DB__;db.close();await rm(dir,{recursive:true,force:true});}
}

test('365 días por defecto; editar frecuencia no confirma el equipo ni requiere conexión',()=>harness(async({call,confirm,db})=>{
  let c=(await call()).body.calibration;
  assert.equal(c.intervalDays,365);assert.equal(c.status,'uncalibrated');assert.equal(c.nextDueAt,null);
  assert.equal((await confirm()).status,409);
  c=(await call(root,'PUT',{expectedRevision:0,intervalDays:180})).body.calibration;
  assert.equal(c.intervalDays,180);assert.equal(c.confirmationId,null);assert.equal(c.nextDueAt,null);
  for(const n of [0,731,1.5,'365']) assert.equal((await call(root,'PUT',{expectedRevision:0,intervalDays:n})).status,400);
  assert.equal((await db.prepare('SELECT count(*) AS n FROM ocio_calibration_events').first()).n,1);
}));

test('registro humano, espera del PLC y confirmación durable con próxima visita a 365 días',()=>harness(async({call,report,confirm,ack,db})=>{
  assert.equal((await report()).body.command,null);
  const registered=await confirm();assert.equal(registered.status,201,JSON.stringify(registered.body));
  const c=registered.body.calibration;
  assert.equal(c.status,'awaiting_plc');assert.ok(c.calibratedBy);
  assert.equal(Date.parse(c.nextDueAt)-Date.parse(c.calibratedAt),365*86400000);
  assert.equal((await confirm()).status,409);assert.equal((await confirm(1)).status,409);
  assert.equal((await report()).body.command.confirmationId,c.confirmationId);
  const applied=await ack(c);assert.equal(applied.status,200,JSON.stringify(applied.body));
  assert.equal(applied.body.calibration.status,'calibrated');
  const at=applied.body.calibration.appliedAt;
  assert.equal((await ack(c)).body.calibration.appliedAt,at);
  const edited=await call(root,'PUT',{expectedRevision:1,intervalDays:180});
  assert.equal(edited.body.calibration.status,'calibrated');
  assert.equal(Date.parse(edited.body.calibration.nextDueAt)-Date.parse(c.calibratedAt),180*86400000);
  // Vencimiento es mantenimiento, no cambia el comando ni apaga las mediciones.
  await db.prepare("UPDATE ocio_calibration_settings SET next_due_at='2020-01-01T00:00:00Z'").run();
  assert.equal((await call()).body.calibration.status,'calibrated');
  assert.equal((await report()).body.command.confirmationId,c.confirmationId);
}));

test('la calibración archiva sin borrar cuadraturas y no acepta muestras del ciclo anterior',()=>harness(async({report,confirm,ack,db,sample,balance})=>{
  assert.equal((await balance(sample('old-sample'))).status,201);
  await report();const c=(await confirm()).body.calibration;
  assert.equal((await ack(c)).status,200);
  const old=await db.prepare('SELECT * FROM inventory_balance_anchors WHERE id=?').bind('old-anchor').first();
  assert.equal(old.site_id,'archived:old-anchor');assert.equal(old.original_site_id,'site');assert.ok(old.archived_at);
  assert.equal((await db.prepare('SELECT count(*) AS n FROM inventory_balance_samples').first()).n,1);
  assert.equal((await balance(sample('stale-sample'))).status,400);
  const epoch=JSON.stringify({confirmationId:c.confirmationId});
  assert.equal((await balance(sample('new-sample',epoch,'new-anchor'))).status,201);
  await ack(c);
  assert.equal((await db.prepare("SELECT id FROM inventory_balance_anchors WHERE site_id='site'").first()).id,'new-anchor');
  assert.equal((await db.prepare('PRAGMA foreign_key_check').all()).results.length,0);
  assert.equal((await db.prepare('SELECT count(*) AS n FROM inventory_balance_samples').first()).n,2);
}));

test('autorización, origen, fingerprint y revisión protegen una confirmación real',()=>harness(async({call,edge,report,confirm,ack})=>{
  assert.equal((await call(root,'GET',undefined,{cookie:''})).status,403);
  assert.equal((await call(root+'/confirm','POST',{expectedRevision:0,intervalDays:365},{origin:'https://attacker.test'})).status,403);
  assert.equal((await call(root+'/current','POST',{}, {'x-edge-sensor-key':'wrong'})).status,403);
  await report();const c=(await confirm()).body.calibration;
  assert.equal((await ack({...c,revision:999})).status,409);
  assert.equal((await edge('/applied',{siteId:'site',fingerprint:'level-'+'b'.repeat(64),confirmationId:c.confirmationId,revision:c.revision,appliedAt:new Date().toISOString()})).status,409);
  await ack(c);
  await edge('/current',{siteId:'site',fingerprint:'level-'+'b'.repeat(64),pending:true,telemetrySessionId:'new-session'});
  assert.equal((await call()).body.calibration.status,'configuration_changed');
}));

test('una escritura fallida devuelve 503 y revierte íntegramente el cambio de referencia',()=>harness(async({report,confirm,ack,db,sample,balance,call})=>{
  await balance(sample('old-sample'));
  await report();const c=(await confirm()).body.calibration;
  db.database.exec("CREATE TRIGGER fail_calibration BEFORE UPDATE ON ocio_calibration_events BEGIN SELECT RAISE(ABORT,'simulated write failure'); END");
  assert.equal((await ack(c)).status,503);
  assert.equal((await db.prepare("SELECT site_id FROM inventory_balance_anchors WHERE id='old-anchor'").first()).site_id,'site');
  assert.equal((await call()).body.calibration.status,'awaiting_plc');
  db.database.exec('DROP TRIGGER fail_calibration');
  assert.equal((await ack(c)).body.calibration.status,'calibrated');
  await db.prepare("UPDATE web_users SET permissions='[\"view_dashboard\"]'").run();
  assert.equal((await confirm(1)).status,403);
}));

test('migración 0035 conserva anclas y muestras con claves foráneas activas',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'calibration-upgrade-'));const db=createLocalD1(join(dir,'db'));
  try {
    db.database.exec(await readFile(new URL('../drizzle/0032_inventory_balance.sql',import.meta.url),'utf8'));
    await db.prepare("INSERT INTO inventory_balance_anchors VALUES ('old','site','{}')").run();
    await db.prepare("INSERT INTO inventory_balance_samples VALUES ('sample','old','2026-01-01','2026-01-01','{}')").run();
    db.database.exec(await readFile(new URL('../drizzle/0035_ocio_calibration.sql',import.meta.url),'utf8'));
    assert.equal((await db.prepare('SELECT site_id FROM inventory_balance_anchors').first()).site_id,'site');
    assert.equal((await db.prepare('PRAGMA foreign_key_check').all()).results.length,0);
    assert.equal((await db.prepare('SELECT count(*) AS n FROM inventory_balance_samples').first()).n,1);
  } finally {db.close();await rm(dir,{recursive:true,force:true});}
});

const compiled=ts.transpileModule(await readFile(new URL('../shared/calibration-schedule.ts',import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.ESNext}}).outputText;
const {calibrationCountdown}=await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`);
test('contador muestra días, horas, vencimiento y espera inicial sin reiniciarse al refrescar',()=>{
  const now=Date.parse('2026-09-09T12:00:00Z');
  assert.equal(calibrationCountdown(null,now).text,'Se inicia al calibrar');
  const next=new Date(now+365*86400000).toISOString();
  assert.equal(calibrationCountdown(next,now).text,'365 días · 0 h');
  assert.equal(calibrationCountdown(next,now+86400000+3600000).text,'363 días · 23 h');
  assert.equal(calibrationCountdown(new Date(now+90000).toISOString(),now).text,'0 h · 1 min');
  assert.equal(calibrationCountdown(new Date(now-86400000).toISOString(),now).text,'1 día de atraso');
  assert.equal(calibrationCountdown(new Date(now).toISOString(),now).overdue,true);
});
