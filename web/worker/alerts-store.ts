import type { D1DatabaseLike } from "./user-store";
import { isPowerAlert, type PowerIncidentType } from "../shared/power-supply";

export type AlertPriority = "urgent" | "high" | "medium" | "low";
export type AlertStatus = "pending" | "in_progress" | "resolved";
export type AlertEventType = "follow_up" | "reopened";

const initialized = new WeakSet<object>();
const initializing = new WeakMap<object, Promise<void>>();

export async function ensureAlertsStore(db: D1DatabaseLike) {
  const marker = db as unknown as object;
  if (initialized.has(marker)) return;
  let pending = initializing.get(marker);
  if (!pending) {
    pending = initializeAlertsStore(db).finally(() => initializing.delete(marker));
    initializing.set(marker, pending);
  }
  await pending;
}

async function initializeAlertsStore(db: D1DatabaseLike) {
  await db.batch([
    db.prepare(`CREATE TABLE IF NOT EXISTS system_alerts(
      id TEXT PRIMARY KEY,
      severity TEXT NOT NULL CHECK(severity IN ('critical','warning','info')),
      priority TEXT NOT NULL DEFAULT 'medium' CHECK(priority IN ('urgent','high','medium','low')),
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','in_progress','resolved')),
      parent_alert_id TEXT,
      root_alert_id TEXT,
      reopen_sequence INTEGER NOT NULL DEFAULT 0,
      reopened_by_user_id TEXT,
      reopened_by_name TEXT,
      reopen_reason TEXT,
      power_incident_type TEXT CHECK(power_incident_type IN ('scheduled','unscheduled','internal_fault')),
      title TEXT NOT NULL,
      detail TEXT NOT NULL,
      occurred_at TEXT NOT NULL,
      acknowledged_at TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(parent_alert_id) REFERENCES system_alerts(id) ON DELETE RESTRICT,
      FOREIGN KEY(root_alert_id) REFERENCES system_alerts(id) ON DELETE RESTRICT
    )`),
    db.prepare("CREATE INDEX IF NOT EXISTS idx_system_alerts_occurred ON system_alerts(occurred_at)"),
    db.prepare(`CREATE TABLE IF NOT EXISTS system_alert_actions(
      id TEXT PRIMARY KEY,
      alert_id TEXT NOT NULL UNIQUE,
      actor_user_id TEXT NOT NULL,
      actor_name TEXT NOT NULL,
      description TEXT NOT NULL,
      occurred_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(alert_id) REFERENCES system_alerts(id) ON DELETE RESTRICT
    )`),
    db.prepare("CREATE INDEX IF NOT EXISTS idx_system_alert_actions_alert ON system_alert_actions(alert_id,occurred_at)"),
    db.prepare("CREATE UNIQUE INDEX IF NOT EXISTS idx_system_alert_actions_once ON system_alert_actions(alert_id)"),
    db.prepare(`CREATE TABLE IF NOT EXISTS system_alert_comments(
      id TEXT PRIMARY KEY,
      alert_id TEXT NOT NULL,
      actor_user_id TEXT NOT NULL,
      actor_name TEXT NOT NULL,
      comment TEXT NOT NULL,
      event_type TEXT NOT NULL DEFAULT 'follow_up' CHECK(event_type IN ('follow_up','reopened')),
      status_after TEXT NOT NULL CHECK(status_after IN ('pending','in_progress','resolved')),
      priority_after TEXT NOT NULL CHECK(priority_after IN ('urgent','high','medium','low')),
      power_incident_type_after TEXT CHECK(power_incident_type_after IN ('scheduled','unscheduled','internal_fault')),
      occurred_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(alert_id) REFERENCES system_alerts(id) ON DELETE RESTRICT
    )`),
    db.prepare("CREATE INDEX IF NOT EXISTS idx_system_alert_comments_alert ON system_alert_comments(alert_id,occurred_at)"),
  ]);

  let priorityAdded = false;
  for (const column of [
    "priority TEXT NOT NULL DEFAULT 'medium' CHECK(priority IN ('urgent','high','medium','low'))",
    "status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','in_progress','resolved'))",
    "parent_alert_id TEXT REFERENCES system_alerts(id) ON DELETE RESTRICT",
    "root_alert_id TEXT REFERENCES system_alerts(id) ON DELETE RESTRICT",
    "reopen_sequence INTEGER NOT NULL DEFAULT 0",
    "reopened_by_user_id TEXT",
    "reopened_by_name TEXT",
    "reopen_reason TEXT",
    "power_incident_type TEXT CHECK(power_incident_type IN ('scheduled','unscheduled','internal_fault'))",
  ]) {
    try {
      await db.prepare(`ALTER TABLE system_alerts ADD COLUMN ${column}`).run();
      if (column.startsWith("priority")) priorityAdded = true;
    } catch (error) {
      if (!(error instanceof Error) || !/duplicate column/i.test(error.message)) throw error;
    }
  }
  try {
    await db.prepare("ALTER TABLE system_alert_comments ADD COLUMN event_type TEXT NOT NULL DEFAULT 'follow_up' CHECK(event_type IN ('follow_up','reopened'))").run();
  } catch (error) {
    if (!(error instanceof Error) || !/duplicate column/i.test(error.message)) throw error;
  }
  try {
    await db.prepare("ALTER TABLE system_alert_comments ADD COLUMN power_incident_type_after TEXT CHECK(power_incident_type_after IN ('scheduled','unscheduled','internal_fault'))").run();
  } catch (error) {
    if (!(error instanceof Error) || !/duplicate column/i.test(error.message)) throw error;
  }
  await db.prepare("CREATE UNIQUE INDEX IF NOT EXISTS idx_system_alerts_single_reopen ON system_alerts(parent_alert_id) WHERE parent_alert_id IS NOT NULL").run();
  await db.prepare("CREATE INDEX IF NOT EXISTS idx_system_alerts_root_cycle ON system_alerts(root_alert_id,reopen_sequence)").run();
  if (priorityAdded) {
    await db.prepare(`UPDATE system_alerts SET priority=CASE severity
      WHEN 'critical' THEN 'urgent' WHEN 'warning' THEN 'high' ELSE 'medium' END`).run();
  }
  await db.prepare("UPDATE system_alerts SET status='resolved' WHERE acknowledged_at IS NOT NULL").run();
  await db.prepare(`INSERT OR IGNORE INTO system_alert_comments(
      id,alert_id,actor_user_id,actor_name,comment,status_after,priority_after,occurred_at
    ) SELECT x.id,x.alert_id,x.actor_user_id,x.actor_name,x.description,'resolved',a.priority,x.occurred_at
      FROM system_alert_actions x INNER JOIN system_alerts a ON a.id=x.alert_id`).run();
  initialized.add(db as unknown as object);
}

