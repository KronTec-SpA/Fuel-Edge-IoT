import assert from "node:assert/strict";
import { createHmac, pbkdf2Sync, randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createLocalD1 } from "../runtime/local-d1.mjs";

const root = new URL("../", import.meta.url);

async function render() {
  const worker = await loadWorker();
  return worker.fetch(
    new Request("http://localhost/", { headers: { accept: "text/html" } }),
    { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } },
    { waitUntil() {}, passThroughOnException() {} },
  );
}

async function loadWorker() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}-${Math.random()}`);
  const { default: worker } = await import(workerUrl.href);
  return worker;
}

function base64url(value) {
  return Buffer.from(value).toString("base64url");
}

function authEnv(email, password) {
  const pepper = randomBytes(32);
  const sessionSecret = randomBytes(32);
  const salt = randomBytes(16);
  const iterations = 310000;
  return {
    ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) },
    AUTH_ADMIN_EMAIL_DIGEST: base64url(createHmac("sha256", pepper).update(email).digest()),
    AUTH_ADMIN_PASSWORD_HASH: `pbkdf2_sha256$${iterations}$${base64url(salt)}$${base64url(pbkdf2Sync(password, salt, iterations, 32, "sha256"))}`,
    AUTH_EMAIL_PEPPER: base64url(pepper),
    AUTH_SESSION_SECRET: base64url(sessionSecret),
    AUTH_SESSION_TTL_SECONDS: "3600",
  };
}

const executionContext = { waitUntil() {}, passThroughOnException() {} };

function dateInputInTimeZone(value, timeZone = "America/Santiago") {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(new Date(value)).map((part) => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

test("renders the Concha y Toro edge application", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);
  const html = await response.text();
  assert.match(html, /<html lang="es">/i);
  assert.match(html, /Concha y Toro -/i);
  assert.match(html, /Monitoreo Combustible/i);
  assert.match(html, /Fundo Santa Isabel/i);
  assert.match(html, /Verificando acceso/i);
  assert.doesNotMatch(html, /Punto Norte/i);
  assert.doesNotMatch(html, /codex-preview|react-loading-skeleton|Your site is taking shape/i);
});

test("supports prioritized alert follow-up with auditable comments", async () => {
  const [source, styles, api, store, migration] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
    readFile(new URL("../worker/alerts-api.ts", import.meta.url), "utf8"),
    readFile(new URL("../worker/alerts-store.ts", import.meta.url), "utf8"),
    readFile(new URL("../drizzle/0021_alert_reopening.sql", import.meta.url), "utf8"),
  ]);
  assert.match(source, /Tomando acción/i);
  assert.match(source, /name="comment" required minLength=\{10\}/i);
  assert.match(source, /Urgente.*Alta.*Media.*Baja/is);
  assert.match(source, /Historial de comentarios/i);
  assert.match(source, /Ordenar alertas/i);
  assert.match(source, /Reabrir como nueva alerta/i);
  assert.match(source, /Reabierta · ciclo/i);
  assert.match(source, /Filtrar alertas por origen/i);
  assert.match(source, /Abre la alerta y define su criticidad/i);
  assert.match(styles, /\.alert-guide li::before[^}]*content:\s*"\\2192"/is);
  assert.doesNotMatch(source, /Cada reapertura inicia un ciclo separado/i);
  assert.match(source, /function AuthVersion\(\).*SITE_VERSION/s);
  assert.match(styles, /alert-reopened-badge/i);
  assert.doesNotMatch(styles, /auth-card::after|V\.1\.\d+/i);
  assert.doesNotMatch(source, /localStorage\.setItem\("krontec\.alerts"/i);
  assert.match(api, /manage_alerts/i);
  assert.match(api, /\/reopen/i);
  assert.match(api, /listAlerts\(env\.DB, canManage\)/i);
  assert.match(store, /system_alert_comments/i);
  assert.match(store, /recordAlertUpdate/i);
  assert.match(store, /reopenAlert/i);
  assert.match(migration, /parent_alert_id/i);
  assert.match(migration, /idx_system_alerts_single_reopen/i);
});

test("keeps update notes and large alert counts compact in the header", async () => {
  const [source, styles] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
  ]);
  assert.match(source, />Novedades</i);
  assert.match(source, /Modo manual programado/i);
  assert.match(source, /count > 99 \? "99\+"/i);
  assert.match(styles, /\.notification-button b[^}]*padding:\s*0 4px/is);
  assert.match(styles, /\.notification-button b[^}]*border-radius:\s*999px/is);
  assert.match(styles, /\.whats-new-panel\s*\{/i);
});

test("keeps the fixed header aligned when horizontal space is constrained", async () => {
  const styles = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");
  assert.match(styles, /\.app-main[^}]*container-name:\s*app-main[^}]*container-type:\s*inline-size/is);
  assert.match(styles, /\.topbar-left[^}]*overflow:\s*hidden/is);
  assert.match(styles, /\.adoption-site-tag[^}]*overflow:\s*hidden/is);
  assert.match(styles, /\.topbar-center[^}]*overflow:\s*hidden/is);
  assert.match(styles, /\.profile-wrap[^}]*min-width:\s*0[^}]*flex:\s*0 1 auto/is);
  assert.match(styles, /\.site-location strong, \.profile-button strong[^}]*text-overflow:\s*ellipsis[^}]*white-space:\s*nowrap/is);
  assert.match(styles, /\.site-indicator[^}]*flex:\s*0 0 26px/is);
  assert.match(styles, /@container app-main \(max-width:\s*1180px\)[\s\S]*?\.adoption-site-tag small, \.profile-button small\s*\{\s*display:\s*none;/i);
  assert.match(styles, /@container app-main \(max-width:\s*1040px\)[\s\S]*?\.adoption-site-tag > span:last-child, \.profile-copy, \.topbar-edge-state\s*\{\s*display:\s*none;/i);
  assert.match(styles, /@container app-main \(max-width:\s*900px\)[\s\S]*?\.topbar-center\s*\{\s*display:\s*none;/i);
});

test("closes header menus outside and optically centers the alert symbol", async () => {
  const [source, styles] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
  ]);
  assert.match(source, /document\.addEventListener\("pointerdown", closeHeaderMenusOutside\)/i);
  assert.match(source, /profileWrapRef\.current\?\.contains\(event\.target\)/i);
  assert.match(source, /whatsNewWrapRef\.current\?\.contains\(event\.target\)/i);
  assert.match(styles, /\.notification-button > span::before[^}]*transform:\s*translate\(-50%,\s*-1px\)/is);
});

test("uses RFID and PLC as the only public hardware nomenclature", async () => {
  const files = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../worker/nfc-enrollment-api.ts", import.meta.url), "utf8"),
    readFile(new URL("../worker/nfc-identification-api.ts", import.meta.url), "utf8"),
    readFile(new URL("../worker/equipment-enrollment-store.ts", import.meta.url), "utf8"),
    readFile(new URL("../worker/relay-test-api.ts", import.meta.url), "utf8"),
    readFile(new URL("../worker/relay-test-store.ts", import.meta.url), "utf8"),
  ]);
  const publicCopy = files.join("\n");
  assert.match(publicCopy, /RFID/i);
  assert.match(publicCopy, /PLC/i);
  assert.doesNotMatch(publicCopy, /\bNFC\b|Raspberry(?: Pi)?/);
  assert.match(files[0], /function formatCredentialId[\s\S]*replace\(\/\^nfc-\/iu, "RFID-"\)/i);
});

test("charts expose liters, independent scales, and the tank-level trend", async () => {
  const [source, styles] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
  ]);
  assert.match(source, /overview-chart-axis/i);
  assert.match(source, /data-tooltip=\{`\$\{formatLiters\(value\)\} despachados`\}/i);
  assert.match(source, /fuel-chart-axis-right[^>]*data-axis-label="NIVEL"/i);
  assert.match(source, /inventory-level-line/i);
  assert.match(source, /Nivel: \$\{formatLiters\(point\.closingLevel\)\}/i);
  assert.match(styles, /\.chart-tooltip-target:hover::after/i);
  assert.match(styles, /\.inventory-level-line polyline[^}]*stroke:/is);
});

test("shows a healthy active manual mode as an operational green state", async () => {
  const source = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
  assert.match(source, /manualModeActive\s*=\s*Boolean\([^;]*state === "manual_mode"[^;]*relayEnergized\)/s);
  assert.match(source, /operational\s*=\s*automaticReady \|\| manualModeActive/i);
  assert.match(source, /manualModeActive\s*\?\s*"Modo manual activo"/s);
  assert.match(source, /ready-ring \$\{operational \? "" : "offline"\}/i);
  assert.match(source, /R0\.1 permanece habilitado durante la ventana manual/i);
});

test("moves overview control notes into an information popover", async () => {
  const [source, styles] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
  ]);
  assert.match(source, /<details className="overview-info">/i);
  assert.match(source, /aria-label="Ver notas de control"/i);
  assert.match(source, /Control local en espera/i);
  assert.match(source, /Control local en el borde/i);
  assert.doesNotMatch(source, /className="safety-note"|Control seguro en el borde/i);
  assert.match(source, /automaticReady\s*\?\s*null/i);
  assert.match(styles, /\.overview-info-popover\s*\{/i);
  assert.doesNotMatch(styles, /\.safety-note\s*\{/i);
});

test("keeps an alert open through multiple updates before resolving it", async () => {
  const directory = await mkdtemp(join(tmpdir(), "fuel-alert-workflow-"));
  const database = createLocalD1(join(directory, "web.sqlite3"));
  globalThis.__FUEL_EDGE_LOCAL_DB__ = database;
  try {
    const legacyTime = new Date(Date.now() - 60_000).toISOString();
    await database.batch([
      database.prepare(`CREATE TABLE system_alerts(
        id TEXT PRIMARY KEY,severity TEXT NOT NULL CHECK(severity IN ('critical','warning','info')),
        title TEXT NOT NULL,detail TEXT NOT NULL,occurred_at TEXT NOT NULL,
        acknowledged_at TEXT,created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      )`),
      database.prepare(`CREATE TABLE system_alert_actions(
        id TEXT PRIMARY KEY,alert_id TEXT NOT NULL UNIQUE,actor_user_id TEXT NOT NULL,
        actor_name TEXT NOT NULL,description TEXT NOT NULL,occurred_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(alert_id) REFERENCES system_alerts(id) ON DELETE RESTRICT
      )`),
      database.prepare("INSERT INTO system_alerts(id,severity,title,detail,occurred_at,acknowledged_at) VALUES ('legacy-alert','critical','Alerta histórica','Evento anterior a la actualización',?,?)")
        .bind(legacyTime, legacyTime),
      database.prepare("INSERT INTO system_alert_actions(id,alert_id,actor_user_id,actor_name,description,occurred_at) VALUES ('legacy-action','legacy-alert','usr-master','Pedro Coloma','Acción histórica conservada',?)")
        .bind(legacyTime),
    ]);
    const worker = await loadWorker();
    const env = {
      ...authEnv("master@example.test", "correct horse battery staple"),
      AUTH_BOOTSTRAP_VERSION: "test-alert-workflow-1",
      FUEL_SENSOR_INGEST_KEY: randomBytes(32).toString("base64url"),
    };
    const login = await worker.fetch(new Request("http://localhost/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://localhost" },
      body: JSON.stringify({ email: "master@example.test", password: "correct horse battery staple" }),
    }), env, executionContext);
    assert.equal(login.status, 200);
    const cookie = (login.headers.get("set-cookie") ?? "").split(";", 1)[0];
    const alertId = `alert-test-${Date.now()}`;
    const ingested = await worker.fetch(new Request("http://localhost/api/alerts/edge", {
      method: "POST",
      headers: { "content-type": "application/json", "x-edge-sensor-key": env.FUEL_SENSOR_INGEST_KEY },
      body: JSON.stringify({ id: alertId, severity: "warning", title: "Presión fuera de rango", detail: "Revisar la línea de combustible", occurredAt: new Date().toISOString() }),
    }), env, executionContext);
    assert.equal(ingested.status, 201);
    const initial = await worker.fetch(new Request("http://localhost/api/alerts", { headers: { cookie } }), env, executionContext);
    const initialAlerts = (await initial.json()).alerts;
    const initialAlert = initialAlerts.find((item) => item.id === alertId);
    assert.equal(initialAlert.priority, "high");
    assert.equal(initialAlert.status, "pending");
    assert.deepEqual(initialAlert.comments, []);
    const migratedLegacy = initialAlerts.find((item) => item.id === "legacy-alert");
    assert.equal(migratedLegacy.priority, "urgent");
    assert.equal(migratedLegacy.status, "resolved");
    assert.equal(migratedLegacy.comments.length, 1);
    assert.equal(migratedLegacy.comments[0].comment, "Acción histórica conservada");

    const browserHeaders = { cookie, origin: "http://localhost", "content-type": "application/json" };
    const started = await worker.fetch(new Request(`http://localhost/api/alerts/${alertId}/action`, {
      method: "POST", headers: browserHeaders,
      body: JSON.stringify({ description: "Se inició la inspección del circuito y sus conexiones.", status: "in_progress", priority: "urgent" }),
    }), env, executionContext);
    assert.equal(started.status, 200);
    assert.deepEqual(await started.json(), { updated: true, resolved: false });
    const progressing = await worker.fetch(new Request("http://localhost/api/alerts", { headers: { cookie } }), env, executionContext);
    const progressingAlert = (await progressing.json()).alerts.find((item) => item.id === alertId);
    assert.equal(progressingAlert.status, "in_progress");
    assert.equal(progressingAlert.priority, "urgent");
    assert.equal(progressingAlert.acknowledged, false);
    assert.equal(progressingAlert.comments.length, 1);
    assert.match(progressingAlert.comments[0].recordedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);

    const resolved = await worker.fetch(new Request(`http://localhost/api/alerts/${alertId}/action`, {
      method: "POST", headers: browserHeaders,
      body: JSON.stringify({ description: "Conexión ajustada y presión verificada dentro del rango normal.", status: "resolved", priority: "urgent" }),
    }), env, executionContext);
    assert.equal(resolved.status, 200);
    assert.deepEqual(await resolved.json(), { updated: true, resolved: true });
    const completed = await worker.fetch(new Request("http://localhost/api/alerts", { headers: { cookie } }), env, executionContext);
    const completedAlert = (await completed.json()).alerts.find((item) => item.id === alertId);
    assert.equal(completedAlert.status, "resolved");
    assert.equal(completedAlert.acknowledged, true);
    assert.equal(completedAlert.comments.length, 2);
    assert.deepEqual(completedAlert.comments.map((item) => item.statusAfter), ["in_progress", "resolved"]);
    const repeated = await worker.fetch(new Request(`http://localhost/api/alerts/${alertId}/action`, {
      method: "POST", headers: browserHeaders,
      body: JSON.stringify({ description: "Este comentario no debe agregarse después del cierre.", status: "resolved", priority: "urgent" }),
    }), env, executionContext);
    assert.equal(repeated.status, 409);
    const stored = await database.prepare("SELECT COUNT(*) AS total FROM system_alert_comments WHERE alert_id=?").bind(alertId).first();
    assert.equal(stored.total, 2);

    const lateEdgeUpdate = await worker.fetch(new Request("http://localhost/api/alerts/edge", {
      method: "POST",
      headers: { "content-type": "application/json", "x-edge-sensor-key": env.FUEL_SENSOR_INGEST_KEY },
      body: JSON.stringify({ id: alertId, severity: "warning", priority: "low", title: "Presión fuera de rango", detail: "Actualización tardía que no debe alterar un cierre histórico.", occurredAt: initialAlert.time }),
    }), env, executionContext);
    assert.equal(lateEdgeUpdate.status, 201);
    assert.deepEqual(await lateEdgeUpdate.json(), { created: false, updated: false, ignored: true, reason: "resolved" });
    const immutableClosedAlert = (await (await worker.fetch(new Request("http://localhost/api/alerts", { headers: { cookie } }), env, executionContext)).json()).alerts.find((item) => item.id === alertId);
    assert.equal(immutableClosedAlert.priority, "urgent");
    assert.equal(immutableClosedAlert.detail, "Revisar la línea de combustible");

    const reopened = await worker.fetch(new Request(`http://localhost/api/alerts/${alertId}/reopen`, {
      method: "POST", headers: browserHeaders,
      body: JSON.stringify({ reason: "La presión volvió a salir de rango durante una nueva operación.", priority: "high" }),
    }), env, executionContext);
    assert.equal(reopened.status, 201);
    const reopenedBody = await reopened.json();
    assert.equal(reopenedBody.reopened, true);
    assert.equal(reopenedBody.parentAlertId, alertId);
    assert.equal(reopenedBody.rootAlertId, alertId);
    assert.equal(reopenedBody.reopenNumber, 1);
    assert.match(reopenedBody.alertId, /^alr-/);

    const afterReopening = await worker.fetch(new Request("http://localhost/api/alerts", { headers: { cookie } }), env, executionContext);
    const alertsAfterReopening = (await afterReopening.json()).alerts;
    const originalAfterReopening = alertsAfterReopening.find((item) => item.id === alertId);
    const reopenedAlert = alertsAfterReopening.find((item) => item.id === reopenedBody.alertId);
    assert.equal(originalAfterReopening.status, "resolved");
    assert.equal(originalAfterReopening.reopenedAsAlertId, reopenedBody.alertId);
    assert.equal(reopenedAlert.status, "pending");
    assert.equal(reopenedAlert.priority, "high");
    assert.equal(reopenedAlert.severity, "warning");
    assert.equal(reopenedAlert.parentAlertId, alertId);
    assert.equal(reopenedAlert.rootAlertId, alertId);
    assert.equal(reopenedAlert.reopenNumber, 1);
    assert.equal(reopenedAlert.acknowledged, false);
    assert.equal(reopenedAlert.reopenedBy, "Pedro Coloma");
    assert.equal(reopenedAlert.reopenReason, "La presión volvió a salir de rango durante una nueva operación.");
    assert.equal(reopenedAlert.comments.length, 1);
    assert.equal(reopenedAlert.comments[0].eventType, "reopened");
    assert.equal(reopenedAlert.comments[0].statusAfter, "pending");

    const duplicateReopening = await worker.fetch(new Request(`http://localhost/api/alerts/${alertId}/reopen`, {
      method: "POST", headers: browserHeaders,
      body: JSON.stringify({ reason: "Intento duplicado que debe quedar expresamente bloqueado.", priority: "urgent" }),
    }), env, executionContext);
    assert.equal(duplicateReopening.status, 409);

    const takingAction = await worker.fetch(new Request(`http://localhost/api/alerts/${reopenedBody.alertId}/action`, {
      method: "POST", headers: browserHeaders,
      body: JSON.stringify({ description: "Se inició una inspección independiente para este nuevo ciclo.", status: "in_progress", priority: "urgent" }),
    }), env, executionContext);
    assert.equal(takingAction.status, 200);
    const afterTakingAction = await worker.fetch(new Request("http://localhost/api/alerts", { headers: { cookie } }), env, executionContext);
    const activeReopenedAlert = (await afterTakingAction.json()).alerts.find((item) => item.id === reopenedBody.alertId);
    assert.equal(activeReopenedAlert.status, "in_progress");
    assert.equal(activeReopenedAlert.priority, "urgent");
    assert.equal(activeReopenedAlert.reopenNumber, 1);
    assert.equal(activeReopenedAlert.comments.length, 2);
    assert.deepEqual(activeReopenedAlert.comments.map((item) => item.eventType), ["reopened", "follow_up"]);
    assert.ok(new Date(activeReopenedAlert.comments[0].recordedAt) <= new Date(activeReopenedAlert.comments[1].recordedAt));
  } finally {
    delete globalThis.__FUEL_EDGE_LOCAL_DB__;
    database.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("keeps transaction filters functional and the single location static", async () => {
  const source = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
  assert.match(source, /aria-label="Filtrar cargas por estado"/i);
  assert.match(source, /aria-pressed=\{status === filter\.value\}/i);
  assert.match(source, /onClick=\{\(\) => onStatus\(filter\.value\)\}/i);
  assert.match(source, /matchesStatus = transactionStatus === "Todas" \|\| item\.status === transactionStatus/i);
  assert.match(source, /allItems\.filter\(\(item\) => item\.status === filter\.value\)/i);
  assert.match(source, /useState<TransactionStatusFilter>\("Completada"\)/i);
  assert.match(source, /if \(next === "transactions"\) setTransactionStatus\("Completada"\)/i);
  assert.ok(source.indexOf('{ label: "Completadas"') < source.indexOf('{ label: "Todas"'));
  assert.match(source, /id: item\.id,/i);
  assert.match(source, /<div className="site-location" aria-label="Locación">/i);
  assert.doesNotMatch(source, /Conexión edge protegida|Sesión privada y con vencimiento|Las sesiones se validan dentro de la Raspberry Pi/i);
});

test("shows each user's role permissions with readable interface typography", async () => {
  const [source, styles] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
  ]);
  assert.match(source, /function UserPermissionDisclosure/i);
  assert.match(source, /permisos activos/i);
  assert.match(source, /Disponible para el rol, no asignado/i);
  assert.match(styles, /\.permission-disclosure/i);
  assert.doesNotMatch(styles, /font-size:\s*[6-9]px/i);
});

