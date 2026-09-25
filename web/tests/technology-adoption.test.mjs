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
    AUTH_BOOTSTRAP_VERSION: "test-adoption-1",
    FUEL_SENSOR_INGEST_KEY: randomBytes(32).toString("base64url"),
    FUEL_SITE_ID: "fundo-adopcion",
  };
}

async function loadWorker() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}-${Math.random()}`);
  return (await import(workerUrl.href)).default;
}

const executionContext = { waitUntil() {}, passThroughOnException() {} };

test("desactivar cierra sesiones activas y rechaza programaciones que llegan tarde", async () => {
  const directory = await mkdtemp(join(tmpdir(), "fuel-adoption-close-"));
  const database = createLocalD1(join(directory, "web.sqlite3"));
  globalThis.__FUEL_EDGE_LOCAL_DB__ = database;
  try {
    const worker = await loadWorker();
    const env = authEnv("master@example.test", "test-password");
    const request = async (path, method="POST", body={}, headers={}) => worker.fetch(new Request(`http://localhost/api/${path}`, {
      method, headers:{origin:"http://localhost","content-type":"application/json",...headers},
      ...(method === "GET" ? {} : {body:JSON.stringify(body)}),
    }),env,executionContext);
    const login = await request("auth/login","POST",{email:"master@example.test",password:"test-password"});
    assert.equal(login.status,200);
    const actor={cookie:login.headers.get("set-cookie").split(";",1)[0]};
    const edge={"x-edge-sensor-key":env.FUEL_SENSOR_INGEST_KEY};
    const window={startAt:new Date(Date.now()-1000).toISOString(),endAt:new Date(Date.now()+3600000).toISOString()};
    assert.equal((await request("technology-adoption/start","POST",{},actor)).status,201);
    const schedule=(await (await request("manual-mode","POST",{...window,purpose:"adoption_assisted"},actor)).json()).schedule;
    assert.equal((await request(`manual-mode/edge/${schedule.id}/state`,"POST",{state:"active"},edge)).status,200);
    assert.equal((await request("technology-adoption/deactivate","POST",{},actor)).status,200);
    assert.equal((await (await request("manual-mode/edge/current","POST",{},edge)).json()).schedule,null);
    assert.equal((await request(`manual-mode/edge/${schedule.id}/state`,"POST",{state:"active"},edge)).status,409);
    const closed=await request(`manual-mode/edge/${schedule.id}/state`,"POST",{state:"completed"},edge);
    assert.equal((await closed.json()).schedule.status,"cancelled");
    assert.equal((await request("manual-mode","POST",{...window,purpose:"adoption_assisted"},actor)).status,409);

    // Ordinary manual work remains independent of the program's lifecycle.
    const manual=(await (await request("manual-mode","POST",{...window,purpose:"manual"},actor)).json()).schedule;
    assert.equal((await request("technology-adoption/start","POST",{},actor)).status,201);
    assert.equal((await request("technology-adoption/deactivate","POST",{},actor)).status,200);
    assert.equal((await (await request("manual-mode/edge/current","POST",{},edge)).json()).schedule.id,manual.id);
    await request(`manual-mode/${manual.id}`,"DELETE",{},actor);

    assert.equal((await request("technology-adoption/start","POST",{},actor)).status,201);
    // Force deactivation between initial API validation and the SQL INSERT.
    const originalPrepare=database.prepare.bind(database);
    let intercepted=false;
    database.prepare=query=>{
      const statement=originalPrepare(query);
      if (/INSERT INTO manual_mode_schedules/u.test(query)) {
        const bind=statement.bind.bind(statement);
        statement.bind=(...values)=>{
          const bound=bind(...values),run=bound.run.bind(bound);
          bound.run=async()=>{
            intercepted=true;
            assert.equal((await request("technology-adoption/deactivate","POST",{},actor)).status,200);
            return run();
          };
          return bound;
        };
      }
      return statement;
    };
    const late=await request("manual-mode","POST",{...window,purpose:"adoption_assisted"},actor);
    database.prepare=originalPrepare;
    assert.equal(intercepted,true);
    assert.equal(late.status,409);
    assert.equal((await (await request("manual-mode/edge/current","POST",{},edge)).json()).schedule,null);
    assert.equal((await database.prepare("SELECT COUNT(*) AS n FROM manual_mode_schedules WHERE status IN ('scheduled','active')").first()).n,0);

    // A review started in another tab must not reactivate the program after close.
    assert.equal((await request("technology-adoption/start","POST",{},actor)).status,201);
    const batch=database.batch.bind(database);
    let reviewed=false;
    database.batch=async statements=>{
      if (/UPDATE technology_adoption_settings/u.test(statements[0]?.query ?? "")) {
        database.batch=batch;
        reviewed=true;
        assert.equal((await request("technology-adoption/deactivate","POST",{},actor)).status,200);
      }
      return batch(statements);
    };
    const lateReview=await request("technology-adoption","PUT",{stage:"rfid_only",reviewAt:null,note:"Revisión anterior a la desactivación"},actor);
    database.batch=batch;
    assert.equal(reviewed,true);
    assert.equal(lateReview.status,409);
    const inactive=(await (await request("technology-adoption","GET",{},actor)).json()).settings;
    assert.equal(inactive.programStatus,"inactive");
    assert.equal(inactive.stage,"full");

    // A revision match in an old report must not confirm application today.
    const settings=(await (await request("technology-adoption","GET",{},actor)).json()).settings;
    await database.prepare(`INSERT OR REPLACE INTO edge_runtime_status(id,module_id,site_id,state,relay_energized,validator_online,k24_healthy,technology_adoption_stage,adoption_policy_revision,occurred_at)
      VALUES (1,'rpi',?,'locked',0,1,1,'full',?,?)`).bind(env.FUEL_SITE_ID,settings.revision,new Date(Date.now()-60000).toISOString()).run();
    assert.equal((await (await request("technology-adoption","GET",{},actor)).json()).edgeApplication.applied,false);
    await database.prepare("UPDATE edge_runtime_status SET occurred_at=? WHERE id=1").bind(new Date().toISOString()).run();
    assert.equal((await (await request("technology-adoption","GET",{},actor)).json()).edgeApplication.applied,true);
  } finally {
    delete globalThis.__FUEL_EDGE_LOCAL_DB__;
    database.close();
    await rm(directory,{recursive:true,force:true});
  }
});