export async function listAlerts(db: D1DatabaseLike, includeHistory = false) {
  const result = await db.prepare(`SELECT a.id,a.severity,a.priority,a.status,a.title,a.detail,
    a.occurred_at AS occurredAt,a.acknowledged_at AS acknowledgedAt,
    a.parent_alert_id AS parentAlertId,a.root_alert_id AS rootAlertId,
    a.reopen_sequence AS reopenSequence,a.reopened_by_name AS reopenedBy,
    a.reopen_reason AS reopenReason,a.power_incident_type AS powerIncidentType,child.id AS reopenedAsAlertId
    FROM system_alerts a LEFT JOIN system_alerts child ON child.parent_alert_id=a.id
    ORDER BY a.occurred_at DESC LIMIT 1000`).all<Record<string, unknown>>();
  const commentsByAlert = new Map<string, Array<Record<string, unknown>>>();
  if (includeHistory) {
    const comments = await db.prepare(`SELECT c.id,c.alert_id AS alertId,c.actor_name AS actor,
      c.comment,c.event_type AS eventType,c.status_after AS statusAfter,c.priority_after AS priorityAfter,
      c.power_incident_type_after AS powerIncidentTypeAfter,c.occurred_at AS recordedAt FROM system_alert_comments c
      INNER JOIN system_alerts a ON a.id=c.alert_id
      ORDER BY c.occurred_at ASC,c.rowid ASC LIMIT 10000`).all<Record<string, unknown>>();
    for (const comment of comments.results) {
      const alertId = String(comment.alertId);
      const history = commentsByAlert.get(alertId) ?? [];
      history.push(comment);
      commentsByAlert.set(alertId, history);
    }
  }
  return result.results.map((row) => ({
    id: String(row.id), severity: row.severity, priority: row.priority, status: row.status,
    powerIncidentType: row.powerIncidentType ?? null,
    title: String(row.title), detail: String(row.detail), time: String(row.occurredAt),
    parentAlertId: row.parentAlertId ? String(row.parentAlertId) : null,
    rootAlertId: row.rootAlertId ? String(row.rootAlertId) : String(row.id),
    reopenNumber: Number(row.reopenSequence ?? 0),
    reopenedAsAlertId: row.reopenedAsAlertId ? String(row.reopenedAsAlertId) : null,
    acknowledged: row.status === "resolved" || Boolean(row.acknowledgedAt),
    ...(includeHistory && Number(row.reopenSequence ?? 0) > 0 ? {
      reopenedBy: row.reopenedBy ? String(row.reopenedBy) : null,
      reopenReason: row.reopenReason ? String(row.reopenReason) : null,
    } : {}),
    ...(includeHistory ? { comments: (commentsByAlert.get(String(row.id)) ?? []).map((comment) => ({
      id: String(comment.id), actor: String(comment.actor), comment: String(comment.comment),
      eventType: comment.eventType === "reopened" ? "reopened" : "follow_up",
      statusAfter: comment.statusAfter, priorityAfter: comment.priorityAfter,
      powerIncidentTypeAfter: comment.powerIncidentTypeAfter ?? null,
      recordedAt: String(comment.recordedAt),
    })) } : {}),
  }));
}

