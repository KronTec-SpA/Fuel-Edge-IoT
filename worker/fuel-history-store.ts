import type { D1DatabaseLike } from "./user-store";

export type FuelMovementType = "receipt" | "dispatch";

export type FuelMovement = {
  id: string;
  type: FuelMovementType;
  occurredAt: string;
  liters: number;
  openingLevel: number;
  closingLevel: number;
  source: string;
  reference: string;
  detail: string;
  operatorId?: string | null;
  operatorName?: string | null;
  equipmentId?: string | null;
  equipmentName?: string | null;
  isMaster?: boolean;
  detectedAutomatically: boolean;
  confidence: number;
  status: "confirmed" | "accumulating";
};

export type EdgeRuntimeStatus = {
  moduleId: string;
  siteId: string;
  state: string;
  relayEnergized: boolean;
  validatorOnline: boolean;
  nfcReady: boolean;
  k24Enabled: boolean;
  k24Healthy: boolean;
  tankLevelEnabled: boolean;
  occurredAt: string;
};

const CAPACITY_LITERS = 2500;
const RECEIPT_THRESHOLD_LITERS = 40;
const SENSOR_NOISE_LITERS = 8;
const initialized = new WeakSet<object>();
const initializing = new WeakMap<object, Promise<void>>();

export async function ensureFuelHistoryStore(db: D1DatabaseLike, seedDemo = false) {
  const marker = db as unknown as object;
  if (initialized.has(marker)) return;
  let pending = initializing.get(marker);
  if (!pending) {
    pending = (async () => {
      await db.batch([
        db.prepare(`CREATE TABLE IF NOT EXISTS fuel_history_meta (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        )`),
        db.prepare(`CREATE TABLE IF NOT EXISTS fuel_movements (
          id TEXT PRIMARY KEY,
          movement_type TEXT NOT NULL CHECK (movement_type IN ('receipt','dispatch')),
          occurred_at TEXT NOT NULL,
          liters REAL NOT NULL CHECK (liters >= 0),
          opening_level_liters REAL NOT NULL,
          closing_level_liters REAL NOT NULL,
          source TEXT NOT NULL,
          reference_id TEXT NOT NULL,
          detail TEXT NOT NULL DEFAULT '',
          operator_id TEXT,
          equipment_id TEXT,
          is_master INTEGER NOT NULL DEFAULT 0 CHECK(is_master IN (0,1)),
          detected_automatically INTEGER NOT NULL DEFAULT 0 CHECK (detected_automatically IN (0,1)),
          confidence REAL NOT NULL DEFAULT 1,
          detection_status TEXT NOT NULL DEFAULT 'confirmed' CHECK (detection_status IN ('confirmed','accumulating')),
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        )`),
        db.prepare("CREATE INDEX IF NOT EXISTS idx_fuel_movements_occurred ON fuel_movements(occurred_at)"),
        db.prepare("CREATE INDEX IF NOT EXISTS idx_fuel_movements_type_occurred ON fuel_movements(movement_type,occurred_at)"),
        db.prepare(`CREATE TABLE IF NOT EXISTS fuel_level_readings (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          occurred_at TEXT NOT NULL,
          level_liters REAL NOT NULL,
          source TEXT NOT NULL DEFAULT 'OCIO',
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        )`),
        db.prepare("CREATE INDEX IF NOT EXISTS idx_fuel_level_readings_occurred ON fuel_level_readings(occurred_at)"),
        db.prepare(`CREATE TABLE IF NOT EXISTS fuel_detection_state (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          capacity_liters REAL NOT NULL,
          baseline_level_liters REAL NOT NULL,
          last_level_liters REAL NOT NULL,
          peak_level_liters REAL NOT NULL,
          active_receipt_id TEXT,
          active_started_at TEXT,
          last_reading_at TEXT NOT NULL
        )`),
        db.prepare(`CREATE TABLE IF NOT EXISTS edge_runtime_status (
          id INTEGER PRIMARY KEY CHECK(id=1),
          module_id TEXT NOT NULL,
          site_id TEXT NOT NULL,
          state TEXT NOT NULL,
          relay_energized INTEGER NOT NULL CHECK(relay_energized IN (0,1)),
          validator_online INTEGER NOT NULL CHECK(validator_online IN (0,1)),
          nfc_ready INTEGER NOT NULL DEFAULT 0 CHECK(nfc_ready IN (0,1)),
          k24_enabled INTEGER NOT NULL DEFAULT 0 CHECK(k24_enabled IN (0,1)),
          k24_healthy INTEGER NOT NULL CHECK(k24_healthy IN (0,1)),
          tank_level_enabled INTEGER NOT NULL DEFAULT 0 CHECK(tank_level_enabled IN (0,1)),
          occurred_at TEXT NOT NULL
        )`),
      ]);
      const movementColumns = await db.prepare("PRAGMA table_info(fuel_movements)").all<{ name: string }>();
      for (const [name, definition] of [
        ["operator_id", "operator_id TEXT"],
        ["equipment_id", "equipment_id TEXT"],
        ["is_master", "is_master INTEGER NOT NULL DEFAULT 0 CHECK(is_master IN (0,1))"],
      ] as const) {
        if (!movementColumns.results.some((column) => column.name === name)) {
          await db.prepare(`ALTER TABLE fuel_movements ADD COLUMN ${definition}`).run();
        }
      }
      for (const column of [
        "nfc_ready INTEGER NOT NULL DEFAULT 0",
        "k24_enabled INTEGER NOT NULL DEFAULT 0",
        "tank_level_enabled INTEGER NOT NULL DEFAULT 0",
      ]) {
        try {
          await db.prepare(`ALTER TABLE edge_runtime_status ADD COLUMN ${column}`).run();
        } catch (error) {
          if (!(error instanceof Error) || !/duplicate column/i.test(error.message)) throw error;
        }
      }
      if (seedDemo) {
        await seedFuelHistory(db);
      } else {
        await db.prepare(`INSERT OR IGNORE INTO fuel_detection_state(
          id,capacity_liters,baseline_level_liters,last_level_liters,peak_level_liters,
          active_receipt_id,active_started_at,last_reading_at
        ) VALUES (1,?,0,0,0,NULL,NULL,'1970-01-01T00:00:00.000Z')`).bind(CAPACITY_LITERS).run();
      }
      await db.prepare("PRAGMA optimize").run();
      initialized.add(marker);
    })().finally(() => initializing.delete(marker));
    initializing.set(marker, pending);
  }
  await pending;
}

