import { authenticatedUser, json, sameOrigin, type AuthEnvironment } from "./auth";
import { edgeSensorSecret, sensorKeyMatches } from "./fuel-history-api";
import { parsePermissions, type D1DatabaseLike } from "./user-store";
import { readJsonBody, RequestBodyError } from "./request-body";
import { ensureInventoryBalanceStore } from "./inventory-balance";

const initializing = new WeakMap<object, Promise<void>>();
export function ensureOcioCalibrationStore(db: D1DatabaseLike) {
  let pending = initializing.get(db);
  if (!pending) {
    pending = db.batch([
      db.prepare(`CREATE TABLE IF NOT EXISTS ocio_calibration_settings (
        site_id TEXT PRIMARY KEY, interval_days INTEGER NOT NULL DEFAULT 365,
        revision INTEGER NOT NULL DEFAULT 0, confirmation_id TEXT,
        calibrated_at TEXT, calibrated_by TEXT, calibrated_by_name TEXT, next_due_at TEXT,
        fingerprint TEXT, applied_revision INTEGER NOT NULL DEFAULT 0, applied_at TEXT,
        controller_fingerprint TEXT, controller_seen_at TEXT, controller_session_id TEXT,
        controller_pending INTEGER)`),
      db.prepare(`CREATE TABLE IF NOT EXISTS ocio_calibration_events (
        id TEXT PRIMARY KEY, site_id TEXT NOT NULL, kind TEXT NOT NULL,
        revision INTEGER NOT NULL, occurred_at TEXT NOT NULL, actor_id TEXT NOT NULL,
        actor_name TEXT NOT NULL, interval_days INTEGER NOT NULL, next_due_at TEXT,
        fingerprint TEXT, applied_at TEXT)`),
      db.prepare("CREATE INDEX IF NOT EXISTS idx_ocio_calibration_events_site ON ocio_calibration_events(site_id,occurred_at)"),
    ]).then(() => undefined).catch(error => { initializing.delete(db); throw error; });
    initializing.set(db, pending);
  }
  return pending;
}

type Row = {site_id:string;interval_days:number;revision:number;confirmation_id:string|null;
  calibrated_at:string|null;calibrated_by_name:string|null;next_due_at:string|null;fingerprint:string|null;
  applied_revision:number;applied_at:string|null;controller_fingerprint:string|null;
  controller_seen_at:string|null;controller_pending:number|null};

export async function ocioCalibrationRow(db: D1DatabaseLike, siteId: string) {
  await ensureOcioCalibrationStore(db);
  await db.prepare("INSERT OR IGNORE INTO ocio_calibration_settings(site_id) VALUES (?)").bind(siteId).run();
  return (await db.prepare("SELECT * FROM ocio_calibration_settings WHERE site_id=?").bind(siteId).first<Row>())!;
}

async function dashboard(db: D1DatabaseLike, siteId: string) {
  const row = await ocioCalibrationRow(db,siteId);
  const history = await db.prepare(`SELECT id,kind,revision,occurred_at AS occurredAt,actor_name AS actorName,
    interval_days AS intervalDays,next_due_at AS nextDueAt,applied_at AS appliedAt
    FROM ocio_calibration_events WHERE site_id=? ORDER BY occurred_at DESC,id DESC LIMIT 12`).bind(siteId).all();
  const changed = Boolean(row.fingerprint && row.controller_fingerprint && row.fingerprint !== row.controller_fingerprint);
  return {intervalDays:row.interval_days,revision:row.revision,confirmationId:row.confirmation_id,
    calibratedAt:row.calibrated_at,calibratedBy:row.calibrated_by_name,nextDueAt:row.next_due_at,
    appliedAt:row.applied_at,controllerSeenAt:row.controller_seen_at,
    controllerAvailable:Boolean(row.controller_fingerprint),
    status: changed ? "configuration_changed" : !row.confirmation_id ? "uncalibrated"
      : row.applied_revision !== row.revision ? "awaiting_plc" : "calibrated",
    history:history.results};
}

