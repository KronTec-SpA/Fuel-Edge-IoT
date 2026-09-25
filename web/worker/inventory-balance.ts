import { authenticatedUser, json, type AuthEnvironment } from "./auth";
import { edgeSensorSecret, sensorKeyMatches } from "./fuel-history-api";
import { ensureFuelHistoryStore } from "./fuel-history-store";
import { ensureAlertsStore } from "./alerts-store";
import { parsePermissions, type D1DatabaseLike } from "./user-store";
import { readJsonBody, RequestBodyError } from "./request-body";
import { ensureManagedEntityStore } from "./managed-entities-store";
import { ocioCalibrationRow } from "./ocio-calibration";
import { comparisonUncertainty } from "../shared/inventory-uncertainty";
import { ensureDetectionStore, recordInventoryDetection, inventoryDetectionSummary } from "./inventory-detection";

type Bounds = { minLiters: number; maxLiters: number };
type Anchor = { id: string; levelLiters: number; levelRange?: Bounds; pulses: number; occurredAt: string;
  calibrationId: string; capacityLiters: number; pulsesPerLiter: number };
export type Sample = { id: string; siteId: string; anchor: Anchor; occurredAt: string;
  measuredLiters: number; measuredRange?: Bounds; pulsesTotal: number; calibrationId: string;
  pulsesPerLiter: number; meterHealthy: boolean };
export type Receipt = { id: string; occurredAt: string; liters: number; reviewStatus: string };
type Environment = AuthEnvironment & { FUEL_SENSOR_INGEST_KEY?: string; FUEL_SITE_ID?: string };

class InvalidSample extends Error {}

const ready = new WeakMap<object, Promise<void>>();
export async function ensureInventoryBalanceStore(db: D1DatabaseLike) {
  const existing = ready.get(db);
  if (existing) return existing;
  const pending = (async () => {
  await db.batch([
    db.prepare(`CREATE TABLE IF NOT EXISTS inventory_balance_anchors (
      id TEXT PRIMARY KEY,site_id TEXT NOT NULL UNIQUE,payload TEXT NOT NULL,
      original_site_id TEXT,archived_at TEXT)`),
    db.prepare(`CREATE TABLE IF NOT EXISTS inventory_balance_samples (
      id TEXT PRIMARY KEY,anchor_id TEXT NOT NULL,occurred_at TEXT NOT NULL,
      local_date TEXT NOT NULL,payload TEXT NOT NULL,
      FOREIGN KEY(anchor_id) REFERENCES inventory_balance_anchors(id))`),
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_inventory_balance_time
      ON inventory_balance_samples(anchor_id,occurred_at)`),
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_inventory_balance_day
      ON inventory_balance_samples(anchor_id,local_date,occurred_at)`),
    db.prepare(`CREATE TABLE IF NOT EXISTS inventory_balance_alarm_state (
      anchor_id TEXT PRIMARY KEY,episode INTEGER NOT NULL DEFAULT 0,
      sign INTEGER NOT NULL DEFAULT 0,tier INTEGER NOT NULL DEFAULT 0,
      last_seen_at TEXT NOT NULL DEFAULT '',
      FOREIGN KEY(anchor_id) REFERENCES inventory_balance_anchors(id))`),
  ]);
  const columns = await db.prepare("PRAGMA table_info(inventory_balance_anchors)").all<{name:string}>();
  for (const name of ["original_site_id","archived_at"]) {
    if (!columns.results.some(c=>c.name===name)) await db.prepare(`ALTER TABLE inventory_balance_anchors ADD COLUMN ${name} TEXT`).run();
  }
  await ensureDetectionStore(db);
  })().catch(error => { ready.delete(db); throw error; });
  ready.set(db,pending);
  return pending;
}