export async function listFuelMovements(db: D1DatabaseLike, from: string, toExclusive: string) {
  const result = await db.prepare(`SELECT
      movements.id,movements.movement_type AS type,movements.occurred_at AS occurredAt,movements.liters,
      movements.opening_level_liters AS openingLevel,movements.closing_level_liters AS closingLevel,
      movements.source,movements.reference_id AS reference,movements.detail,
      movements.operator_id AS operatorId,operators.name AS operatorName,
      movements.equipment_id AS equipmentId,equipment.name AS equipmentName,movements.is_master AS isMaster,
      movements.detected_automatically AS detectedAutomatically,movements.confidence,
      movements.detection_status AS status
    FROM fuel_movements AS movements
    LEFT JOIN managed_operators AS operators ON operators.id=movements.operator_id
    LEFT JOIN managed_equipment AS equipment ON equipment.id=movements.equipment_id
    WHERE movements.occurred_at >= ? AND movements.occurred_at < ?
    ORDER BY movements.occurred_at DESC
    LIMIT 5000`).bind(from, toExclusive).all<Record<string, unknown>>();
  return result.results.map(toMovement);
}

export async function fuelSensorState(db: D1DatabaseLike) {
  const state = await db.prepare(`SELECT capacity_liters AS capacityLiters,last_level_liters AS currentLevel,
      last_reading_at AS latestReadingAt,active_receipt_id AS activeReceiptId
    FROM fuel_detection_state WHERE id=1`).first<Record<string, unknown>>();
  return {
    capacityLiters: Number(state?.capacityLiters ?? CAPACITY_LITERS),
    currentLevel: Number(state?.currentLevel ?? 0),
    latestReadingAt: String(state?.latestReadingAt ?? ""),
    receiptThresholdLiters: RECEIPT_THRESHOLD_LITERS,
    detectionStatus: state?.activeReceiptId ? "detecting" : "monitoring",
  };
}

