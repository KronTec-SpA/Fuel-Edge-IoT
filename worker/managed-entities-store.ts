import type { D1DatabaseLike } from "./user-store";

export type ManagedEntityType = "operators" | "equipment" | "associations";

const initialized = new WeakSet<object>();
const initializing = new WeakMap<object, Promise<void>>();

export async function ensureManagedEntityStore(db: D1DatabaseLike, seedDemo = false) {
  const marker = db as unknown as object;
  if (initialized.has(marker)) return;
  let pending = initializing.get(marker);
  if (!pending) {
    pending = (async () => {
      await db.batch([
    db.prepare(`CREATE TABLE IF NOT EXISTS managed_store_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS managed_operators (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      rut TEXT NOT NULL,
      credential TEXT NOT NULL,
      credential_active INTEGER NOT NULL DEFAULT 1 CHECK (credential_active IN (0,1)),
      credential_is_master INTEGER NOT NULL DEFAULT 0 CHECK (credential_is_master IN (0,1)),
      active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
      last_use TEXT NOT NULL DEFAULT 'Sin actividad',
      archived_at TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`),
    db.prepare("CREATE INDEX IF NOT EXISTS idx_managed_operators_archived ON managed_operators(archived_at)"),
    db.prepare(`CREATE TABLE IF NOT EXISTS managed_rfid_credentials (
      credential_id TEXT PRIMARY KEY,
      credential_active INTEGER NOT NULL DEFAULT 1 CHECK (credential_active IN (0,1)),
      credential_is_master INTEGER NOT NULL DEFAULT 0 CHECK (credential_is_master IN (0,1)),
      operator_id TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS managed_equipment (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      kind TEXT NOT NULL,
      condition TEXT NOT NULL CHECK (condition IN ('Permanente','Temporal','Externo')),
      module TEXT NOT NULL,
      site_id TEXT NOT NULL DEFAULT '',
      active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
      expiry TEXT,
      archived_at TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS managed_associations (
      id TEXT PRIMARY KEY,
      operator_id TEXT NOT NULL,
      equipment_id TEXT NOT NULL,
      active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
      since TEXT NOT NULL,
      archived_at TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`),
    db.prepare("CREATE INDEX IF NOT EXISTS idx_managed_associations_archived ON managed_associations(archived_at)"),
    db.prepare("CREATE INDEX IF NOT EXISTS idx_managed_associations_operator ON managed_associations(operator_id)"),
    db.prepare("CREATE INDEX IF NOT EXISTS idx_managed_associations_equipment ON managed_associations(equipment_id)"),
    db.prepare(`CREATE TABLE IF NOT EXISTS managed_entity_audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      actor_user_id TEXT NOT NULL,
      event TEXT NOT NULL,
      entity_type TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      occurred_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      metadata TEXT NOT NULL DEFAULT '{}'
    )`),
    db.prepare("CREATE INDEX IF NOT EXISTS idx_managed_entity_audit_occurred ON managed_entity_audit(occurred_at)"),
      ]);
      await ensureManagedOperatorColumns(db);
      await ensureManagedEquipmentColumns(db);
      await db.batch([
        db.prepare(`CREATE UNIQUE INDEX IF NOT EXISTS idx_managed_operators_single_active_master
          ON managed_operators(credential_is_master)
          WHERE credential_is_master=1 AND credential_active=1 AND archived_at IS NULL`),
        db.prepare(`CREATE UNIQUE INDEX IF NOT EXISTS idx_managed_rfid_one_per_operator
          ON managed_rfid_credentials(operator_id) WHERE operator_id IS NOT NULL`),
        db.prepare(`CREATE UNIQUE INDEX IF NOT EXISTS idx_managed_rfid_single_active_master
          ON managed_rfid_credentials(credential_is_master)
          WHERE credential_is_master=1 AND credential_active=1`),
        db.prepare("CREATE INDEX IF NOT EXISTS idx_managed_rfid_operator ON managed_rfid_credentials(operator_id)"),
        db.prepare("CREATE INDEX IF NOT EXISTS idx_managed_equipment_archived ON managed_equipment(archived_at)"),
        db.prepare("CREATE INDEX IF NOT EXISTS idx_managed_equipment_module_site_expiry ON managed_equipment(module,site_id,expiry)"),
      ]);
      await db.prepare(`INSERT OR IGNORE INTO managed_rfid_credentials(
        credential_id,credential_active,credential_is_master,operator_id,created_at,updated_at
      ) SELECT credential,credential_active,credential_is_master,id,created_at,updated_at
        FROM managed_operators WHERE credential LIKE 'nfc-%'`).run();
      if (seedDemo) await seedManagedEntities(db);
      await db.prepare("PRAGMA optimize").run();
      initialized.add(marker);
    })().finally(() => initializing.delete(marker));
    initializing.set(marker, pending);
  }
  await pending;
}

