import { audit, type D1DatabaseLike } from "./user-store";
import { ensureManagedEntityStore } from "./managed-entities-store";

export const DEFAULT_BLE_RSSI_THRESHOLD = -70;
export const MINIMUM_BLE_RSSI_THRESHOLD = -100;
export const MAXIMUM_BLE_RSSI_THRESHOLD = -35;

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
  ]);
  initialized.add(marker);
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