test("provides a persistent fuel history with automatic receipt detection", async () => {
  const [page, api, store, migration] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../worker/fuel-history-api.ts", import.meta.url), "utf8"),
    readFile(new URL("../worker/fuel-history-store.ts", import.meta.url), "utf8"),
    readFile(new URL("../drizzle/0004_old_thundra.sql", import.meta.url), "utf8"),
  ]);
  assert.match(page, /Histórico de combustible/i);
  assert.match(page, /Total despachado/i);
  assert.match(page, /Agrupar por/i);
  assert.match(page, /Semana.*Mes.*Año.*Personalizado/is);
  assert.match(page, /Escala vertical en litros/i);
  assert.match(page, /niceFuelAxisMaximum/i);
  assert.match(page, /onClick=\{\(\) => openLedger\("receipt"\)\}/i);
  assert.match(page, /id="fuel-ledger"/i);
  assert.doesNotMatch(page, /OCIO monitoreando cambios/i);
  assert.match(api, /view_transactions/i);
  assert.match(api, /x-edge-sensor-key/i);
  assert.match(store, /RECEIPT_THRESHOLD_LITERS = 100/i);
  assert.match(store, /HIGH_CONFIDENCE_RECEIPT_LITERS = 120/i);
  assert.match(store, /riseFromBaseline >= RECEIPT_THRESHOLD_LITERS/i);
  assert.match(store, /STABLE_PLATEAU_TOLERANCE_LITERS = 50/i);
  assert.match(store, /CONFIRMATION_MINUTES = 10/i);
  assert.match(store, /RECEIPT_CONTINUATION_MINUTES = 90/i);
  assert.match(store, /warmup_started_at/i);
  assert.match(store, /Continuación sostenida consolidada/i);
  assert.match(store, /Aumento breve seguido de nivel sostenido/i);
  assert.match(page, /Carga en curso · flujo K24 detectado/i);
  assert.match(page, /Recepción candidata en curso/i);
  assert.match(page, /function clientRequestId/i);
  assert.match(page, /typeof webCrypto\.randomUUID === "function"/i);
  assert.match(page, /typeof webCrypto\.getRandomValues === "function"/i);
  assert.doesNotMatch(page, /useRef\(crypto\.randomUUID\(\)\)/i);
  assert.match(migration, /CREATE TABLE `fuel_movements`/i);
  assert.match(migration, /idx_fuel_movements_type_occurred/i);
});

