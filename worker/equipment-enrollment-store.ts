import { ensureManagedEntityStore } from "./managed-entities-store";
import type { D1DatabaseLike } from "./user-store";

export type EnrollmentCandidate = {
  moduleId: string;
  siteId: string;
  deviceName: string | null;
  equipmentId: string | null;
  firmware: string;
  rssi: number;
  claimed: boolean;
  status: "detected" | "pending" | "enrolling" | "failed" | "enrolled";
  lastSeen: string;
  commandId: string | null;
  requestedName: string | null;
  requestedKind: string | null;
  validUntil: string | null;
  error: string | null;
};

export type EquipmentScan = {
  id: string;
  status: "pending" | "scanning" | "completed" | "failed";
  durationSeconds: number;
  requestedAt: string;
  startedAt: string | null;
  completedAt: string | null;
  discovered: number;
  verified: number;
  error: string | null;
};

const initialized = new WeakSet<object>();
const initializing = new WeakMap<object, Promise<void>>();
const MANUAL_SCAN_SECONDS = 10;
const STALE_SCAN_SECONDS = 30;

export async function ensureEquipmentEnrollmentStore(db: D1DatabaseLike) {
  const marker = db as unknown as object;
  if (initialized.has(marker)) return;
  let pending = initializing.get(marker);
  if (!pending) {
    pending = (async () => {
      await db.batch([
        db.prepare(`CREATE TABLE IF NOT EXISTS equipment_enrollment_candidates (
          module_id TEXT PRIMARY KEY,
          site_id TEXT NOT NULL,
          device_name TEXT,
          equipment_id TEXT,
          firmware TEXT NOT NULL,
          rssi INTEGER NOT NULL,
          claimed INTEGER NOT NULL DEFAULT 0 CHECK(claimed IN (0,1)),
          status TEXT NOT NULL DEFAULT 'detected' CHECK(status IN ('detected','pending','enrolling','failed','enrolled')),
          last_seen TEXT NOT NULL,
          updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        )`),
        db.prepare("CREATE INDEX IF NOT EXISTS idx_equipment_enrollment_candidates_last_seen ON equipment_enrollment_candidates(last_seen)"),
        db.prepare(`CREATE TABLE IF NOT EXISTS equipment_enrollment_commands (
          id TEXT PRIMARY KEY,
          module_id TEXT NOT NULL,
          site_id TEXT NOT NULL,
          equipment_id TEXT NOT NULL,
          requested_name TEXT NOT NULL,
          kind TEXT NOT NULL DEFAULT 'Tractor',
          condition TEXT NOT NULL DEFAULT 'Permanente',
          valid_until TEXT,
          status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','enrolling','completed','failed')),
          requested_by TEXT NOT NULL,
          error TEXT,
          requested_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          completed_at TEXT
        )`),
        db.prepare(`CREATE TABLE IF NOT EXISTS equipment_scan_requests (
          id TEXT PRIMARY KEY,
          status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','scanning','completed','failed')),
          duration_seconds INTEGER NOT NULL DEFAULT 25 CHECK(duration_seconds BETWEEN 5 AND 60),
          requested_by TEXT NOT NULL,
          requested_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          started_at TEXT,
          completed_at TEXT,
          discovered INTEGER NOT NULL DEFAULT 0 CHECK(discovered >= 0),
          verified INTEGER NOT NULL DEFAULT 0 CHECK(verified >= 0),
          error TEXT,
          updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        )`),
        db.prepare(`CREATE TABLE IF NOT EXISTS equipment_registry_removals (
          id TEXT PRIMARY KEY,
          module_id TEXT NOT NULL,
          equipment_id TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','processing','completed')),
          requested_by TEXT NOT NULL,
          error TEXT,
          requested_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          started_at TEXT,
          completed_at TEXT,
          updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        )`),
      ]);
      await ensureEnrollmentCommandColumns(db);
      await db.batch([
        db.prepare("CREATE INDEX IF NOT EXISTS idx_equipment_enrollment_commands_status_module ON equipment_enrollment_commands(status,module_id,requested_at)"),
        db.prepare("CREATE UNIQUE INDEX IF NOT EXISTS idx_equipment_enrollment_commands_active ON equipment_enrollment_commands(module_id) WHERE status IN ('pending','enrolling')"),
        db.prepare("CREATE INDEX IF NOT EXISTS idx_equipment_scan_requests_status_requested ON equipment_scan_requests(status,requested_at)"),
        db.prepare("CREATE INDEX IF NOT EXISTS idx_equipment_registry_removals_status_requested ON equipment_registry_removals(status,requested_at)"),
        db.prepare("CREATE UNIQUE INDEX IF NOT EXISTS idx_equipment_registry_removals_active_module ON equipment_registry_removals(module_id) WHERE status IN ('pending','processing')"),
      ]);
      await db.prepare("PRAGMA optimize").run();
      initialized.add(marker);
    })().finally(() => initializing.delete(marker));
    initializing.set(marker, pending);
  }
  await pending;
}