const validDays = (n: unknown): n is number => typeof n === "number" && Number.isInteger(n) && n >= 1 && n <= 730;
const validFingerprint = (v:unknown): v is string => typeof v === "string" && /^level-[a-f0-9]{64}$/.test(v);
const validId = (v:unknown): v is string => typeof v === "string" && /^[a-zA-Z0-9][a-zA-Z0-9:._-]{0,159}$/.test(v);
const due = (at:string|null, days:number) => at ? new Date(Date.parse(at)+days*86400000).toISOString() : null;
const pendingGuard = `site_id=? AND confirmation_id=? AND revision=? AND fingerprint=? AND applied_revision<revision`;

async function requestBody(request:Request) {
  const body = await readJsonBody<unknown>(request,4096);
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new RequestBodyError("Solicitud inválida.",400);
  return body as Record<string,unknown>;
}

export async function handleOcioCalibrationRequest(request:Request, env:AuthEnvironment & {FUEL_SENSOR_INGEST_KEY?:string;FUEL_SITE_ID?:string}):Promise<Response|null> {
  const path = new URL(request.url).pathname;
  const root = "/api/system-settings/ocio-calibration";
  if (![root,root+"/current",root+"/applied",root+"/confirm"].includes(path)) return null;
  if (!env.DB) return json({error:"Base local no disponible."},503);
  const db = env.DB, siteId = env.FUEL_SITE_ID?.trim() || "concha-y-toro-piloto";
  try {
    if (path.endsWith("/current") || path.endsWith("/applied")) {
      if (request.method !== "POST" || !await sensorKeyMatches(request.headers.get("x-edge-sensor-key"),edgeSensorSecret(env))) return json({error:"PLC no autorizado."},403);
      const body = await requestBody(request);
      if (!validFingerprint(body.fingerprint) || body.siteId !== siteId) return json({error:"Configuración OCIO inválida."},400);
      const row = await ocioCalibrationRow(db,siteId);
      if (path.endsWith("/current")) {
        if (typeof body.pending !== "boolean" || !validId(body.telemetrySessionId)) return json({error:"Estado PLC inválido."},400);
        await db.prepare(`UPDATE ocio_calibration_settings SET controller_fingerprint=?,controller_seen_at=?,
          controller_session_id=?,controller_pending=? WHERE site_id=?`).bind(body.fingerprint,new Date().toISOString(),body.telemetrySessionId,Number(body.pending),siteId).run();
        const command = row.confirmation_id && row.fingerprint === body.fingerprint ? {
          confirmationId:row.confirmation_id,revision:row.revision,fingerprint:row.fingerprint,calibratedAt:row.calibrated_at,
        } : null;
        return json({command},200);
      }
      if (!validId(body.confirmationId) || !Number.isInteger(body.revision)
        || body.confirmationId !== row.confirmation_id || body.revision !== row.revision || body.fingerprint !== row.fingerprint) return json({error:"La confirmación ya no corresponde a la configuración vigente."},409);
      const at = typeof body.appliedAt === "string" ? new Date(body.appliedAt) : new Date(NaN);
      if (!Number.isFinite(at.getTime()) || at.getTime()<Date.parse(row.calibrated_at!) || at.getTime()>Date.now()+300000) return json({error:"Fecha de aplicación inválida."},400);
      await ensureInventoryBalanceStore(db);
      const args = [siteId,body.confirmationId,body.revision,body.fingerprint];
      // Mantener filas y claves foráneas del ciclo anterior; liberar sólo su
      // posición como referencia vigente. original_site_id conserva el fundo.
      await db.batch([
        db.prepare(`UPDATE inventory_balance_anchors SET original_site_id=site_id,
          site_id='archived:'||id,archived_at=? WHERE site_id=? AND EXISTS
          (SELECT 1 FROM ocio_calibration_settings WHERE ${pendingGuard})`).bind(at.toISOString(),siteId,...args),
        db.prepare(`UPDATE ocio_calibration_events SET applied_at=? WHERE id=? AND EXISTS
          (SELECT 1 FROM ocio_calibration_settings WHERE ${pendingGuard})`).bind(at.toISOString(),body.confirmationId,...args),
        db.prepare(`UPDATE ocio_calibration_settings SET applied_revision=revision,applied_at=?,controller_pending=0
          WHERE ${pendingGuard}`).bind(at.toISOString(),...args),
      ]);
      return json({calibration:await dashboard(db,siteId)},200);
    }
    const actor = await authenticatedUser(request,env);
    const permissions = actor ? parsePermissions(actor.permissions) : [];
    if (!actor || !permissions.includes("view_dashboard")) return json({error:"No tienes permiso para consultar la calibración."},403);
    if (request.method === "GET" && path === "/api/system-settings/ocio-calibration") return json({calibration:await dashboard(db,siteId)},200);
    if (!permissions.includes("manage_system") || !sameOrigin(request)) return json({error:"No tienes permiso para registrar la calibración."},403);
    const body = await requestBody(request);
    if (!validDays(body.intervalDays) || !Number.isInteger(body.expectedRevision)) return json({error:"Ingresa un intervalo de 1 a 730 días."},400);
    const row = await ocioCalibrationRow(db,siteId);
    if (body.expectedRevision !== row.revision) return json({error:"El registro cambió. Actualiza la vista e inténtalo nuevamente."},409);
    const at = new Date().toISOString(), id = crypto.randomUUID();
    if (request.method === "PUT" && path === "/api/system-settings/ocio-calibration") {
      // El intervalo no certifica una calibración nueva ni genera otra orden.
      const nextDue = due(row.calibrated_at,body.intervalDays);
      await db.batch([
        db.prepare(`INSERT INTO ocio_calibration_events(id,site_id,kind,revision,occurred_at,actor_id,actor_name,interval_days,next_due_at)
          SELECT ?,site_id,'interval',revision,?,?,?,?,? FROM ocio_calibration_settings WHERE site_id=? AND revision=?`)
          .bind(id,at,actor.id,actor.name,body.intervalDays,nextDue,siteId,row.revision),
        db.prepare("UPDATE ocio_calibration_settings SET interval_days=?,next_due_at=? WHERE site_id=? AND revision=?")
          .bind(body.intervalDays,nextDue,siteId,row.revision),
      ]);
      return json({calibration:await dashboard(db,siteId)},200);
    }
    if (request.method === "POST" && path.endsWith("/confirm")) {
      if (!row.controller_fingerprint) return json({error:"Espera el primer reporte del PLC antes de confirmar."},409);
      if (row.confirmation_id && row.applied_revision !== row.revision && row.fingerprint === row.controller_fingerprint) return json({error:"La confirmación anterior aún espera al PLC."},409);
      const nextDue = due(at,body.intervalDays);
      await db.batch([
        db.prepare(`UPDATE ocio_calibration_settings SET revision=revision+1,confirmation_id=?,calibrated_at=?,
          calibrated_by=?,calibrated_by_name=?,interval_days=?,next_due_at=?,fingerprint=controller_fingerprint,applied_at=NULL
          WHERE site_id=? AND revision=?`).bind(id,at,actor.id,actor.name,body.intervalDays,nextDue,siteId,row.revision),
        db.prepare(`INSERT INTO ocio_calibration_events(id,site_id,kind,revision,occurred_at,actor_id,actor_name,interval_days,next_due_at,fingerprint)
          SELECT confirmation_id,site_id,'calibration',revision,calibrated_at,calibrated_by,calibrated_by_name,interval_days,next_due_at,fingerprint
          FROM ocio_calibration_settings WHERE site_id=? AND confirmation_id=?`).bind(siteId,id),
      ]);
      const updated = await dashboard(db,siteId);
      if (updated.confirmationId !== id) return json({error:"Otra persona actualizó la calibración. Recarga la vista."},409);
      return json({calibration:updated},201);
    }
    return json({error:"Ruta no encontrada."},404);
  } catch (error) {
    if (error instanceof RequestBodyError) return json({error:error.message},error.status);
    // Una escritura fallida debe reintentarse; nunca descartar el acuse durable.
    return json({error:"No fue posible guardar la calibración. Se reintentará la confirmación del PLC."},503);
  }
}
