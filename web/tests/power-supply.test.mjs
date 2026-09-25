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
    AUTH_BOOTSTRAP_VERSION: "test-power-supply-1",
    FUEL_SENSOR_INGEST_KEY: randomBytes(32).toString("base64url"),
    FUEL_SITE_ID: "fundo-prueba",
  };
}

async function loadWorker() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}-${Math.random()}`);
  return (await import(workerUrl.href)).default;
}

const executionContext = { waitUntil() {}, passThroughOnException() {} };

test("registra cortes desde el edge y entrega el historial sólo a administración", async () => {
  const directory = await mkdtemp(join(tmpdir(), "fuel-power-supply-"));
  const database = createLocalD1(join(directory, "web.sqlite3"));
  globalThis.__FUEL_EDGE_LOCAL_DB__ = database;
  try {
    const worker = await loadWorker();
    const env = authEnv("master@example.test", "correct horse battery staple");
    const restoredAt = new Date(Date.now() - 60 * 1000);
    const lostAt = new Date(restoredAt.getTime() - 2 * 60 * 60 * 1000);
    const event = {
      id: "power-test-01",
      siteId: "fundo-prueba",
      lostAt: lostAt.toISOString(),
      restoredAt: restoredAt.toISOString(),
      durationSeconds: 1,
      source: "ups_gpio24",
      lossBootId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
      restoreBootId: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
    };
    const edgeHeaders = {
      "content-type": "application/json",
      "x-edge-sensor-key": env.FUEL_SENSOR_INGEST_KEY,
    };
    const alert = {id:`edge-alert-${event.id}`,severity:"warning",priority:"high",
      title:"Corte eléctrico",occurredAt:event.lostAt,
      detail:"Detectado por la UPS del PLC. Suministro interrumpido; recuperación aún no registrada."};
    const sendAlert = body => worker.fetch(new Request("http://localhost/api/alerts/edge", {
      method:"POST",headers:edgeHeaders,body:JSON.stringify(body),
    }),env,executionContext);
    const initialAlert = await sendAlert(alert);
    assert.equal(initialAlert.status,201);
    assert.equal((await initialAlert.json()).created,true);
    const created = await worker.fetch(new Request("http://localhost/api/system-settings/power-events/edge", {
      method: "POST", headers: edgeHeaders, body: JSON.stringify(event),
    }), env, executionContext);
    assert.equal(created.status, 201);
    assert.equal((await created.json()).event.durationSeconds, 7200);
    const restoredAlert = {...alert,detail:"Recuperación registrada. Duración registrada: 2 h 0 min 0 s. Revisar la cuadratura del inventario."};
    assert.equal((await (await sendAlert(restoredAlert)).json()).updated,true);
    assert.equal((await (await sendAlert(restoredAlert)).json()).updated,false);

    const anonymous = await worker.fetch(new Request("http://localhost/api/system-settings/power-events?days=1"), env, executionContext);
    assert.equal(anonymous.status, 403);

    const login = await worker.fetch(new Request("http://localhost/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://localhost" },
      body: JSON.stringify({ email: "master@example.test", password: "correct horse battery staple" }),
    }), env, executionContext);
    assert.equal(login.status, 200);
    const cookie = (login.headers.get("set-cookie") ?? "").split(";", 1)[0];
    const history = await worker.fetch(new Request("http://localhost/api/system-settings/power-events?days=1", {
      headers: { cookie },
    }), env, executionContext);
    assert.equal(history.status, 200);
    const payload = await history.json();
    assert.equal(payload.rangeDays, 1);
    assert.equal(payload.summary.outageCount, 1);
    assert.equal(payload.summary.totalDowntimeSeconds, 7200);
    assert.equal(payload.events[0].source, "ups_gpio24");
    assert.equal((await database.prepare("SELECT COUNT(*) AS count FROM power_supply_events").first()).count, 1);
    const visible = await worker.fetch(new Request("http://localhost/api/alerts",{headers:{cookie}}),env,executionContext);
    assert.equal(visible.status,200);
    const {alerts} = await visible.json();
    assert.equal(alerts.length,1);
    assert.equal(alerts[0].title,"Corte eléctrico");
    assert.equal(alerts[0].priority,"high");
    assert.equal(alerts[0].time,event.lostAt);
    assert.equal(alerts[0].detail,restoredAlert.detail);
    assert.equal(alerts[0].status,"pending"); // volver a tener energía no cierra la alarma
    assert.equal(alerts[0].powerIncidentType, null);
    const action = (body, target = alert.id, extraHeaders = {}) => worker.fetch(new Request(`http://localhost/api/alerts/${target}/action`, {
      method: "POST", headers: {"content-type":"application/json",origin:"http://localhost",cookie, ...extraHeaders},
      body: JSON.stringify({description:"Corte revisado y cuadratura verificada en terreno.", status:"in_progress", ...body}),
    }), env, executionContext);
    assert.equal((await action({status:"resolved"})).status,409);
    assert.equal((await action({powerIncidentType:"other"})).status,400);
    assert.equal((await action({powerIncidentType:"scheduled"},alert.id,{origin:"http://otra-web.test"})).status,403);
    assert.equal((await action({powerIncidentType:"scheduled"},alert.id,{cookie:""})).status,401);
    for (const powerIncidentType of ["scheduled", "unscheduled", "internal_fault"]) {
      assert.equal((await action({powerIncidentType})).status,200);
    }
    const classified = await (await worker.fetch(new Request("http://localhost/api/alerts",{headers:{cookie}}),env,executionContext)).json();
    assert.equal(classified.alerts[0].powerIncidentType,"internal_fault");
    assert.deepEqual(classified.alerts[0].comments.map(c=>c.powerIncidentTypeAfter),["scheduled","unscheduled","internal_fault"]);
    // A sensor retry must preserve the human classification.
    await sendAlert({...restoredAlert,detail:restoredAlert.detail+" Registro revisado por el PLC."});
    const updatedHistory = await (await worker.fetch(new Request("http://localhost/api/system-settings/power-events?days=1",{headers:{cookie}}),env,executionContext)).json();
    assert.equal(updatedHistory.events[0].incidentType,"internal_fault");
    assert.equal(updatedHistory.events[0].alertId,alert.id);
    const ordinary = {...alert,id:"edge-alert-sensor-test",title:"Sensor de nivel sin reporte"};
    await sendAlert(ordinary);
    assert.equal((await action({powerIncidentType:"scheduled"},ordinary.id)).status,409);
    assert.equal((await action({status:"resolved"},ordinary.id)).status,200);
    const resolved = await worker.fetch(new Request(`http://localhost/api/alerts/${alert.id}/action`,{
      method:"POST",headers:{"content-type":"application/json",origin:"http://localhost",cookie},
      body:JSON.stringify({status:"resolved",description:"Corte revisado y cuadratura verificada en terreno."}),
    }),env,executionContext);
    assert.equal(resolved.status,200);
    assert.equal((await (await sendAlert(restoredAlert)).json()).reason,"resolved");
    const storedAlert = await database.prepare("SELECT status FROM system_alerts WHERE id=?").bind(alert.id).first();
    assert.equal(storedAlert.status,"resolved");
    assert.equal((await database.prepare("SELECT COUNT(*) AS n FROM system_alerts").first()).n,2);
    const reopened = await worker.fetch(new Request(`http://localhost/api/alerts/${alert.id}/reopen`, {
      method:"POST",headers:{"content-type":"application/json",origin:"http://localhost",cookie},
      body:JSON.stringify({reason:"Nueva revisión del circuito interno de suministro.",priority:"high"}),
    }),env,executionContext);
    assert.equal(reopened.status,201);
    const reopenedId = (await reopened.json()).alertId;
    assert.equal((await action({powerIncidentType:"unscheduled"},reopenedId)).status,200);
    const reopenedHistory = await (await worker.fetch(new Request("http://localhost/api/system-settings/power-events?days=1",{headers:{cookie}}),env,executionContext)).json();
    assert.equal(reopenedHistory.events[0].incidentType,"unscheduled");
    assert.equal(reopenedHistory.events[0].alertId,reopenedId);
    assert.equal((await database.prepare("SELECT power_incident_type AS classification FROM system_alerts WHERE id=?").bind(alert.id).first()).classification,"internal_fault");

    const invalid = await worker.fetch(new Request("http://localhost/api/system-settings/power-events/edge", {
      method: "POST", headers: edgeHeaders, body: JSON.stringify({ ...event, restoredAt: event.lostAt }),
    }), env, executionContext);
    assert.equal(invalid.status, 400);
  } finally {
    delete globalThis.__FUEL_EDGE_LOCAL_DB__;
    database.close();
    await rm(directory, { recursive: true, force: true });
  }
});