export async function recordEquipmentSighting(db: D1DatabaseLike, input: {
  moduleId: string;
  siteId: string;
  deviceName: string | null;
  equipmentId: string | null;
  firmware: string;
  rssi: number;
  claimed: boolean;
  occurredAt: string;
}) {
  await ensureEquipmentEnrollmentStore(db);
  await db.prepare(`INSERT INTO equipment_enrollment_candidates(
      module_id,site_id,device_name,equipment_id,firmware,rssi,claimed,status,last_seen
    ) VALUES (?,?,?,?,?,?,?,?,?)
    ON CONFLICT(module_id) DO UPDATE SET
      site_id=excluded.site_id,
      device_name=excluded.device_name,
      equipment_id=excluded.equipment_id,
      firmware=excluded.firmware,
      rssi=excluded.rssi,
      claimed=excluded.claimed,
      status=CASE
        WHEN equipment_enrollment_candidates.status IN ('pending','enrolling') THEN equipment_enrollment_candidates.status
        WHEN excluded.claimed=1 AND equipment_enrollment_candidates.status='enrolled' THEN 'enrolled'
        ELSE 'detected'
      END,
      last_seen=excluded.last_seen,
      updated_at=CURRENT_TIMESTAMP`)
    .bind(
      input.moduleId,
      input.siteId,
      input.deviceName,
      input.equipmentId,
      input.firmware,
      input.rssi,
      Number(input.claimed),
      "detected",
      input.occurredAt,
    ).run();
}

export async function listEnrollmentCandidates(db: D1DatabaseLike): Promise<EnrollmentCandidate[]> {
  await ensureEquipmentEnrollmentStore(db);
  await ensureManagedEntityStore(db);
  const rows = await db.prepare(`SELECT
      c.module_id AS moduleId,c.site_id AS siteId,c.device_name AS deviceName,
      c.equipment_id AS equipmentId,c.firmware,c.rssi,c.claimed,
      CASE WHEN c.claimed=1 AND m.id IS NOT NULL AND m.site_id=c.site_id
        AND (m.expiry IS NULL OR datetime(m.expiry)>CURRENT_TIMESTAMP)
        THEN 'enrolled' ELSE c.status END AS status,
      c.last_seen AS lastSeen,x.id AS commandId,x.requested_name AS requestedName,
      x.kind AS requestedKind,x.valid_until AS validUntil,x.error
    FROM equipment_enrollment_candidates c
    LEFT JOIN equipment_enrollment_commands x ON x.id=(
      SELECT id FROM equipment_enrollment_commands
      WHERE module_id=c.module_id ORDER BY requested_at DESC LIMIT 1
    )
    LEFT JOIN managed_equipment m ON m.id=(
      SELECT id FROM managed_equipment
      WHERE module=c.module_id AND archived_at IS NULL ORDER BY updated_at DESC LIMIT 1
    )
    WHERE c.status IN ('pending','enrolling','failed')
      OR datetime(c.last_seen) >= datetime('now','-5 minutes')
    ORDER BY c.last_seen DESC`).all<Record<string, unknown>>();
  return rows.results.map((row) => ({
    moduleId: String(row.moduleId),
    siteId: String(row.siteId),
    deviceName: row.deviceName ? String(row.deviceName) : null,
    equipmentId: row.equipmentId ? String(row.equipmentId) : null,
    firmware: String(row.firmware),
    rssi: Number(row.rssi),
    claimed: row.claimed === 1,
    status: String(row.status) as EnrollmentCandidate["status"],
    lastSeen: String(row.lastSeen),
    commandId: row.commandId ? String(row.commandId) : null,
    requestedName: row.requestedName ? String(row.requestedName) : null,
    requestedKind: row.requestedKind ? String(row.requestedKind) : null,
    validUntil: row.validUntil ? String(row.validUntil) : null,
    error: row.error ? String(row.error) : null,
  }));
}

function equipmentScan(row: Record<string, unknown> | null): EquipmentScan | null {
  if (!row) return null;
  return {
    id: String(row.id),
    status: String(row.status) as EquipmentScan["status"],
    durationSeconds: Number(row.durationSeconds),
    requestedAt: String(row.requestedAt),
    startedAt: row.startedAt ? String(row.startedAt) : null,
    completedAt: row.completedAt ? String(row.completedAt) : null,
    discovered: Number(row.discovered),
    verified: Number(row.verified),
    error: row.error ? String(row.error) : null,
  };
}