test("requires human approval, preserves sensor evidence and supports manual receipts", async () => {
  const directory = await mkdtemp(join(tmpdir(), "fuel-receipt-approval-"));
  const database = createLocalD1(join(directory, "web.sqlite3"));
  globalThis.__FUEL_EDGE_LOCAL_DB__ = database;
  try {
    const worker = await loadWorker();
    const password = "correct horse battery staple";
    const env = {
      ...authEnv("master@example.test", password),
      AUTH_BOOTSTRAP_VERSION: "test-receipt-approval-1",
      FUEL_SENSOR_INGEST_KEY: randomBytes(32).toString("base64url"),
    };
    const login = await worker.fetch(new Request("http://localhost/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://localhost" },
      body: JSON.stringify({ email: "master@example.test", password }),
    }), env, executionContext);
    assert.equal(login.status, 200);
    const cookie = (login.headers.get("set-cookie") ?? "").split(";", 1)[0];
    const now = new Date();
    const localDay = dateInputInTimeZone(now);
    const initialize = await worker.fetch(new Request(`http://localhost/api/fuel-history?from=${localDay}&to=${localDay}`, {
      headers: { cookie },
    }), env, executionContext);
    assert.equal(initialize.status, 200);

    const firstAt = new Date(now.getTime() - 30 * 60_000).toISOString();
    const secondAt = new Date(now.getTime() - 20 * 60_000).toISOString();
    const thirdAt = new Date(now.getTime() - 15 * 60_000).toISOString();
    await database.batch([
      database.prepare(`INSERT INTO fuel_movements(
        id,movement_type,occurred_at,liters,opening_level_liters,closing_level_liters,source,reference_id,detail,
        detected_automatically,confidence,detection_status,review_status,original_liters
      ) VALUES ('auto-pending-correct','receipt',?,1000,800,1800,'OCIO','AUTO-CORRECT','Meseta sostenida',1,.98,'confirmed','pending',1000)`).bind(firstAt),
      database.prepare(`INSERT INTO fuel_movements(
        id,movement_type,occurred_at,liters,opening_level_liters,closing_level_liters,source,reference_id,detail,
        detected_automatically,confidence,detection_status,review_status,original_liters
      ) VALUES ('auto-pending-reject','receipt',?,75,1800,1875,'OCIO','AUTO-REJECT','Meseta sostenida',1,.94,'confirmed','pending',75)`).bind(secondAt),
      database.prepare(`INSERT INTO fuel_movements(
        id,movement_type,occurred_at,liters,opening_level_liters,closing_level_liters,source,reference_id,detail,
        detected_automatically,confidence,detection_status,review_status,original_liters
      ) VALUES ('auto-pending-approve','receipt',?,120,1875,1995,'OCIO','AUTO-APPROVE','Meseta sostenida',1,.97,'confirmed','pending',120)`).bind(thirdAt),
    ]);

    const beforeReview = await worker.fetch(new Request(`http://localhost/api/fuel-history?from=${localDay}&to=${localDay}`, {
      headers: { cookie },
    }), env, executionContext);
    const beforeBody = await beforeReview.json();
    assert.equal(beforeBody.summary.receivedLiters, 0);
    assert.equal(beforeBody.summary.pendingReceiptCount, 3);

    const corrected = await worker.fetch(new Request("http://localhost/api/fuel-history/receipts/auto-pending-correct/review", {
      method: "POST",
      headers: { cookie, origin: "http://localhost", "content-type": "application/json" },
      body: JSON.stringify({
        requestId: "review-correct-0001", action: "correct", liters: 1005.8,
        documentReference: "GD-1005-8", note: "Guía del camión acredita 1005,8 litros",
      }),
    }), env, executionContext);
    assert.equal(corrected.status, 200);
    const correctedMovement = (await corrected.json()).movement;
    assert.equal(correctedMovement.reviewStatus, "corrected");
    assert.equal(correctedMovement.originalLiters, 1000);
    assert.equal(correctedMovement.liters, 1005.8);

    const rejected = await worker.fetch(new Request("http://localhost/api/fuel-history/receipts/auto-pending-reject/review", {
      method: "POST",
      headers: { cookie, origin: "http://localhost", "content-type": "application/json" },
      body: JSON.stringify({ requestId: "review-reject-0001", action: "reject", note: "Oscilación verificada sin descarga de camión" }),
    }), env, executionContext);
    assert.equal(rejected.status, 200);
    assert.equal((await rejected.json()).movement.reviewStatus, "rejected");

    const approved = await worker.fetch(new Request("http://localhost/api/fuel-history/receipts/auto-pending-approve/review", {
      method: "POST",
      headers: { cookie, origin: "http://localhost", "content-type": "application/json" },
      body: JSON.stringify({ requestId: "review-approve-0001", action: "approve", documentReference: "GD-APPROVED-120" }),
    }), env, executionContext);
    assert.equal(approved.status, 200);
    assert.equal((await approved.json()).movement.reviewStatus, "approved");

    const adjustedAfterApproval = await worker.fetch(new Request("http://localhost/api/fuel-history/receipts/auto-pending-approve/review", {
      method: "POST",
      headers: { cookie, origin: "http://localhost", "content-type": "application/json" },
      body: JSON.stringify({
        requestId: "review-adjust-0002", action: "correct", liters: 121.2,
        documentReference: "GD-APPROVED-120", note: "Ajuste posterior según pesaje final documentado",
      }),
    }), env, executionContext);
    assert.equal(adjustedAfterApproval.status, 200);
    const adjustedBody = await adjustedAfterApproval.json();
    assert.equal(adjustedBody.movement.reviewStatus, "corrected");
    assert.equal(adjustedBody.movement.liters, 121.2);

    const manual = await worker.fetch(new Request("http://localhost/api/fuel-history/receipts/manual", {
      method: "POST",
      headers: { cookie, origin: "http://localhost", "content-type": "application/json" },
      body: JSON.stringify({
        requestId: "manual-receipt-0001", occurredAt: new Date(now.getTime() - 10 * 60_000).toISOString(),
        liters: 450.25, documentReference: "GD-MANUAL-450", source: "Camión proveedor",
        note: "Recepción autorizada registrada desde la guía",
      }),
    }), env, executionContext);
    assert.equal(manual.status, 201);
    assert.equal((await manual.json()).movement.reviewStatus, "approved");

    const duplicateDocument = await worker.fetch(new Request("http://localhost/api/fuel-history/receipts/manual", {
      method: "POST",
      headers: { cookie, origin: "http://localhost", "content-type": "application/json" },
      body: JSON.stringify({
        requestId: "manual-receipt-0002", occurredAt: new Date(now.getTime() - 5 * 60_000).toISOString(),
        liters: 450.25, documentReference: "GD-MANUAL-450", source: "Camión proveedor",
        note: "Intento duplicado de la misma guía de despacho",
      }),
    }), env, executionContext);
    assert.equal(duplicateDocument.status, 400);
    assert.match((await duplicateDocument.json()).error, /referencia documental ya está asociada/i);

    const afterReview = await worker.fetch(new Request(`http://localhost/api/fuel-history?from=${dateInputInTimeZone(firstAt)}&to=${localDay}`, {
      headers: { cookie },
    }), env, executionContext);
    const afterBody = await afterReview.json();
    assert.equal(afterBody.summary.receivedLiters, 1577.3);
    assert.equal(afterBody.summary.pendingReceiptCount, 0);
    assert.equal((await database.prepare("SELECT COUNT(*) AS total FROM fuel_receipt_reviews").first()).total, 5);
    const correctionAudit = await database.prepare(`SELECT action,previous_liters AS previousLiters,
      resulting_liters AS resultingLiters,actor_name AS actorName FROM fuel_receipt_reviews
      WHERE movement_id='auto-pending-correct'`).first();
    assert.deepEqual(correctionAudit, { action: "corrected", previousLiters: 1000, resultingLiters: 1005.8, actorName: "Pedro Coloma" });

    const unauthenticated = await worker.fetch(new Request("http://localhost/api/fuel-history/receipts/manual", {
      method: "POST", headers: { origin: "http://localhost", "content-type": "application/json" },
      body: JSON.stringify({ requestId: "manual-no-auth-01" }),
    }), env, executionContext);
    assert.equal(unauthenticated.status, 403);
  } finally {
    delete globalThis.__FUEL_EDGE_LOCAL_DB__;
    database.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("resets load and level data only after administrator password confirmation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "fuel-field-reset-"));
  const database = createLocalD1(join(directory, "web.sqlite3"));
  globalThis.__FUEL_EDGE_LOCAL_DB__ = database;
  try {
    const worker = await loadWorker();
    const password = "correct horse battery staple";
    const env = {
      ...authEnv("master@example.test", password),
      AUTH_BOOTSTRAP_VERSION: "test-field-reset-1",
      FUEL_SENSOR_INGEST_KEY: randomBytes(32).toString("base64url"),
    };
    const login = await worker.fetch(new Request("http://localhost/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://localhost" },
      body: JSON.stringify({ email: "master@example.test", password }),
    }), env, executionContext);
    assert.equal(login.status, 200);
    const cookie = (login.headers.get("set-cookie") ?? "").split(";", 1)[0];
    const sensorHeaders = { "content-type": "application/json", "x-edge-sensor-key": env.FUEL_SENSOR_INGEST_KEY };
    const firstReadingAt = new Date(Date.now() - 2000).toISOString();
    const firstReading = await worker.fetch(new Request("http://localhost/api/fuel-history/readings", {
      method: "POST",
      headers: sensorHeaders,
      body: JSON.stringify({ levelLiters: 1200, occurredAt: firstReadingAt, source: "OCIO" }),
    }), env, executionContext);
    assert.equal(firstReading.status, 201);
    const movementId = `RESET-TEST-${Date.now()}`;
    const movementAt = new Date(Date.now() - 1000).toISOString();
    const movement = await worker.fetch(new Request("http://localhost/api/fuel-history/movements", {
      method: "POST",
      headers: sensorHeaders,
      body: JSON.stringify({
        id: movementId,
        type: "dispatch",
        occurredAt: movementAt,
        liters: 75,
        source: "K24 + PLC",
        reference: "field-reset-test",
        detail: "Carga anterior al inicio en terreno",
      }),
    }), env, executionContext);
    assert.equal(movement.status, 201);

    const rejected = await worker.fetch(new Request("http://localhost/api/fuel-history/reset", {
      method: "POST",
      headers: { cookie, origin: "http://localhost", "content-type": "application/json" },
      body: JSON.stringify({ password: "wrong administrator password" }),
    }), env, executionContext);
    assert.equal(rejected.status, 401);
    assert.equal((await database.prepare("SELECT COUNT(*) AS total FROM fuel_movements").first()).total, 1);
    assert.equal((await database.prepare("SELECT COUNT(*) AS total FROM fuel_level_readings").first()).total, 1);

    const accepted = await worker.fetch(new Request("http://localhost/api/fuel-history/reset", {
      method: "POST",
      headers: { cookie, origin: "http://localhost", "content-type": "application/json" },
      body: JSON.stringify({ password }),
    }), env, executionContext);
    assert.equal(accepted.status, 200);
    const reset = await accepted.json();
    assert.equal(reset.reset, true);
    assert.deepEqual(reset.deleted, { movements: 1, readings: 1 });
    assert.equal(reset.sensor.currentLevel, 0);
    assert.equal(reset.sensor.latestReadingAt, "1970-01-01T00:00:00.000Z");
    assert.equal((await database.prepare("SELECT COUNT(*) AS total FROM fuel_movements").first()).total, 0);
    assert.equal((await database.prepare("SELECT COUNT(*) AS total FROM fuel_level_readings").first()).total, 0);
    const detector = await database.prepare(`SELECT baseline_level_liters AS baseline,last_level_liters AS level,
      active_receipt_id AS activeReceipt,last_reading_at AS lastReading FROM fuel_detection_state WHERE id=1`).first();
    assert.deepEqual(detector, { baseline: 0, level: 0, activeReceipt: null, lastReading: "1970-01-01T00:00:00.000Z" });
    const audit = await database.prepare("SELECT actor_user_id AS actor,event,metadata FROM web_access_audit WHERE event='fuel_history_reset'").first();
    assert.equal(audit.event, "fuel_history_reset");
    assert.equal(JSON.parse(audit.metadata).movements, 1);

    const staleMovement = await worker.fetch(new Request("http://localhost/api/fuel-history/movements", {
      method: "POST",
      headers: sensorHeaders,
      body: JSON.stringify({
        id: movementId,
        type: "dispatch",
        occurredAt: movementAt,
        liters: 75,
        source: "K24 + PLC",
        reference: "field-reset-test",
        detail: "Carga anterior al inicio en terreno",
      }),
    }), env, executionContext);
    assert.equal(staleMovement.status, 400);
    const staleReading = await worker.fetch(new Request("http://localhost/api/fuel-history/readings", {
      method: "POST",
      headers: sensorHeaders,
      body: JSON.stringify({ levelLiters: 1200, occurredAt: firstReadingAt, source: "OCIO" }),
    }), env, executionContext);
    assert.equal(staleReading.status, 400);
    assert.equal((await database.prepare("SELECT COUNT(*) AS total FROM fuel_movements").first()).total, 0);
    assert.equal((await database.prepare("SELECT COUNT(*) AS total FROM fuel_level_readings").first()).total, 0);

    const newBaseline = await worker.fetch(new Request("http://localhost/api/fuel-history/readings", {
      method: "POST",
      headers: sensorHeaders,
      body: JSON.stringify({ levelLiters: 980, occurredAt: new Date(new Date(reset.resetAt).getTime() + 1000).toISOString(), source: "OCIO" }),
    }), env, executionContext);
    assert.equal(newBaseline.status, 201);
    assert.equal((await newBaseline.json()).detection.status, "initialized");
    assert.equal((await database.prepare("SELECT COUNT(*) AS total FROM fuel_movements").first()).total, 0);

    const completed = await worker.fetch(new Request("http://localhost/api/system-settings/commissioning", {
      method: "POST",
      headers: { cookie, origin: "http://localhost", "content-type": "application/json" },
      body: JSON.stringify({ action: "complete", password }),
    }), env, executionContext);
    assert.equal(completed.status, 200);
    const completedBody = await completed.json();
    assert.equal(completedBody.commissioning.status, "completed");
    assert.equal(completedBody.commissioning.cycle, 1);

    const resetAfterCompletion = await worker.fetch(new Request("http://localhost/api/fuel-history/reset", {
      method: "POST",
      headers: { cookie, origin: "http://localhost", "content-type": "application/json" },
      body: JSON.stringify({ password }),
    }), env, executionContext);
    assert.equal(resetAfterCompletion.status, 409);
    assert.match((await resetAfterCompletion.json()).error, /puesta en marcha está finalizada/i);
    assert.equal((await database.prepare("SELECT COUNT(*) AS total FROM fuel_level_readings").first()).total, 1);

    const reopened = await worker.fetch(new Request("http://localhost/api/system-settings/commissioning", {
      method: "POST",
      headers: { cookie, origin: "http://localhost", "content-type": "application/json" },
      body: JSON.stringify({
        action: "reopen",
        password,
        reason: "Recepción rechazó la calibración final del sensor de nivel.",
      }),
    }), env, executionContext);
    assert.equal(reopened.status, 200);
    const reopenedBody = await reopened.json();
    assert.equal(reopenedBody.commissioning.status, "in_progress");
    assert.equal(reopenedBody.commissioning.cycle, 2);
    assert.equal((await database.prepare("SELECT COUNT(*) AS total FROM fuel_level_readings").first()).total, 1);
    const lifecycleAudits = await database.prepare(`SELECT event FROM web_access_audit
      WHERE event IN ('commissioning_completed','commissioning_reopened') ORDER BY id`).all();
    assert.deepEqual(lifecycleAudits.results.map((entry) => entry.event), ["commissioning_completed", "commissioning_reopened"]);

    await database.prepare("UPDATE web_users SET role='administrator',is_master=0 WHERE id='usr-master'").run();
    const administratorView = await worker.fetch(new Request("http://localhost/api/system-settings/commissioning", {
      headers: { cookie },
    }), env, executionContext);
    assert.equal(administratorView.status, 403);
    const administratorReset = await worker.fetch(new Request("http://localhost/api/fuel-history/reset", {
      method: "POST",
      headers: { cookie, origin: "http://localhost", "content-type": "application/json" },
      body: JSON.stringify({ password }),
    }), env, executionContext);
    assert.equal(administratorReset.status, 403);
    assert.match((await administratorReset.json()).error, /usuario maestro del proveedor/i);

    const [page, styles, api] = await Promise.all([
      readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
      readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
      readFile(new URL("../worker/fuel-history-api.ts", import.meta.url), "utf8"),
    ]);
    assert.match(page, /Reiniciar base de datos/i);
    assert.match(page, /Clave de administrador/i);
    assert.match(page, /Los operadores, equipos, asociaciones y credenciales no serán eliminados/i);
    assert.match(page, /Finalizar PEM/i);
    assert.match(page, /Reabrir por rechazo/i);
    assert.match(page, /canManageCommissioning=\{currentUser\.roleCode === "master"/i);
    assert.match(styles, /\.commissioning-card/i);
    assert.match(api, /confirmAdministratorPassword/i);
  } finally {
    delete globalThis.__FUEL_EDGE_LOCAL_DB__;
    database.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("migrates an already-started field installation as completed and hides the reset lifecycle", async () => {
  const directory = await mkdtemp(join(tmpdir(), "fuel-field-commissioning-migration-"));
  const database = createLocalD1(join(directory, "web.sqlite3"));
  globalThis.__FUEL_EDGE_LOCAL_DB__ = database;
  try {
    const worker = await loadWorker();
    const password = "correct horse battery staple";
    const env = {
      ...authEnv("master@example.test", password),
      AUTH_BOOTSTRAP_VERSION: "test-field-commissioning-migration-1",
      FUEL_SENSOR_INGEST_KEY: randomBytes(32).toString("base64url"),
      FUEL_SITE_ID: "fundo-santa-isabel",
    };
    const login = await worker.fetch(new Request("http://localhost/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://localhost" },
      body: JSON.stringify({ email: "master@example.test", password }),
    }), env, executionContext);
    assert.equal(login.status, 200);
    const cookie = (login.headers.get("set-cookie") ?? "").split(";", 1)[0];
    const initialized = await worker.fetch(new Request("http://localhost/api/fuel-history/status", {
      headers: { cookie },
    }), env, executionContext);
    assert.equal(initialized.status, 200);
    const legacyResetAt = new Date(Date.now() - 60_000).toISOString();
    await database.prepare("INSERT INTO fuel_history_meta(key,value) VALUES ('field_reset_at',?)")
      .bind(legacyResetAt).run();

    const response = await worker.fetch(new Request("http://localhost/api/system-settings/commissioning", {
      headers: { cookie },
    }), env, executionContext);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.deepEqual(body.commissioning, {
      siteId: "fundo-santa-isabel",
      status: "completed",
      cycle: 1,
      startedAt: legacyResetAt,
      completedAt: legacyResetAt,
      reopenedAt: null,
      reopenReason: null,
      updatedAt: body.commissioning.updatedAt,
    });

    const blockedReset = await worker.fetch(new Request("http://localhost/api/fuel-history/reset", {
      method: "POST",
      headers: { cookie, origin: "http://localhost", "content-type": "application/json" },
      body: JSON.stringify({ password }),
    }), env, executionContext);
    assert.equal(blockedReset.status, 409);
  } finally {
    delete globalThis.__FUEL_EDGE_LOCAL_DB__;
    database.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("records unauthorized K24 flow as an exceptional dispatch and urgent alert", async () => {
  const directory = await mkdtemp(join(tmpdir(), "fuel-unauthorized-flow-"));
  const database = createLocalD1(join(directory, "web.sqlite3"));
  globalThis.__FUEL_EDGE_LOCAL_DB__ = database;
  try {
    const worker = await loadWorker();
    const env = {
      ...authEnv("master@example.test", "correct horse battery staple"),
      AUTH_BOOTSTRAP_VERSION: "test-unauthorized-flow-1",
      FUEL_SENSOR_INGEST_KEY: randomBytes(32).toString("base64url"),
    };
    const login = await worker.fetch(new Request("http://localhost/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://localhost" },
      body: JSON.stringify({ email: "master@example.test", password: "correct horse battery staple" }),
    }), env, executionContext);
    const cookie = (login.headers.get("set-cookie") ?? "").split(";", 1)[0];
    const edgeHeaders = { "content-type": "application/json", "x-edge-sensor-key": env.FUEL_SENSOR_INGEST_KEY };
    const occurredAt = new Date().toISOString();
    const incidentId = `UF-${Date.now()}`;

    const movementResponse = await worker.fetch(new Request("http://localhost/api/fuel-history/movements", {
      method: "POST",
      headers: edgeHeaders,
      body: JSON.stringify({
        id: incidentId,
        type: "dispatch",
        occurredAt,
        liters: 0.01,
        source: "K24 · Detección independiente",
        reference: incidentId,
        detail: "Flujo no autorizado · Sin operador ni equipo · Posible bypass de bomba detectado por K24",
        operatorId: null,
        equipmentId: null,
        isMaster: false,
        unauthorized: true,
      }),
    }), env, executionContext);
    assert.equal(movementResponse.status, 201);
    const movement = (await movementResponse.json()).movement;
    assert.equal(movement.liters, 0.01);
    assert.equal(movement.detectedAutomatically, true);
    assert.equal(movement.operatorId, null);

    const alertId = `edge-alert-${incidentId}`;
    const initialAlert = {
      id: alertId,
      severity: "critical",
      priority: "urgent",
      title: "Flujo de petróleo sin autorización",
      detail: "K24 detectó flujo sin una autorización activa. Conteo en curso; posible bypass de la bomba.",
      occurredAt,
    };
    const alertCreated = await worker.fetch(new Request("http://localhost/api/alerts/edge", {
      method: "POST", headers: edgeHeaders, body: JSON.stringify(initialAlert),
    }), env, executionContext);
    assert.equal(alertCreated.status, 201);
    const finalDetail = "K24 registró 1 pulsos (0.010 L) sin una autorización activa. Posible bypass de la bomba.";
    const alertUpdated = await worker.fetch(new Request("http://localhost/api/alerts/edge", {
      method: "POST", headers: edgeHeaders, body: JSON.stringify({ ...initialAlert, detail: finalDetail }),
    }), env, executionContext);
    assert.equal(alertUpdated.status, 201);
    assert.equal((await alertUpdated.json()).updated, true);

    const day = dateInputInTimeZone(occurredAt);
    const historyResponse = await worker.fetch(new Request(`http://localhost/api/fuel-history?from=${day}&to=${day}`, {
      headers: { cookie },
    }), env, executionContext);
    const history = await historyResponse.json();
    assert.equal(history.movements[0].id, incidentId);
    assert.equal(history.movements[0].detectedAutomatically, true);
    const alertsResponse = await worker.fetch(new Request("http://localhost/api/alerts", { headers: { cookie } }), env, executionContext);
    const alerts = (await alertsResponse.json()).alerts;
    assert.equal(alerts[0].priority, "urgent");
    assert.equal(alerts[0].detail, finalDetail);

    const page = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
    assert.match(page, /K24 · bypass detectado/i);
    assert.match(page, /refreshAlerts\(\)[\s\S]*refreshTransactions\(\)/i);
  } finally {
    delete globalThis.__FUEL_EDGE_LOCAL_DB__;
    database.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("resolves transaction operator and equipment ids to their assigned names", async () => {
  const directory = await mkdtemp(join(tmpdir(), "fuel-transaction-names-"));
  const database = createLocalD1(join(directory, "web.sqlite3"));
  globalThis.__FUEL_EDGE_LOCAL_DB__ = database;
  try {
    const worker = await loadWorker();
    const env = {
      ...authEnv("master@example.test", "correct horse battery staple"),
      AUTH_BOOTSTRAP_VERSION: "test-transaction-names-1",
      FUEL_SENSOR_INGEST_KEY: randomBytes(32).toString("base64url"),
    };
    const login = await worker.fetch(new Request("http://localhost/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://localhost" },
      body: JSON.stringify({ email: "master@example.test", password: "correct horse battery staple" }),
    }), env, executionContext);
    const cookie = (login.headers.get("set-cookie") ?? "").split(";", 1)[0];
    const browserHeaders = { "content-type": "application/json", origin: "http://localhost", cookie };

    const operatorResponse = await worker.fetch(new Request("http://localhost/api/managed-entities/operators", {
      method: "POST", headers: browserHeaders,
      body: JSON.stringify({ name: "María Fernanda Soto", rut: "12.345.678-5" }),
    }), env, executionContext);
    assert.equal(operatorResponse.status, 201);
    const operatorId = (await operatorResponse.json()).id;
    const equipmentResponse = await worker.fetch(new Request("http://localhost/api/managed-entities/equipment", {
      method: "POST", headers: browserHeaders,
      body: JSON.stringify({ name: "Tractor John Deere 6155M", kind: "Tractor", condition: "Permanente", module: "MIM-test-001", siteId: "site-santa-isabel" }),
    }), env, executionContext);
    assert.equal(equipmentResponse.status, 201);
    const equipmentId = (await equipmentResponse.json()).id;

    const occurredAt = new Date().toISOString();
    const transactionId = crypto.randomUUID();
    const movementResponse = await worker.fetch(new Request("http://localhost/api/fuel-history/movements", {
      method: "POST",
      headers: { "content-type": "application/json", "x-edge-sensor-key": env.FUEL_SENSOR_INGEST_KEY },
      body: JSON.stringify({
        id: transactionId, type: "dispatch", occurredAt, liters: 6.57, source: "K24 + PLC",
        reference: transactionId, detail: `${operatorId} · ${equipmentId}`,
        operatorId, equipmentId, isMaster: false,
      }),
    }), env, executionContext);
    assert.equal(movementResponse.status, 201);

    const day = dateInputInTimeZone(occurredAt);
    const historyResponse = await worker.fetch(new Request(`http://localhost/api/fuel-history?from=${day}&to=${day}`, {
      headers: { cookie },
    }), env, executionContext);
    assert.equal(historyResponse.status, 200);
    const movement = (await historyResponse.json()).movements.find((item) => item.id === transactionId);
    assert.equal(movement.operatorId, operatorId);
    assert.equal(movement.operatorName, "María Fernanda Soto");
    assert.equal(movement.equipmentId, equipmentId);
    assert.equal(movement.equipmentName, "Tractor John Deere 6155M");
  } finally {
    delete globalThis.__FUEL_EDGE_LOCAL_DB__;
    database.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("queries complete Chilean calendar days before and after the UTC date changes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "fuel-chilean-day-range-"));
  const database = createLocalD1(join(directory, "web.sqlite3"));
  globalThis.__FUEL_EDGE_LOCAL_DB__ = database;
  try {
    const worker = await loadWorker();
    const env = {
      ...authEnv("master@example.test", "correct horse battery staple"),
      AUTH_BOOTSTRAP_VERSION: "test-chilean-day-range-1",
      FUEL_SENSOR_INGEST_KEY: randomBytes(32).toString("base64url"),
    };
    const login = await worker.fetch(new Request("http://localhost/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://localhost" },
      body: JSON.stringify({ email: "master@example.test", password: "correct horse battery staple" }),
    }), env, executionContext);
    assert.equal(login.status, 200);
    const cookie = (login.headers.get("set-cookie") ?? "").split(";", 1)[0];
    const edgeHeaders = { "content-type": "application/json", "x-edge-sensor-key": env.FUEL_SENSOR_INGEST_KEY };
    const movements = [
      { id: "winter-late-master", occurredAt: "2025-08-17T01:54:15.586Z", liters: 7.02 },
      { id: "winter-next-day", occurredAt: "2025-08-17T04:00:00.000Z", liters: 1 },
      { id: "summer-late-master", occurredAt: "2025-01-16T02:30:00.000Z", liters: 8.5 },
      { id: "summer-next-day", occurredAt: "2025-01-16T03:00:00.000Z", liters: 1 },
    ];
    for (const movement of movements) {
      const response = await worker.fetch(new Request("http://localhost/api/fuel-history/movements", {
        method: "POST", headers: edgeHeaders,
        body: JSON.stringify({
          ...movement,
          type: "dispatch",
          source: "K24 + PLC",
          reference: movement.id,
          detail: "Operador maestro · Carga excepcional · Tarjeta maestra",
          operatorId: "operator-master",
          equipmentId: null,
          isMaster: true,
        }),
      }), env, executionContext);
      assert.equal(response.status, 201);
    }

    const winterResponse = await worker.fetch(new Request("http://localhost/api/fuel-history?from=2025-08-16&to=2025-08-16", {
      headers: { cookie },
    }), env, executionContext);
    assert.equal(winterResponse.status, 200);
    assert.deepEqual((await winterResponse.json()).movements.map((movement) => movement.id), ["winter-late-master"]);

    const summerResponse = await worker.fetch(new Request("http://localhost/api/fuel-history?from=2025-01-15&to=2025-01-15", {
      headers: { cookie },
    }), env, executionContext);
    assert.equal(summerResponse.status, 200);
    assert.deepEqual((await summerResponse.json()).movements.map((movement) => movement.id), ["summer-late-master"]);

    const invalidDate = await worker.fetch(new Request("http://localhost/api/fuel-history?from=2026-02-30&to=2026-02-30", {
      headers: { cookie },
    }), env, executionContext);
    assert.equal(invalidDate.status, 400);

    const [api, page] = await Promise.all([
      readFile(new URL("../worker/fuel-history-api.ts", import.meta.url), "utf8"),
      readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    ]);
    assert.match(api, /America\/Santiago/u);
    assert.match(page, /function FuelHistoryView\([^)]*\)[\s\S]*window\.setInterval\(refresh, 5000\)/u);
  } finally {
    delete globalThis.__FUEL_EDGE_LOCAL_DB__;
    database.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("archives managed records and restricts permanent database cleanup", async () => {
  const [page, api, store] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../worker/managed-entities-api.ts", import.meta.url), "utf8"),
    readFile(new URL("../worker/managed-entities-store.ts", import.meta.url), "utf8"),
  ]);
  assert.match(page, /Operadores pasados/i);
  assert.match(page, /Equipos pasados/i);
  assert.match(page, /Asociaciones.*pasadas/i);
  assert.match(page, /isProviderAdmin=\{currentUser\.roleCode === "master"\}/i);
  assert.doesNotMatch(page, /localStorage\.setItem\("krontec\.(operators|equipment|associations)"/i);
  assert.match(api, /actor\.role !== "master" \|\| actor\.is_master !== 1/i);
  assert.match(api, /No tienes permiso para consultar estos registros/i);
  assert.match(api, /El registro debe estar archivado antes de eliminarlo definitivamente/i);
  assert.match(api, /Elimina primero sus asociaciones históricas/i);
  assert.match(api, /name_changed/i);
  assert.match(api, /validity_changed/i);
  assert.match(api, /factoryIdentityPreserved/i);
  assert.match(page, /Editar nombre/i);
  assert.match(page, /function EquipmentRenameForm/i);
  assert.match(page, /Modificar período de validez/i);
  const equipmentView = page.match(/function EquipmentView[\s\S]*?function AssociationsView/)?.[0] ?? "";
  const equipmentDetail = page.match(/function EquipmentDetail[\s\S]*?function initials/)?.[0] ?? "";
  assert.match(equipmentView, /equipment-detail-link[^>]*>[\s\S]*?Ver ficha/i);
  assert.doesNotMatch(equipmentView, /Editar nombre|Modificar período de validez|Archivar equipo|Desactivar equipo|Eliminar definitivamente/i);
  assert.match(equipmentDetail, /Editar nombre/i);
  assert.match(equipmentDetail, /Modificar período de validez/i);
  assert.match(equipmentDetail, /Desactivar equipo/i);
  assert.match(equipmentDetail, /Archivar equipo/i);
  assert.match(equipmentDetail, /Restaurar equipo/i);
  assert.match(equipmentDetail, /Eliminar definitivamente/i);
  assert.match(page, /MIM \{item\.module\} por caducar en 24 horas/i);
  assert.match(page, /mantén presionado 20 segundos/i);
  assert.doesNotMatch(page, /mantén presionado 8 segundos/i);
  assert.match(page, /La identidad segura del MIM se conservará/i);
  assert.match(store, /managed_operators/i);
  assert.match(store, /managed_equipment/i);
  assert.match(store, /managed_associations/i);
  assert.match(store, /managed_entity_audit/i);
  assert.match(store, /managed_store_meta/i);
});

test("shortens and extends a MIM validity period with an audited immediate update", async () => {
  const directory = await mkdtemp(join(tmpdir(), "fuel-mim-validity-"));
  const database = createLocalD1(join(directory, "web.sqlite3"));
  globalThis.__FUEL_EDGE_LOCAL_DB__ = database;
  try {
    const worker = await loadWorker();
    const env = {
      ...authEnv("master@example.test", "correct horse battery staple"),
      AUTH_BOOTSTRAP_VERSION: "test-mim-validity-1",
      FUEL_SENSOR_INGEST_KEY: randomBytes(32).toString("base64url"),
    };
    const login = await worker.fetch(new Request("http://localhost/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://localhost" },
      body: JSON.stringify({ email: "master@example.test", password: "correct horse battery staple" }),
    }), env, executionContext);
    const cookie = (login.headers.get("set-cookie") ?? "").split(";", 1)[0];
    const browserHeaders = { cookie, origin: "http://localhost", "content-type": "application/json" };
    const initialExpiry = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
    const created = await worker.fetch(new Request("http://localhost/api/managed-entities/equipment", {
      method: "POST", headers: browserHeaders,
      body: JSON.stringify({ name: "MIM con vigencia", kind: "Tractor", condition: "Temporal", module: "mim-validity-01", siteId: "campo-prueba", expiry: initialExpiry }),
    }), env, executionContext);
    assert.equal(created.status, 201);
    const equipmentId = (await created.json()).id;

    const shortenedExpiry = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString();
    const shortened = await worker.fetch(new Request(`http://localhost/api/managed-entities/equipment/${equipmentId}`, {
      method: "PATCH", headers: browserHeaders, body: JSON.stringify({ expiry: shortenedExpiry }),
    }), env, executionContext);
    assert.equal(shortened.status, 200);
    assert.equal((await shortened.json()).expiry, shortenedExpiry);

    const extendedExpiry = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
    const extended = await worker.fetch(new Request(`http://localhost/api/managed-entities/equipment/${equipmentId}`, {
      method: "PATCH", headers: browserHeaders, body: JSON.stringify({ expiry: extendedExpiry }),
    }), env, executionContext);
    assert.equal(extended.status, 200);
    assert.equal((await extended.json()).expiry, extendedExpiry);

    const stored = await database.prepare("SELECT expiry FROM managed_equipment WHERE id=?").bind(equipmentId).first();
    assert.equal(stored.expiry, extendedExpiry);
    const audit = await database.prepare("SELECT event,metadata FROM managed_entity_audit WHERE entity_id=? ORDER BY id DESC LIMIT 1").bind(equipmentId).first();
    assert.equal(audit.event, "validity_changed");
    assert.deepEqual(JSON.parse(audit.metadata), { previousExpiry: shortenedExpiry, expiry: extendedExpiry });

    const authorization = await worker.fetch(new Request("http://localhost/api/equipment-enrollment/authorization/resolve", {
      method: "POST",
      headers: { "content-type": "application/json", "x-edge-sensor-key": env.FUEL_SENSOR_INGEST_KEY },
      body: JSON.stringify({ operatorId: "operator-test", equipmentId, moduleId: "mim-validity-01", siteId: "campo-prueba" }),
    }), env, executionContext);
    assert.equal(authorization.status, 200);
    assert.equal((await authorization.json()).equipment.assignmentValidUntil, extendedExpiry);

    const invalid = await worker.fetch(new Request(`http://localhost/api/managed-entities/equipment/${equipmentId}`, {
      method: "PATCH", headers: browserHeaders,
      body: JSON.stringify({ expiry: new Date(Date.now() - 60_000).toISOString() }),
    }), env, executionContext);
    assert.equal(invalid.status, 400);
  } finally {
    delete globalThis.__FUEL_EDGE_LOCAL_DB__;
    database.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("renames equipment and preserves the factory MIM identity when deleting its assignment", async () => {
  const directory = await mkdtemp(join(tmpdir(), "fuel-mim-removal-"));
  const database = createLocalD1(join(directory, "web.sqlite3"));
  globalThis.__FUEL_EDGE_LOCAL_DB__ = database;
  try {
    const worker = await loadWorker();
    const env = {
      ...authEnv("master@example.test", "correct horse battery staple"),
      AUTH_BOOTSTRAP_VERSION: "test-mim-removal-1",
      FUEL_SENSOR_INGEST_KEY: randomBytes(32).toString("base64url"),
    };
    const login = await worker.fetch(new Request("http://localhost/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://localhost" },
      body: JSON.stringify({ email: "master@example.test", password: "correct horse battery staple" }),
    }), env, executionContext);
    const cookie = (login.headers.get("set-cookie") ?? "").split(";", 1)[0];
    const browserHeaders = { cookie, origin: "http://localhost", "content-type": "application/json" };
    const created = await worker.fetch(new Request("http://localhost/api/managed-entities/equipment", {
      method: "POST", headers: browserHeaders,
      body: JSON.stringify({ name: "MIM para retirar", kind: "Tractor", condition: "Permanente", module: "mim-remove-01", siteId: "campo-prueba" }),
    }), env, executionContext);
    assert.equal(created.status, 201);
    const equipmentId = (await created.json()).id;
    const renamed = await worker.fetch(new Request(`http://localhost/api/managed-entities/equipment/${equipmentId}`, {
      method: "PATCH", headers: browserHeaders, body: JSON.stringify({ name: "MIM reutilizable renombrado" }),
    }), env, executionContext);
    assert.equal(renamed.status, 200);
    assert.equal((await renamed.json()).name, "MIM reutilizable renombrado");
    assert.equal((await database.prepare("SELECT name FROM managed_equipment WHERE id=?").bind(equipmentId).first()).name, "MIM reutilizable renombrado");
    assert.equal((await database.prepare("SELECT event FROM managed_entity_audit WHERE entity_id=? ORDER BY id DESC LIMIT 1").bind(equipmentId).first()).event, "name_changed");

    const edgeHeaders = { "content-type": "application/json", "x-edge-sensor-key": env.FUEL_SENSOR_INGEST_KEY };
    const firstSighting = await worker.fetch(new Request("http://localhost/api/equipment-enrollment/sightings", {
      method: "POST", headers: edgeHeaders,
      body: JSON.stringify({ moduleId: "mim-remove-01", siteId: "campo-prueba", deviceName: "MIM reutilizable renombrado", equipmentId, firmware: "0.6.0", rssi: -51, claimed: true, occurredAt: new Date().toISOString() }),
    }), env, executionContext);
    assert.equal(firstSighting.status, 201);
    assert.equal((await worker.fetch(new Request(`http://localhost/api/managed-entities/equipment/${equipmentId}`, {
      method: "PATCH", headers: browserHeaders, body: JSON.stringify({ archived: true }),
    }), env, executionContext)).status, 200);
    assert.equal((await worker.fetch(new Request(`http://localhost/api/managed-entities/equipment/${equipmentId}`, {
      method: "DELETE", headers: browserHeaders,
    }), env, executionContext)).status, 200);

    const next = await worker.fetch(new Request("http://localhost/api/equipment-enrollment/removals/next", {
      method: "POST", headers: edgeHeaders, body: "{}",
    }), env, executionContext);
    assert.equal(next.status, 200);
    assert.equal((await next.json()).command, null);
    assert.equal((await database.prepare("SELECT COUNT(*) AS count FROM equipment_registry_removals WHERE module_id=?").bind("mim-remove-01").first()).count, 0);
    assert.equal(await database.prepare("SELECT module_id FROM equipment_enrollment_candidates WHERE module_id=?").bind("mim-remove-01").first(), null);

    const resetSighting = await worker.fetch(new Request("http://localhost/api/equipment-enrollment/sightings", {
      method: "POST", headers: edgeHeaders,
      body: JSON.stringify({ moduleId: "mim-remove-01", siteId: "campo-prueba", deviceName: null, equipmentId: null, firmware: "0.6.0", rssi: -49, claimed: false, occurredAt: new Date().toISOString() }),
    }), env, executionContext);
    assert.equal(resetSighting.status, 201);
    const enrollment = await worker.fetch(new Request("http://localhost/api/equipment-enrollment", {
      headers: { cookie },
    }), env, executionContext);
    const candidate = (await enrollment.json()).candidates.find((item) => item.moduleId === "mim-remove-01");
    assert.equal(candidate.status, "detected");
    assert.equal(candidate.claimed, false);
    const deletionAudit = await database.prepare("SELECT metadata FROM managed_entity_audit WHERE event='permanently_deleted' AND entity_id=? ORDER BY id DESC LIMIT 1")
      .bind(equipmentId).first();
    assert.equal(JSON.parse(deletionAudit.metadata).factoryIdentityPreserved, true);
  } finally {
    delete globalThis.__FUEL_EDGE_LOCAL_DB__;
    database.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("keeps edge operation free of remote pump controls", async () => {
  const source = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
  assert.match(source, /La habilitación física pertenece exclusivamente al PLC/i);
  assert.doesNotMatch(source, />\s*(Iniciar|Detener|Encender|Apagar) bomba\s*</i);
  assert.ok(root);
});

test("reports disabled or unavailable field hardware without false healthy states", async () => {
  const [page, store] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../worker/fuel-history-store.ts", import.meta.url), "utf8"),
  ]);
  assert.match(page, /edge\.nfcReady && edge\.k24Enabled && edge\.k24Healthy/i);
  const health = await readFile(new URL("../app/system-workspace.tsx", import.meta.url), "utf8");
  assert.match(health, /No habilitado/i);
  assert.match(health, /Sin confirmar/i);
  assert.match(health, /Lector de credenciales/i);
  assert.match(store, /nfc_ready AS nfcReady/i);
  assert.match(store, /k24_enabled AS k24Enabled/i);
  assert.match(store, /tank_level_enabled AS tankLevelEnabled/i);
});

test("enrolls a factory-trusted MIM through the local Raspberry Wi-Fi link", async () => {
  const [page, styles, api, store, migration, firmwareProtocol, firmware] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
    readFile(new URL("../worker/equipment-enrollment-api.ts", import.meta.url), "utf8"),
    readFile(new URL("../worker/equipment-enrollment-store.ts", import.meta.url), "utf8"),
    readFile(new URL("../drizzle/0007_lying_jubilee.sql", import.meta.url), "utf8"),
    readFile(new URL("../../firmware/common/src/equipment_ble_protocol.h", import.meta.url), "utf8"),
    readFile(new URL("../../firmware/equipment_module/src/main.cpp", import.meta.url), "utf8"),
  ]);
  assert.match(page, /Módulo Identificador de Máquina \(MIM\)/i);
  assert.doesNotMatch(page, />[^<]*XIAO[^<]*</i);
  assert.match(page, /red Wi-Fi privada del PLC/i);
  assert.match(page, /Nombrar y enrolar/i);
  assert.match(page, /Actualizar lectura de MIMs/i);
  assert.match(page, /Buscar equipos en la red/i);
  assert.match(page, /className=\{`overview-scan-button \$\{networkScanState\}`\}/i);
  assert.match(page, /function RefreshArrow/i);
  assert.match(page, /<RefreshArrow spinning=\{networkScanState === "scanning"\}/i);
  assert.match(page, /Red actualizada/i);
  assert.match(page, /10 segundos/i);
  assert.match(page, /scan-refresh-button[\s\S]*?<RefreshArrow \/>/i);
  assert.match(styles, /\.refresh-arrow\.spinning\s*\{[^}]*animation:\s*auth-spin/i);
  assert.match(styles, /\.overview-scan-button\.updated/i);
  assert.doesNotMatch(styles, /\.scan-refresh-icon\.spinning/i);
  assert.match(page, /startNetworkScan/i);
  assert.match(page, /MIM DETECTADO Y VERIFICADO/i);
  assert.match(page, /pendingCandidates = candidates\.filter\(\(candidate\) => candidate\.status !== "enrolled"\)/i);
  assert.match(page, /señal débil/i);
  assert.match(store, /datetime\(c\.last_seen\) >= datetime\('now','-5 minutes'\)/i);
  assert.match(api, /Servicio de enrolamiento no autorizado/i);
  assert.match(api, /manage_equipment/i);
  assert.match(store, /equipment_enrollment_commands/i);
  assert.match(store, /equipment_enrolled_wifi/i);
  assert.match(migration, /idx_equipment_enrollment_commands_active/i);
  assert.match(firmwareProtocol, /kClaimUuid/i);
  assert.match(firmwareProtocol, /kFlagEnrollmentReady/i);
  assert.match(firmware, /startWifiEnrollment/i);
  assert.match(firmware, /kFactoryResetHoldMilliseconds = 20000/i);
});

test("persists the complete sighting, claim and enrollment command flow", async () => {
  const directory = await mkdtemp(join(tmpdir(), "fuel-enrollment-"));
  const database = createLocalD1(join(directory, "web.sqlite3"));
  globalThis.__FUEL_EDGE_LOCAL_DB__ = database;
  try {
    const worker = await loadWorker();
    const env = {
      ...authEnv("master@example.test", "correct horse battery staple"),
      AUTH_BOOTSTRAP_VERSION: "test-enrollment-1",
      FUEL_SENSOR_INGEST_KEY: randomBytes(32).toString("base64url"),
    };
    const login = await worker.fetch(new Request("http://localhost/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://localhost" },
      body: JSON.stringify({ email: "master@example.test", password: "correct horse battery staple" }),
    }), env, executionContext);
    assert.equal(login.status, 200);
    const cookie = (login.headers.get("set-cookie") ?? "").split(";", 1)[0];
    const edgeHeaders = { "content-type": "application/json", "x-edge-sensor-key": env.FUEL_SENSOR_INGEST_KEY };
    const requestedScan = await worker.fetch(new Request("http://localhost/api/equipment-enrollment/scan", {
      method: "POST", headers: { cookie, origin: "http://localhost", "content-type": "application/json" }, body: "{}",
    }), env, executionContext);
    assert.equal(requestedScan.status, 202);
    const scan = (await requestedScan.json()).scan;
    assert.equal(scan.status, "pending");
    assert.equal(scan.durationSeconds, 10);
    const nextScan = await worker.fetch(new Request("http://localhost/api/equipment-enrollment/scan/next", {
      method: "POST", headers: edgeHeaders, body: "{}",
    }), env, executionContext);
    assert.equal(nextScan.status, 200);
    assert.equal((await nextScan.json()).scan.id, scan.id);
    const scanResult = await worker.fetch(new Request(`http://localhost/api/equipment-enrollment/scan/${scan.id}/result`, {
      method: "POST", headers: edgeHeaders, body: JSON.stringify({ success: true, discovered: 2, verified: 2 }),
    }), env, executionContext);
    assert.equal(scanResult.status, 200);
    const enrollmentState = await worker.fetch(new Request("http://localhost/api/equipment-enrollment", {
      headers: { cookie },
    }), env, executionContext);
    assert.equal(enrollmentState.status, 200);
    const completedScan = (await enrollmentState.json()).scan;
    assert.equal(completedScan.id, scan.id);
    assert.equal(completedScan.status, "completed");
    assert.equal(completedScan.discovered, 2);
    assert.equal(completedScan.verified, 2);
    assert.ok(completedScan.startedAt);
    assert.ok(completedScan.completedAt);
    await database.prepare(`INSERT INTO equipment_scan_requests(
      id,status,duration_seconds,requested_by,requested_at,updated_at
    ) VALUES ('stale-network-scan','pending',10,'usr-master',datetime('now','-2 minutes'),datetime('now','-2 minutes'))`).run();
    const replacementScanResponse = await worker.fetch(new Request("http://localhost/api/equipment-enrollment/scan", {
      method: "POST", headers: { cookie, origin: "http://localhost", "content-type": "application/json" }, body: "{}",
    }), env, executionContext);
    assert.equal(replacementScanResponse.status, 202);
    const replacementScan = (await replacementScanResponse.json()).scan;
    assert.notEqual(replacementScan.id, "stale-network-scan");
    assert.equal(replacementScan.durationSeconds, 10);
    assert.equal((await database.prepare("SELECT status FROM equipment_scan_requests WHERE id='stale-network-scan'").first()).status, "failed");
    const sighting = await worker.fetch(new Request("http://localhost/api/equipment-enrollment/sightings", {
      method: "POST", headers: edgeHeaders,
      body: JSON.stringify({ moduleId: "xiao-test-001", siteId: "campo-prueba", deviceName: null, equipmentId: null, firmware: "0.2.0", battery: 77, rssi: -48, claimed: false, occurredAt: new Date().toISOString() }),
    }), env, executionContext);
    assert.equal(sighting.status, 201);
    const expiredClaim = await worker.fetch(new Request("http://localhost/api/equipment-enrollment/xiao-test-001/claim", {
      method: "POST", headers: { cookie, origin: "http://localhost", "content-type": "application/json" },
      body: JSON.stringify({ name: "Tractor vencido", kind: "Tractor", validUntil: new Date(Date.now() - 60_000).toISOString() }),
    }), env, executionContext);
    assert.equal(expiredClaim.status, 400);
    const validUntil = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
    const claim = await worker.fetch(new Request("http://localhost/api/equipment-enrollment/xiao-test-001/claim", {
      method: "POST", headers: { cookie, origin: "http://localhost", "content-type": "application/json" },
      body: JSON.stringify({ name: "Tractor de prueba", kind: "Trilladora", validUntil }),
    }), env, executionContext);
    assert.equal(claim.status, 202);
    const next = await worker.fetch(new Request("http://localhost/api/equipment-enrollment/commands/next", {
      method: "POST", headers: edgeHeaders, body: JSON.stringify({ moduleId: "xiao-test-001" }),
    }), env, executionContext);
    assert.equal(next.status, 200);
    const command = (await next.json()).command;
    assert.equal(command.name, "Tractor de prueba");
    assert.equal(command.siteId, "campo-prueba");
    assert.equal(command.kind, "Trilladora");
    assert.equal(command.validUntil, validUntil);
    const result = await worker.fetch(new Request(`http://localhost/api/equipment-enrollment/commands/${command.id}/result`, {
      method: "POST", headers: edgeHeaders, body: JSON.stringify({ success: true, battery: 76 }),
    }), env, executionContext);
    assert.equal(result.status, 200);
    const connectedState = await worker.fetch(new Request("http://localhost/api/equipment-enrollment", { headers: { cookie } }), env, executionContext);
    const connectedCandidate = (await connectedState.json()).candidates.find((item) => item.moduleId === "xiao-test-001");
    assert.equal(connectedCandidate.status, "enrolled");
    const managed = await worker.fetch(new Request("http://localhost/api/managed-entities", { headers: { cookie } }), env, executionContext);
    assert.equal(managed.status, 200);
    const body = await managed.json();
    const enrolled = body.equipment.find((item) => item.name === "Tractor de prueba" && item.module === "xiao-test-001");
    assert.equal(enrolled.kind, "Trilladora");
    assert.equal(enrolled.siteId, "campo-prueba");
    assert.equal(enrolled.expiry, validUntil);
    const authorization = await worker.fetch(new Request("http://localhost/api/equipment-enrollment/authorization/resolve", {
      method: "POST", headers: edgeHeaders,
      body: JSON.stringify({ operatorId: "operator-test", equipmentId: command.equipmentId, moduleId: "xiao-test-001", siteId: "campo-prueba" }),
    }), env, executionContext);
    assert.equal(authorization.status, 200);
    assert.deepEqual((await authorization.json()).equipment, { active: true, associationActive: false, assignmentValidUntil: validUntil });

    const transferUntil = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString();
    const transferredSighting = await worker.fetch(new Request("http://localhost/api/equipment-enrollment/sightings", {
      method: "POST", headers: edgeHeaders,
      body: JSON.stringify({ moduleId: "xiao-test-001", siteId: "campo-dos", deviceName: "Tractor de prueba", equipmentId: command.equipmentId, firmware: "0.2.0", battery: 75, rssi: -46, claimed: true, occurredAt: new Date().toISOString() }),
    }), env, executionContext);
    assert.equal(transferredSighting.status, 201);
    const transferClaim = await worker.fetch(new Request("http://localhost/api/equipment-enrollment/xiao-test-001/claim", {
      method: "POST", headers: { cookie, origin: "http://localhost", "content-type": "application/json" },
      body: JSON.stringify({ name: "Camioneta trasladada", kind: "Camioneta", validUntil: transferUntil }),
    }), env, executionContext);
    assert.equal(transferClaim.status, 202);
    const transferNext = await worker.fetch(new Request("http://localhost/api/equipment-enrollment/commands/next", {
      method: "POST", headers: edgeHeaders, body: JSON.stringify({ moduleId: "xiao-test-001" }),
    }), env, executionContext);
    const transferCommand = (await transferNext.json()).command;
    assert.equal(transferCommand.equipmentId, command.equipmentId);
    assert.equal(transferCommand.siteId, "campo-dos");
    const transferResult = await worker.fetch(new Request(`http://localhost/api/equipment-enrollment/commands/${transferCommand.id}/result`, {
      method: "POST", headers: edgeHeaders, body: JSON.stringify({ success: true, battery: 74 }),
    }), env, executionContext);
    assert.equal(transferResult.status, 200);
    const transferredManaged = await worker.fetch(new Request("http://localhost/api/managed-entities", { headers: { cookie } }), env, executionContext);
    const transferred = (await transferredManaged.json()).equipment.find((item) => item.module === "xiao-test-001");
    assert.equal(transferred.name, "Camioneta trasladada");
    assert.equal(transferred.kind, "Camioneta");
    assert.equal(transferred.siteId, "campo-dos");
    assert.equal(transferred.expiry, transferUntil);
  } finally {
    delete globalThis.__FUEL_EDGE_LOCAL_DB__;
    database.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("enrolls two MIM independently and in parallel at the same site", async () => {
  const directory = await mkdtemp(join(tmpdir(), "fuel-parallel-enrollment-"));
  const database = createLocalD1(join(directory, "web.sqlite3"));
  globalThis.__FUEL_EDGE_LOCAL_DB__ = database;
  try {
    const worker = await loadWorker();
    const env = {
      ...authEnv("master@example.test", "correct horse battery staple"),
      AUTH_BOOTSTRAP_VERSION: "test-parallel-enrollment-1",
      FUEL_SENSOR_INGEST_KEY: randomBytes(32).toString("base64url"),
    };
    const login = await worker.fetch(new Request("http://localhost/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://localhost" },
      body: JSON.stringify({ email: "master@example.test", password: "correct horse battery staple" }),
    }), env, executionContext);
    assert.equal(login.status, 200);
    const cookie = (login.headers.get("set-cookie") ?? "").split(";", 1)[0];
    const edgeHeaders = { "content-type": "application/json", "x-edge-sensor-key": env.FUEL_SENSOR_INGEST_KEY };
    const modules = [
      { moduleId: "mim-parallel-01", name: "Tractor paralelo A", rssi: -47 },
      { moduleId: "mim-parallel-02", name: "Tractor paralelo B", rssi: -51 },
    ];

    const sightings = await Promise.all(modules.map((item) => worker.fetch(new Request("http://localhost/api/equipment-enrollment/sightings", {
      method: "POST",
      headers: edgeHeaders,
      body: JSON.stringify({ moduleId: item.moduleId, siteId: "fundo-paralelo", deviceName: null, equipmentId: null, firmware: "0.2.0", battery: 80, rssi: item.rssi, claimed: false, occurredAt: new Date().toISOString() }),
    }), env, executionContext)));
    assert.deepEqual(sightings.map((response) => response.status), [201, 201]);

    const validUntil = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
    const claims = await Promise.all(modules.map((item) => worker.fetch(new Request(`http://localhost/api/equipment-enrollment/${item.moduleId}/claim`, {
      method: "POST",
      headers: { cookie, origin: "http://localhost", "content-type": "application/json" },
      body: JSON.stringify({ name: item.name, kind: "Tractor", validUntil }),
    }), env, executionContext)));
    assert.deepEqual(claims.map((response) => response.status), [202, 202]);

    const nextCommands = await Promise.all(modules.map((item) => worker.fetch(new Request("http://localhost/api/equipment-enrollment/commands/next", {
      method: "POST",
      headers: edgeHeaders,
      body: JSON.stringify({ moduleId: item.moduleId }),
    }), env, executionContext)));
    assert.deepEqual(nextCommands.map((response) => response.status), [200, 200]);
    const commands = await Promise.all(nextCommands.map((response) => response.json().then((body) => body.command)));
    assert.equal(new Set(commands.map((command) => command.id)).size, 2);
    assert.deepEqual(commands.map((command) => command.siteId), ["fundo-paralelo", "fundo-paralelo"]);

    const parallelState = await worker.fetch(new Request("http://localhost/api/equipment-enrollment", { headers: { cookie } }), env, executionContext);
    const parallelCandidates = (await parallelState.json()).candidates.filter((candidate) => modules.some((item) => item.moduleId === candidate.moduleId));
    assert.equal(parallelCandidates.length, 2);
    assert.ok(parallelCandidates.every((candidate) => candidate.status === "enrolling"));

    const results = await Promise.all(commands.map((command) => worker.fetch(new Request(`http://localhost/api/equipment-enrollment/commands/${command.id}/result`, {
      method: "POST",
      headers: edgeHeaders,
      body: JSON.stringify({ success: true, battery: 79 }),
    }), env, executionContext)));
    assert.deepEqual(results.map((response) => response.status), [200, 200]);
    const managed = await worker.fetch(new Request("http://localhost/api/managed-entities", { headers: { cookie } }), env, executionContext);
    const enrolledNames = (await managed.json()).equipment.filter((item) => modules.some((module) => module.moduleId === item.module)).map((item) => item.name).sort();
    assert.deepEqual(enrolledNames, modules.map((item) => item.name).sort());
  } finally {
    delete globalThis.__FUEL_EDGE_LOCAL_DB__;
    database.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("opens a real NFC enrollment window and links the physical credential", async () => {
  const [page, coordinator, validatorFirmware] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../../src/fuel_edge/nfc_enrollment.py", import.meta.url), "utf8"),
    readFile(new URL("../../firmware/rfid_validator/src/main.cpp", import.meta.url), "utf8"),
  ]);
  assert.match(page, /Espera a que aparezca “Validador listo”/i);
  assert.doesNotMatch(coordinator, /if self\._active is not None:\s*return self\._active/i);
  assert.match(validatorFirmware, /maintainProactiveEquipmentDiscovery\(\)[\s\S]*?scanAndAuthenticateEquipment\(kProactiveScanSliceMilliseconds\)/i);
  assert.match(validatorFirmware, /include_equipment &&[\s\S]*?equipment_client == nullptr[\s\S]*?scanAndAuthenticateEquipment\(\)/i);
  assert.match(validatorFirmware, /reason == "equipment_required"[\s\S]*?publishPresentation\(true\)/i);
  assert.match(validatorFirmware, /master_authorized[\s\S]*?playMasterChime\(\)/i);
  const directory = await mkdtemp(join(tmpdir(), "fuel-nfc-enrollment-"));
  const database = createLocalD1(join(directory, "web.sqlite3"));
  globalThis.__FUEL_EDGE_LOCAL_DB__ = database;
  try {
    const worker = await loadWorker();
    const env = {
      ...authEnv("master@example.test", "correct horse battery staple"),
      AUTH_BOOTSTRAP_VERSION: "test-nfc-enrollment-1",
      FUEL_SENSOR_INGEST_KEY: randomBytes(32).toString("base64url"),
    };
    const login = await worker.fetch(new Request("http://localhost/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://localhost" },
      body: JSON.stringify({ email: "master@example.test", password: "correct horse battery staple" }),
    }), env, executionContext);
    const cookie = (login.headers.get("set-cookie") ?? "").split(";", 1)[0];
    const browserHeaders = { cookie, origin: "http://localhost", "content-type": "application/json" };
    const invalid = await worker.fetch(new Request("http://localhost/api/managed-entities/operators", {
      method: "POST", headers: browserHeaders,
      body: JSON.stringify({ name: "Operador inválido", rut: "12.345.678-9" }),
    }), env, executionContext);
    assert.equal(invalid.status, 400);
    assert.match((await invalid.json()).error, /RUT ingresado no es válido/i);
    const created = await worker.fetch(new Request("http://localhost/api/managed-entities/operators", {
      method: "POST", headers: browserHeaders,
      body: JSON.stringify({ name: "Operador NFC", rut: "12.345.678-5" }),
    }), env, executionContext);
    assert.equal(created.status, 201);
    const operatorId = (await created.json()).id;
    const opened = await worker.fetch(new Request("http://localhost/api/nfc-enrollment", {
      method: "POST", headers: browserHeaders, body: JSON.stringify({ operatorId }),
    }), env, executionContext);
    assert.equal(opened.status, 202);
    const commandId = (await opened.json()).command.id;
    const edgeHeaders = { "content-type": "application/json", "x-edge-sensor-key": env.FUEL_SENSOR_INGEST_KEY };
    const next = await worker.fetch(new Request("http://localhost/api/nfc-enrollment/commands/next", {
      method: "POST", headers: edgeHeaders, body: "{}",
    }), env, executionContext);
    assert.equal(next.status, 200);
    assert.equal((await next.json()).command.operatorId, operatorId);
    const completed = await worker.fetch(new Request(`http://localhost/api/nfc-enrollment/commands/${commandId}/result`, {
      method: "POST", headers: edgeHeaders,
      body: JSON.stringify({ success: true, credentialId: "nfc-fa2f0707" }),
    }), env, executionContext);
    assert.equal(completed.status, 200);
    const repeated = await worker.fetch(new Request(`http://localhost/api/nfc-enrollment/commands/${commandId}/result`, {
      method: "POST", headers: edgeHeaders,
      body: JSON.stringify({ success: true, credentialId: "nfc-fa2f0707" }),
    }), env, executionContext);
    assert.equal(repeated.status, 200);
    assert.equal((await repeated.json()).credentialId, "nfc-fa2f0707");
    const status = await worker.fetch(new Request(`http://localhost/api/nfc-enrollment/${commandId}`, {
      headers: { cookie },
    }), env, executionContext);
    assert.equal((await status.json()).command.status, "completed");
    const managed = await worker.fetch(new Request("http://localhost/api/managed-entities", {
      headers: { cookie },
    }), env, executionContext);
    const operator = (await managed.json()).operators.find((item) => item.id === operatorId);
    assert.equal(operator.credential, "nfc-fa2f0707");
  } finally {
    delete globalThis.__FUEL_EDGE_LOCAL_DB__;
    database.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("reassigns a tag after its deleted operator is recreated", async () => {
  const directory = await mkdtemp(join(tmpdir(), "fuel-nfc-reassignment-"));
  const database = createLocalD1(join(directory, "web.sqlite3"));
  globalThis.__FUEL_EDGE_LOCAL_DB__ = database;
  try {
    const worker = await loadWorker();
    const env = {
      ...authEnv("master@example.test", "correct horse battery staple"),
      AUTH_BOOTSTRAP_VERSION: "test-nfc-reassignment-1",
      FUEL_SENSOR_INGEST_KEY: randomBytes(32).toString("base64url"),
    };
    const login = await worker.fetch(new Request("http://localhost/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://localhost" },
      body: JSON.stringify({ email: "master@example.test", password: "correct horse battery staple" }),
    }), env, executionContext);
    const cookie = (login.headers.get("set-cookie") ?? "").split(";", 1)[0];
    const browserHeaders = { cookie, origin: "http://localhost", "content-type": "application/json" };
    const edgeHeaders = { "content-type": "application/json", "x-edge-sensor-key": env.FUEL_SENSOR_INGEST_KEY };
    const createOperator = async (name, rut) => {
      const response = await worker.fetch(new Request("http://localhost/api/managed-entities/operators", {
        method: "POST", headers: browserHeaders, body: JSON.stringify({ name, rut }),
      }), env, executionContext);
      assert.equal(response.status, 201);
      return (await response.json()).id;
    };
    const enroll = async (operatorId, credentialId) => {
      const opened = await worker.fetch(new Request("http://localhost/api/nfc-enrollment", {
        method: "POST", headers: browserHeaders, body: JSON.stringify({ operatorId }),
      }), env, executionContext);
      assert.equal(opened.status, 202);
      const commandId = (await opened.json()).command.id;
      const next = await worker.fetch(new Request("http://localhost/api/nfc-enrollment/commands/next", {
        method: "POST", headers: edgeHeaders, body: "{}",
      }), env, executionContext);
      assert.equal(next.status, 200);
      const command = (await next.json()).command;
      if (credentialId) {
        const completed = await worker.fetch(new Request(`http://localhost/api/nfc-enrollment/commands/${commandId}/result`, {
          method: "POST", headers: edgeHeaders,
          body: JSON.stringify({ success: true, credentialId }),
        }), env, executionContext);
        assert.equal(completed.status, 200);
      }
      return { commandId, command };
    };

    const originalId = await createOperator("Manolo Carewueo", "12.345.678-5");
    await enroll(originalId, "nfc-fa2f0707");

    const otherId = await createOperator("Operador vigente", "11.111.111-1");
    const blocked = await enroll(otherId);
    assert.deepEqual(blocked.command.unavailableCredentialIds, ["nfc-fa2f0707"]);
    const cancelled = await worker.fetch(new Request(`http://localhost/api/nfc-enrollment/${blocked.commandId}`, {
      method: "DELETE", headers: browserHeaders,
    }), env, executionContext);
    assert.equal(cancelled.status, 200);

    const archived = await worker.fetch(new Request(`http://localhost/api/managed-entities/operators/${originalId}`, {
      method: "PATCH", headers: browserHeaders, body: JSON.stringify({ archived: true }),
    }), env, executionContext);
    assert.equal(archived.status, 200);
    const deleted = await worker.fetch(new Request(`http://localhost/api/managed-entities/operators/${originalId}`, {
      method: "DELETE", headers: browserHeaders,
    }), env, executionContext);
    assert.equal(deleted.status, 200);

    const recreatedId = await createOperator("Manolo Carewueo", "12.345.678-5");
    const reassignment = await enroll(recreatedId, "nfc-fa2f0707");
    assert.deepEqual(reassignment.command.unavailableCredentialIds, []);
    const recreated = await database.prepare("SELECT credential FROM managed_operators WHERE id=?")
      .bind(recreatedId).first();
    assert.equal(recreated.credential, "nfc-fa2f0707");
  } finally {
    delete globalThis.__FUEL_EDGE_LOCAL_DB__;
    database.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("inventories, identifies, links and deletes RFID credentials independently from operators", async () => {
  const [page, api, store, migration] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../worker/rfid-credentials-api.ts", import.meta.url), "utf8"),
    readFile(new URL("../worker/rfid-credentials-store.ts", import.meta.url), "utf8"),
    readFile(new URL("../drizzle/0016_rfid_inventory.sql", import.meta.url), "utf8"),
  ]);
  assert.match(page, /title: "Credenciales RFID"/i);
  assert.match(page, /INVENTARIO LOCAL SINCRONIZADO/i);
  assert.match(page, /Vinculaciones/i);
  assert.match(page, /function CreateCredentialModal/i);
  assert.match(page, /Tipo de credencial<select/i);
  assert.match(page, /function EnrollModal[\s\S]*?openEnrollment\(credentialIsMaster\)/i);
  assert.match(page, /onCompletedRef\.current\(\)/i);
  assert.doesNotMatch(page, /\[commandId, status, onCompleted\]/i);
  assert.match(api, /manage_operators/i);
  assert.match(store, /idx_managed_rfid_one_per_operator|El operador ya tiene una credencial RFID asignada/i);
  assert.match(migration, /managed_rfid_credentials/i);

  const directory = await mkdtemp(join(tmpdir(), "fuel-rfid-inventory-"));
  const database = createLocalD1(join(directory, "web.sqlite3"));
  globalThis.__FUEL_EDGE_LOCAL_DB__ = database;
  try {
    const worker = await loadWorker();
    const env = {
      ...authEnv("master@example.test", "correct horse battery staple"),
      AUTH_BOOTSTRAP_VERSION: "test-rfid-inventory-1",
      FUEL_SENSOR_INGEST_KEY: randomBytes(32).toString("base64url"),
    };
    const login = await worker.fetch(new Request("http://localhost/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://localhost" },
      body: JSON.stringify({ email: "master@example.test", password: "correct horse battery staple" }),
    }), env, executionContext);
    const cookie = (login.headers.get("set-cookie") ?? "").split(";", 1)[0];
    const browserHeaders = { cookie, origin: "http://localhost", "content-type": "application/json" };
    const edgeHeaders = { "content-type": "application/json", "x-edge-sensor-key": env.FUEL_SENSOR_INGEST_KEY };
    const createOperator = async (name, rut) => {
      const response = await worker.fetch(new Request("http://localhost/api/managed-entities/operators", {
        method: "POST", headers: browserHeaders, body: JSON.stringify({ name, rut }),
      }), env, executionContext);
      assert.equal(response.status, 201);
      return (await response.json()).id;
    };
    const enroll = async (credentialId, body = {}) => {
      const opened = await worker.fetch(new Request("http://localhost/api/nfc-enrollment", {
        method: "POST", headers: browserHeaders, body: JSON.stringify(body),
      }), env, executionContext);
      assert.equal(opened.status, 202);
      const commandId = (await opened.json()).command.id;
      const next = await worker.fetch(new Request("http://localhost/api/nfc-enrollment/commands/next", {
        method: "POST", headers: edgeHeaders, body: "{}",
      }), env, executionContext);
      assert.equal(next.status, 200);
      const nextBody = await next.json();
      const completed = await worker.fetch(new Request(`http://localhost/api/nfc-enrollment/commands/${commandId}/result`, {
        method: "POST", headers: edgeHeaders,
        body: JSON.stringify({ success: true, credentialId }),
      }), env, executionContext);
      assert.equal(completed.status, 200);
      return nextBody;
    };
    const patchCredential = (credentialId, operatorId) => worker.fetch(new Request(
      `http://localhost/api/rfid-credentials/${credentialId}`,
      { method: "PATCH", headers: browserHeaders, body: JSON.stringify({ operatorId }) },
    ), env, executionContext);

    const operatorA = await createOperator("Operadora RFID A", "12.345.678-5");
    const operatorB = await createOperator("Operador RFID B", "11.111.111-1");
    const firstPoll = await enroll("nfc-11111111");
    assert.equal(firstPoll.command.operatorActive, false);
    assert.equal(firstPoll.command.operatorId, "__rfid_inventory_unassigned__");
    assert.deepEqual(firstPoll.credentials, []);

    const inventoryResponse = await worker.fetch(new Request("http://localhost/api/rfid-credentials", {
      headers: { cookie },
    }), env, executionContext);
    assert.equal(inventoryResponse.status, 200);
    const initialInventory = (await inventoryResponse.json()).credentials;
    assert.equal(initialInventory.length, 1);
    assert.equal(initialInventory[0].credentialId, "nfc-11111111");
    assert.equal(initialInventory[0].operatorId, null);
    assert.equal(initialInventory[0].credentialActive, true);

    const identifyOpened = await worker.fetch(new Request("http://localhost/api/nfc-identification", {
      method: "POST", headers: browserHeaders, body: "{}",
    }), env, executionContext);
    const identifyId = (await identifyOpened.json()).command.id;
    const identifyNext = await worker.fetch(new Request("http://localhost/api/nfc-identification/commands/next", {
      method: "POST", headers: edgeHeaders, body: "{}",
    }), env, executionContext);
    assert.equal((await identifyNext.json()).command.purpose, "identification");
    await worker.fetch(new Request(`http://localhost/api/nfc-identification/commands/${identifyId}/result`, {
      method: "POST", headers: edgeHeaders,
      body: JSON.stringify({ success: true, credentialId: "nfc-11111111" }),
    }), env, executionContext);
    const identifyStatus = await worker.fetch(new Request(`http://localhost/api/nfc-identification/${identifyId}`, {
      headers: { cookie },
    }), env, executionContext);
    const identified = (await identifyStatus.json()).command;
    assert.equal(identified.registered, true);
    assert.equal(identified.operator, null);

    assert.equal((await patchCredential("nfc-11111111", operatorA)).status, 200);
    const secondPoll = await enroll("nfc-22222222");
    assert.deepEqual(secondPoll.credentials, [{
      credentialId: "nfc-11111111",
      operatorId: operatorA,
      credentialActive: true,
      operatorActive: true,
      isMaster: false,
    }]);
    const duplicateOwner = await patchCredential("nfc-22222222", operatorA);
    assert.equal(duplicateOwner.status, 409);
    assert.match((await duplicateOwner.json()).error, /ya tiene una credencial/i);

    assert.equal((await patchCredential("nfc-11111111", operatorB)).status, 200);
    const managedAfterMove = await worker.fetch(new Request("http://localhost/api/managed-entities", {
      headers: { cookie },
    }), env, executionContext);
    const movedOperators = (await managedAfterMove.json()).operators;
    assert.equal(movedOperators.find((item) => item.id === operatorA).credential, "Sin enrolar");
    assert.equal(movedOperators.find((item) => item.id === operatorB).credential, "nfc-11111111");

    const masterWithoutOwner = await worker.fetch(new Request("http://localhost/api/nfc-enrollment", {
      method: "POST", headers: browserHeaders, body: JSON.stringify({ isMaster: true }),
    }), env, executionContext);
    assert.equal(masterWithoutOwner.status, 409);
    assert.match((await masterWithoutOwner.json()).error, /persona|operador vigente/i);

    const deleted = await worker.fetch(new Request("http://localhost/api/rfid-credentials/nfc-11111111", {
      method: "DELETE", headers: browserHeaders,
    }), env, executionContext);
    assert.equal(deleted.status, 200);
    const finalInventoryResponse = await worker.fetch(new Request("http://localhost/api/rfid-credentials", {
      headers: { cookie },
    }), env, executionContext);
    const finalInventory = (await finalInventoryResponse.json()).credentials;
    assert.deepEqual(finalInventory.map((item) => item.credentialId), ["nfc-22222222"]);
    const finalPoll = await worker.fetch(new Request("http://localhost/api/nfc-enrollment/commands/next", {
      method: "POST", headers: edgeHeaders, body: "{}",
    }), env, executionContext);
    assert.deepEqual((await finalPoll.json()).credentials.map((item) => item.credentialId), ["nfc-22222222"]);
  } finally {
    delete globalThis.__FUEL_EDGE_LOCAL_DB__;
    database.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("reserves new RFID enrollment for the provider master account", async () => {
  const [page, enrollmentApi] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../worker/nfc-enrollment-api.ts", import.meta.url), "utf8"),
  ]);
  assert.match(enrollmentApi, /actor\.role !== "master" \|\| actor\.is_master !== 1/i);
  assert.match(enrollmentApi, /cuenta maestra del proveedor tecnológico/i);
  assert.match(page, /isProviderAdmin && <button[\s\S]{0,300}?Enrolar RFID<\/button>/i);
  assert.match(page, /tags nuevos los enrola el proveedor tecnológico/i);

  const directory = await mkdtemp(join(tmpdir(), "fuel-rfid-provider-master-"));
  const database = createLocalD1(join(directory, "web.sqlite3"));
  globalThis.__FUEL_EDGE_LOCAL_DB__ = database;
  try {
    const worker = await loadWorker();
    const env = {
      ...authEnv("master@example.test", "correct horse battery staple"),
      AUTH_BOOTSTRAP_VERSION: "test-rfid-provider-master-1",
      FUEL_SENSOR_INGEST_KEY: randomBytes(32).toString("base64url"),
    };
    const masterLogin = await worker.fetch(new Request("http://localhost/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://localhost" },
      body: JSON.stringify({ email: "master@example.test", password: "correct horse battery staple" }),
    }), env, executionContext);
    assert.equal(masterLogin.status, 200);
    const masterCookie = (masterLogin.headers.get("set-cookie") ?? "").split(";", 1)[0];

    const administratorEmail = "operations-admin@example.test";
    const administratorPassword = "correct horse battery staple admin";
    const administratorSalt = randomBytes(16);
    const administratorDigest = base64url(createHmac("sha256", Buffer.from(env.AUTH_EMAIL_PEPPER, "base64url"))
      .update(administratorEmail).digest());
    const administratorHash = `pbkdf2_sha256$310000$${base64url(administratorSalt)}$${base64url(pbkdf2Sync(administratorPassword, administratorSalt, 310000, 32, "sha256"))}`;
    await database.prepare(`INSERT INTO web_users(
      id,email_digest,email_encrypted,name,role,permissions,password_hash,
      active,must_change_password,is_master
    ) VALUES ('usr-operations-admin',?,NULL,'Administrador operacional','administrator',?,?,1,0,0)`)
      .bind(administratorDigest, JSON.stringify(["view_dashboard", "manage_operators"]), administratorHash).run();

    const administratorLogin = await worker.fetch(new Request("http://localhost/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://localhost" },
      body: JSON.stringify({ email: administratorEmail, password: administratorPassword }),
    }), env, executionContext);
    assert.equal(administratorLogin.status, 200);
    const administratorCookie = (administratorLogin.headers.get("set-cookie") ?? "").split(";", 1)[0];
    const administratorHeaders = {
      cookie: administratorCookie,
      origin: "http://localhost",
      "content-type": "application/json",
    };

    const inventory = await worker.fetch(new Request("http://localhost/api/rfid-credentials", {
      headers: { cookie: administratorCookie },
    }), env, executionContext);
    assert.equal(inventory.status, 200);
    const identification = await worker.fetch(new Request("http://localhost/api/nfc-identification", {
      method: "POST", headers: administratorHeaders, body: "{}",
    }), env, executionContext);
    assert.equal(identification.status, 202);
    const identificationId = (await identification.json()).command.id;
    const cancelledIdentification = await worker.fetch(new Request(`http://localhost/api/nfc-identification/${identificationId}`, {
      method: "DELETE", headers: administratorHeaders,
    }), env, executionContext);
    assert.equal(cancelledIdentification.status, 200);

    const forbiddenEnrollment = await worker.fetch(new Request("http://localhost/api/nfc-enrollment", {
      method: "POST", headers: administratorHeaders, body: "{}",
    }), env, executionContext);
    assert.equal(forbiddenEnrollment.status, 403);
    assert.match((await forbiddenEnrollment.json()).error, /proveedor tecnológico/i);

    const masterEnrollment = await worker.fetch(new Request("http://localhost/api/nfc-enrollment", {
      method: "POST",
      headers: { cookie: masterCookie, origin: "http://localhost", "content-type": "application/json" },
      body: "{}",
    }), env, executionContext);
    assert.equal(masterEnrollment.status, 202);
  } finally {
    delete globalThis.__FUEL_EDGE_LOCAL_DB__;
    database.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("requires approval to replace the single master card and records emergency dispatches", async () => {
  const [page, store, managedStore, coordinator] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../worker/nfc-enrollment-store.ts", import.meta.url), "utf8"),
    readFile(new URL("../worker/managed-entities-store.ts", import.meta.url), "utf8"),
    readFile(new URL("../../src/fuel_edge/nfc_enrollment.py", import.meta.url), "utf8"),
  ]);
  assert.match(page, /Tarjeta maestra de emergencia/i);
  assert.match(page, /La tarjeta anterior se desactivará/i);
  assert.match(managedStore, /idx_managed_operators_single_active_master/i);
  assert.match(store, /MASTER_REPLACEMENT_REQUIRED|NfcMasterReplacementRequired/i);
  assert.match(coordinator, /credential_ids_to_deactivate/i);

  const directory = await mkdtemp(join(tmpdir(), "fuel-master-card-"));
  const database = createLocalD1(join(directory, "web.sqlite3"));
  globalThis.__FUEL_EDGE_LOCAL_DB__ = database;
  try {
    const worker = await loadWorker();
    const env = {
      ...authEnv("master@example.test", "correct horse battery staple"),
      AUTH_BOOTSTRAP_VERSION: "test-master-card-1",
      FUEL_SENSOR_INGEST_KEY: randomBytes(32).toString("base64url"),
    };
    const login = await worker.fetch(new Request("http://localhost/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://localhost" },
      body: JSON.stringify({ email: "master@example.test", password: "correct horse battery staple" }),
    }), env, executionContext);
    const cookie = (login.headers.get("set-cookie") ?? "").split(";", 1)[0];
    const browserHeaders = { cookie, origin: "http://localhost", "content-type": "application/json" };
    const edgeHeaders = { "content-type": "application/json", "x-edge-sensor-key": env.FUEL_SENSOR_INGEST_KEY };
    const createOperator = async (name, rut) => {
      const response = await worker.fetch(new Request("http://localhost/api/managed-entities/operators", {
        method: "POST", headers: browserHeaders, body: JSON.stringify({ name, rut }),
      }), env, executionContext);
      assert.equal(response.status, 201);
      return (await response.json()).id;
    };
    const oldOperatorId = await createOperator("Encargado anterior", "11.111.111-1");
    const newOperatorId = await createOperator("Encargada de emergencia", "9.876.543-3");

    const firstEnrollment = await worker.fetch(new Request("http://localhost/api/nfc-enrollment", {
      method: "POST", headers: browserHeaders,
      body: JSON.stringify({ operatorId: oldOperatorId, isMaster: true }),
    }), env, executionContext);
    assert.equal(firstEnrollment.status, 202);
    const firstCommandId = (await firstEnrollment.json()).command.id;
    const firstNext = await worker.fetch(new Request("http://localhost/api/nfc-enrollment/commands/next", {
      method: "POST", headers: edgeHeaders, body: "{}",
    }), env, executionContext);
    const firstCommand = (await firstNext.json()).command;
    assert.equal(firstCommand.isMaster, true);
    assert.deepEqual(firstCommand.deactivatedCredentialIds, []);
    const firstCompleted = await worker.fetch(new Request(`http://localhost/api/nfc-enrollment/commands/${firstCommandId}/result`, {
      method: "POST", headers: edgeHeaders,
      body: JSON.stringify({ success: true, credentialId: "nfc-aaaaaaaa" }),
    }), env, executionContext);
    assert.equal(firstCompleted.status, 200);

    const replacementWarning = await worker.fetch(new Request("http://localhost/api/nfc-enrollment", {
      method: "POST", headers: browserHeaders,
      body: JSON.stringify({ operatorId: newOperatorId, isMaster: true }),
    }), env, executionContext);
    assert.equal(replacementWarning.status, 409);
    const warningBody = await replacementWarning.json();
    assert.equal(warningBody.code, "MASTER_REPLACEMENT_REQUIRED");
    assert.equal(warningBody.currentMaster.operatorName, "Encargado anterior");
    assert.equal(warningBody.currentMaster.credentialId, "nfc-aaaaaaaa");

    const approvedReplacement = await worker.fetch(new Request("http://localhost/api/nfc-enrollment", {
      method: "POST", headers: browserHeaders,
      body: JSON.stringify({
        operatorId: newOperatorId,
        isMaster: true,
        replaceMasterCredentialId: warningBody.currentMaster.credentialId,
      }),
    }), env, executionContext);
    assert.equal(approvedReplacement.status, 202);
    const replacementCommandId = (await approvedReplacement.json()).command.id;
    const replacementNext = await worker.fetch(new Request("http://localhost/api/nfc-enrollment/commands/next", {
      method: "POST", headers: edgeHeaders, body: "{}",
    }), env, executionContext);
    const replacementCommand = (await replacementNext.json()).command;
    assert.equal(replacementCommand.isMaster, true);
    assert.deepEqual(replacementCommand.deactivatedCredentialIds, ["nfc-aaaaaaaa"]);
    const replacementCompleted = await worker.fetch(new Request(`http://localhost/api/nfc-enrollment/commands/${replacementCommandId}/result`, {
      method: "POST", headers: edgeHeaders,
      body: JSON.stringify({ success: true, credentialId: "nfc-bbbbbbbb" }),
    }), env, executionContext);
    assert.equal(replacementCompleted.status, 200);
    const unassignMaster = await worker.fetch(new Request("http://localhost/api/rfid-credentials/nfc-bbbbbbbb", {
      method: "PATCH", headers: browserHeaders, body: JSON.stringify({ operatorId: null }),
    }), env, executionContext);
    assert.equal(unassignMaster.status, 409);
    assert.match((await unassignMaster.json()).error, /persona responsable/i);

    const managed = await worker.fetch(new Request("http://localhost/api/managed-entities", {
      headers: { cookie },
    }), env, executionContext);
    const operators = (await managed.json()).operators;
    const previousMaster = operators.find((item) => item.id === oldOperatorId);
    const currentMaster = operators.find((item) => item.id === newOperatorId);
    assert.equal(previousMaster.credentialActive, false);
    assert.equal(previousMaster.credentialIsMaster, true);
    assert.equal(currentMaster.credentialActive, true);
    assert.equal(currentMaster.credentialIsMaster, true);
    assert.equal(operators.filter((item) => item.credentialActive && item.credentialIsMaster).length, 1);

    const now = new Date();
    const localDay = dateInputInTimeZone(now);
    const initialized = await worker.fetch(new Request(`http://localhost/api/fuel-history?from=${localDay}&to=${localDay}`, {
      headers: { cookie },
    }), env, executionContext);
    assert.equal(initialized.status, 200);
    const dispatchId = `master-dispatch-${Date.now()}`;
    const dispatch = await worker.fetch(new Request("http://localhost/api/fuel-history/movements", {
      method: "POST", headers: edgeHeaders,
      body: JSON.stringify({
        id: dispatchId,
        type: "dispatch",
        occurredAt: now.toISOString(),
        liters: 25.4,
        source: "K24 + PLC",
        reference: dispatchId,
        detail: `${newOperatorId} · Carga excepcional · Tarjeta maestra`,
        operatorId: newOperatorId,
        equipmentId: null,
        isMaster: true,
      }),
    }), env, executionContext);
    assert.equal(dispatch.status, 201);
    const recorded = (await dispatch.json()).movement;
    assert.equal(recorded.operatorId, newOperatorId);
    assert.equal(recorded.equipmentId, null);
    assert.equal(recorded.isMaster, true);

    const audit = await database.prepare(`SELECT metadata FROM managed_entity_audit
      WHERE event='nfc_enrollment_completed' AND entity_id=? ORDER BY id DESC LIMIT 1`)
      .bind(newOperatorId).first();
    assert.deepEqual(JSON.parse(audit.metadata).deactivatedCredentialIds, ["nfc-aaaaaaaa"]);
    const approval = await database.prepare(`SELECT actor_user_id AS actorUserId,metadata FROM managed_entity_audit
      WHERE event='nfc_master_replacement_approved' AND entity_id=? ORDER BY id DESC LIMIT 1`)
      .bind(newOperatorId).first();
    assert.ok(approval.actorUserId);
    assert.equal(JSON.parse(approval.metadata).previousCredentialId, "nfc-aaaaaaaa");
  } finally {
    delete globalThis.__FUEL_EDGE_LOCAL_DB__;
    database.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("identifies an RFID credential without modifying its operator", async () => {
  const [page, styles, coordinator, store] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
    readFile(new URL("../../src/fuel_edge/nfc_enrollment.py", import.meta.url), "utf8"),
    readFile(new URL("../worker/nfc-enrollment-store.ts", import.meta.url), "utf8"),
  ]);
  assert.match(page, /Identificar credencial RFID/i);
  assert.match(page, /Tag no registrado/i);
  assert.match(page, /TAG ENROLADO/i);
  assert.match(page, /Sin operador asociado/i);
  assert.match(page, /window\.setTimeout\(poll, 200\)/i);
  assert.match(page, /no necesitas volver a presentarlo/i);
  assert.match(page, /function RfidTagSchematic/i);
  assert.match(page, /className="rfid-tag-body"/i);
  assert.match(page, /className="rfid-tag-wave wave-three"/i);
  assert.match(page, /className="rfid-tag-loop" cx="42" cy="81" r="29"/i);
  assert.match(page, /M69 53C98 36 127 20 159 20/i);
  assert.doesNotMatch(page, /className="(?:nfc-card|rfid-tag)"/i);
  assert.match(styles, /\.rfid-tag-body.*url\(#rfid-tag-gradient\)/i);
  assert.match(styles, /@keyframes rfid-float/i);
  assert.doesNotMatch(styles, /\.rfid-tag::before/i);
  assert.match(page, /sin modificar ni enrolar datos/i);
  assert.match(coordinator, /purpose="identification" if identifying else "enrollment"/i);
  assert.match(coordinator, /poll_seconds: float = 0\.25/i);
  assert.match(store, /nfc_identification_completed/i);
  const directory = await mkdtemp(join(tmpdir(), "fuel-nfc-identification-"));
  const database = createLocalD1(join(directory, "web.sqlite3"));
  globalThis.__FUEL_EDGE_LOCAL_DB__ = database;
  try {
    const worker = await loadWorker();
    const env = {
      ...authEnv("master@example.test", "correct horse battery staple"),
      AUTH_BOOTSTRAP_VERSION: "test-nfc-identification-1",
      FUEL_SENSOR_INGEST_KEY: randomBytes(32).toString("base64url"),
    };
    const login = await worker.fetch(new Request("http://localhost/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://localhost" },
      body: JSON.stringify({ email: "master@example.test", password: "correct horse battery staple" }),
    }), env, executionContext);
    const cookie = (login.headers.get("set-cookie") ?? "").split(";", 1)[0];
    const browserHeaders = { cookie, origin: "http://localhost", "content-type": "application/json" };
    const created = await worker.fetch(new Request("http://localhost/api/managed-entities/operators", {
      method: "POST", headers: browserHeaders,
      body: JSON.stringify({ name: "Operador identificado", rut: "12.345.678-5" }),
    }), env, executionContext);
    const operatorId = (await created.json()).id;
    const enrollment = await worker.fetch(new Request("http://localhost/api/nfc-enrollment", {
      method: "POST", headers: browserHeaders, body: JSON.stringify({ operatorId }),
    }), env, executionContext);
    const enrollmentId = (await enrollment.json()).command.id;
    const edgeHeaders = { "content-type": "application/json", "x-edge-sensor-key": env.FUEL_SENSOR_INGEST_KEY };
    await worker.fetch(new Request(`http://localhost/api/nfc-enrollment/commands/${enrollmentId}/result`, {
      method: "POST", headers: edgeHeaders, body: JSON.stringify({ success: true, credentialId: "nfc-fa2f0707" }),
    }), env, executionContext);

    const opened = await worker.fetch(new Request("http://localhost/api/nfc-identification", {
      method: "POST", headers: browserHeaders, body: "{}",
    }), env, executionContext);
    assert.equal(opened.status, 202);
    const openedCommand = (await opened.json()).command;
    assert.ok(new Date(openedCommand.expiresAt).getTime() - Date.now() <= 60_000);
    const next = await worker.fetch(new Request("http://localhost/api/nfc-identification/commands/next", {
      method: "POST", headers: edgeHeaders, body: "{}",
    }), env, executionContext);
    assert.equal((await next.json()).command.purpose, "identification");
    const completed = await worker.fetch(new Request(`http://localhost/api/nfc-identification/commands/${openedCommand.id}/result`, {
      method: "POST", headers: edgeHeaders, body: JSON.stringify({ success: true, credentialId: "nfc-fa2f0707" }),
    }), env, executionContext);
    assert.equal(completed.status, 200);
    const status = await worker.fetch(new Request(`http://localhost/api/nfc-identification/${openedCommand.id}`, {
      headers: { cookie },
    }), env, executionContext);
    const identified = (await status.json()).command;
    assert.equal(identified.status, "completed");
    assert.equal(identified.registered, true);
    assert.equal(identified.operator.id, operatorId);
    assert.equal(identified.operator.name, "Operador identificado");
    const unknownOpened = await worker.fetch(new Request("http://localhost/api/nfc-identification", {
      method: "POST", headers: browserHeaders, body: "{}",
    }), env, executionContext);
    const unknownId = (await unknownOpened.json()).command.id;
    await worker.fetch(new Request(`http://localhost/api/nfc-identification/commands/${unknownId}/result`, {
      method: "POST", headers: edgeHeaders, body: JSON.stringify({ success: true, credentialId: "nfc-deadbeef" }),
    }), env, executionContext);
    const unknownStatus = await worker.fetch(new Request(`http://localhost/api/nfc-identification/${unknownId}`, {
      headers: { cookie },
    }), env, executionContext);
    const unknown = (await unknownStatus.json()).command;
    assert.equal(unknown.registered, false);
    assert.equal(unknown.operator, null);
    const managed = await worker.fetch(new Request("http://localhost/api/managed-entities", { headers: { cookie } }), env, executionContext);
    const unchanged = (await managed.json()).operators.find((item) => item.id === operatorId);
    assert.equal(unchanged.credential, "nfc-fa2f0707");
  } finally {
    delete globalThis.__FUEL_EDGE_LOCAL_DB__;
    database.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("groups system calibration separately from status and preserves its permissions", async () => {
  const [page, styles] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
  ]);
  assert.match(page, /id: "maintenance"[\s\S]*?canManage && <BluetoothCalibration \/>/i);
  assert.match(styles, /\.system-primary\s*\{[^}]*min-width:\s*0[^}]*flex-direction:\s*column/i);
  assert.match(styles, /\.bluetooth-calibration\s*\{[^}]*min-width:\s*0/i);
  assert.doesNotMatch(styles, /\.bluetooth-calibration\s*\{[^}]*grid-column:\s*1\s*\/\s*-1/i);
});