export async function edgeRuntimeStatus(db: D1DatabaseLike): Promise<EdgeRuntimeStatus | null> {
  const row = await db.prepare(`SELECT module_id AS moduleId,site_id AS siteId,state,
    relay_energized AS relayEnergized,validator_online AS validatorOnline,nfc_ready AS nfcReady,
    k24_enabled AS k24Enabled,k24_healthy AS k24Healthy,tank_level_enabled AS tankLevelEnabled,
    occurred_at AS occurredAt FROM edge_runtime_status WHERE id=1`).first<Record<string, unknown>>();
  if (!row) return null;
  return {
    moduleId: String(row.moduleId), siteId: String(row.siteId), state: String(row.state),
    relayEnergized: row.relayEnergized === 1, validatorOnline: row.validatorOnline === 1,
    nfcReady: row.nfcReady === 1, k24Enabled: row.k24Enabled === 1,
    k24Healthy: row.k24Healthy === 1, tankLevelEnabled: row.tankLevelEnabled === 1,
    occurredAt: String(row.occurredAt),
  };
}

export async function resetFuelHistoryStore(db: D1DatabaseLike, actorUserId: string) {
  const [movementCount, readingCount] = await Promise.all([
    db.prepare("SELECT COUNT(*) AS total FROM fuel_movements").first<{ total: number }>(),
    db.prepare("SELECT COUNT(*) AS total FROM fuel_level_readings").first<{ total: number }>(),
  ]);
  const resetAt = new Date().toISOString();
  const deleted = {
    movements: Number(movementCount?.total ?? 0),
    readings: Number(readingCount?.total ?? 0),
  };
  await db.batch([
    db.prepare("DELETE FROM fuel_movements"),
    db.prepare("DELETE FROM fuel_level_readings"),
    db.prepare(`UPDATE fuel_detection_state SET
      capacity_liters=?,baseline_level_liters=0,last_level_liters=0,peak_level_liters=0,
      active_receipt_id=NULL,active_started_at=NULL,last_reading_at='1970-01-01T00:00:00.000Z'
      WHERE id=1`).bind(CAPACITY_LITERS),
    db.prepare(`INSERT INTO fuel_history_meta(key,value) VALUES ('seed_version','2')
      ON CONFLICT(key) DO UPDATE SET value=excluded.value`),
    db.prepare(`INSERT INTO fuel_history_meta(key,value) VALUES ('field_reset_at',?)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value`).bind(resetAt),
    db.prepare(`INSERT INTO web_access_audit(actor_user_id,event,target_user_id,metadata)
      VALUES (?,'fuel_history_reset',NULL,?)`).bind(actorUserId, JSON.stringify({ ...deleted, resetAt })),
  ]);
  return { resetAt, deleted };
}

export async function ingestEdgeRuntimeStatus(db: D1DatabaseLike, body: Record<string, unknown>) {
  const moduleId = boundedText(body.moduleId, 80); const siteId = boundedText(body.siteId, 80);
  const state = boundedText(body.state, 40); const timestamp = typeof body.occurredAt === "string" ? new Date(body.occurredAt) : new Date(Number.NaN);
  if (!moduleId || !siteId || !state || typeof body.relayEnergized !== "boolean" || typeof body.validatorOnline !== "boolean" || typeof body.nfcReady !== "boolean" || typeof body.k24Enabled !== "boolean" || typeof body.k24Healthy !== "boolean" || typeof body.tankLevelEnabled !== "boolean" || Number.isNaN(timestamp.getTime()) || timestamp.getTime() > Date.now() + 5 * 60_000) {
    throw new Error("Estado del controlador inválido.");
  }
  await db.prepare(`INSERT INTO edge_runtime_status(id,module_id,site_id,state,relay_energized,validator_online,nfc_ready,k24_enabled,k24_healthy,tank_level_enabled,occurred_at)
    VALUES (1,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET module_id=excluded.module_id,site_id=excluded.site_id,
    state=excluded.state,relay_energized=excluded.relay_energized,validator_online=excluded.validator_online,
    nfc_ready=excluded.nfc_ready,k24_enabled=excluded.k24_enabled,k24_healthy=excluded.k24_healthy,
    tank_level_enabled=excluded.tank_level_enabled,occurred_at=excluded.occurred_at`).bind(
      moduleId, siteId, state, Number(body.relayEnergized), Number(body.validatorOnline), Number(body.nfcReady),
      Number(body.k24Enabled), Number(body.k24Healthy), Number(body.tankLevelEnabled), timestamp.toISOString(),
    ).run();
  return { recorded: true };
}