async function seedManagedEntities(db: D1DatabaseLike) {
  const seeded = await db.prepare("SELECT value FROM managed_store_meta WHERE key='seed_version'").first<{ value: string }>();
  if (seeded) return;
  const operators = [
    ["op-01", "Carlos Muñoz", "15.842.611-7", "NFC-0421", 1, "Hoy, 09:44"],
    ["op-02", "Daniela Rojas", "17.208.493-2", "NFC-0422", 1, "Hoy, 08:16"],
    ["op-03", "Mauricio Salas", "13.774.850-5", "NFC-0424", 1, "Ayer, 17:32"],
    ["op-04", "Rodrigo Araya", "16.441.272-1", "Sin enrolar", 0, "Sin actividad"],
  ];
  const equipment = [
    ["eq-01", "Tractor New Holland T7", "Tractor", "Permanente", "KT-MOD-0018", "site-santa-isabel", 1, null],
    ["eq-02", "Tractor John Deere 6155M", "Tractor", "Permanente", "KT-MOD-0021", "site-santa-isabel", 1, null],
    ["eq-03", "Trilladora contratista", "Trilladora", "Temporal", "KT-MOD-0024", "site-santa-isabel", 1, "2026-08-28T23:59:00.000Z"],
    ["eq-04", "Cuatrimoto de inspección", "Cuatrimoto", "Temporal", "KT-MOD-0032", "site-santa-isabel", 1, "2026-08-28T23:59:00.000Z"],
    ["eq-05", "Tractor auxiliar", "Tractor", "Externo", "Sin módulo", "", 0, null],
  ];
  const associations = [
    ["as-01", "op-01", "eq-01", 1, "12 mar 2026"],
    ["as-02", "op-01", "eq-04", 1, "05 ago 2026"],
    ["as-03", "op-02", "eq-02", 1, "18 abr 2026"],
    ["as-04", "op-03", "eq-03", 1, "02 may 2026"],
  ];
  await db.batch([
    ...operators.map((item) => db.prepare(`INSERT OR IGNORE INTO managed_operators(id,name,rut,credential,active,last_use)
      VALUES (?,?,?,?,?,?)`).bind(...item)),
    ...equipment.map((item) => db.prepare(`INSERT OR IGNORE INTO managed_equipment(id,name,kind,condition,module,site_id,active,expiry)
      VALUES (?,?,?,?,?,?,?,?)`).bind(...item)),
    ...associations.map((item) => db.prepare(`INSERT OR IGNORE INTO managed_associations(id,operator_id,equipment_id,active,since)
      VALUES (?,?,?,?,?)`).bind(...item)),
    db.prepare("INSERT OR REPLACE INTO managed_store_meta(key,value) VALUES ('seed_version','1')"),
  ]);
}

export async function listManagedEntities(db: D1DatabaseLike) {
  const [operators, equipment, associations] = await Promise.all([
    db.prepare(`SELECT id,name,rut,credential,credential_active AS credentialActive,
      credential_is_master AS credentialIsMaster,active,last_use AS lastUse,archived_at AS archivedAt
      FROM managed_operators ORDER BY archived_at IS NOT NULL, name COLLATE NOCASE`).all<Record<string, unknown>>(),
    db.prepare(`SELECT id,name,kind,condition,module,site_id AS siteId,active,expiry,archived_at AS archivedAt
      FROM managed_equipment ORDER BY archived_at IS NOT NULL, name COLLATE NOCASE`).all<Record<string, unknown>>(),
    db.prepare(`SELECT id,operator_id AS operatorId,equipment_id AS equipmentId,active,since,archived_at AS archivedAt
      FROM managed_associations ORDER BY archived_at IS NOT NULL, created_at DESC`).all<Record<string, unknown>>(),
  ]);
  return {
    operators: operators.results.map((item) => ({
      ...item,
      active: item.active === 1,
      credentialActive: item.credentialActive === 1,
      credentialIsMaster: item.credentialIsMaster === 1,
    })),
    equipment: equipment.results.map((item) => ({
      ...item,
      active: item.active === 1,
      assignmentExpired: assignmentExpired(item.expiry),
      assignmentExpiringSoon: assignmentExpiringSoon(item.expiry),
    })),
    associations: associations.results.map((item) => ({ ...item, active: item.active === 1 })),
  };
}

async function ensureManagedOperatorColumns(db: D1DatabaseLike) {
  const columns = await db.prepare("PRAGMA table_info(managed_operators)").all<{ name: string }>();
  if (!columns.results.some((column) => column.name === "credential_active")) {
    await db.prepare("ALTER TABLE managed_operators ADD COLUMN credential_active INTEGER NOT NULL DEFAULT 1 CHECK (credential_active IN (0,1))").run();
  }
  if (!columns.results.some((column) => column.name === "credential_is_master")) {
    await db.prepare("ALTER TABLE managed_operators ADD COLUMN credential_is_master INTEGER NOT NULL DEFAULT 0 CHECK (credential_is_master IN (0,1))").run();
  }
}

async function ensureManagedEquipmentColumns(db: D1DatabaseLike) {
  const columns = await db.prepare("PRAGMA table_info(managed_equipment)").all<{ name: string }>();
  if (!columns.results.some((column) => column.name === "site_id")) {
    await db.prepare("ALTER TABLE managed_equipment ADD COLUMN site_id TEXT NOT NULL DEFAULT ''").run();
  }
}

function assignmentExpired(value: unknown) {
  if (typeof value !== "string" || !value) return false;
  const instant = new Date(value).getTime();
  return Number.isFinite(instant) && instant <= Date.now();
}

function assignmentExpiringSoon(value: unknown) {
  if (typeof value !== "string" || !value) return false;
  const remaining = new Date(value).getTime() - Date.now();
  return Number.isFinite(remaining) && remaining > 0 && remaining <= 24 * 60 * 60 * 1000;
}

export async function recordManagedAudit(db: D1DatabaseLike, actorId: string, event: string, type: ManagedEntityType, id: string, metadata: object = {}) {
  await db.prepare(`INSERT INTO managed_entity_audit(actor_user_id,event,entity_type,entity_id,metadata)
    VALUES (?,?,?,?,?)`).bind(actorId, event, type, id, JSON.stringify(metadata)).run();
}