function validId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u.test(value);
}
function finite(value: unknown, min: number, max = Number.MAX_SAFE_INTEGER): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= min && value <= max;
}
function date(value: unknown): string {
  if (typeof value !== "string" || !/(Z|[+-]\d{2}:\d{2})$/u.test(value)) throw new InvalidSample("Fecha sin zona horaria.");
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.getTime() <= 0 || parsed.getTime() > Date.now() + 300_000) throw new InvalidSample("Fecha inválida.");
  return parsed.toISOString();
}
function rangeInput(value: unknown, center: number, capacity: number): Bounds | undefined {
  if (value === undefined) return undefined;
  const r = value as Partial<Bounds> | null;
  if (!r || !finite(r.minLiters, 0, center) || !finite(r.maxLiters, center, capacity)) throw new InvalidSample("Intervalo inválido.");
  return {minLiters: r.minLiters, maxLiters: r.maxLiters};
}
function sampleInput(body: Record<string, unknown>): Sample {
  const a = body.anchor as Partial<Anchor> | undefined;
  if (!a || !validId(a.id) || !validId(body.id) || !validId(body.siteId)
    || !finite(a.capacityLiters, 1) || !finite(a.levelLiters, 0, a.capacityLiters)
    || !Number.isSafeInteger(a.pulses) || !finite(a.pulses, 0)
    || !Number.isSafeInteger(body.pulsesTotal) || !finite(body.pulsesTotal, 0)
    || !finite(a.pulsesPerLiter, 0.000001) || !finite(body.pulsesPerLiter, 0.000001)
    || !finite(body.measuredLiters, 0, a.capacityLiters)
    || typeof a.calibrationId !== "string" || a.calibrationId.length > 1000
    || typeof body.calibrationId !== "string" || body.calibrationId.length > 1000
    || typeof body.meterHealthy !== "boolean") throw new InvalidSample("Muestra de cuadratura inválida.");
  const occurredAt = date(body.occurredAt), anchorAt = date(a.occurredAt);
  const anchorRange = rangeInput(a.levelRange, a.levelLiters, a.capacityLiters);
  const measuredRange = rangeInput(body.measuredRange, body.measuredLiters, a.capacityLiters);
  if (occurredAt < anchorAt) throw new InvalidSample("La muestra precede al inventario inicial.");
  return { id: body.id, siteId: body.siteId, occurredAt,
    anchor: { id: a.id, levelLiters: a.levelLiters, pulses: a.pulses, occurredAt: anchorAt,
      calibrationId: a.calibrationId, capacityLiters: a.capacityLiters, pulsesPerLiter: a.pulsesPerLiter,
      ...(anchorRange ? {levelRange: anchorRange} : {}) },
    measuredLiters: body.measuredLiters, pulsesTotal: body.pulsesTotal,
    calibrationId: body.calibrationId, pulsesPerLiter: body.pulsesPerLiter,
    meterHealthy: body.meterHealthy, ...(measuredRange ? {measuredRange} : {}) };
}

export async function ingestInventorySample(db: D1DatabaseLike, body: Record<string, unknown>) {
  const sample = sampleInput(body);
  const calibration = await ocioCalibrationRow(db,sample.siteId);
  if (calibration.confirmation_id && calibration.applied_revision === calibration.revision) {
    let confirmation:unknown;
    try { confirmation = JSON.parse(sample.calibrationId).confirmationId; } catch { /* legacy evidence */ }
    if (confirmation !== calibration.confirmation_id || sample.anchor.calibrationId !== sample.calibrationId)
      throw new InvalidSample("Muestra de una calibración anterior; no puede sustituir la referencia vigente.");
  }
  const existing = await db.prepare("SELECT id,payload FROM inventory_balance_anchors WHERE site_id=?")
    .bind(sample.siteId).first<{ id: string; payload: string }>();
  const anchorPayload = JSON.stringify(sample.anchor);
  if (existing && (existing.id !== sample.anchor.id || existing.payload !== anchorPayload)) {
    throw new InvalidSample("La referencia contable no puede cambiar automáticamente. Requiere conciliación auditada.");
  }
  const previous = await db.prepare("SELECT payload FROM inventory_balance_samples WHERE id=?")
    .bind(sample.id).first<{ payload: string }>();
  const payload = JSON.stringify(sample);
  if (previous && previous.payload !== payload) throw new InvalidSample("La muestra ya existe con otra evidencia.");
  const localDate = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Santiago",
    year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(sample.occurredAt));
  await db.batch([
    db.prepare("INSERT OR IGNORE INTO inventory_balance_anchors(id,site_id,payload) VALUES (?,?,?)")
      .bind(sample.anchor.id, sample.siteId, anchorPayload),
    db.prepare(`INSERT OR IGNORE INTO inventory_balance_samples(id,anchor_id,occurred_at,local_date,payload)
      VALUES (?,?,?,?,?)`).bind(sample.id, sample.anchor.id, sample.occurredAt, localDate, payload),
    db.prepare("INSERT OR IGNORE INTO inventory_balance_alarm_state(anchor_id) VALUES (?)").bind(sample.anchor.id),
  ]);
  const receipts = await db.prepare(`SELECT id,occurred_at AS occurredAt,liters,review_status AS reviewStatus
    FROM fuel_movements WHERE movement_type='receipt' AND occurred_at>? AND occurred_at<=? ORDER BY occurred_at LIMIT 10001`)
    .bind(sample.anchor.occurredAt,sample.occurredAt).all<Receipt>();
  if(receipts.results.length>10000)throw new Error("Demasiadas recepciones para verificar inventario.");
  await recordInventoryDetection(db,sample,receipts.results);
  return inventoryBalance(db, sample.siteId);
}