export async function ingestFuelLevelReading(db: D1DatabaseLike, levelLiters: number, occurredAt: string, source = "OCIO") {
  if (!Number.isFinite(levelLiters) || levelLiters < 0 || levelLiters > CAPACITY_LITERS) {
    throw new Error(`El nivel debe estar entre 0 y ${CAPACITY_LITERS} litros.`);
  }
  const timestamp = new Date(occurredAt);
  if (Number.isNaN(timestamp.getTime())) throw new Error("La fecha de lectura no es válida.");
  if (timestamp.getTime() > Date.now() + 5 * 60_000) throw new Error("La lectura no puede estar en el futuro.");
  const iso = timestamp.toISOString();
  await assertAfterFieldReset(db, iso);
  const normalizedSource = source.trim().slice(0, 80) || "OCIO";
  const duplicate = await db.prepare(`SELECT level_liters AS levelLiters,source
    FROM fuel_level_readings WHERE occurred_at=? ORDER BY id DESC LIMIT 1`).bind(iso).first<Record<string, unknown>>();
  if (duplicate) {
    if (round1(Number(duplicate.levelLiters)) === round1(levelLiters) && String(duplicate.source) === normalizedSource) {
      return { status: "duplicate", receiptId: null, detectedLiters: 0, levelLiters: round1(levelLiters), occurredAt: iso };
    }
    throw new Error("Ya existe otra lectura con la misma fecha.");
  }
  const state = await db.prepare(`SELECT baseline_level_liters AS baseline,last_level_liters AS lastLevel,
      peak_level_liters AS peak,active_receipt_id AS activeId,active_started_at AS activeStartedAt,
      last_reading_at AS lastReadingAt FROM fuel_detection_state WHERE id=1`).first<Record<string, unknown>>();
  if (!state) throw new Error("El detector de nivel no está inicializado.");
  if (iso <= String(state.lastReadingAt)) throw new Error("La lectura es anterior a la última muestra registrada.");

  if (String(state.lastReadingAt) === "1970-01-01T00:00:00.000Z") {
    await db.batch([
      db.prepare("INSERT INTO fuel_level_readings(occurred_at,level_liters,source) VALUES (?,?,?)")
        .bind(iso, round1(levelLiters), normalizedSource),
      db.prepare(`UPDATE fuel_detection_state SET baseline_level_liters=?,last_level_liters=?,peak_level_liters=?,
        active_receipt_id=NULL,active_started_at=NULL,last_reading_at=? WHERE id=1`)
        .bind(round1(levelLiters), round1(levelLiters), round1(levelLiters), iso),
    ]);
    return { status: "initialized", receiptId: null, detectedLiters: 0, levelLiters: round1(levelLiters), occurredAt: iso };
  }

  const baseline = Number(state.baseline);
  const lastLevel = Number(state.lastLevel);
  const peak = Number(state.peak);
  const activeId = state.activeId ? String(state.activeId) : null;
  const riseFromBaseline = levelLiters - baseline;
  const deltaFromLast = levelLiters - lastLevel;
  const activeMinutes = state.activeStartedAt
    ? (timestamp.getTime() - new Date(String(state.activeStartedAt)).getTime()) / 60000
    : 0;
  let receiptId = activeId;
  let detectedLiters = 0;
  let status: "none" | "started" | "updated" | "confirmed" = "none";

  await db.prepare("INSERT INTO fuel_level_readings(occurred_at,level_liters,source) VALUES (?,?,?)")
    .bind(iso, round1(levelLiters), normalizedSource).run();

  if (!activeId && riseFromBaseline >= RECEIPT_THRESHOLD_LITERS) {
    receiptId = `FR-AUTO-${crypto.randomUUID()}`;
    detectedLiters = round1(riseFromBaseline);
    await db.prepare(`INSERT INTO fuel_movements(
        id,movement_type,occurred_at,liters,opening_level_liters,closing_level_liters,
        source,reference_id,detail,detected_automatically,confidence,detection_status
      ) VALUES (?,'receipt',?,?,?,?,? ,?,'Aumento de nivel detectado por el sensor del estanque',1,0.96,'accumulating')`)
      .bind(receiptId, iso, detectedLiters, round1(baseline), round1(levelLiters), normalizedSource, `AUTO-${iso.slice(0, 16)}`).run();
    status = "started";
  } else if (activeId && levelLiters > peak + SENSOR_NOISE_LITERS) {
    detectedLiters = round1(levelLiters - baseline);
    await db.prepare(`UPDATE fuel_movements SET liters=?,closing_level_liters=?,confidence=0.98 WHERE id=?`)
      .bind(detectedLiters, round1(levelLiters), activeId).run();
    status = "updated";
  } else if (activeId && Math.abs(deltaFromLast) <= SENSOR_NOISE_LITERS && activeMinutes >= 10) {
    await db.prepare("UPDATE fuel_movements SET detection_status='confirmed',confidence=0.99 WHERE id=?").bind(activeId).run();
    receiptId = null;
    status = "confirmed";
  } else if (activeId && deltaFromLast < -SENSOR_NOISE_LITERS) {
    await db.prepare("UPDATE fuel_movements SET detection_status='confirmed',confidence=0.99 WHERE id=?").bind(activeId).run();
    receiptId = null;
    status = "confirmed";
  }

  const nextBaseline = receiptId ? baseline : !activeId && riseFromBaseline > SENSOR_NOISE_LITERS ? baseline : levelLiters;
  const nextPeak = receiptId ? Math.max(peak, levelLiters) : levelLiters;
  await db.prepare(`UPDATE fuel_detection_state SET baseline_level_liters=?,last_level_liters=?,peak_level_liters=?,
      active_receipt_id=?,active_started_at=?,last_reading_at=? WHERE id=1`)
    .bind(round1(nextBaseline), round1(levelLiters), round1(nextPeak), receiptId,
      receiptId ? String(state.activeStartedAt ?? iso) : null, iso).run();
  return { status, receiptId, detectedLiters, levelLiters: round1(levelLiters), occurredAt: iso };
}