test("shows only enrolled MIMs observed by the validator on the machine radar", async () => {
  const [page, styles, api, store, migration] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
    readFile(new URL("../worker/system-settings-api.ts", import.meta.url), "utf8"),
    readFile(new URL("../worker/system-settings-store.ts", import.meta.url), "utf8"),
    readFile(new URL("../drizzle/0014_machine_map.sql", import.meta.url), "utf8"),
  ]);
  assert.match(page, /Mapa de máquinas/i);
  assert.match(page, /\[-40, -60, -80, -100\]/i);
  assert.match(page, /nowMs - databaseInstant\(item\.observedAt\)\.getTime\(\) <= 4_000/i);
  assert.match(page, /window\.setInterval\(refresh, 1000\)/i);
  assert.match(styles, /\.machine-radar/i);
  assert.match(api, /view_dashboard/i);
  assert.match(store, /INNER JOIN managed_equipment/i);
  assert.match(store, /m\.active=1[\s\S]*m\.archived_at IS NULL/i);
  assert.match(migration, /validator_bluetooth_observations/i);

  const directory = await mkdtemp(join(tmpdir(), "fuel-machine-map-"));
  const database = createLocalD1(join(directory, "web.sqlite3"));
  globalThis.__FUEL_EDGE_LOCAL_DB__ = database;
  try {
    const worker = await loadWorker();
    const env = {
      ...authEnv("master@example.test", "correct horse battery staple"),
      AUTH_BOOTSTRAP_VERSION: "test-machine-map-1",
      FUEL_SENSOR_INGEST_KEY: randomBytes(32).toString("base64url"),
      FUEL_SITE_ID: "campo-radar",
    };
    const login = await worker.fetch(new Request("http://localhost/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://localhost" },
      body: JSON.stringify({ email: "master@example.test", password: "correct horse battery staple" }),
    }), env, executionContext);
    assert.equal(login.status, 200);
    const cookie = (login.headers.get("set-cookie") ?? "").split(";", 1)[0];
    const equipment = await worker.fetch(new Request("http://localhost/api/managed-entities/equipment", {
      method: "POST",
      headers: { cookie, origin: "http://localhost", "content-type": "application/json" },
      body: JSON.stringify({ name: "Tractor radar", kind: "Tractor", condition: "Permanente", module: "mim-radar-01", siteId: "campo-radar" }),
    }), env, executionContext);
    assert.equal(equipment.status, 201);
    const edgeHeaders = { "content-type": "application/json", "x-edge-sensor-key": env.FUEL_SENSOR_INGEST_KEY };
    for (const [moduleId, rssi] of [["mim-radar-01", -58], ["mim-no-enrolado", -44]]) {
      const observation = await worker.fetch(new Request("http://localhost/api/system-settings/bluetooth/observation", {
        method: "POST", headers: edgeHeaders, body: JSON.stringify({ moduleId, rssi }),
      }), env, executionContext);
      assert.equal(observation.status, 200);
    }
    const radar = await worker.fetch(new Request("http://localhost/api/system-settings/bluetooth/observations", {
      headers: { cookie },
    }), env, executionContext);
    assert.equal(radar.status, 200);
    const observations = (await radar.json()).observations;
    assert.deepEqual(observations.map((item) => ({ name: item.name, moduleId: item.moduleId, rssi: item.rssi })), [
      { name: "Tractor radar", moduleId: "mim-radar-01", rssi: -58 },
    ]);
  } finally {
    delete globalThis.__FUEL_EDGE_LOCAL_DB__;
    database.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("nests the machine map under manageable equipment", async () => {
  const page = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
  const navigation = page.match(/const navItems:[\s\S]*?const viewCopy/)?.[0] ?? "";
  assert.doesNotMatch(navigation, /id: "machineMap"/i);
  assert.match(page, /view === "equipment"[\s\S]*?onNavigate\("machineMap"\)[\s\S]*?Mapa de máquinas/i);
  assert.match(page, /view === "equipment"[\s\S]*?onNavigate\("mimEnrollment"\)[\s\S]*?Enlazar nuevo MIM/i);
  assert.match(page, /view === "machineMap"[\s\S]*?onNavigate\("equipment"\)[\s\S]*?Volver a equipos/i);
  assert.match(page, /view === "machineMap" && item\.id === "equipment"/i);
  assert.match(page, /view === "mimEnrollment" && item\.id === "equipment"/i);
  assert.match(page, /mimEnrollment: \{ eyebrow: "Activos · Equipos abastecibles", title: "Enlazar nuevo MIM"/i);
  assert.doesNotMatch(navigation, /id: "mimEnrollment"/i);
  assert.match(page, /machineMap: \{ eyebrow: "Activos · Equipos abastecibles"/i);
});

test("keeps Operators selected while managing RFID credentials", async () => {
  const page = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
  assert.match(page, /view === "rfidCredentials" && item\.id === "operators"/i);
  assert.doesNotMatch(page.match(/const navItems:[\s\S]*?const viewCopy/)?.[0] ?? "", /id: "rfidCredentials"/i);
});

test("prioritizes fuel history and shows adoption only as the final active operation tab", async () => {
  const page = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
  const navigation = page.match(/const navItems:[\s\S]*?const viewCopy/)?.[0] ?? "";
  const historyIndex = navigation.indexOf('id: "fuelHistory"');
  const loadsIndex = navigation.indexOf('id: "transactions"');
  const alertsIndex = navigation.indexOf('id: "alerts"');
  const adoptionIndex = navigation.indexOf('id: "adoption"');
  assert.ok(historyIndex >= 0 && historyIndex < loadsIndex);
  assert.ok(loadsIndex < alertsIndex && alertsIndex < adoptionIndex);
  assert.match(page, /item\.id !== "adoption" \|\| adoptionActive/i);
  assert.match(page, /Iniciar etapa de adopción tecnológica/i);
  assert.match(page, /Desactivar etapa de adopción tecnológica/i);
  assert.match(page, /\/api\/technology-adoption\/deactivate/i);
  assert.doesNotMatch(page, /Para el operador|Para el encargado agrícola|Para gerencia/i);
  assert.doesNotMatch(page, /Gobierno y auditoría|Decisiones de etapa|adoption-history/i);
});

test("allows only the master account to permanently delete a system user", async () => {
  const directory = await mkdtemp(join(tmpdir(), "fuel-user-deletion-"));
  const database = createLocalD1(join(directory, "web.sqlite3"));
  globalThis.__FUEL_EDGE_LOCAL_DB__ = database;
  try {
    const worker = await loadWorker();
    const env = {
      ...authEnv("master@example.test", "correct horse battery staple"),
      AUTH_BOOTSTRAP_VERSION: "test-user-deletion-1",
      AUTH_DATA_KEY: randomBytes(32).toString("base64url"),
    };
    const login = await worker.fetch(new Request("http://localhost/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://localhost" },
      body: JSON.stringify({ email: "master@example.test", password: "correct horse battery staple" }),
    }), env, executionContext);
    assert.equal(login.status, 200);
    const cookie = (login.headers.get("set-cookie") ?? "").split(";", 1)[0];
    const browserHeaders = { cookie, origin: "http://localhost", "content-type": "application/json" };
    const created = await worker.fetch(new Request("http://localhost/api/users", {
      method: "POST", headers: browserHeaders,
      body: JSON.stringify({ name: "Usuario eliminable", email: "delete@example.test", role: "viewer", permissions: ["view_dashboard", "view_transactions"] }),
    }), env, executionContext);
    assert.equal(created.status, 201);
    const target = (await created.json()).user;
    const deleted = await worker.fetch(new Request(`http://localhost/api/users/${target.id}`, {
      method: "DELETE", headers: browserHeaders,
    }), env, executionContext);
    assert.equal(deleted.status, 200);
    assert.deepEqual(await deleted.json(), { deleted: true });
    const users = await worker.fetch(new Request("http://localhost/api/users", { headers: { cookie } }), env, executionContext);
    assert.equal((await users.json()).users.some((user) => user.id === target.id), false);
    const protectedMaster = await worker.fetch(new Request("http://localhost/api/users/usr-master", {
      method: "DELETE", headers: browserHeaders,
    }), env, executionContext);
    assert.equal(protectedMaster.status, 409);
    assert.match((await protectedMaster.json()).error, /No puedes eliminar la cuenta/i);
    const audit = await database.prepare("SELECT event FROM web_access_audit WHERE target_user_id = ? ORDER BY id DESC LIMIT 1")
      .bind(target.id).first();
    assert.equal(audit.event, "user_deleted");
  } finally {
    delete globalThis.__FUEL_EDGE_LOCAL_DB__;
    database.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("calibrates Bluetooth in the app and confirms application by the validator", async () => {
  const directory = await mkdtemp(join(tmpdir(), "fuel-bluetooth-settings-"));
  const database = createLocalD1(join(directory, "web.sqlite3"));
  globalThis.__FUEL_EDGE_LOCAL_DB__ = database;
  try {
    const worker = await loadWorker();
    const env = {
      ...authEnv("master@example.test", "correct horse battery staple"),
      AUTH_BOOTSTRAP_VERSION: "test-bluetooth-settings-1",
      FUEL_SENSOR_INGEST_KEY: randomBytes(32).toString("base64url"),
    };
    const login = await worker.fetch(new Request("http://localhost/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://localhost" },
      body: JSON.stringify({ email: "master@example.test", password: "correct horse battery staple" }),
    }), env, executionContext);
    const cookie = (login.headers.get("set-cookie") ?? "").split(";", 1)[0];
    const updated = await worker.fetch(new Request("http://localhost/api/system-settings/bluetooth", {
      method: "PUT",
      headers: { cookie, origin: "http://localhost", "content-type": "application/json" },
      body: JSON.stringify({ rssiThreshold: -64 }),
    }), env, executionContext);
    assert.equal(updated.status, 200);
    const changed = (await updated.json()).settings;
    assert.equal(changed.rssiThreshold, -64);
    assert.equal(changed.revision, 2);

    const edgeHeaders = { "content-type": "application/json", "x-edge-sensor-key": env.FUEL_SENSOR_INGEST_KEY };
    const current = await worker.fetch(new Request("http://localhost/api/system-settings/bluetooth/current", {
      method: "POST", headers: edgeHeaders, body: "{}",
    }), env, executionContext);
    assert.equal((await current.json()).settings.rssiThreshold, -64);
    const applied = await worker.fetch(new Request("http://localhost/api/system-settings/bluetooth/applied", {
      method: "POST", headers: edgeHeaders,
      body: JSON.stringify({ rssiThreshold: -64, revision: 2 }),
    }), env, executionContext);
    assert.equal((await applied.json()).settings.appliedRevision, 2);
    const observed = await worker.fetch(new Request("http://localhost/api/system-settings/bluetooth/observation", {
      method: "POST", headers: edgeHeaders,
      body: JSON.stringify({ moduleId: "equipment-module-7f8da4", rssi: -61 }),
    }), env, executionContext);
    assert.equal((await observed.json()).settings.lastObservedRssi, -61);
  } finally {
    delete globalThis.__FUEL_EDGE_LOCAL_DB__;
    database.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("reports the live validator connectivity through the lightweight operational endpoint", async () => {
  const directory = await mkdtemp(join(tmpdir(), "fuel-operational-status-"));
  const database = createLocalD1(join(directory, "web.sqlite3"));
  globalThis.__FUEL_EDGE_LOCAL_DB__ = database;
  try {
    const worker = await loadWorker();
    const env = {
      ...authEnv("master@example.test", "correct horse battery staple"),
      AUTH_BOOTSTRAP_VERSION: "test-operational-status-1",
      FUEL_SENSOR_INGEST_KEY: randomBytes(32).toString("base64url"),
    };
    const login = await worker.fetch(new Request("http://localhost/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://localhost" },
      body: JSON.stringify({ email: "master@example.test", password: "correct horse battery staple" }),
    }), env, executionContext);
    const cookie = (login.headers.get("set-cookie") ?? "").split(";", 1)[0];
    const occurredAt = new Date().toISOString();
    const recorded = await worker.fetch(new Request("http://localhost/api/fuel-history/status", {
      method: "POST",
      headers: { "content-type": "application/json", "x-edge-sensor-key": env.FUEL_SENSOR_INGEST_KEY },
      body: JSON.stringify({ moduleId: "rpi-01", siteId: "fundo-01", state: "locked", relayEnergized: false, validatorOnline: true, nfcReady: true, k24Enabled: true, k24Healthy: true, tankLevelEnabled: true, occurredAt }),
    }), env, executionContext);
    assert.equal(recorded.status, 200);
    const levelAt = new Date().toISOString();
    const level = await worker.fetch(new Request("http://localhost/api/fuel-history/readings", {
      method: "POST",
      headers: { "content-type": "application/json", "x-edge-sensor-key": env.FUEL_SENSOR_INGEST_KEY },
      body: JSON.stringify({ levelLiters: 2500, occurredAt: levelAt, source: "OCIO 0-10 V" }),
    }), env, executionContext);
    assert.equal(level.status, 201);
    const live = await worker.fetch(new Request("http://localhost/api/fuel-history/status", { headers: { cookie } }), env, executionContext);
    assert.equal(live.status, 200);
    const payload = await live.json();
    assert.equal(payload.edge.validatorOnline, true);
    assert.equal(payload.edge.occurredAt, occurredAt);
    assert.equal(payload.sensor.currentLevel, 2500);
    assert.equal(payload.sensor.latestReadingAt, levelAt);
  } finally {
    delete globalThis.__FUEL_EDGE_LOCAL_DB__;
    database.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("runs an administrator-confirmed pump test for the requested time and records its transaction", async () => {
  const directory = await mkdtemp(join(tmpdir(), "fuel-relay-test-"));
  const database = createLocalD1(join(directory, "web.sqlite3"));
  globalThis.__FUEL_EDGE_LOCAL_DB__ = database;
  try {
    const worker = await loadWorker();
    const env = {
      ...authEnv("master@example.test", "correct horse battery staple"),
      AUTH_BOOTSTRAP_VERSION: "test-relay-command-1",
      AUTH_DATA_KEY: randomBytes(32).toString("base64url"),
      FUEL_SENSOR_INGEST_KEY: randomBytes(32).toString("base64url"),
    };
    const login = await worker.fetch(new Request("http://localhost/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://localhost" },
      body: JSON.stringify({ email: "master@example.test", password: "correct horse battery staple" }),
    }), env, executionContext);
    const cookie = (login.headers.get("set-cookie") ?? "").split(";", 1)[0];
    const edgeHeaders = { "content-type": "application/json", "x-edge-sensor-key": env.FUEL_SENSOR_INGEST_KEY };
    await worker.fetch(new Request("http://localhost/api/fuel-history/status", {
      method: "POST", headers: edgeHeaders,
      body: JSON.stringify({ moduleId: "rpi-01", siteId: "fundo-01", state: "locked", relayEnergized: false, validatorOnline: false, nfcReady: false, k24Enabled: true, k24Healthy: true, tankLevelEnabled: true, occurredAt: new Date().toISOString() }),
    }), env, executionContext);

    const wrongPassword = await worker.fetch(new Request("http://localhost/api/relay-test", {
      method: "POST",
      headers: { cookie, origin: "http://localhost", "content-type": "application/json" },
      body: JSON.stringify({ password: "incorrect password", durationSeconds: 25 }),
    }), env, executionContext);
    assert.equal(wrongPassword.status, 401);

    const requested = await worker.fetch(new Request("http://localhost/api/relay-test", {
      method: "POST",
      headers: { cookie, origin: "http://localhost", "content-type": "application/json" },
      body: JSON.stringify({ password: "correct horse battery staple", durationSeconds: 25 }),
    }), env, executionContext);
    assert.equal(requested.status, 202);
    const commandId = (await requested.json()).command.id;

    const rejectedEdge = await worker.fetch(new Request("http://localhost/api/relay-test/commands/next", {
      method: "POST", headers: { "content-type": "application/json", "x-edge-sensor-key": "wrong" }, body: "{}",
    }), env, executionContext);
    assert.equal(rejectedEdge.status, 401);
    const taken = await worker.fetch(new Request("http://localhost/api/relay-test/commands/next", {
      method: "POST", headers: edgeHeaders, body: "{}",
    }), env, executionContext);
    const takenCommand = (await taken.json()).command;
    assert.equal(takenCommand.id, commandId);
    assert.equal(takenCommand.durationSeconds, 25);
    assert.equal(takenCommand.transactionType, "pump_test");
    assert.equal(takenCommand.status, "running");
    const runningVisible = await worker.fetch(new Request(`http://localhost/api/relay-test/${commandId}`, {
      headers: { cookie },
    }), env, executionContext);
    const runningCommand = (await runningVisible.json()).command;
    assert.match(runningCommand.startedAt, /^\d{4}-\d{2}-\d{2}T.*Z$/u);

    const duplicate = await worker.fetch(new Request("http://localhost/api/relay-test", {
      method: "POST",
      headers: { cookie, origin: "http://localhost", "content-type": "application/json" },
      body: JSON.stringify({ password: "correct horse battery staple", durationSeconds: 30 }),
    }), env, executionContext);
    assert.equal(duplicate.status, 409);

    const completed = await worker.fetch(new Request(`http://localhost/api/relay-test/commands/${commandId}/result`, {
      method: "POST", headers: edgeHeaders, body: JSON.stringify({ success: true }),
    }), env, executionContext);
    assert.equal(completed.status, 200);
    assert.equal((await completed.json()).command.status, "completed");
    const visible = await worker.fetch(new Request(`http://localhost/api/relay-test/${commandId}`, {
      headers: { cookie },
    }), env, executionContext);
    assert.equal(visible.status, 200);
    const visibleCommand = (await visible.json()).command;
    assert.equal(visibleCommand.durationSeconds, 25);
    assert.equal(visibleCommand.transactionType, "pump_test");
    const transaction = await database.prepare(`SELECT actor_user_id AS actorId,transaction_type AS transactionType,
      duration_seconds AS durationSeconds,status FROM pump_test_transactions WHERE id=?`).bind(commandId).first();
    assert.equal(transaction.actorId, "usr-master");
    assert.equal(transaction.transactionType, "pump_test");
    assert.equal(transaction.durationSeconds, 25);
    assert.equal(transaction.status, "completed");
    const audit = await database.prepare("SELECT event,metadata FROM web_access_audit WHERE event='pump_test_transaction_completed' ORDER BY id DESC LIMIT 1").first();
    assert.equal(audit.event, "pump_test_transaction_completed");
    assert.equal(JSON.parse(audit.metadata).durationSeconds, 25);

    const supervisorCreated = await worker.fetch(new Request("http://localhost/api/users", {
      method: "POST",
      headers: { cookie, origin: "http://localhost", "content-type": "application/json" },
      body: JSON.stringify({ name: "Supervisor sin prueba", email: "supervisor@example.test", role: "supervisor", permissions: ["view_dashboard"] }),
    }), env, executionContext);
    assert.equal(supervisorCreated.status, 201);
    const supervisor = await supervisorCreated.json();
    await database.prepare("UPDATE web_users SET permissions=? WHERE id=?")
      .bind(JSON.stringify(["view_dashboard", "manage_system"]), supervisor.user.id).run();
    const supervisorLogin = await worker.fetch(new Request("http://localhost/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://localhost" },
      body: JSON.stringify({ email: "supervisor@example.test", password: supervisor.temporaryPassword }),
    }), env, executionContext);
    assert.equal(supervisorLogin.status, 200);
    const supervisorCookie = (supervisorLogin.headers.get("set-cookie") ?? "").split(";", 1)[0];
    const supervisorRejected = await worker.fetch(new Request("http://localhost/api/relay-test", {
      method: "POST",
      headers: { cookie: supervisorCookie, origin: "http://localhost", "content-type": "application/json" },
      body: JSON.stringify({ password: supervisor.temporaryPassword, durationSeconds: 10 }),
    }), env, executionContext);
    assert.equal(supervisorRejected.status, 403);
  } finally {
    delete globalThis.__FUEL_EDGE_LOCAL_DB__;
    database.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("shows the administrator-only pump test with enable time in Sistema", async () => {
  const [page, api, store] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../worker/relay-test-api.ts", import.meta.url), "utf8"),
    readFile(new URL("../worker/relay-test-store.ts", import.meta.url), "utf8"),
  ]);
  assert.match(page, /Probar bomba/i);
  assert.match(page, /Tiempo de habilitación \(segundos\)/i);
  assert.match(page, /Clave de administrador/i);
  assert.match(page, /transactionType: "pump_test"/i);
  assert.match(page, /edge\?\.state === "locked"/i);
  assert.match(page, /Math\.min\(command\.durationSeconds/i);
  assert.match(api, /manage_system/i);
  assert.match(api, /confirmAdministratorPassword/i);
  assert.match(api, /role === "master" \|\| role === "administrator"/i);
  assert.match(api, /x-edge-sensor-key/i);
  assert.match(api, /k24Enabled.*k24Healthy/is);
  assert.match(store, /pump_test_transactions/i);
  assert.match(store, /CHECK\(duration_seconds BETWEEN 5 AND 60\)/i);
  assert.match(store, /UNIQUE INDEX.*one_active/is);
});

test("offers temporary fundo assignment, controlled equipment types and KronTec copyright", async () => {
  const [page, api, store] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../worker/equipment-enrollment-api.ts", import.meta.url), "utf8"),
    readFile(new URL("../worker/equipment-enrollment-store.ts", import.meta.url), "utf8"),
  ]);
  assert.match(page, /Vence en este fundo/i);
  assert.match(page, /<option>Tractor<\/option><option>Trilladora<\/option><option>Camión<\/option><option>Camioneta<\/option><option>Otro<\/option>/i);
  assert.match(page, /label: "Data"/i);
  assert.match(page, /title: "Data"/i);
  assert.doesNotMatch(page, /label: "DATA"|title: "DATA"/);
  assert.match(page, /Revalidar módulo/i);
  assert.match(page, /© 2026 by KronTec/i);
  assert.match(page, /V\.1\.9\.29/i);
  assert.doesNotMatch(page, /⚡/u);
  assert.match(page, /id: "power", label: "Suministro eléctrico"/i);
  assert.match(page, /Control y trazabilidad de petróleo en línea/i);
  assert.doesNotMatch(page, /Conectividad del validador · en vivo|validator-live-state/i);
  assert.match(page, /window\.setInterval\(refresh, 5000\)/i);
  assert.match(page, /modal-form-error/i);
  assert.match(api, /authorization\/resolve/i);
  assert.match(api, /assignmentValidUntil/i);
  assert.match(store, /equipment_revalidated_wifi/i);
  assert.match(store, /valid_until/i);
});

test("authenticates the master account with a private expiring cookie", async () => {
  const worker = await loadWorker();
  const email = "master@example.test";
  const password = "correct horse battery staple";
  const env = authEnv(email, password);

  const rejected = await worker.fetch(new Request("http://localhost/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json", origin: "http://localhost" },
    body: JSON.stringify({ email, password: "incorrect password" }),
  }), env, executionContext);
  assert.equal(rejected.status, 401);
  assert.equal(rejected.headers.get("set-cookie"), null);

  const accepted = await worker.fetch(new Request("http://localhost/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json", origin: "http://localhost" },
    body: JSON.stringify({ email, password }),
  }), env, executionContext);
  assert.equal(accepted.status, 200);
  const setCookie = accepted.headers.get("set-cookie") ?? "";
  assert.match(setCookie, /^fuel_edge_session=/i);
  assert.match(setCookie, /HttpOnly/i);
  assert.match(setCookie, /SameSite=Strict/i);
  assert.doesNotMatch(await accepted.text(), new RegExp(password, "i"));

  const cookie = setCookie.split(";", 1)[0];
  const session = await worker.fetch(new Request("http://localhost/api/auth/session", {
    headers: { cookie },
  }), env, executionContext);
  assert.equal(session.status, 200);
  assert.deepEqual(await session.json(), {
    authenticated: true,
    user: {
      name: "Pedro Coloma",
      role: "Usuario maestro",
      roleCode: "master",
      permissions: ["view_dashboard", "view_transactions", "manage_receipts", "manage_alerts", "manage_operators", "manage_equipment", "manage_associations", "manage_users", "manage_system"],
      mustChangePassword: false,
    },
  });

  const logout = await worker.fetch(new Request("http://localhost/api/auth/logout", {
    method: "POST",
    headers: { cookie, origin: "http://localhost" },
  }), env, executionContext);
  assert.equal(logout.status, 200);
  assert.match(logout.headers.get("set-cookie") ?? "", /Max-Age=0/i);
});

test("enforces user administration and recovery on the server", async () => {
  const source = await Promise.all([
    readFile(new URL("../worker/users-api.ts", import.meta.url), "utf8"),
    readFile(new URL("../worker/user-store.ts", import.meta.url), "utf8"),
    readFile(new URL("../worker/auth.ts", import.meta.url), "utf8"),
  ]).then((files) => files.join("\n"));
  assert.match(source, /includes\("manage_users"\)/i);
  assert.match(source, /must_change_password/i);
  assert.match(source, /AES-GCM/i);
  assert.match(source, /master_password_recovered/i);
  assert.match(source, /password_reset_by_admin/i);
});

test("keeps production credentials out of browser-delivered source", async () => {
  const source = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../worker/auth.ts", import.meta.url), "utf8"),
  ]).then((files) => files.join("\n"));
  assert.doesNotMatch(source, /Krontec_admin|pedro\.coloma@krontec\.cl/i);
  assert.doesNotMatch(source, /María Fernández|Ricardo Silva|Soporte técnico/i);
});