function calculate(sample: Sample, receipts: Receipt[], highestPulses = sample.anchor.pulses) {
  const applicable = receipts.filter(r => r.occurredAt > sample.anchor.occurredAt && r.occurredAt <= sample.occurredAt);
  const approved = applicable.filter(r => ["approved", "corrected"].includes(r.reviewStatus));
  const pendingReceipts = applicable.filter(r => r.reviewStatus === "pending").length;
  const receivedLiters = approved.reduce((s,r) => s + r.liters, 0);
  const compatible = sample.calibrationId === sample.anchor.calibrationId
    && sample.pulsesPerLiter === sample.anchor.pulsesPerLiter
    && sample.pulsesTotal >= Math.max(sample.anchor.pulses, highestPulses) && sample.meterHealthy;
  const meteredLiters = compatible ? (sample.pulsesTotal-sample.anchor.pulses)/sample.anchor.pulsesPerLiter : null;
  const expectedLiters = meteredLiters === null ? null : sample.anchor.levelLiters + receivedLiters - meteredLiters;
  const initialRange = sample.anchor.levelRange ?? {minLiters: sample.anchor.levelLiters, maxLiters: sample.anchor.levelLiters};
  const measuredRange = sample.measuredRange ?? {minLiters: sample.measuredLiters, maxLiters: sample.measuredLiters};
  const expectedRange = meteredLiters === null ? null : {minLiters: initialRange.minLiters+receivedLiters-meteredLiters, maxLiters: initialRange.maxLiters+receivedLiters-meteredLiters};
  const observedDifferenceRange = expectedRange === null ? null : {
    minLiters: Math.round((expectedRange.minLiters-measuredRange.maxLiters)*1000)/1000,
    maxLiters: Math.round((expectedRange.maxLiters-measuredRange.minLiters)*1000)/1000,
  };
  const uncertainty=meteredLiters===null?null:comparisonUncertainty(sample.calibrationId,initialRange,measuredRange,meteredLiters,receivedLiters);
  const differenceRange=uncertainty?.differenceBounds??observedDifferenceRange;
  const differenceLiters = differenceRange?.minLiters === differenceRange?.maxLiters ? differenceRange?.minLiters ?? null : null;
  const lower = differenceRange?.minLiters ?? 0, upper = differenceRange?.maxLiters ?? 0;
  const status = !compatible ? "unverifiable" : lower >= 20 ? "suspected_loss"
    : pendingReceipts ? "pending_receipts" : upper <= -20 ? "unverified_increase"
      : uncertainty && lower<=10 && upper>=-10 ? "within_uncertainty"
        : lower >= -10 && upper <= 10 ? "within_band" : differenceLiters === null ? "range_uncertainty" : "watch";
  return { sampleId: sample.id, occurredAt: sample.occurredAt,
    initialLiters: sample.anchor.levelLiters, receivedLiters, meteredLiters,
    expectedLiters, measuredLiters: sample.measuredLiters, differenceLiters,
    initialRange, expectedRange, measuredRange, differenceRange, observedDifferenceRange, uncertainty,
    observedDifferenceLiters:expectedLiters===null?null:Math.round((expectedLiters-sample.measuredLiters)*1000)/1000,
    pendingReceipts, status, receiptIds: approved.map(r => r.id) };
}

