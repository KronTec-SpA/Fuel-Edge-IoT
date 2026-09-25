import { json, type AuthEnvironment } from "./auth";
import { edgeSensorSecret, sensorKeyMatches } from "./fuel-history-api";
import { readJsonBody, RequestBodyError } from "./request-body";
import type { D1DatabaseLike } from "./user-store";

const schema = `CREATE TABLE IF NOT EXISTS voltage_readings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  site_id TEXT NOT NULL, telemetry_session_id TEXT NOT NULL DEFAULT '',
  occurred_at TEXT NOT NULL, source TEXT NOT NULL, volts REAL NOT NULL,
  raw_adc REAL NOT NULL, quality TEXT NOT NULL, calibration_id TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(site_id,telemetry_session_id,source,occurred_at)
)`;
const ready = new WeakMap<object, Promise<void>>();
export async function ensureVoltageHistoryStore(db: D1DatabaseLike) {
  let pending = ready.get(db);
  if (!pending) {
    pending = db.batch([db.prepare(schema), db.prepare("CREATE INDEX IF NOT EXISTS idx_voltage_readings_occurred ON voltage_readings(occurred_at)")]).then(() => {});
    ready.set(db, pending);
    pending.catch(() => ready.delete(db));
  }
  await pending;
}

type Environment = AuthEnvironment & { FUEL_SENSOR_INGEST_KEY?: string; FUEL_SITE_ID?: string };
class InvalidVoltage extends Error {}
const field = (value: unknown, name: string, optional = false): string => {
  if (optional && value == null) return "";
  if (typeof value !== "string" || !value.trim() || value.length > 160) throw new InvalidVoltage(`${name} no válido.`);
  return value.trim();
};

export async function handleVoltageHistoryRequest(request: Request, env: Environment): Promise<Response | null> {
  if (new URL(request.url).pathname !== "/api/fuel-history/voltages") return null;
  if (request.method !== "POST") return json({ error: "Método no permitido." }, 405);
  if (!await sensorKeyMatches(request.headers.get("x-edge-sensor-key"), edgeSensorSecret(env))) return json({ error: "Lectura de sensor no autorizada." }, 403);
  if (!env.DB) return json({ error: "Base de datos no disponible." }, 503);
  try {
    const body = await readJsonBody<Record<string, unknown>>(request, 64 * 1024);
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new InvalidVoltage("Lote no válido.");
    const siteId = field(body.siteId, "Fundo");
    if (siteId !== (env.FUEL_SITE_ID?.trim() || "concha-y-toro-piloto")) throw new InvalidVoltage("El fundo no corresponde a este sistema.");
    const session = field(body.telemetrySessionId, "Sesión", true);
    const source = field(body.source, "Fuente");
    if (!Array.isArray(body.samples) || body.samples.length < 1 || body.samples.length > 100) throw new InvalidVoltage("Se requieren entre 1 y 100 muestras.");
    // Validate the entire batch before writing: a bad sample cannot partially commit it.
    const samples = body.samples.map((sample: unknown) => {
      if (!sample || typeof sample !== "object" || Array.isArray(sample)) throw new InvalidVoltage("Muestra no válida.");
      const s = sample as Record<string, unknown>;
      const at = field(s.occurredAt, "Fecha");
      if (!/(Z|[+-]\d{2}:\d{2})$/u.test(at) || !Number.isFinite(Date.parse(at)) || Date.parse(at) > Date.now() + 300000) throw new InvalidVoltage("Fecha de muestra no válida.");
      if (typeof s.volts !== "number" || !Number.isFinite(s.volts) || s.volts < 0 || s.volts > 10
        || typeof s.rawAdc !== "number" || !Number.isFinite(s.rawAdc) || s.rawAdc < 0 || s.rawAdc > 65535) throw new InvalidVoltage("Voltaje o ADC no válido.");
      return { at: new Date(at).toISOString(), volts: s.volts, adc: s.rawAdc,
        quality: field(s.quality, "Estado"), calibration: field(s.calibrationId, "Calibración", true) || null };
    });
    await ensureVoltageHistoryStore(env.DB);
    await env.DB.batch(samples.map(s => env.DB!.prepare(`INSERT INTO voltage_readings
      (site_id,telemetry_session_id,occurred_at,source,volts,raw_adc,quality,calibration_id)
      VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(site_id,telemetry_session_id,source,occurred_at) DO NOTHING`)
      .bind(siteId, session, s.at, source, s.volts, s.adc, s.quality, s.calibration)));
    return json({ recorded: true, samples: samples.length }, 200);
  } catch (error) {
    if (error instanceof InvalidVoltage) return json({ error: error.message }, 400);
    if (error instanceof RequestBodyError) return json({ error: error.message }, error.status);
    throw error;
  }
}

export async function voltageSnapshot(db: D1DatabaseLike) {
  await ensureVoltageHistoryStore(db);
  return (await db.prepare("SELECT COALESCE(MAX(id),0) AS lastId,COUNT(*) AS total FROM voltage_readings").first<{ lastId: number; total: number }>())!;
}

// Keyset pagination bounds memory even for years of one-second observations.
export async function* voltageRows(db: D1DatabaseLike, lastId: number) {
  let cursor = 0;
  while (cursor < lastId) {
    const { results } = await db.prepare(`SELECT id,site_id AS siteId,telemetry_session_id AS telemetrySessionId,
      occurred_at AS occurredAt,source,volts,raw_adc AS rawAdc,quality,calibration_id AS calibrationId,created_at AS createdAt
      FROM voltage_readings WHERE id>? AND id<=? ORDER BY id LIMIT 1000`).bind(cursor, lastId).all<Record<string, unknown>>();
    if (!results.length) return;
    for (const row of results) yield row;
    cursor = Number(results.at(-1)!.id);
  }
}

export function textStream(chunks: AsyncGenerator<string>) {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try { const next = await chunks.next(); if (next.done) controller.close(); else controller.enqueue(encoder.encode(next.value)); }
      catch (error) { controller.error(error); }
    },
    async cancel() { await chunks.return(undefined); },
  });
}
