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
    AUTH_BOOTSTRAP_VERSION: "test-manual-mode-1",
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

test("permite al supervisor programar modo manual y lo entrega al controlador edge", async () => {
  const directory = await mkdtemp(join(tmpdir(), "fuel-manual-mode-"));
  const database = createLocalD1(join(directory, "web.sqlite3"));
  globalThis.__FUEL_EDGE_LOCAL_DB__ = database;
  try {
    const worker = await loadWorker();
    const env = authEnv("master@example.test", "correct horse battery staple");
    const masterLogin = await worker.fetch(new Request("http://localhost/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://localhost" },
      body: JSON.stringify({ email: "master@example.test", password: "correct horse battery staple" }),
    }), env, executionContext);
    assert.equal(masterLogin.status, 200);
    const masterCookie = (masterLogin.headers.get("set-cookie") ?? "").split(";", 1)[0];
    const created = await worker.fetch(new Request("http://localhost/api/users", {
      method: "POST",
      headers: { cookie: masterCookie, origin: "http://localhost", "content-type": "application/json" },
      body: JSON.stringify({
        name: "Segundo al mando",
        email: "supervisor@example.test",
        role: "supervisor",
        permissions: ["view_dashboard"],
      }),
    }), env, executionContext);
    assert.equal(created.status, 201);
    const supervisor = await created.json();
    const supervisorLogin = await worker.fetch(new Request("http://localhost/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://localhost" },
      body: JSON.stringify({ email: "supervisor@example.test", password: supervisor.temporaryPassword }),
    }), env, executionContext);
    assert.equal(supervisorLogin.status, 200);
    const supervisorCookie = (supervisorLogin.headers.get("set-cookie") ?? "").split(";", 1)[0];
    const startAt = new Date(Date.now() - 1000).toISOString();
    const endAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const scheduled = await worker.fetch(new Request("http://localhost/api/manual-mode", {
      method: "POST",
      headers: { cookie: supervisorCookie, origin: "http://localhost", "content-type": "application/json" },
      body: JSON.stringify({ startAt, endAt }),
    }), env, executionContext);
    assert.equal(scheduled.status, 201);
    const schedule = (await scheduled.json()).schedule;
    assert.equal(schedule.actorRole, "supervisor");
    assert.equal(schedule.siteId, "fundo-prueba");

    const edgeHeaders = { "content-type": "application/json", "x-edge-sensor-key": env.FUEL_SENSOR_INGEST_KEY };
    const edgeCurrent = await worker.fetch(new Request("http://localhost/api/manual-mode/edge/current", {
      method: "POST", headers: edgeHeaders, body: "{}",
    }), env, executionContext);
    assert.equal(edgeCurrent.status, 200);
    const desired = (await edgeCurrent.json()).schedule;
    assert.equal(desired.id, schedule.id);
    assert.equal(desired.desiredActive, true);
    const activated = await worker.fetch(new Request(`http://localhost/api/manual-mode/edge/${schedule.id}/state`, {
      method: "POST", headers: edgeHeaders, body: JSON.stringify({ state: "active" }),
    }), env, executionContext);
    assert.equal(activated.status, 200);
    assert.equal((await activated.json()).schedule.status, "active");

    const cancelled = await worker.fetch(new Request(`http://localhost/api/manual-mode/${schedule.id}`, {
      method: "DELETE", headers: { cookie: supervisorCookie, origin: "http://localhost" },
    }), env, executionContext);
    assert.equal(cancelled.status, 200);
    assert.equal((await cancelled.json()).schedule.status, "cancelled");
    const none = await worker.fetch(new Request("http://localhost/api/manual-mode/edge/current", {
      method: "POST", headers: edgeHeaders, body: "{}",
    }), env, executionContext);
    assert.equal((await none.json()).schedule, null);
    const audits = await database.prepare("SELECT event FROM web_access_audit WHERE event LIKE 'manual_mode_%' ORDER BY id").all();
    assert.deepEqual(audits.results.map((row) => row.event), ["manual_mode_scheduled", "manual_mode_cancelled"]);
  } finally {
    delete globalThis.__FUEL_EDGE_LOCAL_DB__;
    database.close();
    await rm(directory, { recursive: true, force: true });
  }
});
