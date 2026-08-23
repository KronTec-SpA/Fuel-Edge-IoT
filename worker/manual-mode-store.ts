import { audit, type D1DatabaseLike } from "./user-store";

const MAXIMUM_MANUAL_MODE_MILLISECONDS = 31 * 24 * 60 * 60 * 1000;
const START_GRACE_MILLISECONDS = 60_000;
const initialized = new WeakSet<object>();

export type ManualModeState = "active" | "completed" | "failed";
export type ManualModePurpose = "manual" | "adoption_assisted";

export async function ensureManualModeStore(db: D1DatabaseLike) {
  const marker = db as unknown as object;
  if (initialized.has(marker)) return;
  await db.batch([
    db.prepare(`CREATE TABLE IF NOT EXISTS manual_mode_schedules (
      id TEXT PRIMARY KEY,
      actor_user_id TEXT NOT NULL,
      actor_role TEXT NOT NULL CHECK(actor_role IN ('master','administrator','supervisor')),
      site_id TEXT NOT NULL,
      purpose TEXT NOT NULL DEFAULT 'manual' CHECK(purpose IN ('manual','adoption_assisted')),
      status TEXT NOT NULL CHECK(status IN ('scheduled','active','completed','cancelled','expired','failed')),
      start_at TEXT NOT NULL,
      end_at TEXT NOT NULL,
      requested_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      started_at TEXT,
      completed_at TEXT,
      cancelled_at TEXT,
      error TEXT
    )`),
    db.prepare("CREATE INDEX IF NOT EXISTS idx_manual_mode_status_start ON manual_mode_schedules(status,start_at)"),
    db.prepare("CREATE UNIQUE INDEX IF NOT EXISTS idx_manual_mode_one_open ON manual_mode_schedules((1)) WHERE status IN ('scheduled','active')"),
  ]);
  const columns = await db.prepare("PRAGMA table_info(manual_mode_schedules)").all<{ name: string }>();
  if (!columns.results.some((column) => column.name === "purpose")) {
    await db.prepare("ALTER TABLE manual_mode_schedules ADD COLUMN purpose TEXT NOT NULL DEFAULT 'manual' CHECK(purpose IN ('manual','adoption_assisted'))").run();
  }
  initialized.add(marker);
}

async function expireMissedSchedules(db: D1DatabaseLike) {
  await ensureManualModeStore(db);
  await db.prepare(`UPDATE manual_mode_schedules SET
      status='expired',completed_at=CURRENT_TIMESTAMP,
      error='La ventana terminó sin confirmación del controlador edge.'
    WHERE status='scheduled' AND datetime(end_at)<=datetime('now')`).run();
}

export async function createManualModeSchedule(
  db: D1DatabaseLike,
  actor: { id: string; role: string },
  siteId: string,
  startAt: string,
  endAt: string,
  purpose: ManualModePurpose = "manual",
) {
  const start = new Date(startAt);
  const end = new Date(endAt);
  const now = Date.now();
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime())) {
    throw new ManualModeConflict("Selecciona fechas válidas para el inicio y el fin.");
  }
  if (start.getTime() < now - START_GRACE_MILLISECONDS) {
    throw new ManualModeConflict("El inicio del modo manual no puede estar en el pasado.");
  }
  if (end.getTime() <= start.getTime()) {
    throw new ManualModeConflict("El fin debe ser posterior al inicio del modo manual.");
  }
  if (end.getTime() - start.getTime() > MAXIMUM_MANUAL_MODE_MILLISECONDS) {
    throw new ManualModeConflict("El período de modo manual no puede superar 31 días.");
  }
  await expireMissedSchedules(db);
  const open = await db.prepare("SELECT id FROM manual_mode_schedules WHERE status IN ('scheduled','active') LIMIT 1")
    .first<{ id: string }>();
  if (open) throw new ManualModeConflict("Ya existe un período de modo manual programado o activo.");
  const id = `${purpose === "adoption_assisted" ? "adoption-session" : "manual-mode"}-${crypto.randomUUID()}`;
  try {
    await db.prepare(`INSERT INTO manual_mode_schedules(
        id,actor_user_id,actor_role,site_id,purpose,status,start_at,end_at
      ) VALUES (?,?,?,?,?,'scheduled',?,?)`)
      .bind(id, actor.id, actor.role, siteId, purpose, start.toISOString(), end.toISOString()).run();
  } catch (error) {
    if (error instanceof Error && /unique|constraint/iu.test(error.message)) {
      throw new ManualModeConflict("Ya existe un período de modo manual programado o activo.");
    }
    throw error;
  }
  await audit(db, purpose === "adoption_assisted" ? "technology_adoption_assisted_session_scheduled" : "manual_mode_scheduled", actor.id, null, {
    scheduleId: id,
    siteId,
    startAt: start.toISOString(),
    endAt: end.toISOString(),
    purpose,
  });
  return getManualModeSchedule(db, id);
}

