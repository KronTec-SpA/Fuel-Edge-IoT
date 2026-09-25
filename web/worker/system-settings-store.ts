import { audit, type D1DatabaseLike } from "./user-store";
import { ensureManagedEntityStore } from "./managed-entities-store";
import { ensureAlertsStore } from "./alerts-store";
import { summarizePowerEvents, type PowerSupplyEvent } from "../shared/power-supply";
export type { PowerSupplyEvent } from "../shared/power-supply";

export const DEFAULT_BLE_RSSI_THRESHOLD = -70;
export const MINIMUM_BLE_RSSI_THRESHOLD = -100;
export const MAXIMUM_BLE_RSSI_THRESHOLD = -35;

export type CommissioningStatus = "in_progress" | "completed";

export type CommissioningState = {
  siteId: string;
  status: CommissioningStatus;
  cycle: number;
  startedAt: string;
  completedAt: string | null;
  reopenedAt: string | null;
  reopenReason: string | null;
  updatedAt: string;
};

const initialized = new WeakSet<object>();

export async function ensureSystemSettingsStore(db: D1DatabaseLike) {
  const marker = db as unknown as object;
  if (initialized.has(marker)) return;
  await db.batch([
    db.prepare(`CREATE TABLE IF NOT EXISTS validator_bluetooth_settings (
      site_id TEXT PRIMARY KEY,
      rssi_threshold INTEGER NOT NULL DEFAULT -70,
      revision INTEGER NOT NULL DEFAULT 1,
      updated_by TEXT,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      applied_threshold INTEGER,
      applied_revision INTEGER,
      applied_at TEXT,
      last_observed_rssi INTEGER,
      last_observed_module TEXT,
      observed_at TEXT
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS validator_bluetooth_observations (
      site_id TEXT NOT NULL,
      module_id TEXT NOT NULL,
      rssi INTEGER NOT NULL CHECK(rssi BETWEEN -127 AND 20),
      observed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY(site_id,module_id)
    )`),
    db.prepare("CREATE INDEX IF NOT EXISTS idx_validator_bluetooth_observations_site_time ON validator_bluetooth_observations(site_id,observed_at)"),
    db.prepare(`CREATE TABLE IF NOT EXISTS site_commissioning (
      site_id TEXT PRIMARY KEY,
      status TEXT NOT NULL DEFAULT 'in_progress' CHECK(status IN ('in_progress','completed')),
      cycle INTEGER NOT NULL DEFAULT 1 CHECK(cycle >= 1),
      started_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      completed_at TEXT,
      completed_by TEXT,
      reopened_at TEXT,
      reopened_by TEXT,
      reopen_reason TEXT,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS power_supply_events (
      id TEXT PRIMARY KEY,
      site_id TEXT NOT NULL,
      lost_at TEXT NOT NULL,
      restored_at TEXT NOT NULL,
      duration_seconds INTEGER NOT NULL CHECK(duration_seconds >= 0),
      source TEXT NOT NULL CHECK(source IN ('ups_gpio24','operator_confirmed','reconstructed')),
      loss_boot_id TEXT,
      restore_boot_id TEXT,
      recorded_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`),
    db.prepare("CREATE INDEX IF NOT EXISTS idx_power_supply_events_site_lost ON power_supply_events(site_id,lost_at)"),
  ]);
  await db.prepare("PRAGMA optimize").run();
  initialized.add(marker);
}