export async function inventoryBalance(db: D1DatabaseLike, siteId?: string) {
  const anchorRow = siteId
    ? await db.prepare("SELECT id,payload,site_id AS siteId FROM inventory_balance_anchors WHERE site_id=?").bind(siteId)
      .first<{ id: string; payload: string; siteId: string }>()
    : await db.prepare("SELECT id,payload,site_id AS siteId FROM inventory_balance_anchors ORDER BY rowid DESC LIMIT 1")
      .first<{ id: string; payload: string; siteId: string }>();
  if (!anchorRow) return { anchor: null, latest: null, daily: [] };
  const anchor = JSON.parse(anchorRow.payload) as Anchor;
  const last = await db.prepare("SELECT payload FROM inventory_balance_samples WHERE anchor_id=? ORDER BY occurred_at DESC,id DESC LIMIT 1")
    .bind(anchor.id).first<{ payload: string }>();
  if (!last) return { anchor, latest: null, daily: [] };
  const sample = JSON.parse(last.payload) as Sample;
  const rows = await db.prepare(`SELECT id,occurred_at AS occurredAt,liters,review_status AS reviewStatus
    FROM fuel_movements WHERE movement_type='receipt' AND occurred_at>? AND occurred_at<=?
    ORDER BY occurred_at LIMIT 10001`).bind(anchor.occurredAt, sample.occurredAt).all<Receipt>();
  if (rows.results.length > 10000) throw new Error("La cuadratura excede el límite de recepciones; requiere consolidación auditada.");
  const counter = await db.prepare(`SELECT MAX(CAST(json_extract(payload,'$.pulsesTotal') AS INTEGER)) AS highest
    FROM inventory_balance_samples WHERE anchor_id=? AND occurred_at<=?`)
    .bind(anchor.id, sample.occurredAt).first<{ highest: number }>();
  const latest = calculate(sample, rows.results, counter?.highest);
  const detection = await inventoryDetectionSummary(db,anchor.id,anchorRow.siteId);
  const days = await db.prepare(`SELECT local_date AS day,payload,highest FROM (
    SELECT local_date,payload,
    MAX(CAST(json_extract(payload,'$.pulsesTotal') AS INTEGER)) OVER(ORDER BY occurred_at,id ROWS UNBOUNDED PRECEDING) AS highest,
    ROW_NUMBER() OVER(PARTITION BY local_date ORDER BY occurred_at DESC,id DESC) AS rn
    FROM inventory_balance_samples WHERE anchor_id=?) WHERE rn=1 ORDER BY local_date DESC LIMIT 31`)
    .bind(anchor.id).all<{ day: string; payload: string; highest: number }>();
  return { anchor, siteId: anchorRow.siteId, latest, detection,
    daily: days.results.reverse().map(r => ({ day: r.day, ...calculate(JSON.parse(r.payload), rows.results, r.highest) })) };
}

export async function handleInventoryBalanceRequest(request: Request, env: Environment): Promise<Response | null> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith("/api/inventory-balance")) return null;
  if (!env.DB) return json({ error: "Base local no disponible." }, 503);
  await ensureManagedEntityStore(env.DB);
  await ensureFuelHistoryStore(env.DB);
  await ensureAlertsStore(env.DB);
  await ensureInventoryBalanceStore(env.DB);
  if (url.pathname === "/api/inventory-balance/health" && request.method === "POST") {
    if (!await sensorKeyMatches(request.headers.get("x-edge-sensor-key"), edgeSensorSecret(env))) return json({error:"Controlador no autorizado."},403);
    try {
      const body=await readJsonBody(request,8192) as Record<string,unknown>;
      if(!validId(body.siteId) || (env.FUEL_SITE_ID && body.siteId!==env.FUEL_SITE_ID)
        || body.policyId!=="inventory-evidence-v2" || typeof body.incident!=="object" || !body.incident)
        throw new InvalidSample("Estado de medición inválido.");
      const at=date(body.occurredAt);
      await env.DB.prepare(`INSERT INTO inventory_measurement_health(site_id,occurred_at,payload) VALUES (?,?,?)
        ON CONFLICT(site_id) DO UPDATE SET occurred_at=excluded.occurred_at,payload=excluded.payload
        WHERE excluded.occurred_at>inventory_measurement_health.occurred_at`)
        .bind(body.siteId,at,JSON.stringify({...body,occurredAt:at})).run();
      return json({updated:true},201);
    } catch(error) {
      if(error instanceof RequestBodyError)return json({error:error.message},error.status);
      if(error instanceof InvalidSample)return json({error:error.message},400);
      return json({error:"Estado técnico pendiente de sincronización."},503);
    }
  }
  if (url.pathname === "/api/inventory-balance/edge" && request.method === "POST") {
    if (!await sensorKeyMatches(request.headers.get("x-edge-sensor-key"), edgeSensorSecret(env))) return json({ error: "Controlador no autorizado." }, 403);
    try {
      const body = await readJsonBody(request, 8192) as Record<string, unknown>;
      if (!body || typeof body !== "object" || Array.isArray(body)) throw new InvalidSample("Muestra inválida.");
      if (env.FUEL_SITE_ID && body.siteId !== env.FUEL_SITE_ID) throw new InvalidSample("Fundo incorrecto.");
      return json(await ingestInventorySample(env.DB, body), 201);
    } catch (error) {
      if (error instanceof RequestBodyError) return json({ error: error.message }, error.status);
      if (error instanceof InvalidSample) return json({ error: error.message }, 400);
      return json({ error: "No se pudo completar la cuadratura; el controlador debe reintentar." }, 503);
    }
  }
  if (url.pathname === "/api/inventory-balance" && request.method === "GET") {
    const actor = await authenticatedUser(request, env);
    if (!actor || !parsePermissions(actor.permissions).includes("view_dashboard")) return json({ error: "Acceso no autorizado." }, 403);
    try { return json(await inventoryBalance(env.DB, env.FUEL_SITE_ID), 200); }
    catch { return json({ error: "Cuadratura pendiente de verificación." }, 503); }
  }
  return json({ error: "Ruta no encontrada." }, 404);
}