export async function currentManualModeSchedule(db: D1DatabaseLike) {
  await expireMissedSchedules(db);
  const open = await db.prepare(`SELECT id FROM manual_mode_schedules
    WHERE status IN ('scheduled','active') ORDER BY requested_at DESC LIMIT 1`).first<{ id: string }>();
  if (open) return getManualModeSchedule(db, open.id);
  const latest = await db.prepare(`SELECT id FROM manual_mode_schedules
    ORDER BY requested_at DESC LIMIT 1`).first<{ id: string }>();
  return latest ? getManualModeSchedule(db, latest.id) : null;
}

export async function desiredManualModeSchedule(db: D1DatabaseLike) {
  await expireMissedSchedules(db);
  const row = await db.prepare(`SELECT id FROM manual_mode_schedules
    WHERE status IN ('scheduled','active') ORDER BY requested_at DESC LIMIT 1`).first<{ id: string }>();
  if (!row) return null;
  const schedule = await getManualModeSchedule(db, row.id);
  if (!schedule) return null;
  const now = Date.now();
  return {
    ...schedule,
    desiredActive: now >= new Date(schedule.startAt).getTime() && now < new Date(schedule.endAt).getTime(),
  };
}

export async function cancelManualModeSchedule(db: D1DatabaseLike, id: string, actorId: string) {
  await expireMissedSchedules(db);
  const schedule = await getManualModeSchedule(db, id);
  if (!schedule) throw new ManualModeNotFound();
  if (!(["scheduled", "active"] as string[]).includes(String(schedule.status))) {
    throw new ManualModeConflict("El período de modo manual ya terminó.");
  }
  await db.prepare(`UPDATE manual_mode_schedules SET
      status='cancelled',cancelled_at=CURRENT_TIMESTAMP,completed_at=CURRENT_TIMESTAMP,error=NULL
    WHERE id=? AND status IN ('scheduled','active')`).bind(id).run();
  await audit(db, "manual_mode_cancelled", actorId, null, { scheduleId: id });
  return getManualModeSchedule(db, id);
}

export async function reportManualModeState(
  db: D1DatabaseLike,
  id: string,
  state: ManualModeState,
  error?: string,
) {
  const schedule = await getManualModeSchedule(db, id);
  if (!schedule) throw new ManualModeNotFound();
  if (state === "active") {
    if (schedule.status === "active") return schedule;
    if (schedule.status !== "scheduled") {
      throw new ManualModeConflict("El período ya no admite activación.");
    }
    await db.prepare(`UPDATE manual_mode_schedules SET
        status='active',started_at=CURRENT_TIMESTAMP,error=NULL WHERE id=? AND status='scheduled'`).bind(id).run();
  } else if (state === "completed") {
    if (schedule.status === "completed") return schedule;
    if (schedule.status === "cancelled") return schedule;
    if (!(["scheduled", "active", "cancelled"] as string[]).includes(String(schedule.status))) {
      throw new ManualModeConflict("El período ya tiene un resultado final.");
    }
    await db.prepare(`UPDATE manual_mode_schedules SET
        status='completed',completed_at=CURRENT_TIMESTAMP,error=NULL WHERE id=?`).bind(id).run();
  } else {
    if (schedule.status === "failed") return schedule;
    const detail = (error?.trim() || "El controlador edge no pudo mantener el modo manual.").slice(0, 200);
    await db.prepare(`UPDATE manual_mode_schedules SET
        status='failed',completed_at=CURRENT_TIMESTAMP,error=? WHERE id=?`).bind(detail, id).run();
  }
  return getManualModeSchedule(db, id);
}

export async function getManualModeSchedule(db: D1DatabaseLike, id: string) {
  await ensureManualModeStore(db);
  const row = await db.prepare(`SELECT
      s.id,s.actor_user_id AS actorUserId,s.actor_role AS actorRole,s.site_id AS siteId,
      s.purpose,s.status,s.start_at AS startAt,s.end_at AS endAt,s.requested_at AS requestedAt,
      s.started_at AS startedAt,s.completed_at AS completedAt,s.cancelled_at AS cancelledAt,
      s.error
    FROM manual_mode_schedules s
    WHERE s.id=?`).bind(id).first<Record<string, unknown>>();
  if (!row) return null;
  return {
    ...row,
    actorName: "Usuario autorizado",
    startAt: utcTimestamp(row.startAt),
    endAt: utcTimestamp(row.endAt),
    requestedAt: utcTimestamp(row.requestedAt),
    startedAt: utcTimestamp(row.startedAt),
    completedAt: utcTimestamp(row.completedAt),
    cancelledAt: utcTimestamp(row.cancelledAt),
  } as Record<string, unknown> & { startAt: string; endAt: string };
}

export class ManualModeConflict extends Error {}
export class ManualModeNotFound extends Error {}

function utcTimestamp(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const source = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/u.test(value)
    ? `${value.replace(" ", "T")}Z`
    : value;
  const parsed = new Date(source);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}