export async function savePowerSupplyEvent(
  db: D1DatabaseLike,
  event: PowerSupplyEvent,
): Promise<PowerSupplyEvent> {
  await ensureSystemSettingsStore(db);
  await db.prepare(`INSERT INTO power_supply_events(
      id,site_id,lost_at,restored_at,duration_seconds,source,loss_boot_id,restore_boot_id
    ) VALUES (?,?,?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET
      site_id=excluded.site_id,lost_at=excluded.lost_at,restored_at=excluded.restored_at,
      duration_seconds=excluded.duration_seconds,source=excluded.source,
      loss_boot_id=excluded.loss_boot_id,restore_boot_id=excluded.restore_boot_id
    WHERE power_supply_events.site_id=excluded.site_id`)
    .bind(
      event.id,
      event.siteId,
      event.lostAt,
      event.restoredAt,
      event.durationSeconds,
      event.source,
      event.lossBootId,
      event.restoreBootId,
    ).run();
  const stored = await db.prepare(`SELECT id,site_id AS siteId,lost_at AS lostAt,
      restored_at AS restoredAt,duration_seconds AS durationSeconds,source,
      loss_boot_id AS lossBootId,restore_boot_id AS restoreBootId
    FROM power_supply_events WHERE id=? AND site_id=?`)
    .bind(event.id, event.siteId).first<PowerSupplyEvent>();
  if (!stored) throw new Error("No fue posible guardar el evento eléctrico.");
  return stored;
}

export async function listPowerSupplyEvents(
  db: D1DatabaseLike,
  siteId: string,
  days: number,
) {
  await ensureSystemSettingsStore(db);
  const safeDays = [1, 7, 30].includes(days) ? days : 30;
  await ensureAlertsStore(db);
  const end = Date.now();
  const start = end - safeDays * 24 * 60 * 60 * 1000;
  const since = new Date(start).toISOString();
  const generatedAt = new Date(end).toISOString();
  const rows = await db.prepare(`SELECT e.id,e.site_id AS siteId,e.lost_at AS lostAt,
      e.restored_at AS restoredAt,e.duration_seconds AS durationSeconds,e.source,
      e.loss_boot_id AS lossBootId,e.restore_boot_id AS restoreBootId,
      a.id AS alertId,a.power_incident_type AS incidentType
    FROM power_supply_events e
    LEFT JOIN system_alerts a ON a.id=(SELECT x.id FROM system_alerts x
      WHERE x.id='edge-alert-' || e.id OR x.root_alert_id='edge-alert-' || e.id
      ORDER BY x.reopen_sequence DESC LIMIT 1)
    WHERE e.site_id=? AND e.restored_at>? AND e.lost_at<?
    ORDER BY e.lost_at DESC`)
    .bind(siteId, since, generatedAt).all<PowerSupplyEvent>();
  const events = rows.results.map((event) => ({
    ...event,
    durationSeconds: Number(event.durationSeconds),
  }));
  return {
    rangeDays: safeDays,
    rangeStart: since,
    generatedAt,
    events,
    summary: summarizePowerEvents(events, start, end),
  };
}

export async function getCommissioningState(db: D1DatabaseLike, siteId: string): Promise<CommissioningState> {
  await ensureSystemSettingsStore(db);
  let row = await commissioningRow(db, siteId);
  if (!row) {
    // Existing installations that already performed the one-time field reset are
    // migrated as completed. A new installation has no reset marker and starts
    // its first explicit commissioning cycle in progress.
    const legacyReset = await db.prepare("SELECT value FROM fuel_history_meta WHERE key='field_reset_at'")
      .first<{ value: string }>();
    const migratedAsCompleted = Boolean(legacyReset?.value);
    await db.prepare(`INSERT OR IGNORE INTO site_commissioning(
        site_id,status,cycle,started_at,completed_at,updated_at
      ) VALUES (?,?,1,COALESCE(?,CURRENT_TIMESTAMP),?,CURRENT_TIMESTAMP)`)
      .bind(
        siteId,
        migratedAsCompleted ? "completed" : "in_progress",
        legacyReset?.value ?? null,
        legacyReset?.value ?? null,
      ).run();
    row = await commissioningRow(db, siteId);
  }
  if (!row) throw new Error("No fue posible inicializar el estado de puesta en marcha.");
  return normalizeCommissioning(row);
}