export async function ingestEdgeAlert(db: D1DatabaseLike, body: Record<string, unknown>) {
  const id = text(body.id, 160);
  const severity = body.severity;
  const priority = body.priority === undefined ? priorityForSeverity(String(severity)) : body.priority;
  const title = text(body.title, 160);
  const detail = text(body.detail, 500);
  const timestamp = typeof body.occurredAt === "string" ? new Date(body.occurredAt) : new Date(Number.NaN);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u.test(id)) throw new Error("Identificador de alerta inválido.");
  if (!["critical", "warning", "info"].includes(String(severity))) throw new Error("Severidad de alerta inválida.");
  if (!isAlertPriority(priority)) throw new Error("Prioridad de alerta inválida.");
  if (!title || Number.isNaN(timestamp.getTime()) || timestamp.getTime() > Date.now() + 5 * 60_000) throw new Error("Alerta inválida.");
  const existing = await db.prepare("SELECT severity,priority,status,title,detail,occurred_at AS occurredAt FROM system_alerts WHERE id=?")
    .bind(id).first<Record<string, unknown>>();
  if (existing) {
    if (String(existing.severity) !== String(severity) || String(existing.title) !== title || String(existing.occurredAt) !== timestamp.toISOString()) {
      throw new Error("El identificador de alerta ya pertenece a otro evento.");
    }
    if (existing.status === "resolved") {
      return { created: false, updated: false, ignored: true, reason: "resolved" };
    }
    if (String(existing.detail) !== detail || String(existing.priority) !== String(priority)) {
      await db.prepare("UPDATE system_alerts SET detail=?,priority=? WHERE id=?")
        .bind(detail, priority, id).run();
      return { created: false, updated: true };
    }
    return { created: false, updated: false };
  }
  await db.prepare(`INSERT INTO system_alerts(id,severity,priority,status,title,detail,occurred_at)
    VALUES (?,?,?,'pending',?,?,?)`).bind(id, severity, priority, title, detail, timestamp.toISOString()).run();
  return { created: true };
}

