import assert from "node:assert/strict";
import test from "node:test";
import { createHmac, pbkdf2Sync, randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ts from "typescript";
import { createLocalD1 } from "../runtime/local-d1.mjs";

const source = await readFile(new URL("../shared/machine-fuel-history.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext } }).outputText;
const { rankMachines, machineCategory } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`);

test("ranking keeps equipment identities, sorts naturally, handles ties and recalculates filtered shares", () => {
  const machine = (id, name, kind, liters) => ({ equipmentId: id, name, kind, liters, loads: 2, lastAt: "2026-09-08T12:00:00Z" });
  const rows = [machine("a", "T195", "Tractor", 100), machine("b", "C2", "Camioneta", 200), machine("c", "T195", "Tractor", 100), machine("d", "C10", "Camioneta", 200)];
  const ranking = rankMachines(rows);
  assert.deepEqual(ranking.map((row) => row.equipmentId), ["b", "d", "a", "c"]);
  assert.deepEqual(ranking.map((row) => row.rank), [1, 1, 3, 3]);
  assert.deepEqual(rankMachines(rows, "Tractor").map((row) => [row.rank, row.share]), [[1, 50], [1, 50]]);
  assert.equal(rankMachines(rows, "all", " c10 ")[0].share, 100);
  assert.equal(rankMachines(rows, "Tractor", "c10").length, 0);
  assert.equal(rankMachines(rows, "all", "missing").length, 0);
  assert.equal(machineCategory("Trilladora"), machineCategory("Cosechadora"));
  assert.equal(machineCategory("Camión"), "Camión");
  assert.equal(machineCategory("Camioneta"), "Camioneta");
  assert.equal(machineCategory("Generador"), "Otro");
  assert.deepEqual(rankMachines([]), []);
});

test("machine history uses full historical volume, preserves archived/missing machines, and paginates auditable loads", async () => {
  const dir = await mkdtemp(join(tmpdir(), "machine-fuel-history-"));
  const db = createLocalD1(join(dir, "db.sqlite3"));
  globalThis.__FUEL_EDGE_LOCAL_DB__ = db;
  try {
    const worker = (await import(`../dist/server/index.js?machines=${Date.now()}`)).default;
    const context = { waitUntil() {}, passThroughOnException() {} };
    const email = "machine-history@example.test", password = "machine history test password";
    const pepper = randomBytes(32), salt = randomBytes(16);
    const env = {
      AUTH_ADMIN_EMAIL_DIGEST: createHmac("sha256", pepper).update(email).digest("base64url"),
      AUTH_ADMIN_PASSWORD_HASH: `pbkdf2_sha256$310000$${salt.toString("base64url")}$${pbkdf2Sync(password, salt, 310000, 32, "sha256").toString("base64url")}`,
      AUTH_EMAIL_PEPPER: pepper.toString("base64url"), AUTH_SESSION_SECRET: randomBytes(32).toString("base64url"),
      AUTH_BOOTSTRAP_VERSION: "machine-history-tests", AUTH_DATA_KEY: randomBytes(32).toString("base64url"),
    };
    const login = await worker.fetch(new Request("http://localhost/api/auth/login", { method: "POST", headers: { "content-type": "application/json", origin: "http://localhost" }, body: JSON.stringify({ email, password }) }), env, context);
    assert.equal(login.status, 200);
    const cookie = login.headers.get("set-cookie").split(";", 1)[0];
    const get = (path, authenticated = true) => worker.fetch(new Request(`http://localhost${path}`, { headers: authenticated ? { cookie } : {} }), env, context);
    const path = "/api/fuel-history/machines?from=2026-09-08&to=2026-09-08";
    assert.equal((await get(path, false)).status, 403);
    assert.deepEqual(await (await get(path)).json(), { machines: [], unassigned: null });
    assert.equal((await get("/api/fuel-history/machines?from=2026-09-09&to=2026-09-08")).status, 400);
    await db.prepare(`INSERT INTO managed_equipment(id,name,kind,condition,module,archived_at) VALUES
      ('tractor-1','T195','Tractor','Permanente','m1','2026-09-08'),
      ('tractor-2','T195','Tractor','Temporal','m2',NULL),
      ('pickup','P12','Camioneta','Permanente','m3',NULL)`).run();
    await db.prepare(`INSERT INTO managed_operators(id,name,rut,credential) VALUES ('op1','Operador secundario','test','rfid-test')`).run();
    const insert = (id, liters, equipmentId, extra = {}) => db.prepare(`INSERT INTO fuel_movements
      (id,movement_type,classification,occurred_at,liters,opening_level_liters,closing_level_liters,source,reference_id,equipment_id,operator_id,review_status,detection_status)
      VALUES (?,?,?,?,?,2000,1900,'K24',?,?,? ,?,?)`).bind(id, extra.type ?? "dispatch", extra.classification ?? "standard", extra.at ?? "2026-09-08T15:00:00.000Z", liters, `ref-${id}`, equipmentId, "op1", extra.review ?? "not_required", extra.status ?? "confirmed");
    await db.batch([
      insert("t1", 100.04, "tractor-1"), insert("t2", 50.04, "tractor-1"), insert("t3", 80, "tractor-2"),
      insert("missing", 20, "removed-machine"), insert("unassigned", 30, null), insert("blank", 10, ""),
      insert("receipt", 999, "tractor-1", { type: "receipt" }),
      insert("enablement", 0.1, "tractor-1", { classification: "pump_enablement" }),
      insert("zero", 0, "tractor-1"), insert("rejected", 999, "tractor-1", { review: "rejected" }),
      insert("pending", 999, "tractor-1", { review: "pending" }), insert("accumulating", 999, "tractor-1", { status: "accumulating" }),
      // Chile is UTC-3: the selected day starts at 03:00 UTC and ends at the next 03:00.
      insert("before", 999, "tractor-1", { at: "2026-09-08T02:59:59.999Z" }),
      insert("start", 5, "tractor-1", { at: "2026-09-08T03:00:00.000Z" }),
      insert("end", 5, "tractor-1", { at: "2026-09-09T02:59:59.999Z" }),
      insert("after", 999, "tractor-1", { at: "2026-09-09T03:00:00.000Z" }),
      ...Array.from({ length: 5001 }, (_, index) => insert(`pickup-${String(index).padStart(5, "0")}`, 0.2, "pickup")),
    ]);
    const result = await (await get(path)).json();
    assert.equal(result.machines.length, 4);
    assert.equal(result.machines[0].equipmentId, "pickup");
    assert.equal(result.machines[0].loads, 5001);
    assert.ok(Math.abs(result.machines[0].liters - 1000.2) < 1e-8);
    const tractor = result.machines.find((row) => row.equipmentId === "tractor-1");
    assert.equal(tractor.name, "T195"); assert.equal(tractor.kind, "Tractor");
    assert.equal(tractor.loads, 4); assert.ok(Math.abs(tractor.liters - 160.08) < 1e-8);
    assert.equal(result.machines.find((row) => row.equipmentId === "removed-machine").name, "removed-machine");
    assert.equal(result.unassigned.liters, 40); assert.equal(result.unassigned.loads, 2);
    const nativeExport = await get("/api/data-export?dataset=machine-liters");
    assert.equal(nativeExport.status, 200);
    const csv = await nativeExport.text();
    assert.match(csv, /"pickup","P12","Camioneta","1000.2","5001"/);
    assert.match(csv, /"tractor-1","T195","Tractor","2158.1","6"/);
    assert.match(csv, /"","Sin máquina identificada","Otro","40.0","2"/);
    assert.match(csv, /"removed-machine","removed-machine"/);
    const detailPath = "/api/fuel-history/machines/loads?from=2026-09-08&to=2026-09-08";
    assert.equal((await get(`${detailPath}&equipmentId=pickup`, false)).status, 403);
    for (const query of ["", "&equipmentId=pickup&page=-1", "&equipmentId=pickup&page=1.5", "&equipmentId=pickup&page=NaN"]) assert.equal((await get(detailPath + query)).status, 400);
    const page1 = await (await get(`${detailPath}&equipmentId=pickup`)).json();
    const page2 = await (await get(`${detailPath}&equipmentId=pickup&page=2`)).json();
    assert.equal(page1.total, 5001); assert.equal(page1.movements.length, 25);
    assert.equal(page2.movements.length, 25);
    assert.ok(page1.movements.every((row) => !page2.movements.some((other) => row.id === other.id)));
    assert.equal(page1.movements[0].operator, "Operador secundario");
    assert.equal(page1.movements[0].source, "K24");
    const unknown = await (await get(`${detailPath}&equipmentId=`)).json();
    assert.equal(unknown.total, 2);
    const tractorLoads = await (await get(`${detailPath}&equipmentId=tractor-1`)).json();
    assert.equal(tractorLoads.total, tractor.loads);
    assert.ok(Math.abs(tractorLoads.movements.reduce((sum, row) => sum + row.liters, 0) - tractor.liters) < 1e-8);
    const injection = await (await get(`${detailPath}&equipmentId=${encodeURIComponent("' OR 1=1 --")}`)).json();
    assert.equal(injection.total, 0);
  } finally { delete globalThis.__FUEL_EDGE_LOCAL_DB__; db.close(); await rm(dir, { recursive: true, force: true }); }
});