export async function completeCommissioning(
  db: D1DatabaseLike,
  siteId: string,
  actorId: string,
): Promise<CommissioningState> {
  const current = await getCommissioningState(db, siteId);
  if (current.status === "completed") return current;
  const fieldReset = await db.prepare("SELECT value FROM fuel_history_meta WHERE key='field_reset_at'")
    .first<{ value: string }>();
  if (!fieldReset?.value) {
    throw new Error("Primero reinicia la base de carga y nivel para establecer el inicio del registro en terreno.");
  }
  const completedAt = new Date().toISOString();
  await db.batch([
    db.prepare(`UPDATE site_commissioning SET
        status='completed',completed_at=?,completed_by=?,updated_at=?
      WHERE site_id=? AND status='in_progress'`).bind(completedAt, actorId, completedAt, siteId),
    db.prepare(`INSERT INTO web_access_audit(actor_user_id,event,target_user_id,metadata)
      VALUES (?,'commissioning_completed',NULL,?)`).bind(actorId, JSON.stringify({
        siteId,
        cycle: current.cycle,
        completedAt,
      })),
  ]);
  return getCommissioningState(db, siteId);
}

export async function reopenCommissioning(
  db: D1DatabaseLike,
  siteId: string,
  actorId: string,
  reason: string,
): Promise<CommissioningState> {
  const current = await getCommissioningState(db, siteId);
  if (current.status !== "completed") {
    throw new Error("La puesta en marcha ya se encuentra abierta.");
  }
  const reopenedAt = new Date().toISOString();
  const cycle = current.cycle + 1;
  await db.batch([
    db.prepare(`UPDATE site_commissioning SET
        status='in_progress',cycle=?,started_at=?,reopened_at=?,reopened_by=?,reopen_reason=?,updated_at=?
      WHERE site_id=? AND status='completed'`).bind(
        cycle, reopenedAt, reopenedAt, actorId, reason, reopenedAt, siteId,
      ),
    db.prepare(`INSERT INTO web_access_audit(actor_user_id,event,target_user_id,metadata)
      VALUES (?,'commissioning_reopened',NULL,?)`).bind(actorId, JSON.stringify({
        siteId,
        previousCycle: current.cycle,
        cycle,
        reason,
        reopenedAt,
      })),
  ]);
  return getCommissioningState(db, siteId);
}

async function commissioningRow(db: D1DatabaseLike, siteId: string) {
  return db.prepare(`SELECT site_id AS siteId,status,cycle,started_at AS startedAt,
      completed_at AS completedAt,reopened_at AS reopenedAt,reopen_reason AS reopenReason,
      updated_at AS updatedAt
    FROM site_commissioning WHERE site_id=?`).bind(siteId).first<Record<string, unknown>>();
}

function normalizeCommissioning(row: Record<string, unknown>): CommissioningState {
  return {
    siteId: String(row.siteId),
    status: row.status === "completed" ? "completed" : "in_progress",
    cycle: Math.max(1, Number(row.cycle ?? 1)),
    startedAt: String(row.startedAt),
    completedAt: row.completedAt ? String(row.completedAt) : null,
    reopenedAt: row.reopenedAt ? String(row.reopenedAt) : null,
    reopenReason: row.reopenReason ? String(row.reopenReason) : null,
    updatedAt: String(row.updatedAt),
  };
}

export async function getBluetoothSettings(db: D1DatabaseLike, siteId: string) {
  await ensureSystemSettingsStore(db);
  await db.prepare(`INSERT OR IGNORE INTO validator_bluetooth_settings(site_id,rssi_threshold,revision)
    VALUES (?,?,1)`).bind(siteId, DEFAULT_BLE_RSSI_THRESHOLD).run();
  const row = await db.prepare(`SELECT site_id AS siteId,rssi_threshold AS rssiThreshold,revision,
      updated_at AS updatedAt,applied_threshold AS appliedThreshold,applied_revision AS appliedRevision,
      applied_at AS appliedAt,last_observed_rssi AS lastObservedRssi,
      last_observed_module AS lastObservedModule,observed_at AS observedAt
    FROM validator_bluetooth_settings WHERE site_id=?`).bind(siteId).first<Record<string, unknown>>();
  if (!row) throw new Error("No fue posible inicializar la calibración Bluetooth.");
  return row;
}

