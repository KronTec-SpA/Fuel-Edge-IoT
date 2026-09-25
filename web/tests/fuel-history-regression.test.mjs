import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createLocalD1 } from "../runtime/local-d1.mjs";

const executionContext = { waitUntil() {}, passThroughOnException() {} };
const sensorKey = "fuel-history-regression-sensor-key";
const sensorHeaders = {
  "content-type": "application/json",
  "x-edge-sensor-key": sensorKey,
};

async function loadWorker() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}-${Math.random()}`);
  const { default: worker } = await import(workerUrl.href);
  return worker;
}

function post(worker, env, path, body) {
  return worker.fetch(new Request(`http://localhost${path}`, {
    method: "POST",
    headers: sensorHeaders,
    body: JSON.stringify(body),
  }), env, executionContext);
}

test("a manufacturer calibration change is not a receipt and later real filling is still detected", async () => {
  const directory = await mkdtemp(join(tmpdir(), "fuel-calibration-"));
  const database = createLocalD1(join(directory, "web.sqlite3"));
  globalThis.__FUEL_EDGE_LOCAL_DB__ = database;
  try {
    const worker = await loadWorker(), env = {FUEL_SENSOR_INGEST_KEY: sensorKey};
    const start = Date.now() - 40 * 60000;
    const send = (minute, levelLiters, calibrationId) => post(worker, env, "/api/fuel-history/readings", {
      levelLiters, occurredAt: new Date(start + minute * 60000).toISOString(),
      telemetrySessionId: "same-session", calibrationId,
    });
    for (let minute = 0; minute < 5; minute++) assert.equal((await send(minute, 1000)).status, 201);
    const changed = await send(5, 1150, "manufacturer-v1");
    assert.equal((await changed.json()).detection.status, "calibration_changed");
    assert.equal((await send(5, 1150, "manufacturer-v1")).status, 201);
    assert.equal((await send(6, 1150)).status, 400);
    assert.equal((await send(6, 1150, "x".repeat(161))).status, 400);
    for (let minute = 6; minute <= 12; minute++) assert.equal((await send(minute, 1150, "manufacturer-v1")).status, 201);
    assert.equal((await database.prepare("SELECT COUNT(*) AS n FROM fuel_movements").first()).n, 0);
    assert.equal((await database.prepare("SELECT COUNT(*) AS n FROM fuel_history_meta WHERE key LIKE 'level_calibration:%'").first()).n, 1);
    for (let minute = 13; minute <= 27; minute++) assert.equal((await send(minute, 1300, "manufacturer-v1")).status, 201);
    const receipts = await database.prepare("SELECT liters FROM fuel_movements WHERE movement_type='receipt'").all();
    assert.equal(receipts.results.length, 1);
    assert.equal(receipts.results[0].liters, 150);
  } finally {
    delete globalThis.__FUEL_EDGE_LOCAL_DB__;
    database.close();
    await rm(directory, {recursive: true, force: true});
  }
});

test("a changed calibration cannot extend a previous pending receipt and accepts an interval transition", async () => {
  const directory = await mkdtemp(join(tmpdir(), "fuel-calibration-receipt-"));
  const database = createLocalD1(join(directory, "web.sqlite3"));
  globalThis.__FUEL_EDGE_LOCAL_DB__ = database;
  try {
    const worker = await loadWorker(), env = {FUEL_SENSOR_INGEST_KEY: sensorKey};
    const start = Date.now() - 45 * 60000;
    const send = (minute, levelLiters, calibrationId) => post(worker, env, "/api/fuel-history/readings", {
      levelLiters, occurredAt: new Date(start + minute * 60000).toISOString(),
      telemetrySessionId: "one-session", calibrationId,
    });
    for (let minute = 0; minute < 5; minute++) await send(minute, 1000);
    for (let minute = 5; minute <= 19; minute++) await send(minute, 1300);
    const before = await database.prepare("SELECT id,liters,review_status FROM fuel_movements WHERE movement_type='receipt'").first();
    assert.equal(before.liters, 300);
    assert.equal(before.review_status, "pending");
    const interval = {levelRange: {minLiters:1490,maxLiters:1510},
      occurredAt:new Date(start+20*60000).toISOString(), calibrationId:"manufacturer-v1"};
    assert.equal((await post(worker,env,"/api/fuel-history/readings",interval)).status,201);
    assert.equal((await post(worker,env,"/api/fuel-history/readings",interval)).status,201);
    for (let minute = 21; minute <= 35; minute++) assert.equal((await send(minute, 1500, "manufacturer-v1")).status,201);
    assert.deepEqual(await database.prepare("SELECT id,liters,review_status FROM fuel_movements WHERE movement_type='receipt'").first(),before);
    assert.equal((await database.prepare("SELECT COUNT(*) AS n FROM fuel_movements WHERE movement_type='receipt'").first()).n,1);
    assert.equal((await database.prepare("SELECT COUNT(*) AS n FROM fuel_history_meta WHERE key LIKE 'level_calibration:%'").first()).n,1);
  } finally {
    delete globalThis.__FUEL_EDGE_LOCAL_DB__;
    database.close();
    await rm(directory, {recursive: true, force: true});
  }
});