export async function latestEquipmentScan(db: D1DatabaseLike): Promise<EquipmentScan | null> {
  await ensureEquipmentEnrollmentStore(db);
  await expireStaleEquipmentScans(db);
  const row = await db.prepare(`SELECT id,status,duration_seconds AS durationSeconds,
      requested_at AS requestedAt,started_at AS startedAt,completed_at AS completedAt,
      discovered,verified,error
    FROM equipment_scan_requests ORDER BY requested_at DESC LIMIT 1`).first<Record<string, unknown>>();
  return equipmentScan(row);
}

export async function requestEquipmentScan(db: D1DatabaseLike, actorId: string) {
  await ensureEquipmentEnrollmentStore(db);
  await expireStaleEquipmentScans(db);
  const active = await db.prepare(`SELECT id,status,duration_seconds AS durationSeconds,
      requested_at AS requestedAt,started_at AS startedAt,completed_at AS completedAt,
      discovered,verified,error FROM equipment_scan_requests
    WHERE status IN ('pending','scanning') ORDER BY requested_at DESC LIMIT 1`).first<Record<string, unknown>>();
  if (active) return equipmentScan(active);
  const id = `scan-${crypto.randomUUID()}`;
  await db.prepare(`INSERT INTO equipment_scan_requests(id,status,duration_seconds,requested_by)
    VALUES (?,'pending',?,?)`).bind(id, MANUAL_SCAN_SECONDS, actorId).run();
  return latestEquipmentScan(db);
}

export async function takeEquipmentScan(db: D1DatabaseLike): Promise<EquipmentScan | null> {
  await ensureEquipmentEnrollmentStore(db);
  await expireStaleEquipmentScans(db);
  const row = await db.prepare(`SELECT id,status,duration_seconds AS durationSeconds,
      requested_at AS requestedAt,started_at AS startedAt,completed_at AS completedAt,
      discovered,verified,error FROM equipment_scan_requests
    WHERE status='pending' OR (status='scanning' AND updated_at <= datetime('now','-90 seconds'))
    ORDER BY requested_at LIMIT 1`).first<Record<string, unknown>>();
  if (!row) return null;
  await db.prepare(`UPDATE equipment_scan_requests SET status='scanning',started_at=CURRENT_TIMESTAMP,
      completed_at=NULL,error=NULL,updated_at=CURRENT_TIMESTAMP WHERE id=?`).bind(row.id).run();
  return equipmentScan({ ...row, status: "scanning", startedAt: new Date().toISOString() });
}

export async function completeEquipmentScan(db: D1DatabaseLike, scanId: string, result: {
  success: boolean;
  discovered: number;
  verified: number;
  error?: string;
}) {
  await ensureEquipmentEnrollmentStore(db);
  const scan = await db.prepare("SELECT id FROM equipment_scan_requests WHERE id=?")
    .bind(scanId).first<{ id: string }>();
  if (!scan) throw new EnrollmentConflict("La búsqueda de MIM solicitada no existe.");
  const status = result.success ? "completed" : "failed";
  const error = result.success ? null : (result.error ?? "La Raspberry no pudo completar la búsqueda de MIM").slice(0, 240);
  await db.prepare(`UPDATE equipment_scan_requests SET status=?,discovered=?,verified=?,error=?,
      completed_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP WHERE id=?`)
    .bind(status, result.discovered, result.verified, error, scanId).run();
  return latestEquipmentScan(db);
}

async function expireStaleEquipmentScans(db: D1DatabaseLike) {
  await db.prepare(`UPDATE equipment_scan_requests SET status='failed',
      error='La búsqueda superó el tiempo máximo de respuesta',completed_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP
    WHERE status IN ('pending','scanning')
      AND datetime(COALESCE(started_at,requested_at)) <= datetime('now',?)`)
    .bind(`-${STALE_SCAN_SECONDS} seconds`).run();
}

export async function queueEquipmentRegistryRemoval(
  db: D1DatabaseLike,
  moduleId: string,
  equipmentId: string,
  actorId: string,
) {
  await ensureEquipmentEnrollmentStore(db);
  const existing = await db.prepare(`SELECT id FROM equipment_registry_removals
    WHERE module_id=? AND status IN ('pending','processing') LIMIT 1`).bind(moduleId).first<{ id: string }>();
  if (existing) return existing.id;
  const id = `mim-remove-${crypto.randomUUID()}`;
  await db.prepare(`INSERT INTO equipment_registry_removals(id,module_id,equipment_id,requested_by)
    VALUES (?,?,?,?)`).bind(id, moduleId, equipmentId, actorId).run();
  return id;
}