export async function recordAlertUpdate(
  db: D1DatabaseLike,
  alertId: string,
  actorId: string,
  actorName: string,
  comment: string,
  status: AlertStatus,
  requestedPriority: AlertPriority | null,
  requestedPowerIncidentType?: PowerIncidentType | null,
) {
  const alert = await db.prepare("SELECT id,status,priority,title,root_alert_id AS rootAlertId,power_incident_type AS powerIncidentType FROM system_alerts WHERE id=?")
    .bind(alertId).first<{ id: string; title: string; rootAlertId: string | null; status: AlertStatus; priority: AlertPriority; powerIncidentType: PowerIncidentType | null }>();
  if (!alert) throw new Error("Alerta no encontrada.");
  if (alert.status === "resolved") throw new Error("La alerta ya fue resuelta.");
  const powerIncidentType = requestedPowerIncidentType === undefined ? alert.powerIncidentType : requestedPowerIncidentType;
  const electrical = isPowerAlert(alert);
  if (!electrical && powerIncidentType !== null) throw new Error("La clasificación eléctrica sólo corresponde a fallas eléctricas.");
  if (electrical && status === "resolved" && !powerIncidentType) throw new Error("Selecciona el tipo de falla eléctrica antes de resolver la alerta.");
  const priority = requestedPriority ?? alert.priority;
  const occurredAt = new Date().toISOString();
  await db.batch([
    db.prepare(`INSERT INTO system_alert_comments(
      id,alert_id,actor_user_id,actor_name,comment,status_after,priority_after,power_incident_type_after,occurred_at
    ) VALUES (?,?,?,?,?,?,?,?,?)`).bind(
      `alc-${crypto.randomUUID()}`, alertId, actorId, actorName.slice(0, 80), comment, status, priority, powerIncidentType, occurredAt,
    ),
    db.prepare(`UPDATE system_alerts SET priority=?,status=?,power_incident_type=?,
      acknowledged_at=CASE WHEN ?='resolved' THEN ? ELSE NULL END
      WHERE id=? AND status<>'resolved'`).bind(priority, status, powerIncidentType, status, occurredAt, alertId),
  ]);
}

export async function reopenAlert(
  db: D1DatabaseLike,
  alertId: string,
  actorId: string,
  actorName: string,
  reason: string,
  priority: AlertPriority,
) {
  const alert = await db.prepare(`SELECT a.id,a.severity,a.priority,a.status,a.title,a.detail,a.power_incident_type AS powerIncidentType,
      a.root_alert_id AS rootAlertId,a.reopen_sequence AS reopenSequence,
      child.id AS reopenedAsAlertId
    FROM system_alerts a LEFT JOIN system_alerts child ON child.parent_alert_id=a.id
    WHERE a.id=?`).bind(alertId).first<Record<string, unknown>>();
  if (!alert) throw new Error("Alerta no encontrada.");
  if (alert.status !== "resolved") throw new Error("Sólo se puede reabrir una alerta resuelta.");
  if (alert.reopenedAsAlertId) throw new Error(`La alerta ya fue reabierta como ${String(alert.reopenedAsAlertId)}.`);

  const reopenedAt = new Date().toISOString();
  const reopenedId = `alr-${crypto.randomUUID()}`;
  const rootAlertId = alert.rootAlertId ? String(alert.rootAlertId) : String(alert.id);
  const reopenNumber = Number(alert.reopenSequence ?? 0) + 1;
  const safeActorName = actorName.slice(0, 80);
  await db.batch([
    db.prepare(`INSERT INTO system_alerts(
      id,severity,priority,status,parent_alert_id,root_alert_id,reopen_sequence,
      reopened_by_user_id,reopened_by_name,reopen_reason,title,detail,power_incident_type,occurred_at
    ) VALUES (?,?,?,'pending',?,?,?,?,?,?,?,?,?,?)`).bind(
      reopenedId, alert.severity, priority, alert.id, rootAlertId, reopenNumber,
      actorId, safeActorName, reason, alert.title, alert.detail, alert.powerIncidentType, reopenedAt,
    ),
    db.prepare(`INSERT INTO system_alert_comments(
      id,alert_id,actor_user_id,actor_name,comment,event_type,status_after,priority_after,power_incident_type_after,occurred_at
    ) VALUES (?,?,?,?,?,'reopened','pending',?,?,?)`).bind(
      `alc-${crypto.randomUUID()}`, reopenedId, actorId, safeActorName, reason, priority, alert.powerIncidentType, reopenedAt,
    ),
  ]);
  return { alertId: reopenedId, parentAlertId: String(alert.id), rootAlertId, reopenNumber, reopenedAt };
}

export function isAlertPriority(value: unknown): value is AlertPriority {
  return typeof value === "string" && ["urgent", "high", "medium", "low"].includes(value);
}

export function isAlertStatus(value: unknown): value is AlertStatus {
  return typeof value === "string" && ["pending", "in_progress", "resolved"].includes(value);
}

function priorityForSeverity(severity: string): AlertPriority {
  if (severity === "critical") return "urgent";
  if (severity === "warning") return "high";
  return "medium";
}

function text(value: unknown, max: number) { return typeof value === "string" ? value.trim().slice(0, max) : ""; }