type EdgeFuelMovementInput = {
  id?: unknown;
  type?: unknown;
  occurredAt?: unknown;
  liters?: unknown;
  source?: unknown;
  reference?: unknown;
  detail?: unknown;
  operatorId?: unknown;
  equipmentId?: unknown;
  isMaster?: unknown;
  unauthorized?: unknown;
};

export async function ingestEdgeFuelMovement(db: D1DatabaseLike, input: EdgeFuelMovementInput) {
  const id = boundedText(input.id, 128);
  if (!id || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(id)) throw new Error("El identificador del despacho no es válido.");
  if (input.type !== "dispatch") throw new Error("El canal edge sólo acepta despachos del PLC.");
  if (typeof input.liters !== "number" || !Number.isFinite(input.liters) || input.liters <= 0 || input.liters > CAPACITY_LITERS) {
    throw new Error(`El despacho debe estar entre 0 y ${CAPACITY_LITERS} litros.`);
  }
  if (typeof input.occurredAt !== "string") throw new Error("La fecha del despacho no es válida.");
  const timestamp = new Date(input.occurredAt);
  if (Number.isNaN(timestamp.getTime())) throw new Error("La fecha del despacho no es válida.");
  if (timestamp.getTime() > Date.now() + 5 * 60_000) throw new Error("El despacho no puede estar en el futuro.");
  await assertAfterFieldReset(db, timestamp.toISOString());
  const existing = await db.prepare(`SELECT
      id,movement_type AS type,occurred_at AS occurredAt,liters,
      opening_level_liters AS openingLevel,closing_level_liters AS closingLevel,
      source,reference_id AS reference,detail,operator_id AS operatorId,equipment_id AS equipmentId,
      is_master AS isMaster,detected_automatically AS detectedAutomatically,
      confidence,detection_status AS status FROM fuel_movements WHERE id=?`).bind(id).first<Record<string, unknown>>();
  const operatorId = optionalIdentifier(input.operatorId);
  const equipmentId = optionalIdentifier(input.equipmentId);
  if (input.operatorId != null && !operatorId) throw new Error("El operador del despacho no es válido.");
  if (input.equipmentId != null && !equipmentId) throw new Error("El equipo del despacho no es válido.");
  if (typeof input.isMaster !== "undefined" && typeof input.isMaster !== "boolean") {
    throw new Error("La condición de tarjeta maestra no es válida.");
  }
  if (typeof input.unauthorized !== "undefined" && typeof input.unauthorized !== "boolean") {
    throw new Error("La condición de flujo no autorizado no es válida.");
  }
  const isMaster = input.isMaster === true;
  const unauthorized = input.unauthorized === true;
  if (isMaster && !operatorId) throw new Error("Un despacho con tarjeta maestra requiere un operador responsable.");
  if (existing) {
    const movement = toMovement(existing);
    if (
      movement.type !== "dispatch"
      || movement.occurredAt !== timestamp.toISOString()
      || movement.liters !== round1(input.liters)
      || movement.operatorId !== operatorId
      || movement.equipmentId !== equipmentId
      || movement.isMaster !== isMaster
      || movement.detectedAutomatically !== unauthorized
    ) throw new Error("El identificador del despacho ya pertenece a otro movimiento.");
    return { created: false, movement };
  }

  const state = await db.prepare(`SELECT baseline_level_liters AS baseline,last_level_liters AS lastLevel,
      peak_level_liters AS peak,active_receipt_id AS activeId FROM fuel_detection_state WHERE id=1`)
    .first<Record<string, unknown>>();
  if (!state) throw new Error("El detector de nivel no está inicializado.");
  const liters = round3(input.liters);
  const opening = round1(Math.max(0, Number(state.lastLevel)));
  const closing = round1(Math.max(0, opening - liters));
  const baseDetail = boundedText(input.detail, 200);
  const closeReason = boundedText((input as EdgeFuelMovementInput & { closeReason?: unknown }).closeReason, 80);
  const movementDetail = closeReason ? `${baseDetail} · Cierre: ${closeReason}`.slice(0, 240) : baseDetail;
  if (state.activeId) {
    await db.prepare("UPDATE fuel_movements SET detection_status='confirmed',confidence=0.99 WHERE id=?")
      .bind(String(state.activeId)).run();
  }
  await db.batch([
    db.prepare(`INSERT INTO fuel_movements(
      id,movement_type,occurred_at,liters,opening_level_liters,closing_level_liters,
      source,reference_id,detail,operator_id,equipment_id,is_master,detected_automatically,confidence,detection_status
    ) VALUES (?,'dispatch',?,?,?,?,?,?,?,?,?,?,?,1,'confirmed')`).bind(
      id,
      timestamp.toISOString(),
      liters,
      opening,
      closing,
      boundedText(input.source, 80) || "K24 + PLC",
      boundedText(input.reference, 128) || id,
      movementDetail,
      operatorId,
      equipmentId,
      Number(isMaster),
      Number(unauthorized),
    ),
    db.prepare(`UPDATE fuel_detection_state SET baseline_level_liters=?,last_level_liters=?,peak_level_liters=?,
      active_receipt_id=NULL,active_started_at=NULL WHERE id=1`).bind(closing, closing, closing),
  ]);
  const movement = await db.prepare(`SELECT
      id,movement_type AS type,occurred_at AS occurredAt,liters,
      opening_level_liters AS openingLevel,closing_level_liters AS closingLevel,
      source,reference_id AS reference,detail,operator_id AS operatorId,equipment_id AS equipmentId,
      is_master AS isMaster,detected_automatically AS detectedAutomatically,
      confidence,detection_status AS status FROM fuel_movements WHERE id=?`).bind(id).first<Record<string, unknown>>();
  return { created: true, movement: movement ? toMovement(movement) : null };
}