export async function takeEquipmentRegistryRemoval(db: D1DatabaseLike) {
  await ensureEquipmentEnrollmentStore(db);
  const command = await db.prepare(`SELECT id,module_id AS moduleId,equipment_id AS equipmentId
    FROM equipment_registry_removals WHERE status IN ('pending','processing')
    ORDER BY requested_at LIMIT 1`).first<Record<string, string>>();
  if (!command) return null;
  await db.prepare(`UPDATE equipment_registry_removals SET status='processing',
    started_at=COALESCE(started_at,CURRENT_TIMESTAMP),updated_at=CURRENT_TIMESTAMP WHERE id=?`)
    .bind(command.id).run();
  return { ...command, status: "processing" as const };
}

export async function completeEquipmentRegistryRemoval(
  db: D1DatabaseLike,
  commandId: string,
  result: { success: boolean; error?: string },
) {
  await ensureEquipmentEnrollmentStore(db);
  const command = await db.prepare("SELECT id,status FROM equipment_registry_removals WHERE id=?")
    .bind(commandId).first<{ id: string; status: string }>();
  if (!command) throw new EnrollmentConflict("La orden de baja del MIM no existe.");
  if (command.status === "completed" && result.success) return { completed: true };
  if (result.success) {
    await db.prepare(`UPDATE equipment_registry_removals SET status='completed',error=NULL,
      completed_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP WHERE id=?`).bind(commandId).run();
    return { completed: true };
  }
  await db.prepare(`UPDATE equipment_registry_removals SET status='pending',error=?,updated_at=CURRENT_TIMESTAMP WHERE id=?`)
    .bind((result.error ?? "La Raspberry no pudo quitar el MIM del identificador.").slice(0, 240), commandId).run();
  return { completed: false };
}

export async function requestEquipmentEnrollment(db: D1DatabaseLike, moduleId: string, details: {
  name: string;
  kind: "Tractor" | "Trilladora" | "Camión" | "Camioneta" | "Otro";
  validUntil: string;
}, actorId: string) {
  await ensureEquipmentEnrollmentStore(db);
  await ensureManagedEntityStore(db);
  const candidate = await db.prepare(`SELECT module_id AS moduleId,site_id AS siteId,claimed,last_seen AS lastSeen
    FROM equipment_enrollment_candidates WHERE module_id=?`).bind(moduleId)
    .first<{ moduleId: string; siteId: string; claimed: number; lastSeen: string }>();
  if (!candidate) throw new EnrollmentConflict("El módulo aún no ha sido detectado por esta Raspberry.");
  if (Date.now() - new Date(candidate.lastSeen).getTime() > 120_000) {
    throw new EnrollmentConflict("El módulo dejó de reportarse por Wi-Fi. Energízalo nuevamente.");
  }
  const registered = await db.prepare(`SELECT id,site_id AS siteId,active,expiry
      FROM managed_equipment WHERE module=? AND archived_at IS NULL ORDER BY updated_at DESC LIMIT 1`)
    .bind(moduleId).first<{ id: string; siteId: string; active: number; expiry: string | null }>();
  if (registered?.active === 0) throw new EnrollmentConflict("El módulo está desactivado administrativamente.");
  if (registered && registered.siteId === candidate.siteId
    && (!registered.expiry || new Date(registered.expiry).getTime() > Date.now())) {
    throw new EnrollmentConflict("Ese módulo ya tiene una asignación vigente en este fundo.");
  }
  const active = await db.prepare("SELECT id FROM equipment_enrollment_commands WHERE module_id=? AND status IN ('pending','enrolling') LIMIT 1")
    .bind(moduleId).first<{ id: string }>();
  if (active) return { commandId: active.id, accepted: true, existing: true };
  const commandId = `enr-${crypto.randomUUID()}`;
  const equipmentId = registered?.id ?? `eq-${crypto.randomUUID()}`;
  await db.batch([
    db.prepare(`INSERT INTO equipment_enrollment_commands(
      id,module_id,site_id,equipment_id,requested_name,kind,condition,valid_until,status,requested_by
    ) VALUES (?,?,?,?,?,?,'Temporal',?,'pending',?)`)
      .bind(commandId, moduleId, candidate.siteId, equipmentId, details.name, details.kind, details.validUntil, actorId),
    db.prepare("UPDATE equipment_enrollment_candidates SET status='pending',updated_at=CURRENT_TIMESTAMP WHERE module_id=?")
      .bind(moduleId),
  ]);
  return { commandId, accepted: true, existing: Boolean(registered) };
}

