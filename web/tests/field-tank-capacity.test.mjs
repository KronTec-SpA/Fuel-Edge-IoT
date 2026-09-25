import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createLocalD1} from '../runtime/local-d1.mjs';

test('existing capacity migrates to overflow, accepts 2662 L and a curve transition does not create a receipt',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'field-capacity-'));
  const db=createLocalD1(join(dir,'db.sqlite3'));globalThis.__FUEL_EDGE_LOCAL_DB__=db;
  try{
    const {default:worker}=await import('../dist/server/index.js');
    const env={FUEL_SENSOR_INGEST_KEY:'field-capacity-test-only-sensor-key'};
    const headers={'content-type':'application/json','x-edge-sensor-key':env.FUEL_SENSOR_INGEST_KEY};
    const context={waitUntil(){},passThroughOnException(){}};
    // Simula la fila de una instalación anterior sin reemplazar su inventario.
    await db.prepare(`CREATE TABLE fuel_detection_state(id INTEGER PRIMARY KEY,capacity_liters REAL,
      baseline_level_liters REAL,last_level_liters REAL,peak_level_liters REAL,active_receipt_id TEXT,
      active_started_at TEXT,last_reading_at TEXT)`).run();
    await db.prepare(`INSERT INTO fuel_detection_state VALUES(1,2500,1365,1365,1365,NULL,NULL,'1970-01-01T00:00:00.000Z')`).run();
    const send=(liters,minute)=>worker.fetch(new Request('http://localhost/api/fuel-history/readings',{
      method:'POST',headers,body:JSON.stringify({levelLiters:liters,calibrationId:'field-copec-20260909-test',
        occurredAt:new Date(Date.now()-20*60000+minute*60000).toISOString(),telemetrySessionId:'field-test'})}),env,context);
    for(let m=0;m<15;m++)assert.equal((await send(2662,m)).status,201);
    const state=await db.prepare('SELECT * FROM fuel_detection_state WHERE id=1').first();
    assert.equal(state.capacity_liters,2662);assert.equal(state.last_level_liters,2662);
    assert.equal((await db.prepare('SELECT count(*) AS n FROM fuel_movements').first()).n,0);
    assert.equal((await send(2662.1,15)).status,400);
    assert.equal((await db.prepare('PRAGMA foreign_key_check').all()).results.length,0);
  }finally{delete globalThis.__FUEL_EDGE_LOCAL_DB__;db.close();await rm(dir,{recursive:true,force:true});}
});
