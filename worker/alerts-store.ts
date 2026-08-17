import type { D1DatabaseLike } from "./user-store";

export type AlertPriority = "urgent" | "high" | "medium" | "low";
export type AlertStatus = "pending" | "in_progress" | "resolved";

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
      title TEXT NOT NULL,
      detail TEXT NOT NULL,
      occurred_at TEXT NOT NULL,
      acknowledged_at TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
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
      status_after TEXT NOT NULL CHECK(status_after IN ('pending','in_progress','resolved')),
      priority_after TEXT NOT NULL CHECK(priority_after IN ('urgent','high','medium','low')),
      occurred_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(alert_id) REFERENCES system_alerts(id) ON DELETE RESTRICT
    )`),
    db.prepare("CREATE INDEX IF NOT EXISTS idx_system_alert_comments_alert ON system_alert_comments(alert_id,occurred_at)"),
  ]);

  let priorityAdded = false;
  for (const column of [
    "priority TEXT NOT NULL DEFAULT 'medium' CHECK(priority IN ('urgent','high','medium','low'))",
    "status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','in_progress','resolved'))",
  ]) {
    try {
      await db.prepare(`ALTER TABLE system_alerts ADD COLUMN ${column}`).run();
      if (column.startsWith("priority")) priorityAdded = true;
    } catch (error) {
      if (!(error instanceof Error) || !/duplicate column/i.test(error.message)) throw error;
    }
  }
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
  const result = await db.prepare(`SELECT id,severity,priority,status,title,detail,
    occurred_at AS occurredAt,acknowledged_at AS acknowledgedAt
    FROM system_alerts ORDER BY occurred_at DESC LIMIT 1000`).all<Record<string, unknown>>();
  const commentsByAlert = new Map<string, Array<Record<string, unknown>>>();
  if (includeHistory) {
    const comments = await db.prepare(`SELECT c.id,c.alert_id AS alertId,c.actor_name AS actor,
      c.comment,c.status_after AS statusAfter,c.priority_after AS priorityAfter,
      c.occurred_at AS recordedAt FROM system_alert_comments c
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
    title: String(row.title), detail: String(row.detail), time: String(row.occurredAt),
    acknowledged: row.status === "resolved" || Boolean(row.acknowledgedAt),
    ...(includeHistory ? { comments: (commentsByAlert.get(String(row.id)) ?? []).map((comment) => ({
      id: String(comment.id), actor: String(comment.actor), comment: String(comment.comment),
      statusAfter: comment.statusAfter, priorityAfter: comment.priorityAfter,
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
  const existing = await db.prepare("SELECT severity,priority,title,detail,occurred_at AS occurredAt FROM system_alerts WHERE id=?")
    .bind(id).first<Record<string, unknown>>();
  if (existing) {
    if (String(existing.severity) !== String(severity) || String(existing.title) !== title || String(existing.occurredAt) !== timestamp.toISOString()) {
      throw new Error("El identificador de alerta ya pertenece a otro evento.");
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
) {
  const alert = await db.prepare("SELECT id,status,priority FROM system_alerts WHERE id=?")
    .bind(alertId).first<{ id: string; status: AlertStatus; priority: AlertPriority }>();
  if (!alert) throw new Error("Alerta no encontrada.");
  if (alert.status === "resolved") throw new Error("La alerta ya fue resuelta.");
  const priority = requestedPriority ?? alert.priority;
  await db.batch([
    db.prepare(`INSERT INTO system_alert_comments(
      id,alert_id,actor_user_id,actor_name,comment,status_after,priority_after
    ) VALUES (?,?,?,?,?,?,?)`).bind(
      `alc-${crypto.randomUUID()}`, alertId, actorId, actorName.slice(0, 80), comment, status, priority,
    ),
    db.prepare(`UPDATE system_alerts SET priority=?,status=?,
      acknowledged_at=CASE WHEN ?='resolved' THEN CURRENT_TIMESTAMP ELSE NULL END
      WHERE id=? AND status<>'resolved'`).bind(priority, status, status, alertId),
  ]);
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