async function assertAfterFieldReset(db: D1DatabaseLike, occurredAt: string) {
  const reset = await db.prepare("SELECT value FROM fuel_history_meta WHERE key='field_reset_at'")
    .first<{ value: string }>();
  if (reset?.value && occurredAt <= reset.value) {
    throw new Error("El registro es anterior al inicio en terreno y fue descartado.");
  }
}

async function seedFuelHistory(db: D1DatabaseLike) {
  const seeded = await db.prepare("SELECT value FROM fuel_history_meta WHERE key='seed_version'").first<{ value: string }>();
  if (seeded?.value === "2") return;
  const movements = buildSeedMovements();
  const latest = movements.at(-1)?.closingLevel ?? 1600;
  await db.batch([
    ...(seeded ? [db.prepare("DELETE FROM fuel_movements WHERE id IN ('FD-202608-2','FD-202608-3','FD-202608-4')")] : []),
    ...movements.map((item) => db.prepare(`INSERT OR IGNORE INTO fuel_movements(
      id,movement_type,occurred_at,liters,opening_level_liters,closing_level_liters,
      source,reference_id,detail,detected_automatically,confidence,detection_status
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,'confirmed')`).bind(
      item.id, item.type, item.occurredAt, item.liters, item.openingLevel, item.closingLevel,
      item.source, item.reference, item.detail, Number(item.detectedAutomatically), item.confidence,
    )),
    db.prepare(`INSERT OR REPLACE INTO fuel_detection_state(
      id,capacity_liters,baseline_level_liters,last_level_liters,peak_level_liters,active_receipt_id,active_started_at,last_reading_at
    ) VALUES (1,?,?,?,?,NULL,NULL,?)`).bind(CAPACITY_LITERS, latest, latest, latest, "2026-08-10T14:30:00.000Z"),
    ...(!seeded ? [db.prepare("INSERT INTO fuel_level_readings(occurred_at,level_liters,source) VALUES (?,?,?)")
      .bind("2026-08-10T14:30:00.000Z", latest, "OCIO")] : []),
    db.prepare("INSERT OR REPLACE INTO fuel_history_meta(key,value) VALUES ('seed_version','2')"),
  ]);
}