test("el rango persiste, llega al estado de pantalla y no se convierte en una recepción", async () => {
  const directory = await mkdtemp(join(tmpdir(), "fuel-range-"));
  const database = createLocalD1(join(directory, "web.sqlite3"));
  globalThis.__FUEL_EDGE_LOCAL_DB__ = database;
  try {
    const worker = await loadWorker(), env = {FUEL_SENSOR_INGEST_KEY: sensorKey};
    const start = Date.now()-10*60_000;
    const point = await post(worker, env, "/api/fuel-history/readings", {levelLiters:750, occurredAt:new Date(start).toISOString()});
    assert.equal(point.status,201);
    const body = {levelRange:{minLiters:773.77,maxLiters:798.36}, occurredAt:new Date(start+60000).toISOString(),telemetrySessionId:"range-boot"};
    assert.equal((await post(worker,env,"/api/fuel-history/readings",body)).status,201);
    assert.equal((await post(worker,env,"/api/fuel-history/readings",body)).status,201);
    assert.equal((await post(worker,env,"/api/fuel-history/readings",{...body,levelRange:{minLiters:800,maxLiters:700}})).status,400);
    assert.equal((await database.prepare("SELECT COUNT(*) AS n FROM fuel_level_readings").first()).n,1);
    assert.equal((await database.prepare("SELECT COUNT(*) AS n FROM fuel_movements").first()).n,0);
    const {readFile} = await import("node:fs/promises"), ts = (await import("typescript")).default;
    const capacity = await readFile(new URL("../shared/tank-capacity.ts",import.meta.url),"utf8");
    const capacityCode = ts.transpileModule(capacity,{compilerOptions:{module:ts.ModuleKind.ESNext}}).outputText;
    const source = (await readFile(new URL("../worker/fuel-history-store.ts",import.meta.url),"utf8"))
      .replace("../shared/tank-capacity",`data:text/javascript;base64,${Buffer.from(capacityCode).toString("base64")}`);
    const compiled = ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.ESNext}}).outputText;
    const {fuelSensorState} = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`);
    const sensor = await fuelSensorState(database);
    assert.deepEqual(sensor.levelRange,body.levelRange);
    assert.equal(sensor.latestReadingAt,body.occurredAt);
    assert.equal(sensor.telemetrySessionId,"range-boot");
    assert.equal(sensor.displayReference.liters,786);
    assert.equal(sensor.displayReference.sourceAt,body.occurredAt);
    const quality = {quality:"settling",occurredAt:new Date(start+90000).toISOString(),telemetrySessionId:"range-boot"};
    assert.equal((await post(worker,env,"/api/fuel-history/readings",quality)).status,201);
    assert.equal((await post(worker,env,"/api/fuel-history/readings",{...quality,quality:"invented"})).status,400);
    assert.equal((await post(worker,env,"/api/fuel-history/readings",{...quality,levelLiters:1000})).status,400);
    // Cambiar el estado del filtro nunca renueva la fecha ni el volumen OCIO.
    const validating = await fuelSensorState(database);
    assert.equal(validating.latestReadingAt,body.occurredAt);
    assert.deepEqual(validating.levelRange,body.levelRange);
    assert.deepEqual(validating.measurementQuality,{status:"settling",occurredAt:quality.occurredAt,telemetrySessionId:"range-boot"});
    await post(worker,env,"/api/fuel-history/readings",{...quality,quality:"valid",occurredAt:new Date(start+80000).toISOString()});
    assert.equal((await fuelSensorState(database)).measurementQuality.status,"settling");
    assert.equal((await post(worker,env,"/api/fuel-history/readings",{...quality,quality:"calibration_pending"})).status,201);
    const pendingCalibration = await fuelSensorState(database);
    assert.equal(pendingCalibration.measurementQuality.status,"calibration_pending");
    assert.equal(pendingCalibration.latestReadingAt,body.occurredAt);
    assert.equal((await database.prepare("SELECT COUNT(*) AS n FROM fuel_level_readings").first()).n,1);
    assert.equal((await database.prepare("SELECT COUNT(*) AS n FROM fuel_movements").first()).n,0);
    const settled = await post(worker,env,"/api/fuel-history/readings",{levelLiters:790,occurredAt:new Date(start+120000).toISOString()});
    assert.equal(settled.status,201);
    assert.equal((await settled.json()).detection.status,"warming_up");
    assert.equal((await fuelSensorState(database)).levelRange,null);
    const noiseAt=new Date(start+180000).toISOString();
    assert.equal((await post(worker,env,"/api/fuel-history/readings",{levelLiters:790.6,occurredAt:noiseAt})).status,201);
    const afterNoise=await fuelSensorState(database);
    assert.equal(afterNoise.currentLevel,790.6);
    assert.equal(afterNoise.displayReference.liters,790);
    assert.equal(afterNoise.displayReference.sourceAt,noiseAt);
    const reopened=createLocalD1(join(directory,"web.sqlite3"));
    try { assert.deepEqual((await fuelSensorState(reopened)).displayReference,afterNoise.displayReference); }
    finally { reopened.close(); }
  } finally { delete globalThis.__FUEL_EDGE_LOCAL_DB__; database.close(); await rm(directory,{recursive:true,force:true}); }
});

test("a K24 dispatch does not turn the next unchanged OCIO reading into a receipt", async () => {
  const directory = await mkdtemp(join(tmpdir(), "fuel-history-regression-"));
  const database = createLocalD1(join(directory, "web.sqlite3"));
  globalThis.__FUEL_EDGE_LOCAL_DB__ = database;
  try {
    const worker = await loadWorker();
    const env = { FUEL_SENSOR_INGEST_KEY: sensorKey };
    const start = Date.now() - 5 * 60_000;

    const initial = await post(worker, env, "/api/fuel-history/readings", {
      levelLiters: 1500,
      occurredAt: new Date(start).toISOString(),
      source: "PIUSI OCIO 4-20 mA",
    });
    assert.equal(initial.status, 201);

    const dispatch = await post(worker, env, "/api/fuel-history/movements", {
      id: "tx-k24-100l",
      type: "dispatch",
      occurredAt: new Date(start + 60_000).toISOString(),
      liters: 100,
      source: "K24 + PLC",
      reference: "regression",
      detail: "Despacho real medido por pulsos",
    });
    assert.equal(dispatch.status, 201);

    const unchanged = await post(worker, env, "/api/fuel-history/readings", {
      levelLiters: 1500,
      occurredAt: new Date(start + 2 * 60_000).toISOString(),
      source: "PIUSI OCIO 4-20 mA",
    });
    assert.equal(unchanged.status, 201);
    assert.equal((await unchanged.json()).detection.status, "warming_up");

    const movements = await database.prepare(`SELECT movement_type AS type,liters
      FROM fuel_movements ORDER BY occurred_at`).all();
    assert.deepEqual(movements.results, [{ type: "dispatch", liters: 100 }]);

    const detector = await database.prepare(`SELECT baseline_level_liters AS baseline,
      last_level_liters AS lastLevel,peak_level_liters AS peak FROM fuel_detection_state WHERE id=1`).first();
    assert.deepEqual(detector, { baseline: 1500, lastLevel: 1500, peak: 1500 });
  } finally {
    delete globalThis.__FUEL_EDGE_LOCAL_DB__;
    database.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a sub-0.12 L pump enablement is stored separately from a classic dispatch", async () => {
  const directory = await mkdtemp(join(tmpdir(), "fuel-pump-enablement-"));
  const database = createLocalD1(join(directory, "web.sqlite3"));
  globalThis.__FUEL_EDGE_LOCAL_DB__ = database;
  try {
    const worker = await loadWorker();
    const env = { FUEL_SENSOR_INGEST_KEY: sensorKey };
    const occurredAt = new Date().toISOString();

    const response = await post(worker, env, "/api/fuel-history/movements", {
      id: "pump-enablement-001",
      type: "dispatch",
      classification: "pump_enablement",
      occurredAt,
      liters: 0.11,
      source: "K24 + PLC · Habilitación de bomba",
      reference: "pump-enablement-001",
      detail: "Habilitación de bomba · Menos de 0,12 L sin flujo posterior",
    });

    assert.equal(response.status, 201);
    assert.equal((await response.json()).movement.classification, "pump_enablement");
    assert.deepEqual(
      await database.prepare("SELECT classification,liters FROM fuel_movements WHERE id='pump-enablement-001'").first(),
      { classification: "pump_enablement", liters: 0.11 },
    );
    const duplicate = await post(worker, env, "/api/fuel-history/movements", {
      id: "pump-enablement-001",
      type: "dispatch",
      classification: "pump_enablement",
      occurredAt,
      liters: 0.11,
      source: "K24 + PLC · Habilitación de bomba",
      reference: "pump-enablement-001",
      detail: "Habilitación de bomba · Menos de 0,12 L sin flujo posterior",
    });
    assert.equal(duplicate.status, 200);
    assert.equal((await duplicate.json()).created, false);

    const rejected = await post(worker, env, "/api/fuel-history/movements", {
      id: "pump-enablement-too-large",
      type: "dispatch",
      classification: "pump_enablement",
      occurredAt,
      liters: 0.12,
      source: "K24 + PLC",
      reference: "pump-enablement-too-large",
      detail: "No debe aceptarse como habilitación",
    });
    assert.equal(rejected.status, 400);
    assert.match((await rejected.json()).error, /menos de 0,12 L/i);
  } finally {
    delete globalThis.__FUEL_EDGE_LOCAL_DB__;
    database.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("startup retroactively normalizes manual load IDs and recategorizes legacy enablements", async () => {
  const directory = await mkdtemp(join(tmpdir(), "fuel-manual-identity-migration-"));
  const databasePath = join(directory, "web.sqlite3");
  let database = createLocalD1(databasePath);
  globalThis.__FUEL_EDGE_LOCAL_DB__ = database;
  try {
    const worker = await loadWorker();
    const env = { FUEL_SENSOR_INGEST_KEY: sensorKey };
    const initial = await post(worker, env, "/api/fuel-history/movements", {
      id: "migration-bootstrap",
      type: "dispatch",
      occurredAt: new Date(Date.now() - 60_000).toISOString(),
      liters: 1,
      source: "K24 + PLC",
      reference: "migration-bootstrap",
      detail: "Inicializa el esquema de prueba",
    });
    assert.equal(initial.status, 201);
    await database.batch([
      database.prepare("DELETE FROM fuel_movements"),
      database.prepare("DELETE FROM fuel_history_meta WHERE key IN ('manual_movement_identity_v1','pump_enablement_classification_v3_under_0_12')"),
      database.prepare(`INSERT INTO fuel_movements(
        id,movement_type,classification,occurred_at,liters,opening_level_liters,closing_level_liters,
        source,reference_id,detail,detected_automatically,confidence,detection_status
      ) VALUES (?,?,?,?,?,?,?,?,?,?,0,1,'confirmed')`).bind(
        "manual-segment-bbc8b607-dd88-4785-a5c1-d638cd0fb851", "dispatch", "standard",
        new Date(Date.now() - 50_000).toISOString(), 46.15, 1000, 953.9,
        "K24 + PLC · Modo manual", "manual-mode-bbc8b607-dd88-4785-a5c1-d638cd0fb851",
        "operator-01 · Consumo imputado por tag · Modo manual",
      ),
      database.prepare(`INSERT INTO fuel_movements(
        id,movement_type,classification,occurred_at,liters,opening_level_liters,closing_level_liters,
        source,reference_id,detail,detected_automatically,confidence,detection_status
      ) VALUES (?,?,?,?,?,?,?,?,?,?,0,1,'confirmed')`).bind(
        "legacy-enable-01", "dispatch", "standard", new Date(Date.now() - 40_000).toISOString(),
        0.1, 953.9, 953.8, "K24 + PLC", "legacy-enable-01",
        "Carga histórica sin categoría de habilitación",
      ),
    ]);
    database.close();
    database = createLocalD1(databasePath);
    globalThis.__FUEL_EDGE_LOCAL_DB__ = database;

    const trigger = await post(worker, env, "/api/fuel-history/movements", {
      id: "migration-trigger",
      type: "dispatch",
      occurredAt: new Date(Date.now() - 30_000).toISOString(),
      liters: 2,
      source: "K24 + PLC",
      reference: "migration-trigger",
      detail: "Ejecuta las migraciones de inicio",
    });
    assert.equal(trigger.status, 201);

    assert.deepEqual(await database.prepare(`SELECT id,reference_id AS reference,legacy_id AS legacyId,
      manual_mode_session_id AS manualModeSessionId FROM fuel_movements WHERE legacy_id IS NOT NULL`).first(), {
      id: "bbc8b607-dd88-4785-a5c1-d638cd0fb851",
      reference: "bbc8b607-dd88-4785-a5c1-d638cd0fb851",
      legacyId: "manual-segment-bbc8b607-dd88-4785-a5c1-d638cd0fb851",
      manualModeSessionId: "manual-mode-bbc8b607-dd88-4785-a5c1-d638cd0fb851",
    });
    assert.deepEqual(await database.prepare("SELECT classification FROM fuel_movements WHERE id='legacy-enable-01'").first(), {
      classification: "pump_enablement",
    });
  } finally {
    delete globalThis.__FUEL_EDGE_LOCAL_DB__;
    database.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("startup removes OCIO cycle transients and retains a sustained receipt", async () => {
  const directory = await mkdtemp(join(tmpdir(), "fuel-history-repair-"));
  const database = createLocalD1(join(directory, "web.sqlite3"));
  globalThis.__FUEL_EDGE_LOCAL_DB__ = database;
  try {
    const falseReceiptAt = new Date(Date.now() - 10 * 60_000);
    const realReceiptAt = new Date(Date.now() - 5 * 60_000);
    await database.batch([
      database.prepare(`CREATE TABLE fuel_history_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL)`),
      database.prepare(`CREATE TABLE fuel_movements(
        id TEXT PRIMARY KEY,movement_type TEXT NOT NULL,occurred_at TEXT NOT NULL,liters REAL NOT NULL,
        opening_level_liters REAL NOT NULL,closing_level_liters REAL NOT NULL,source TEXT NOT NULL,
        reference_id TEXT NOT NULL,detail TEXT NOT NULL DEFAULT '',operator_id TEXT,equipment_id TEXT,
        is_master INTEGER NOT NULL DEFAULT 0,detected_automatically INTEGER NOT NULL DEFAULT 0,
        confidence REAL NOT NULL DEFAULT 1,detection_status TEXT NOT NULL DEFAULT 'confirmed',
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      )`),
      database.prepare(`CREATE TABLE fuel_detection_state(
        id INTEGER PRIMARY KEY,capacity_liters REAL NOT NULL,baseline_level_liters REAL NOT NULL,
        last_level_liters REAL NOT NULL,peak_level_liters REAL NOT NULL,active_receipt_id TEXT,
        active_started_at TEXT,last_reading_at TEXT NOT NULL
      )`),
      database.prepare(`CREATE TABLE fuel_level_readings(
        id INTEGER PRIMARY KEY AUTOINCREMENT,occurred_at TEXT NOT NULL,level_liters REAL NOT NULL,
        source TEXT NOT NULL DEFAULT 'OCIO',created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      )`),
      database.prepare("INSERT INTO fuel_level_readings(occurred_at,level_liters,source) VALUES (?,?,?)")
        .bind(new Date(falseReceiptAt.getTime() - 2_000).toISOString(), 1095, "PIUSI OCIO"),
      database.prepare("INSERT INTO fuel_level_readings(occurred_at,level_liters,source) VALUES (?,?,?)")
        .bind(falseReceiptAt.toISOString(), 1300, "PIUSI OCIO"),
      database.prepare("INSERT INTO fuel_level_readings(occurred_at,level_liters,source) VALUES (?,?,?)")
        .bind(new Date(falseReceiptAt.getTime() + 10_000).toISOString(), 1095, "PIUSI OCIO"),
      database.prepare(`INSERT INTO fuel_movements(
        id,movement_type,occurred_at,liters,opening_level_liters,closing_level_liters,
        source,reference_id,detail,detected_automatically,confidence,detection_status
      ) VALUES ('receipt-transient','receipt',?,205,1095,1300,'PIUSI OCIO 4-20 mA','AUTO','Pulso transitorio',1,0.96,'accumulating')`).bind(falseReceiptAt.toISOString()),
      database.prepare("INSERT INTO fuel_level_readings(occurred_at,level_liters,source) VALUES (?,?,?)")
        .bind(new Date(realReceiptAt.getTime() - 2_000).toISOString(), 1038, "PIUSI OCIO"),
      database.prepare("INSERT INTO fuel_level_readings(occurred_at,level_liters,source) VALUES (?,?,?)")
        .bind(realReceiptAt.toISOString(), 1042, "PIUSI OCIO"),
      database.prepare("INSERT INTO fuel_level_readings(occurred_at,level_liters,source) VALUES (?,?,?)")
        .bind(new Date(realReceiptAt.getTime() + 60_000).toISOString(), 1200, "PIUSI OCIO"),
      database.prepare(`INSERT INTO fuel_movements(
        id,movement_type,occurred_at,liters,opening_level_liters,closing_level_liters,
        source,reference_id,detail,detected_automatically,confidence,detection_status
      ) VALUES ('receipt-sustained','receipt',?,200,1000,1200,'PIUSI OCIO 4-20 mA','AUTO','Recepción sostenida',1,0.99,'confirmed')`).bind(realReceiptAt.toISOString()),
      database.prepare(`INSERT INTO fuel_detection_state(
        id,capacity_liters,baseline_level_liters,last_level_liters,peak_level_liters,
        active_receipt_id,active_started_at,last_reading_at
      ) VALUES (1,2500,1095,1200,1300,'receipt-transient',?,?)`).bind(falseReceiptAt.toISOString(), new Date(realReceiptAt.getTime() + 60_000).toISOString()),
    ]);

    const worker = await loadWorker();
    const response = await post(worker, { FUEL_SENSOR_INGEST_KEY: sensorKey }, "/api/fuel-history/readings", {
      levelLiters: 1200,
      occurredAt: new Date().toISOString(),
      source: "PIUSI OCIO 4-20 mA",
    });
    assert.equal(response.status, 201);
    assert.equal((await response.json()).detection.status, "warming_up");

    const movements = await database.prepare("SELECT id,movement_type AS type FROM fuel_movements ORDER BY occurred_at").all();
    assert.deepEqual(movements.results, [{ id: "receipt-sustained", type: "receipt" }]);
    const detector = await database.prepare(`SELECT baseline_level_liters AS baseline,
      last_level_liters AS lastLevel,active_receipt_id AS activeId FROM fuel_detection_state WHERE id=1`).first();
    assert.deepEqual(detector, { baseline: 1200, lastLevel: 1200, activeId: null });
    const repair = await database.prepare("SELECT value FROM fuel_history_meta WHERE key='ocio_transient_receipts_repair_v1'").first();
    assert.equal(JSON.parse(repair.value).removed, 1);
    assert.equal(JSON.parse(repair.value).removedLiters, 205);
  } finally {
    delete globalThis.__FUEL_EDGE_LOCAL_DB__;
    database.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("startup sends historical automatic receipts to review without reopening human decisions", async () => {
  const directory = await mkdtemp(join(tmpdir(), "fuel-history-historical-review-"));
  const database = createLocalD1(join(directory, "web.sqlite3"));
  globalThis.__FUEL_EDGE_LOCAL_DB__ = database;
  try {
    const occurredAt = new Date(Date.now() - 24 * 60 * 60_000).toISOString();
    await database.batch([
      database.prepare(`CREATE TABLE fuel_history_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL)`),
      database.prepare(`CREATE TABLE fuel_movements(
        id TEXT PRIMARY KEY,movement_type TEXT NOT NULL,classification TEXT NOT NULL DEFAULT 'standard',
        occurred_at TEXT NOT NULL,liters REAL NOT NULL,opening_level_liters REAL NOT NULL,
        closing_level_liters REAL NOT NULL,source TEXT NOT NULL,reference_id TEXT NOT NULL,
        detail TEXT NOT NULL DEFAULT '',operator_id TEXT,equipment_id TEXT,is_master INTEGER NOT NULL DEFAULT 0,
        detected_automatically INTEGER NOT NULL DEFAULT 0,confidence REAL NOT NULL DEFAULT 1,
        detection_status TEXT NOT NULL DEFAULT 'confirmed',review_status TEXT NOT NULL DEFAULT 'not_required',
        original_liters REAL,document_reference TEXT,reviewed_by_user_id TEXT,reviewed_by_name TEXT,
        reviewed_at TEXT,review_note TEXT,created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      )`),
      database.prepare(`CREATE TABLE fuel_receipt_reviews(
        id TEXT PRIMARY KEY,movement_id TEXT NOT NULL,action TEXT NOT NULL,previous_liters REAL,
        resulting_liters REAL,document_reference TEXT,note TEXT NOT NULL DEFAULT '',actor_user_id TEXT,
        actor_name TEXT,occurred_at TEXT NOT NULL
      )`),
      database.prepare(`INSERT INTO fuel_movements(
        id,movement_type,occurred_at,liters,opening_level_liters,closing_level_liters,source,reference_id,
        detected_automatically,confidence,detection_status,review_status,original_liters,reviewed_by_name,
        reviewed_at,review_note
      ) VALUES ('historical-auto','receipt',?,55.1,1023,1078,'OCIO','AUTO-HIST',1,.99,'confirmed',
        'approved',55.1,'Confirmación histórica',?,'Movimiento confirmado antes de habilitar el flujo de aprobación')`)
        .bind(occurredAt, occurredAt),
      database.prepare(`INSERT INTO fuel_movements(
        id,movement_type,occurred_at,liters,opening_level_liters,closing_level_liters,source,reference_id,
        detected_automatically,confidence,detection_status,review_status,original_liters,reviewed_by_user_id,
        reviewed_by_name,reviewed_at,review_note
      ) VALUES ('human-approved-auto','receipt',?,43.8,1024,1068,'OCIO','AUTO-HUMAN',1,.99,'confirmed',
        'approved',43.8,'usr-supervisor','Encargado',?,'Recepción comprobada con guía')`).bind(occurredAt, occurredAt),
      database.prepare(`INSERT INTO fuel_movements(
        id,movement_type,occurred_at,liters,opening_level_liters,closing_level_liters,source,reference_id,
        detected_automatically,confidence,detection_status,review_status,original_liters,reviewed_by_name,
        reviewed_at,review_note
      ) VALUES ('historical-manual','receipt',?,80,1068,1148,'Registro anterior','GUIDE-80',0,1,'confirmed',
        'approved',80,'Confirmación histórica',?,'Movimiento confirmado antes de habilitar el flujo de aprobación')`)
        .bind(occurredAt, occurredAt),
      database.prepare(`INSERT INTO fuel_receipt_reviews(
        id,movement_id,action,previous_liters,resulting_liters,note,actor_name,occurred_at
      ) VALUES ('historical-auto:legacy-review','historical-auto','approved',55.1,55.1,
        'Movimiento confirmado antes de habilitar el flujo de aprobación','Migración del sistema',?)`).bind(occurredAt),
      database.prepare(`INSERT INTO fuel_receipt_reviews(
        id,movement_id,action,previous_liters,resulting_liters,note,actor_user_id,actor_name,occurred_at
      ) VALUES ('human-approval-event','human-approved-auto','approved',43.8,43.8,
        'Recepción comprobada con guía','usr-supervisor','Encargado',?)`).bind(occurredAt),
      database.prepare("INSERT INTO fuel_history_meta(key,value) VALUES ('receipt_review_workflow_v1','{}')"),
    ]);

    const worker = await loadWorker();
    const response = await post(worker, { FUEL_SENSOR_INGEST_KEY: sensorKey }, "/api/fuel-history/readings", {
      levelLiters: 1148,
      occurredAt: new Date().toISOString(),
      source: "PIUSI OCIO 4-20 mA",
      telemetrySessionId: "historical-review-migration",
    });
    assert.equal(response.status, 201);

    const movements = await database.prepare(`SELECT id,review_status AS reviewStatus,confidence,
      reviewed_by_user_id AS reviewedByUserId,reviewed_by_name AS reviewedByName
      FROM fuel_movements WHERE movement_type='receipt' ORDER BY id`).all();
    assert.deepEqual(movements.results, [
      { id: "historical-auto", reviewStatus: "pending", confidence: 0.551, reviewedByUserId: null, reviewedByName: null },
      { id: "historical-manual", reviewStatus: "approved", confidence: 1, reviewedByUserId: null, reviewedByName: "Confirmación histórica" },
      { id: "human-approved-auto", reviewStatus: "approved", confidence: 0.99, reviewedByUserId: "usr-supervisor", reviewedByName: "Encargado" },
    ]);
    const historicalAudit = await database.prepare(`SELECT action,note FROM fuel_receipt_reviews
      WHERE movement_id='historical-auto' ORDER BY occurred_at`).all();
    assert.deepEqual(historicalAudit.results, [{
      action: "automatic_detected",
      note: "Detección automática histórica enviada a conciliación",
    }]);
    assert.equal((await database.prepare(`SELECT COUNT(*) AS total FROM fuel_receipt_reviews
      WHERE movement_id='human-approved-auto' AND action='approved'`).first()).total, 1);
  } finally {
    delete globalThis.__FUEL_EDGE_LOCAL_DB__;
    database.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("short OCIO dips and a returning pulse never become an automatic receipt", async () => {
  const directory = await mkdtemp(join(tmpdir(), "fuel-history-transient-v2-"));
  const database = createLocalD1(join(directory, "web.sqlite3"));
  globalThis.__FUEL_EDGE_LOCAL_DB__ = database;
  try {
    const worker = await loadWorker();
    const env = { FUEL_SENSOR_INGEST_KEY: sensorKey };
    const start = Date.now() - 30 * 60_000;
    const reading = (minute, levelLiters, seconds = 0) => post(worker, env, "/api/fuel-history/readings", {
      levelLiters,
      occurredAt: new Date(start + minute * 60_000 + seconds * 1000).toISOString(),
      source: "PIUSI OCIO 4-20 mA",
      telemetrySessionId: "transient-session",
    });

    for (let minute = 0; minute < 5; minute += 1) await reading(minute, 1049);
    await reading(5, 1023, 0);
    await reading(5, 1045, 20);
    await reading(6, 1049);
    await reading(7, 1049);
    await reading(8, 1049);
    const pulse = await reading(9, 1068);
    assert.equal((await pulse.json()).detection.status, "none");
    await reading(9, 1051, 20);
    await reading(10, 1049);
    await reading(11, 1049);

    assert.equal((await database.prepare("SELECT COUNT(*) AS total FROM fuel_movements WHERE movement_type='receipt'").first()).total, 0);
    const detector = await database.prepare(`SELECT baseline_level_liters AS baseline,
      active_receipt_id AS activeId FROM fuel_detection_state WHERE id=1`).first();
    assert.deepEqual(detector, { baseline: 1049, activeId: null });
  } finally {
    delete globalThis.__FUEL_EDGE_LOCAL_DB__;
    database.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a new telemetry session warms up before evaluating level increases", async () => {
  const directory = await mkdtemp(join(tmpdir(), "fuel-history-restart-v2-"));
  const database = createLocalD1(join(directory, "web.sqlite3"));
  globalThis.__FUEL_EDGE_LOCAL_DB__ = database;
  try {
    const worker = await loadWorker();
    const env = { FUEL_SENSOR_INGEST_KEY: sensorKey };
    const start = Date.now() - 20 * 60_000;
    const reading = (minute, levelLiters, telemetrySessionId) => post(worker, env, "/api/fuel-history/readings", {
      levelLiters,
      occurredAt: new Date(start + minute * 60_000).toISOString(),
      source: "PIUSI OCIO 4-20 mA",
      telemetrySessionId,
    });

    for (let minute = 0; minute < 5; minute += 1) await reading(minute, 1046, "session-before-restart");
    const firstAfterRestart = await reading(5, 1078, "session-after-restart");
    assert.equal((await firstAfterRestart.json()).detection.status, "warming_up");
    assert.equal((await reading(6, 1072, "session-after-restart")).status, 201);
    assert.equal((await reading(7, 1071, "session-after-restart")).status, 201);
    await reading(8, 1071, "session-after-restart");

    assert.equal((await database.prepare("SELECT COUNT(*) AS total FROM fuel_movements WHERE movement_type='receipt'").first()).total, 0);
    const detector = await database.prepare(`SELECT baseline_level_liters AS baseline,
      active_receipt_id AS activeId,telemetry_session_id AS sessionId FROM fuel_detection_state WHERE id=1`).first();
    assert.deepEqual(detector, { baseline: 1072, activeId: null, sessionId: "session-after-restart" });
  } finally {
    delete globalThis.__FUEL_EDGE_LOCAL_DB__;
    database.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("99 L is ignored and a later 100 L sustained increase creates one confirmed receipt", async () => {
  const directory = await mkdtemp(join(tmpdir(), "fuel-history-sustained-v2-"));
  const database = createLocalD1(join(directory, "web.sqlite3"));
  globalThis.__FUEL_EDGE_LOCAL_DB__ = database;
  try {
    const worker = await loadWorker();
    const env = { FUEL_SENSOR_INGEST_KEY: sensorKey };
    const start = Date.now() - 30 * 60_000;
    const reading = (minute, levelLiters) => post(worker, env, "/api/fuel-history/readings", {
      levelLiters,
      occurredAt: new Date(start + minute * 60_000).toISOString(),
      source: "PIUSI OCIO 4-20 mA",
      telemetrySessionId: "real-receipt-session",
    });

    for (let minute = 0; minute < 5; minute += 1) await reading(minute, 1000);
    const belowThreshold = await reading(5, 1099);
    assert.equal((await belowThreshold.json()).detection.status, "none");
    const candidate = await reading(6, 1100);
    assert.equal((await candidate.json()).detection.status, "started");
    const plateau = [1082, 1118, 1090, 1110, 1088, 1112, 1095, 1105, 1098, 1102];
    let finalDetection = null;
    for (let index = 0; index < plateau.length; index += 1) {
      const response = await reading(7 + index, plateau[index]);
      finalDetection = (await response.json()).detection;
    }

    assert.equal(finalDetection.status, "confirmed");
    const movements = await database.prepare(`SELECT movement_type AS type,liters,opening_level_liters AS opening,
      closing_level_liters AS closing,detected_automatically AS automatic,detection_status AS status,
      review_status AS reviewStatus,original_liters AS originalLiters,confidence
      FROM fuel_movements WHERE movement_type='receipt'`).all();
    assert.equal(movements.results.length, 1);
    assert.deepEqual(movements.results[0], {
      type: "receipt", liters: 100, opening: 1000, closing: 1100, automatic: 1, status: "confirmed",
      reviewStatus: "pending", originalLiters: 100, confidence: 0.847,
    });
  } finally {
    delete globalThis.__FUEL_EDGE_LOCAL_DB__;
    database.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a gradual fill keeps its anchored baseline and becomes one receipt", async () => {
  const directory = await mkdtemp(join(tmpdir(), "fuel-history-gradual-fill-"));
  const database = createLocalD1(join(directory, "web.sqlite3"));
  globalThis.__FUEL_EDGE_LOCAL_DB__ = database;
  try {
    const worker = await loadWorker();
    const env = { FUEL_SENSOR_INGEST_KEY: sensorKey };
    const start = Date.now() - 45 * 60_000;
    const reading = (minute, levelLiters) => post(worker, env, "/api/fuel-history/readings", {
      levelLiters,
      occurredAt: new Date(start + minute * 60_000).toISOString(),
      source: "PIUSI OCIO 4-20 mA",
      telemetrySessionId: "gradual-fill-session",
    });

    for (let minute = 0; minute < 5; minute += 1) await reading(minute, 1000);
    let detection = null;
    for (let minute = 5; minute <= 19; minute += 1) {
      detection = (await (await reading(minute, 1000 + (minute - 4) * 8)).json()).detection;
    }
    assert.equal(detection.status, "accumulating");
    for (let minute = 20; minute <= 27; minute += 1) {
      detection = (await (await reading(minute, 1120)).json()).detection;
    }
    assert.equal(detection.status, "confirmed");
    assert.deepEqual(await database.prepare(`SELECT liters,opening_level_liters AS opening,
      closing_level_liters AS closing FROM fuel_movements WHERE movement_type='receipt'`).first(), {
      liters: 120, opening: 1000, closing: 1120,
    });
  } finally {
    delete globalThis.__FUEL_EDGE_LOCAL_DB__;
    database.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("an active receipt candidate survives an edge status session change", async () => {
  const directory = await mkdtemp(join(tmpdir(), "fuel-history-active-restart-"));
  const database = createLocalD1(join(directory, "web.sqlite3"));
  globalThis.__FUEL_EDGE_LOCAL_DB__ = database;
  try {
    const worker = await loadWorker();
    const env = { FUEL_SENSOR_INGEST_KEY: sensorKey };
    const start = Date.now() - 30 * 60_000;
    const reading = (minute, levelLiters, session) => post(worker, env, "/api/fuel-history/readings", {
      levelLiters,
      occurredAt: new Date(start + minute * 60_000).toISOString(),
      source: "OCIO",
      telemetrySessionId: session,
    });

    for (let minute = 0; minute < 5; minute += 1) await reading(minute, 1000, "before-restart");
    assert.equal((await (await reading(5, 1120, "before-restart")).json()).detection.status, "started");
    const status = await post(worker, env, "/api/fuel-history/status", {
      moduleId: "rpi-01", siteId: "fundo-01", state: "locked", relayEnergized: false,
      validatorOnline: true, nfcReady: true, k24Enabled: true, k24Healthy: true,
      tankLevelEnabled: true, telemetrySessionId: "after-restart",
      technologyAdoptionStage: "full", adoptionPolicyRevision: 1,
      occurredAt: new Date(start + 6 * 60_000).toISOString(),
    });
    assert.equal(status.status, 200);
    let detection = null;
    for (let minute = 6; minute <= 15; minute += 1) {
      detection = (await (await reading(minute, 1120, "after-restart")).json()).detection;
    }
    assert.equal(detection.status, "confirmed");
    assert.equal((await database.prepare("SELECT COUNT(*) AS total FROM fuel_movements WHERE movement_type='receipt'").first()).total, 1);
  } finally {
    delete globalThis.__FUEL_EDGE_LOCAL_DB__;
    database.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a resumed fill extends the same pending automatic receipt", async () => {
  const directory = await mkdtemp(join(tmpdir(), "fuel-history-receipt-continuation-"));
  const database = createLocalD1(join(directory, "web.sqlite3"));
  globalThis.__FUEL_EDGE_LOCAL_DB__ = database;
  try {
    const worker = await loadWorker();
    const env = { FUEL_SENSOR_INGEST_KEY: sensorKey };
    const start = Date.now() - 40 * 60_000;
    const reading = (minute, levelLiters, session) => post(worker, env, "/api/fuel-history/readings", {
      levelLiters,
      occurredAt: new Date(start + minute * 60_000).toISOString(),
      source: "OCIO",
      telemetrySessionId: session,
    });

    for (let minute = 0; minute < 5; minute += 1) await reading(minute, 1000, "first-session");
    await reading(5, 1100, "first-session");
    await reading(6, 1150, "first-session");
    await reading(7, 1200, "first-session");
    await reading(8, 1250, "first-session");
    await reading(9, 1300, "first-session");
    for (let minute = 10; minute <= 19; minute += 1) await reading(minute, 1300, "first-session");
    const first = await database.prepare(`SELECT id,liters FROM fuel_movements
      WHERE movement_type='receipt'`).first();
    assert.equal(first.liters, 300);

    await reading(20, 1340, "second-session");
    await reading(21, 1380, "second-session");
    await reading(22, 1420, "second-session");
    await reading(23, 1460, "second-session");
    await reading(24, 1500, "second-session");
    let detection = null;
    for (let minute = 25; minute <= 29; minute += 1) {
      detection = (await (await reading(minute, 1500, "second-session")).json()).detection;
      if (detection.status === "extended") break;
    }
    const continuationState = await database.prepare(`SELECT baseline_level_liters AS baseline,
      last_level_liters AS lastLevel,active_receipt_id AS activeId,active_started_at AS activeStartedAt,
      warmup_started_at AS warmupStartedAt,last_reading_at AS lastReadingAt
      FROM fuel_detection_state WHERE id=1`).first();
    const receiptBeforeExtension = await database.prepare(`SELECT id,occurred_at AS occurredAt,liters,
      opening_level_liters AS opening,closing_level_liters AS closing,created_at AS createdAt
      FROM fuel_movements WHERE movement_type='receipt'`).first();
    const receiptReviews = await database.prepare(`SELECT action,occurred_at AS occurredAt
      FROM fuel_receipt_reviews WHERE movement_id=? ORDER BY occurred_at`).bind(first.id).all();
    assert.equal(detection.status, "extended", JSON.stringify({
      detection, continuationState, receiptBeforeExtension, receiptReviews: receiptReviews.results,
    }));
    assert.equal(detection.receiptId, first.id);
    assert.deepEqual(await database.prepare(`SELECT COUNT(*) AS total,liters,
      opening_level_liters AS opening,closing_level_liters AS closing
      FROM fuel_movements WHERE movement_type='receipt'`).first(), {
      total: 1, liters: 500, opening: 1000, closing: 1500,
    });
    assert.equal((await database.prepare(`SELECT COUNT(*) AS total FROM fuel_receipt_reviews
      WHERE movement_id=? AND action='automatic_detected'`).bind(first.id).first()).total, 2);
  } finally {
    delete globalThis.__FUEL_EDGE_LOCAL_DB__;
    database.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("99 percent confidence is reserved for sustained receipts of at least 120 L", async () => {
  const directory = await mkdtemp(join(tmpdir(), "fuel-history-confidence-v2-"));
  const database = createLocalD1(join(directory, "web.sqlite3"));
  globalThis.__FUEL_EDGE_LOCAL_DB__ = database;
  try {
    const worker = await loadWorker();
    const env = { FUEL_SENSOR_INGEST_KEY: sensorKey };
    const start = Date.now() - 30 * 60_000;
    const reading = (minute, levelLiters) => post(worker, env, "/api/fuel-history/readings", {
      levelLiters,
      occurredAt: new Date(start + minute * 60_000).toISOString(),
      source: "PIUSI OCIO 4-20 mA",
      telemetrySessionId: "high-confidence-session",
    });

    for (let minute = 0; minute < 5; minute += 1) await reading(minute, 1000);
    assert.equal((await (await reading(5, 1120)).json()).detection.status, "started");
    let finalDetection = null;
    for (let minute = 6; minute <= 15; minute += 1) {
      finalDetection = (await (await reading(minute, 1120)).json()).detection;
    }
    assert.equal(finalDetection.status, "confirmed");

    const movement = await database.prepare(`SELECT liters,confidence FROM fuel_movements
      WHERE movement_type='receipt'`).first();
    assert.deepEqual(movement, { liters: 120, confidence: 0.986 });
    assert.equal(Math.round(movement.confidence * 100), 99);
  } finally {
    delete globalThis.__FUEL_EDGE_LOCAL_DB__;
    database.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a candidate that returns to the robust baseline is cancelled without a ledger row", async () => {
  const directory = await mkdtemp(join(tmpdir(), "fuel-history-candidate-cancel-v2-"));
  const database = createLocalD1(join(directory, "web.sqlite3"));
  globalThis.__FUEL_EDGE_LOCAL_DB__ = database;
  try {
    const worker = await loadWorker();
    const env = { FUEL_SENSOR_INGEST_KEY: sensorKey };
    const start = Date.now() - 20 * 60_000;
    const reading = (minute, levelLiters) => post(worker, env, "/api/fuel-history/readings", {
      levelLiters,
      occurredAt: new Date(start + minute * 60_000).toISOString(),
      source: "PIUSI OCIO 4-20 mA",
      telemetrySessionId: "cancel-session",
    });

    for (let minute = 0; minute < 5; minute += 1) await reading(minute, 1000);
    const candidate = await reading(5, 1110);
    assert.equal((await candidate.json()).detection.status, "started");
    await reading(6, 1002);
    const cancelled = await reading(7, 1000);
    assert.equal((await cancelled.json()).detection.status, "cancelled");
    assert.equal((await database.prepare("SELECT COUNT(*) AS total FROM fuel_movements WHERE movement_type='receipt'").first()).total, 0);
    assert.equal((await database.prepare("SELECT active_receipt_id AS activeId FROM fuel_detection_state WHERE id=1").first()).activeId, null);
  } finally {
    delete globalThis.__FUEL_EDGE_LOCAL_DB__;
    database.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a telemetry gap also enforces warmup for an older edge without session identifiers", async () => {
  const directory = await mkdtemp(join(tmpdir(), "fuel-history-gap-warmup-v2-"));
  const database = createLocalD1(join(directory, "web.sqlite3"));
  globalThis.__FUEL_EDGE_LOCAL_DB__ = database;
  try {
    const worker = await loadWorker();
    const env = { FUEL_SENSOR_INGEST_KEY: sensorKey };
    const start = Date.now() - 20 * 60_000;
    const reading = (offsetMs, levelLiters) => post(worker, env, "/api/fuel-history/readings", {
      levelLiters,
      occurredAt: new Date(start + offsetMs).toISOString(),
      source: "OCIO",
    });

    await reading(0, 1000);
    await reading(60_000, 1000);
    await reading(120_000, 1000);
    const afterGap = await reading(7 * 60_000, 1070);
    assert.equal((await afterGap.json()).detection.status, "warming_up");
    await reading(8 * 60_000, 1071);
    await reading(9 * 60_000, 1070);
    await reading(10 * 60_000, 1070);
    assert.equal((await database.prepare("SELECT COUNT(*) AS total FROM fuel_movements WHERE movement_type='receipt'").first()).total, 0);
  } finally {
    delete globalThis.__FUEL_EDGE_LOCAL_DB__;
    database.close();
    await rm(directory, { recursive: true, force: true });
  }
});
