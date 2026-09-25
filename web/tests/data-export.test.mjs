import assert from "node:assert/strict";
import { createHmac, pbkdf2Sync, randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createLocalD1 } from "../runtime/local-d1.mjs";

function base64url(value) {
  return Buffer.from(value).toString("base64url");
}

function authEnv(email, password) {
  const pepper = randomBytes(32);
  const salt = randomBytes(16);
  const iterations = 310000;
  return {
    ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) },
    AUTH_ADMIN_EMAIL_DIGEST: base64url(createHmac("sha256", pepper).update(email).digest()),
    AUTH_ADMIN_PASSWORD_HASH: `pbkdf2_sha256$${iterations}$${base64url(salt)}$${base64url(pbkdf2Sync(password, salt, iterations, 32, "sha256"))}`,
    AUTH_EMAIL_PEPPER: base64url(pepper),
    AUTH_SESSION_SECRET: randomBytes(32).toString("base64url"),
    AUTH_SESSION_TTL_SECONDS: "3600",
    AUTH_DATA_KEY: randomBytes(32).toString("base64url"),
    AUTH_BOOTSTRAP_VERSION: "test-data-export-1",
  };
}

async function loadWorker() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}-${Math.random()}`);
  return (await import(workerUrl.href)).default;
}

async function login(worker, env, email, password) {
  const response = await worker.fetch(new Request("http://localhost/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json", origin: "http://localhost" },
    body: JSON.stringify({ email, password }),
  }), env, executionContext);
  assert.equal(response.status, 200);
  return (response.headers.get("set-cookie") ?? "").split(";", 1)[0];
}

const executionContext = { waitUntil() {}, passThroughOnException() {} };

test("permite a todo usuario autenticado descargar una exportación operacional sanitizada", async () => {
  const directory = await mkdtemp(join(tmpdir(), "fuel-data-export-"));
  const database = createLocalD1(join(directory, "web.sqlite3"));
  globalThis.__FUEL_EDGE_LOCAL_DB__ = database;
  try {
    const worker = await loadWorker();
    const env = authEnv("master@example.test", "correct horse battery staple");
    const masterCookie = await login(worker, env, "master@example.test", "correct horse battery staple");

    const initialized = await worker.fetch(new Request("http://localhost/api/data-export", {
      headers: { cookie: masterCookie },
    }), env, executionContext);
    assert.equal(initialized.status, 200);
    const initialData = await initialized.json();
    assert.deepEqual(initialData.voltajesHistoricos, []);
    const sensorKey = "voltage-sensor-test-key-32-characters";
    env.FUEL_SENSOR_INGEST_KEY = sensorKey;
    const voltageBody = { siteId: "concha-y-toro-piloto", telemetrySessionId: "boot-1", source: "OCIO",
      samples: [{ occurredAt: "2026-08-20T12:00:00+00:00", volts: 8.129426, rawAdc: 3329, quality: "valid", calibrationId: "curve-test" }] };
    const postVoltage = (body, key = sensorKey) => worker.fetch(new Request("http://localhost/api/fuel-history/voltages", {
      method: "POST", headers: { "content-type": "application/json", "x-edge-sensor-key": key }, body: JSON.stringify(body),
    }), env, executionContext);
    assert.equal((await postVoltage(voltageBody, "wrong")).status, 403);
    assert.equal((await postVoltage(voltageBody)).status, 200);
    assert.equal((await postVoltage({ ...voltageBody, samples: [{ ...voltageBody.samples[0], occurredAt: "2026-08-20T12:00:00.000Z" }] })).status, 200);
    assert.equal((await database.prepare("SELECT COUNT(*) AS n FROM voltage_readings").first()).n, 1);
    for (const bad of [null, {}, { ...voltageBody, siteId: "another-site" }, { ...voltageBody, samples: [] },
      { ...voltageBody, samples: [voltageBody.samples[0], { ...voltageBody.samples[0], volts: 11 }] },
      { ...voltageBody, samples: [{ ...voltageBody.samples[0], occurredAt: "not-a-date" }] }]) {
      assert.equal((await postVoltage(bad)).status, 400);
    }
    assert.equal((await database.prepare("SELECT COUNT(*) AS n FROM voltage_readings").first()).n, 1);
    await database.batch(Array.from({ length: 1001 }, (_, i) => database.prepare(`INSERT INTO voltage_readings
      (site_id,telemetry_session_id,occurred_at,source,volts,raw_adc,quality) VALUES ('concha-y-toro-piloto','boot-1',?,'OCIO',2.5,1023.75,'warming_up')`)
      .bind(new Date(Date.UTC(2026, 7, 20, 13, 0, i)).toISOString())));

    const created = await worker.fetch(new Request("http://localhost/api/users", {
      method: "POST",
      headers: { cookie: masterCookie, origin: "http://localhost", "content-type": "application/json" },
      body: JSON.stringify({
        name: "Usuario consulta",
        email: "viewer@example.test",
        role: "viewer",
        permissions: ["view_dashboard", "view_transactions"],
      }),
    }), env, executionContext);
    assert.equal(created.status, 201);
    const viewer = await created.json();
    const viewerCookie = await login(worker, env, "viewer@example.test", viewer.temporaryPassword);

    await database.batch([
      database.prepare(`INSERT INTO managed_operators(
        id,name,rut,credential,credential_active,credential_is_master,active,last_use
      ) VALUES ('op-export','Operador Exportación','11.111.111-1','nfc-private-id',1,0,1,'Hoy')`),
      database.prepare(`INSERT INTO managed_rfid_credentials(
        credential_id,credential_active,credential_is_master,operator_id
      ) VALUES ('nfc-private-id',1,0,'op-export')`),
      database.prepare(`INSERT INTO managed_equipment(
        id,name,kind,condition,module,site_id,active
      ) VALUES ('eq-export','Tractor de prueba','Tractor','Permanente','KT-MOD-EXPORT','site-santa-isabel',1)`),
      database.prepare(`INSERT INTO managed_associations(
        id,operator_id,equipment_id,active,since
      ) VALUES ('as-export','op-export','eq-export',1,'20 ago 2026')`),
      database.prepare(`INSERT INTO fuel_level_readings(occurred_at,level_liters,source)
        VALUES ('2026-08-20T12:00:00.000Z',1450.5,'OCIO')`),
      database.prepare(`INSERT INTO fuel_movements(
        id,movement_type,occurred_at,liters,opening_level_liters,closing_level_liters,
        source,reference_id,detail,operator_id,equipment_id
      ) VALUES ('tx-export','dispatch','2026-08-20T12:05:00.000Z',50,1450.5,1400.5,
        'K24','ref-export','Carga normal','op-export','eq-export')`),
      database.prepare(`INSERT INTO system_alerts(
        id,severity,priority,status,title,detail,occurred_at
      ) VALUES ('alert-export','info','low','resolved','Prueba de exportación','Evento incluido','2026-08-20T12:10:00.000Z')`),
    ]);

    const response = await worker.fetch(new Request("http://localhost/api/data-export", {
      headers: { cookie: viewerCookie },
    }), env, executionContext);
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /^application\/json/i);
    assert.match(response.headers.get("content-disposition") ?? "", /^attachment; filename="base-datos-fundo-santa-isabel-/i);
    assert.match(response.headers.get("cache-control") ?? "", /no-store/i);
    const body = await response.json();
    assert.equal(body.metadatos.scope, "operational-sanitized");
    assert.equal(body.metadatos.schemaVersion, 3);
    assert.equal(body.metadatos.counts.voltajesHistoricos, 1002);
    assert.equal(body.voltajesHistoricos.length, 1002);
    assert.equal(body.voltajesHistoricos[0].volts, 8.129426);
    assert.equal(body.voltajesHistoricos[0].rawAdc, 3329);
    assert.equal(body.voltajesHistoricos[0].calibrationId, "curve-test");
    assert.equal(body.litrosPorMaquina[0].equipmentId, "eq-export");
    assert.equal(body.litrosPorMaquina[0].liters, 50);
    assert.equal(body.litrosPorMaquina[0].loads, 1);
    assert.equal(body.metadatos.generatedBy.role, "viewer");
    assert.equal(body.nivelesHistoricos.at(-1).levelLiters, 1450.5);
    assert.equal(body.transacciones.at(-1).operatorName, "Operador Exportación");
    assert.equal(body.vinculacionesOperadorEquipo.at(-1).equipmentName, "Tractor de prueba");
    assert.equal(body.usuarios.some((user) => user.name === "Usuario consulta"), true);
    assert.equal(body.alertas.some((alert) => alert.id === "alert-export"), true);
    const serialized = JSON.stringify(body);
    assert.doesNotMatch(serialized, /viewer@example\.test|11\.111\.111-1|nfc-private-id|password_hash|email_digest/i);

    const transactionsCsv = await worker.fetch(new Request("http://localhost/api/data-export?dataset=transactions", {
      headers: { cookie: viewerCookie },
    }), env, executionContext);
    assert.equal(transactionsCsv.status, 200);
    assert.match(transactionsCsv.headers.get("content-type") ?? "", /^text\/csv/i);
    assert.match(transactionsCsv.headers.get("content-disposition") ?? "", /transacciones-/i);
    assert.match(await transactionsCsv.text(), /Operador Exportación.*Tractor de prueba/is);
    const getExport = dataset => worker.fetch(new Request(`http://localhost/api/data-export?dataset=${dataset}`, { headers: { cookie: viewerCookie } }), env, executionContext);
    const voltagesCsv = await getExport("voltages");
    assert.equal(voltagesCsv.status, 200);
    const voltageCsvText = await voltagesCsv.text();
    assert.match(voltageCsvText, /"8.129426","3329","valid"/);
    assert.equal(voltageCsvText.trim().split(/\r?\n/).length, 1003);
    const machineCsv = await getExport("machine-liters");
    assert.equal(machineCsv.status, 200);
    assert.match(await machineCsv.text(), /"eq-export","Tractor de prueba","Tractor","50.0","1","50.0"/);

    const invalidDataset = await worker.fetch(new Request("http://localhost/api/data-export?dataset=private-secrets", {
      headers: { cookie: viewerCookie },
    }), env, executionContext);
    assert.equal(invalidDataset.status, 400);

    const audit = await database.prepare("SELECT event FROM web_access_audit WHERE actor_user_id=? ORDER BY id DESC LIMIT 1")
      .bind(viewer.user.id).first();
    assert.equal(audit.event, "operational_data_exported");

    const unauthorized = await worker.fetch(new Request("http://localhost/api/data-export"), env, executionContext);
    assert.equal(unauthorized.status, 401);
  } finally {
    delete globalThis.__FUEL_EDGE_LOCAL_DB__;
    database.close();
    await rm(directory, { recursive: true, force: true });
  }
});