function buildSeedMovements(): FuelMovement[] {
  const output: FuelMovement[] = [];
  let level = 780;
  for (let monthIndex = 0; monthIndex < 13; monthIndex += 1) {
    const date = new Date(Date.UTC(2025, 7 + monthIndex, 1, 12));
    const year = date.getUTCFullYear();
    const month = date.getUTCMonth();
    const monthKey = `${year}${String(month + 1).padStart(2, "0")}`;
    const requestedReceipt = 980 + ((monthIndex * 73) % 230);
    const received = Math.min(requestedReceipt, 2360 - level);
    const receiptOpening = level;
    level = round1(level + received);
    output.push({
      id: `FR-${monthKey}`, type: "receipt", occurredAt: new Date(Date.UTC(year, month, 3, 15, 20)).toISOString(),
      liters: round1(received), openingLevel: round1(receiptOpening), closingLevel: level,
      source: "Sensor OCIO", reference: `AUTO-OCIO-${monthKey}`,
      detail: "Recepción detectada por aumento sostenido del nivel", detectedAutomatically: true, confidence: 0.99, status: "confirmed",
    });
    [7, 13, 19, 25].forEach((day, dispatchIndex) => {
      const liters = 172 + ((monthIndex * 31 + dispatchIndex * 47) % 88);
      const opening = level;
      level = round1(Math.max(180, level - liters));
      output.push({
        id: `FD-${monthKey}-${dispatchIndex + 1}`, type: "dispatch", occurredAt: new Date(Date.UTC(year, month, day, 14 + dispatchIndex, 10)).toISOString(),
        liters: round1(opening - level), openingLevel: round1(opening), closingLevel: level,
        source: "PLC surtidor", reference: `TX-${monthKey}-${String(dispatchIndex + 1).padStart(3, "0")}`,
        detail: `${5 + dispatchIndex * 2} cargas trazables consolidadas`, detectedAutomatically: false, confidence: 1, status: "confirmed",
      });
    });
  }
  const cutoff = "2026-08-10T23:59:59.999Z";
  const actual = output.filter((item) => item.occurredAt <= cutoff).sort((a, b) => a.occurredAt.localeCompare(b.occurredAt));
  level = actual.at(-1)?.closingLevel ?? level;
  const recentDispatches = [
    ["2026-08-09T15:25:00.000Z", 59.4, "TX-260809-010", "Daniela Rojas · Tractor New Holland T7"],
    ["2026-08-09T19:10:00.000Z", 77.9, "TX-260809-011", "Carlos Muñoz · Cosechadora contratista"],
    ["2026-08-09T21:32:00.000Z", 61.5, "TX-260809-012", "Mauricio Salas · Tractor John Deere 6155M"],
    ["2026-08-10T10:20:00.000Z", 198.9, "TX-260810-001-003", "3 cargas trazables consolidadas"],
    ["2026-08-10T10:58:00.000Z", 23.1, "TX-260810-004", "Pedro Coloma · Carga excepcional"],
    ["2026-08-10T11:32:00.000Z", 41.2, "TX-260810-005", "Mauricio Salas · Pulverizador Jacto Uniport"],
    ["2026-08-10T12:16:00.000Z", 54.8, "TX-260810-006", "Daniela Rojas · Tractor John Deere 6155M"],
    ["2026-08-10T13:44:00.000Z", 68.4, "TX-260810-007", "Carlos Muñoz · Tractor New Holland T7"],
  ] as const;
  recentDispatches.forEach(([occurredAt, liters, reference, detail], index) => {
    const opening = level;
    level = round1(Math.max(0, level - liters));
    actual.push({
      id: `FD-RECENT-${index + 1}`, type: "dispatch", occurredAt, liters, openingLevel: round1(opening), closingLevel: level,
      source: "PLC surtidor", reference, detail, detectedAutomatically: false, confidence: 1, status: "confirmed",
    });
  });
  return actual;
}