test("la adopción avanza por etapas y habilita sesiones asistidas auditables", async () => {
  const directory = await mkdtemp(join(tmpdir(), "fuel-adoption-"));
  const database = createLocalD1(join(directory, "web.sqlite3"));
  globalThis.__FUEL_EDGE_LOCAL_DB__ = database;
  try {
    const worker = await loadWorker();
    const env = authEnv("master@example.test", "correct horse battery staple");
    const login = await worker.fetch(new Request("http://localhost/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://localhost" },
      body: JSON.stringify({ email: "master@example.test", password: "correct horse battery staple" }),
    }), env, executionContext);
    assert.equal(login.status, 200);
    const cookie = (login.headers.get("set-cookie") ?? "").split(";", 1)[0];
    const actorHeaders = { cookie, origin: "http://localhost", "content-type": "application/json" };
    const edgeHeaders = { "content-type": "application/json", "x-edge-sensor-key": env.FUEL_SENSOR_INGEST_KEY };

    const initial = await worker.fetch(new Request("http://localhost/api/technology-adoption", {
      headers: { cookie },
    }), env, executionContext);
    assert.equal(initial.status, 200);
    const initialDashboard = await initial.json();
    assert.equal(initialDashboard.settings.stage, "full");
    assert.equal(initialDashboard.settings.programStatus, "inactive");
    assert.equal(initialDashboard.settings.completedAt, null);
    assert.equal(initialDashboard.settings.revision, 1);
    assert.equal(initialDashboard.metrics.totalLoads, 0);

    const master = await database.prepare("SELECT permissions FROM web_users WHERE id=?")
      .bind("usr-master").first();
    assert.equal(typeof master?.permissions, "string");
    await database.prepare("UPDATE web_users SET permissions=? WHERE id=?")
      .bind(JSON.stringify(["view_dashboard"]), "usr-master").run();
    const forbidden = await worker.fetch(new Request("http://localhost/api/technology-adoption/start", {
      method: "POST",
      headers: actorHeaders,
      body: "{}",
    }), env, executionContext);
    assert.equal(forbidden.status, 403);
    await database.prepare("UPDATE web_users SET permissions=? WHERE id=?")
      .bind(master.permissions, "usr-master").run();

    const started = await worker.fetch(new Request("http://localhost/api/technology-adoption/start", {
      method: "POST",
      headers: actorHeaders,
      body: "{}",
    }), env, executionContext);
    assert.equal(started.status, 201);
    const startedSettings = (await started.json()).settings;
    assert.equal(startedSettings.programStatus, "active");
    assert.equal(startedSettings.stage, "assisted");
    assert.equal(startedSettings.revision, 2);

    const unsafeJump = await worker.fetch(new Request("http://localhost/api/technology-adoption", {
      method: "PUT",
      headers: actorHeaders,
      body: JSON.stringify({ stage: "full", reviewAt: null, note: "Intento de completar sin etapa RFID" }),
    }), env, executionContext);
    assert.equal(unsafeJump.status, 409);

    const reviewAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
    const rfid = await worker.fetch(new Request("http://localhost/api/technology-adoption", {
      method: "PUT",
      headers: actorHeaders,
      body: JSON.stringify({ stage: "rfid_only", reviewAt, note: "Comenzaremos exigiendo identidad RFID" }),
    }), env, executionContext);
    assert.equal(rfid.status, 200);
    assert.equal((await rfid.json()).settings.revision, 3);

    const assisted = await worker.fetch(new Request("http://localhost/api/technology-adoption", {
      method: "PUT",
      headers: actorHeaders,
      body: JSON.stringify({ stage: "assisted", reviewAt, note: "Acompañamiento inicial en terreno" }),
    }), env, executionContext);
    assert.equal(assisted.status, 200);
    assert.equal((await assisted.json()).settings.revision, 4);

    const edgePolicy = await worker.fetch(new Request("http://localhost/api/technology-adoption/edge/current", {
      method: "POST", headers: edgeHeaders, body: "{}",
    }), env, executionContext);
    assert.equal(edgePolicy.status, 200);
    const policy = (await edgePolicy.json()).policy;
    assert.equal(policy.siteId, "fundo-adopcion");
    assert.equal(policy.stage, "assisted");
    assert.equal(policy.revision, 4);
    assert.ok(Number.isFinite(new Date(policy.updatedAt).getTime()));

    const scheduled = await worker.fetch(new Request("http://localhost/api/manual-mode", {
      method: "POST",
      headers: actorHeaders,
      body: JSON.stringify({
        startAt: new Date(Date.now() - 1000).toISOString(),
        endAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        purpose: "adoption_assisted",
      }),
    }), env, executionContext);
    assert.equal(scheduled.status, 201);
    const schedule = (await scheduled.json()).schedule;
    assert.equal(schedule.purpose, "adoption_assisted");
    assert.match(schedule.id, /^adoption-session-/u);

    const edgeSchedule = await worker.fetch(new Request("http://localhost/api/manual-mode/edge/current", {
      method: "POST", headers: edgeHeaders, body: "{}",
    }), env, executionContext);
    assert.equal(edgeSchedule.status, 200);
    assert.equal((await edgeSchedule.json()).schedule.purpose, "adoption_assisted");

    const changeDuringSession = await worker.fetch(new Request("http://localhost/api/technology-adoption", {
      method: "PUT",
      headers: actorHeaders,
      body: JSON.stringify({ stage: "rfid_only", reviewAt, note: "Intento durante sesión activa" }),
    }), env, executionContext);
    assert.equal(changeDuringSession.status, 409);

    const deactivateDuringSession = await worker.fetch(new Request("http://localhost/api/technology-adoption/deactivate", {
      method: "POST",
      headers: actorHeaders,
      body: "{}",
    }), env, executionContext);
    assert.equal(deactivateDuringSession.status, 200);
    assert.equal((await deactivateDuringSession.json()).settings.stage, "full");
    const cancelled = await database.prepare("SELECT status FROM manual_mode_schedules WHERE id=?").bind(schedule.id).first();
    assert.equal(cancelled.status, "cancelled");
    const stopped = await worker.fetch(new Request("http://localhost/api/manual-mode/edge/current", {
      method: "POST", headers: edgeHeaders, body: "{}",
    }), env, executionContext);
    assert.equal((await stopped.json()).schedule, null);

    const audits = await database.prepare(`SELECT event FROM web_access_audit
      WHERE event LIKE 'technology_adoption_%'
      ORDER BY id`).all();
    assert.deepEqual(audits.results.map((row) => row.event), [
      "technology_adoption_started",
      "technology_adoption_stage_changed",
      "technology_adoption_stage_changed",
      "technology_adoption_assisted_session_scheduled",
      "technology_adoption_deactivated",
    ]);
  } finally {
    delete globalThis.__FUEL_EDGE_LOCAL_DB__;
    database.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("un inicio accidental puede desactivarse y restaura la política completa", async () => {
  const directory = await mkdtemp(join(tmpdir(), "fuel-adoption-deactivate-"));
  const database = createLocalD1(join(directory, "web.sqlite3"));
  globalThis.__FUEL_EDGE_LOCAL_DB__ = database;
  try {
    const worker = await loadWorker();
    const env = authEnv("master@example.test", "correct horse battery staple");
    const login = await worker.fetch(new Request("http://localhost/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://localhost" },
      body: JSON.stringify({ email: "master@example.test", password: "correct horse battery staple" }),
    }), env, executionContext);
    assert.equal(login.status, 200);
    const cookie = (login.headers.get("set-cookie") ?? "").split(";", 1)[0];
    const actorHeaders = { cookie, origin: "http://localhost", "content-type": "application/json" };
    const edgeHeaders = { "content-type": "application/json", "x-edge-sensor-key": env.FUEL_SENSOR_INGEST_KEY };

    const started = await worker.fetch(new Request("http://localhost/api/technology-adoption/start", {
      method: "POST", headers: actorHeaders, body: "{}",
    }), env, executionContext);
    assert.equal(started.status, 201);
    assert.equal((await started.json()).settings.stage, "assisted");

    const master = await database.prepare("SELECT permissions FROM web_users WHERE id=?")
      .bind("usr-master").first();
    await database.prepare("UPDATE web_users SET permissions=? WHERE id=?")
      .bind(JSON.stringify(["view_dashboard"]), "usr-master").run();
    const forbidden = await worker.fetch(new Request("http://localhost/api/technology-adoption/deactivate", {
      method: "POST", headers: actorHeaders, body: "{}",
    }), env, executionContext);
    assert.equal(forbidden.status, 403);
    await database.prepare("UPDATE web_users SET permissions=? WHERE id=?")
      .bind(master.permissions, "usr-master").run();

    const deactivated = await worker.fetch(new Request("http://localhost/api/technology-adoption/deactivate", {
      method: "POST", headers: actorHeaders, body: "{}",
    }), env, executionContext);
    assert.equal(deactivated.status, 200);
    const settings = (await deactivated.json()).settings;
    assert.equal(settings.programStatus, "inactive");
    assert.equal(settings.stage, "full");
    assert.equal(settings.revision, 3);
    assert.equal(settings.completedAt, null);
    assert.match(settings.note, /restaura la trazabilidad completa/i);

    const edgePolicy = await worker.fetch(new Request("http://localhost/api/technology-adoption/edge/current", {
      method: "POST", headers: edgeHeaders, body: "{}",
    }), env, executionContext);
    assert.equal(edgePolicy.status, 200);
    const policy = (await edgePolicy.json()).policy;
    assert.equal(policy.stage, "full");
    assert.equal(policy.revision, 3);

    const audits = await database.prepare(`SELECT event FROM web_access_audit
      WHERE event LIKE 'technology_adoption_%'
      ORDER BY id`).all();
    assert.deepEqual(audits.results.map((row) => row.event), [
      "technology_adoption_started",
      "technology_adoption_deactivated",
    ]);

    const restarted = await worker.fetch(new Request("http://localhost/api/technology-adoption/start", {
      method: "POST", headers: actorHeaders, body: "{}",
    }), env, executionContext);
    assert.equal(restarted.status, 201);
    const restartedSettings = (await restarted.json()).settings;
    assert.equal(restartedSettings.programStatus, "active");
    assert.equal(restartedSettings.stage, "assisted");
    assert.equal(restartedSettings.revision, 4);
  } finally {
    delete globalThis.__FUEL_EDGE_LOCAL_DB__;
    database.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("la adopción completada queda cerrada y conserva la política completa", async () => {
  const directory = await mkdtemp(join(tmpdir(), "fuel-adoption-complete-"));
  const database = createLocalD1(join(directory, "web.sqlite3"));
  globalThis.__FUEL_EDGE_LOCAL_DB__ = database;
  try {
    const worker = await loadWorker();
    const env = authEnv("master@example.test", "correct horse battery staple");
    const login = await worker.fetch(new Request("http://localhost/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://localhost" },
      body: JSON.stringify({ email: "master@example.test", password: "correct horse battery staple" }),
    }), env, executionContext);
    assert.equal(login.status, 200);
    const cookie = (login.headers.get("set-cookie") ?? "").split(";", 1)[0];
    const headers = { cookie, origin: "http://localhost", "content-type": "application/json" };

    const started = await worker.fetch(new Request("http://localhost/api/technology-adoption/start", {
      method: "POST", headers, body: "{}",
    }), env, executionContext);
    assert.equal(started.status, 201);

    const reviewAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
    const rfid = await worker.fetch(new Request("http://localhost/api/technology-adoption", {
      method: "PUT", headers,
      body: JSON.stringify({ stage: "rfid_only", reviewAt, note: "Identidad RFID incorporada en la operación" }),
    }), env, executionContext);
    assert.equal(rfid.status, 200);

    const completed = await worker.fetch(new Request("http://localhost/api/technology-adoption", {
      method: "PUT", headers,
      body: JSON.stringify({ stage: "full", reviewAt: null, note: "Aprendizaje completado con trazabilidad integral" }),
    }), env, executionContext);
    assert.equal(completed.status, 200);
    const settings = (await completed.json()).settings;
    assert.equal(settings.programStatus, "completed");
    assert.equal(settings.stage, "full");
    assert.equal(settings.revision, 4);
    assert.ok(Number.isFinite(new Date(settings.completedAt).getTime()));

    const restart = await worker.fetch(new Request("http://localhost/api/technology-adoption/start", {
      method: "POST", headers, body: "{}",
    }), env, executionContext);
    assert.equal(restart.status, 409);

    const edgePolicy = await worker.fetch(new Request("http://localhost/api/technology-adoption/edge/current", {
      method: "POST",
      headers: { "content-type": "application/json", "x-edge-sensor-key": env.FUEL_SENSOR_INGEST_KEY },
      body: "{}",
    }), env, executionContext);
    assert.equal(edgePolicy.status, 200);
    const policy = (await edgePolicy.json()).policy;
    assert.equal(policy.stage, "full");
    assert.equal(policy.revision, 4);
  } finally {
    delete globalThis.__FUEL_EDGE_LOCAL_DB__;
    database.close();
    await rm(directory, { recursive: true, force: true });
  }
});