export async function takeEnrollmentCommand(db: D1DatabaseLike, moduleId: string) {
  await ensureEquipmentEnrollmentStore(db);
  const command = await db.prepare(`SELECT id,module_id AS moduleId,site_id AS siteId,equipment_id AS equipmentId,
      requested_name AS name,kind,condition,valid_until AS validUntil,status
    FROM equipment_enrollment_commands
    WHERE module_id=? AND status IN ('pending','enrolling') ORDER BY requested_at LIMIT 1`)
    .bind(moduleId).first<Record<string, unknown>>();
  if (!command) return null;
  if (command.status === "pending") {
    await db.batch([
      db.prepare("UPDATE equipment_enrollment_commands SET status='enrolling',error=NULL,updated_at=CURRENT_TIMESTAMP WHERE id=? AND status='pending'").bind(command.id),
      db.prepare("UPDATE equipment_enrollment_candidates SET status='enrolling',updated_at=CURRENT_TIMESTAMP WHERE module_id=?").bind(moduleId),
    ]);
  }
  return { ...command, status: "enrolling" };
}

export async function completeEnrollmentCommand(db: D1DatabaseLike, commandId: string, result: {
  success: boolean;
  error?: string;
}) {
  await ensureEquipmentEnrollmentStore(db);
  await ensureManagedEntityStore(db);
  const command = await db.prepare(`SELECT id,module_id AS moduleId,site_id AS siteId,equipment_id AS equipmentId,
      requested_name AS name,kind,condition,valid_until AS validUntil,status,requested_by AS requestedBy
    FROM equipment_enrollment_commands WHERE id=?`).bind(commandId).first<Record<string, unknown>>();
  if (!command) throw new EnrollmentConflict("La orden de enrolamiento no existe.");
  if (command.status === "completed") return { completed: true, equipmentId: String(command.equipmentId) };
  if (!result.success) {
    const error = (result.error ?? "No fue posible configurar el módulo por Wi-Fi").slice(0, 240);
    await db.batch([
      db.prepare("UPDATE equipment_enrollment_commands SET status='failed',error=?,updated_at=CURRENT_TIMESTAMP WHERE id=?").bind(error, commandId),
      db.prepare("UPDATE equipment_enrollment_candidates SET status='failed',updated_at=CURRENT_TIMESTAMP WHERE module_id=?").bind(command.moduleId),
    ]);
    return { completed: false, error };
  }
  const previous = await db.prepare("SELECT id FROM managed_equipment WHERE id=?").bind(command.equipmentId).first<{ id: string }>();
  await db.batch([
    db.prepare(`INSERT INTO managed_equipment(
      id,name,kind,condition,module,site_id,active,expiry
    ) VALUES (?,?,?,?,?,?,1,?)
    ON CONFLICT(id) DO UPDATE SET
      name=excluded.name,kind=excluded.kind,condition='Temporal',module=excluded.module,
      site_id=excluded.site_id,
      active=1,expiry=excluded.expiry,archived_at=NULL,updated_at=CURRENT_TIMESTAMP`)
      .bind(command.equipmentId, command.name, command.kind, command.condition, command.moduleId, command.siteId, command.validUntil),
    db.prepare(`UPDATE equipment_enrollment_commands SET
      status='completed',error=NULL,completed_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP WHERE id=?`).bind(commandId),
    db.prepare(`UPDATE equipment_enrollment_candidates SET
      equipment_id=?,device_name=?,claimed=1,status='enrolled',updated_at=CURRENT_TIMESTAMP
      WHERE module_id=?`).bind(command.equipmentId, command.name, command.moduleId),
    db.prepare(`INSERT INTO managed_entity_audit(actor_user_id,event,entity_type,entity_id,metadata)
      VALUES (?,?,?,?,?)`)
      .bind(command.requestedBy, previous ? "equipment_revalidated_wifi" : "equipment_enrolled_wifi", "equipment", command.equipmentId,
        JSON.stringify({ moduleId: command.moduleId, siteId: command.siteId, kind: command.kind, validUntil: command.validUntil })),
  ]);
  return { completed: true, equipmentId: String(command.equipmentId) };
}

async function ensureEnrollmentCommandColumns(db: D1DatabaseLike) {
  const columns = await db.prepare("PRAGMA table_info(equipment_enrollment_commands)").all<{ name: string }>();
  if (!columns.results.some((column) => column.name === "valid_until")) {
    await db.prepare("ALTER TABLE equipment_enrollment_commands ADD COLUMN valid_until TEXT").run();
  }
}

export class EnrollmentConflict extends Error {}