function toMovement(row: Record<string, unknown>): FuelMovement {
  return {
    id: String(row.id), type: row.type as FuelMovementType, occurredAt: String(row.occurredAt),
    liters: Number(row.liters), openingLevel: Number(row.openingLevel), closingLevel: Number(row.closingLevel),
    source: String(row.source), reference: String(row.reference), detail: String(row.detail),
    operatorId: typeof row.operatorId === "string" && row.operatorId ? row.operatorId : null,
    operatorName: typeof row.operatorName === "string" && row.operatorName ? row.operatorName : null,
    equipmentId: typeof row.equipmentId === "string" && row.equipmentId ? row.equipmentId : null,
    equipmentName: typeof row.equipmentName === "string" && row.equipmentName ? row.equipmentName : null,
    isMaster: row.isMaster === 1 || row.isMaster === true,
    detectedAutomatically: row.detectedAutomatically === 1, confidence: Number(row.confidence),
    status: row.status === "accumulating" ? "accumulating" : "confirmed",
  };
}

function round1(value: number) { return Math.round(value * 10) / 10; }
function round3(value: number) { return Math.round(value * 1000) / 1000; }
function boundedText(value: unknown, max: number) { return typeof value === "string" ? value.trim().slice(0, max) : ""; }
function optionalIdentifier(value: unknown) {
  if (value === null || typeof value === "undefined" || value === "") return null;
  if (typeof value !== "string") return null;
  const identifier = value.trim();
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(identifier) ? identifier : null;
}