export async function updateBluetoothSettings(
  db: D1DatabaseLike,
  siteId: string,
  rssiThreshold: number,
  actorId: string,
) {
  const current = await getBluetoothSettings(db, siteId);
  const revision = Number(current.revision) + 1;
  await db.prepare(`UPDATE validator_bluetooth_settings SET
      rssi_threshold=?,revision=?,updated_by=?,updated_at=CURRENT_TIMESTAMP
    WHERE site_id=?`).bind(rssiThreshold, revision, actorId, siteId).run();
  await audit(db, "bluetooth_rssi_threshold_changed", actorId, null, {
    siteId,
    previousThreshold: current.rssiThreshold,
    rssiThreshold,
    revision,
  });
  return getBluetoothSettings(db, siteId);
}

export async function markBluetoothSettingsApplied(
  db: D1DatabaseLike,
  siteId: string,
  rssiThreshold: number,
  revision: number,
) {
  const current = await getBluetoothSettings(db, siteId);
  if (revision !== Number(current.revision) || rssiThreshold !== Number(current.rssiThreshold)) return current;
  await db.prepare(`UPDATE validator_bluetooth_settings SET
      applied_threshold=?,applied_revision=?,applied_at=CURRENT_TIMESTAMP
    WHERE site_id=?`).bind(rssiThreshold, revision, siteId).run();
  return getBluetoothSettings(db, siteId);
}

export async function recordBluetoothObservation(
  db: D1DatabaseLike,
  siteId: string,
  moduleId: string,
  rssi: number,
) {
  await getBluetoothSettings(db, siteId);
  await db.batch([
    db.prepare(`UPDATE validator_bluetooth_settings SET
        last_observed_rssi=?,last_observed_module=?,observed_at=CURRENT_TIMESTAMP
      WHERE site_id=?`).bind(rssi, moduleId, siteId),
    db.prepare(`INSERT INTO validator_bluetooth_observations(site_id,module_id,rssi,observed_at)
      VALUES (?,?,?,CURRENT_TIMESTAMP)
      ON CONFLICT(site_id,module_id) DO UPDATE SET
        rssi=excluded.rssi,observed_at=CURRENT_TIMESTAMP`).bind(siteId, moduleId, rssi),
  ]);
  return getBluetoothSettings(db, siteId);
}

export async function listLinkedBluetoothObservations(db: D1DatabaseLike, siteId: string) {
  await ensureSystemSettingsStore(db);
  await ensureManagedEntityStore(db);
  const rows = await db.prepare(`SELECT
      o.module_id AS moduleId,m.id AS equipmentId,m.name,m.kind,o.rssi,o.observed_at AS observedAt
    FROM validator_bluetooth_observations o
    INNER JOIN managed_equipment m ON m.module=o.module_id
      AND m.site_id=o.site_id
      AND m.active=1
      AND m.archived_at IS NULL
      AND (m.expiry IS NULL OR datetime(m.expiry)>CURRENT_TIMESTAMP)
    WHERE o.site_id=?
    ORDER BY o.rssi DESC,o.observed_at DESC`).bind(siteId).all<Record<string, unknown>>();
  return rows.results.map((row) => ({
    moduleId: String(row.moduleId),
    equipmentId: String(row.equipmentId),
    name: String(row.name),
    kind: String(row.kind),
    rssi: Number(row.rssi),
    observedAt: String(row.observedAt),
  }));
}

export function validRssiThreshold(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value)
    && value >= MINIMUM_BLE_RSSI_THRESHOLD && value <= MAXIMUM_BLE_RSSI_THRESHOLD;
}
