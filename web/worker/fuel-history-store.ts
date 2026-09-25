import type { D1DatabaseLike } from "./user-store";
import { TANK_CAPACITY_LITERS as CAPACITY_LITERS } from "../shared/tank-capacity";

export type FuelMovementType = "receipt" | "dispatch";
export type FuelMovementClassification = "standard" | "pump_enablement";
export type ReceiptReviewStatus = "not_required" | "pending" | "approved" | "corrected" | "rejected";
export type AuthorizationEvidence = "full" | "rfid_only" | "assisted" | "master" | "unauthorized" | "legacy";
export type MovementAdoptionStage = "assisted" | "rfid_only" | "full";

export type FuelMovement = {
  id: string;
  type: FuelMovementType;
  classification: FuelMovementClassification;
  occurredAt: string;
  liters: number;
  openingLevel: number;
  closingLevel: number;
  source: string;
  reference: string;
  legacyId?: string | null;
  manualModeSessionId?: string | null;
  detail: string;
  operatorId?: string | null;
  operatorName?: string | null;
  equipmentId?: string | null;
  equipmentName?: string | null;
  isMaster?: boolean;
  authorizationEvidence: AuthorizationEvidence;
  adoptionStage: MovementAdoptionStage | null;
  assistedMode: boolean;
  equipmentIssue: string | null;
  detectedAutomatically: boolean;
  confidence: number;
  status: "confirmed" | "accumulating";
  reviewStatus: ReceiptReviewStatus;
  originalLiters: number | null;
  documentReference: string | null;
  reviewedByUserId: string | null;
  reviewedByName: string | null;
  reviewedAt: string | null;
  reviewNote: string | null;
};

export type ReceiptReviewActor = { id: string; name: string };

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
  telemetrySessionId: string | null;
  technologyAdoptionStage: MovementAdoptionStage;
  adoptionPolicyRevision: number;
  occurredAt: string;
};

const PUMP_ENABLEMENT_THRESHOLD_LITERS = 0.12;
const RECEIPT_THRESHOLD_LITERS = 100;
const HIGH_CONFIDENCE_RECEIPT_LITERS = 120;
// La recepción se reconoce por su forma temporal: subida breve y una nueva
// meseta sostenida. La tolerancia de 2 % del OCIO equivale a 50 L en este
// estanque; por eso una oscilación de ese orden no abre ni confirma un registro.
const STABLE_PLATEAU_TOLERANCE_LITERS = 50;
const STABLE_PLATEAU_TOLERANCE_PERCENT = STABLE_PLATEAU_TOLERANCE_LITERS / CAPACITY_LITERS * 100;
const BASELINE_LOOKBACK_MINUTES = 15;
const WARMUP_MINUTE_BUCKETS = 3;
const TELEMETRY_GAP_MINUTES = 3;
const PLATEAU_WINDOW_MINUTES = 5;
const CONFIRMATION_MINUTES = 10;
const CANDIDATE_TIMEOUT_MINUTES = 45;
const CANDIDATE_RETURN_MARGIN_LITERS = RECEIPT_THRESHOLD_LITERS / 2;
const BASELINE_SETTLE_TOLERANCE_LITERS = 10;
const RECEIPT_CONTINUATION_MINUTES = 90;
const RECEIPT_CONTINUATION_MINIMUM_LITERS = 10;
const TRANSIENT_RECEIPT_REPAIR_KEY = "ocio_transient_receipts_repair_v1";
const DETECTOR_V2_MIGRATION_KEY = "sustained_receipt_detector_v2";
const RECEIPT_REVIEW_MIGRATION_KEY = "receipt_review_workflow_v1";
const HISTORICAL_AUTOMATIC_REVIEW_MIGRATION_KEY = "historical_automatic_receipt_review_v1";
const RECEIPT_CONFIDENCE_MIGRATION_KEY = "automatic_receipt_confidence_v2";
const MANUAL_MOVEMENT_IDENTITY_MIGRATION_KEY = "manual_movement_identity_v1";
const PUMP_ENABLEMENT_CLASSIFICATION_MIGRATION_KEY = "pump_enablement_classification_v3_under_0_12";
const initialized = new WeakSet<object>();
const initializing = new WeakMap<object, Promise<void>>();

export async function ensureFuelHistoryStore(db: D1DatabaseLike, seedDemo = false) {
  const marker = db as unknown as object;
  if (initialized.has(marker)) return;
  let pending = initializing.get(marker);
  if (!pending) {
    pending = (async () => {
      await db.batch([
        db.prepare(`CREATE TABLE IF NOT EXISTS fuel_level_quality (
          id INTEGER PRIMARY KEY CHECK(id=1),occurred_at TEXT NOT NULL,quality TEXT NOT NULL,telemetry_session_id TEXT)`),
        db.prepare(`CREATE TABLE IF NOT EXISTS fuel_level_ranges (
          occurred_at TEXT PRIMARY KEY,min_liters REAL NOT NULL,max_liters REAL NOT NULL,
          source TEXT NOT NULL,telemetry_session_id TEXT)`),
        db.prepare(`CREATE TABLE IF NOT EXISTS fuel_history_meta (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        )`),
        db.prepare(`CREATE TABLE IF NOT EXISTS fuel_movements (
          id TEXT PRIMARY KEY,
          movement_type TEXT NOT NULL CHECK (movement_type IN ('receipt','dispatch')),
          classification TEXT NOT NULL DEFAULT 'standard' CHECK (classification IN ('standard','pump_enablement')),
          occurred_at TEXT NOT NULL,
          liters REAL NOT NULL CHECK (liters >= 0),
          opening_level_liters REAL NOT NULL,
          closing_level_liters REAL NOT NULL,
          source TEXT NOT NULL,
          reference_id TEXT NOT NULL,
          legacy_id TEXT,
          manual_mode_session_id TEXT,
          detail TEXT NOT NULL DEFAULT '',
          operator_id TEXT,
          equipment_id TEXT,
          is_master INTEGER NOT NULL DEFAULT 0 CHECK(is_master IN (0,1)),
          authorization_evidence TEXT NOT NULL DEFAULT 'legacy' CHECK(authorization_evidence IN ('full','rfid_only','assisted','master','unauthorized','legacy')),
          adoption_stage TEXT CHECK(adoption_stage IN ('assisted','rfid_only','full')),
          assisted_mode INTEGER NOT NULL DEFAULT 0 CHECK(assisted_mode IN (0,1)),
          equipment_issue TEXT,
          detected_automatically INTEGER NOT NULL DEFAULT 0 CHECK (detected_automatically IN (0,1)),
          confidence REAL NOT NULL DEFAULT 1,
          detection_status TEXT NOT NULL DEFAULT 'confirmed' CHECK (detection_status IN ('confirmed','accumulating')),
          review_status TEXT NOT NULL DEFAULT 'not_required' CHECK (review_status IN ('not_required','pending','approved','corrected','rejected')),
          original_liters REAL,
          document_reference TEXT,
          reviewed_by_user_id TEXT,
          reviewed_by_name TEXT,
          reviewed_at TEXT,
          review_note TEXT,
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        )`),
        db.prepare("CREATE INDEX IF NOT EXISTS idx_fuel_movements_occurred ON fuel_movements(occurred_at)"),
        db.prepare("CREATE INDEX IF NOT EXISTS idx_fuel_movements_type_occurred ON fuel_movements(movement_type,occurred_at)"),
        db.prepare(`CREATE TABLE IF NOT EXISTS fuel_receipt_reviews (
          id TEXT PRIMARY KEY,
          movement_id TEXT NOT NULL,
          action TEXT NOT NULL CHECK(action IN ('automatic_detected','approved','corrected','rejected','manual_created')),
          previous_liters REAL,
          resulting_liters REAL,
          document_reference TEXT,
          note TEXT NOT NULL DEFAULT '',
          actor_user_id TEXT,
          actor_name TEXT,
          occurred_at TEXT NOT NULL,
          FOREIGN KEY(movement_id) REFERENCES fuel_movements(id) ON DELETE RESTRICT
        )`),
        db.prepare("CREATE INDEX IF NOT EXISTS idx_fuel_receipt_reviews_movement ON fuel_receipt_reviews(movement_id,occurred_at)"),
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
          baseline_started_at TEXT NOT NULL DEFAULT '1970-01-01T00:00:00.000Z',
          warmup_started_at TEXT,
          telemetry_session_id TEXT,
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
          telemetry_session_id TEXT,
          technology_adoption_stage TEXT NOT NULL DEFAULT 'full' CHECK(technology_adoption_stage IN ('assisted','rfid_only','full')),
          adoption_policy_revision INTEGER NOT NULL DEFAULT 1 CHECK(adoption_policy_revision > 0),
          occurred_at TEXT NOT NULL
        )`),
      ]);
      const movementColumns = await db.prepare("PRAGMA table_info(fuel_movements)").all<{ name: string }>();
      for (const [name, definition] of [
        ["classification", "classification TEXT NOT NULL DEFAULT 'standard' CHECK(classification IN ('standard','pump_enablement'))"],
        ["operator_id", "operator_id TEXT"],
        ["equipment_id", "equipment_id TEXT"],
        ["is_master", "is_master INTEGER NOT NULL DEFAULT 0 CHECK(is_master IN (0,1))"],
        ["authorization_evidence", "authorization_evidence TEXT NOT NULL DEFAULT 'legacy' CHECK(authorization_evidence IN ('full','rfid_only','assisted','master','unauthorized','legacy'))"],
        ["adoption_stage", "adoption_stage TEXT CHECK(adoption_stage IN ('assisted','rfid_only','full'))"],
        ["assisted_mode", "assisted_mode INTEGER NOT NULL DEFAULT 0 CHECK(assisted_mode IN (0,1))"],
        ["equipment_issue", "equipment_issue TEXT"],
        ["legacy_id", "legacy_id TEXT"],
        ["manual_mode_session_id", "manual_mode_session_id TEXT"],
        ["review_status", "review_status TEXT NOT NULL DEFAULT 'not_required' CHECK(review_status IN ('not_required','pending','approved','corrected','rejected'))"],
        ["original_liters", "original_liters REAL"],
        ["document_reference", "document_reference TEXT"],
        ["reviewed_by_user_id", "reviewed_by_user_id TEXT"],
        ["reviewed_by_name", "reviewed_by_name TEXT"],
        ["reviewed_at", "reviewed_at TEXT"],
        ["review_note", "review_note TEXT"],
      ] as const) {
        if (!movementColumns.results.some((column) => column.name === name)) {
          await db.prepare(`ALTER TABLE fuel_movements ADD COLUMN ${definition}`).run();
        }
      }
      await db.prepare("CREATE UNIQUE INDEX IF NOT EXISTS idx_fuel_movements_legacy_id ON fuel_movements(legacy_id) WHERE legacy_id IS NOT NULL").run();
      await db.prepare("CREATE INDEX IF NOT EXISTS idx_fuel_movements_receipt_review ON fuel_movements(movement_type,review_status,occurred_at)").run();
      for (const column of [
        "nfc_ready INTEGER NOT NULL DEFAULT 0",
        "k24_enabled INTEGER NOT NULL DEFAULT 0",
        "tank_level_enabled INTEGER NOT NULL DEFAULT 0",
        "telemetry_session_id TEXT",
        "technology_adoption_stage TEXT NOT NULL DEFAULT 'full'",
        "adoption_policy_revision INTEGER NOT NULL DEFAULT 1",
      ]) {
        try {
          await db.prepare(`ALTER TABLE edge_runtime_status ADD COLUMN ${column}`).run();
        } catch (error) {
          if (!(error instanceof Error) || !/duplicate column/i.test(error.message)) throw error;
        }
      }
      const detectorColumns = await db.prepare("PRAGMA table_info(fuel_detection_state)").all<{ name: string }>();
      for (const column of [
        ["baseline_started_at", "baseline_started_at TEXT NOT NULL DEFAULT '1970-01-01T00:00:00.000Z'"],
        ["warmup_started_at", "warmup_started_at TEXT"],
        ["telemetry_session_id", "telemetry_session_id TEXT"],
      ] as const) {
        if (!detectorColumns.results.some((item) => item.name === column[0])) {
          await db.prepare(`ALTER TABLE fuel_detection_state ADD COLUMN ${column[1]}`).run();
        }
      }
      if (seedDemo) {
        await seedFuelHistory(db);
      } else {
        await db.prepare(`INSERT OR IGNORE INTO fuel_detection_state(
          id,capacity_liters,baseline_level_liters,last_level_liters,peak_level_liters,
          active_receipt_id,active_started_at,baseline_started_at,warmup_started_at,telemetry_session_id,last_reading_at
        ) VALUES (1,?,0,0,0,NULL,NULL,'1970-01-01T00:00:00.000Z',NULL,NULL,'1970-01-01T00:00:00.000Z')`).bind(CAPACITY_LITERS).run();
      }
      // También actualizar bases existentes: INSERT OR IGNORE no migra capacidad.
      // No toca lecturas, movimientos ni anclas históricas de cuadratura.
      await db.prepare("UPDATE fuel_detection_state SET capacity_liters=? WHERE id=1 AND capacity_liters<>?")
        .bind(CAPACITY_LITERS, CAPACITY_LITERS).run();
      await repairTransientReceipts(db);
      await migrateSustainedReceiptDetector(db);
      await migrateReceiptReviewWorkflow(db);
      await migrateHistoricalAutomaticReceiptsForReview(db);
      await migrateAutomaticReceiptConfidence(db);
      await migrateManualMovementIdentity(db);
      await migrateLegacyPumpEnablements(db);
      await db.prepare("PRAGMA optimize").run();
      initialized.add(marker);
    })().finally(() => initializing.delete(marker));
    initializing.set(marker, pending);
  }
  await pending;
}

export async function listFuelMovements(db: D1DatabaseLike, from: string, toExclusive: string) {
  const result = await db.prepare(`SELECT
      movements.id,movements.movement_type AS type,movements.classification,movements.occurred_at AS occurredAt,movements.liters,
      movements.opening_level_liters AS openingLevel,movements.closing_level_liters AS closingLevel,
      movements.source,movements.reference_id AS reference,movements.legacy_id AS legacyId,
      movements.manual_mode_session_id AS manualModeSessionId,movements.detail,
      movements.operator_id AS operatorId,operators.name AS operatorName,
      movements.equipment_id AS equipmentId,equipment.name AS equipmentName,movements.is_master AS isMaster,
      movements.authorization_evidence AS authorizationEvidence,movements.adoption_stage AS adoptionStage,
      movements.assisted_mode AS assistedMode,movements.equipment_issue AS equipmentIssue,
      movements.detected_automatically AS detectedAutomatically,movements.confidence,
      movements.detection_status AS status,movements.review_status AS reviewStatus,
      movements.original_liters AS originalLiters,movements.document_reference AS documentReference,
      movements.reviewed_by_user_id AS reviewedByUserId,movements.reviewed_by_name AS reviewedByName,
      movements.reviewed_at AS reviewedAt,movements.review_note AS reviewNote
    FROM fuel_movements AS movements
    LEFT JOIN managed_operators AS operators ON operators.id=movements.operator_id
    LEFT JOIN managed_equipment AS equipment ON equipment.id=movements.equipment_id
    WHERE movements.occurred_at >= ? AND movements.occurred_at < ?
    ORDER BY movements.occurred_at DESC
    LIMIT 5000`).bind(from, toExclusive).all<Record<string, unknown>>();
  return result.results.map(toMovement);
}

export async function listPendingReceiptReviews(db: D1DatabaseLike) {
  const result = await db.prepare(`SELECT
      movements.id,movements.movement_type AS type,movements.classification,movements.occurred_at AS occurredAt,movements.liters,
      movements.opening_level_liters AS openingLevel,movements.closing_level_liters AS closingLevel,
      movements.source,movements.reference_id AS reference,NULL AS legacyId,NULL AS manualModeSessionId,movements.detail,
      movements.operator_id AS operatorId,NULL AS operatorName,movements.equipment_id AS equipmentId,NULL AS equipmentName,
      movements.is_master AS isMaster,movements.detected_automatically AS detectedAutomatically,movements.confidence,
      movements.detection_status AS status,movements.review_status AS reviewStatus,
      movements.original_liters AS originalLiters,movements.document_reference AS documentReference,
      movements.reviewed_by_user_id AS reviewedByUserId,movements.reviewed_by_name AS reviewedByName,
      movements.reviewed_at AS reviewedAt,movements.review_note AS reviewNote
    FROM fuel_movements AS movements
    WHERE movements.movement_type='receipt' AND movements.review_status='pending'
    ORDER BY movements.occurred_at DESC LIMIT 250`).all<Record<string, unknown>>();
  return result.results.map(toMovement);
}

export type LevelDisplayReference = {liters: number; sourceAt: string; telemetrySessionId: string | null; ranged: boolean};

/** Histéresis exclusiva de presentación. Nunca alimenta movimientos ni alarmas. */
export function nextLevelDisplayReference(previous: LevelDisplayReference | null, reading: {
  currentLevel: number; latestReadingAt: string; telemetrySessionId: string | null;
  levelRange: {minLiters: number; maxLiters: number} | null;
}): LevelDisplayReference {
  const ranged = Boolean(reading.levelRange);
  const center = reading.levelRange ? (reading.levelRange.minLiters + reading.levelRange.maxLiters)/2 : reading.currentLevel;
  const gap = Date.parse(reading.latestReadingAt)-Date.parse(previous?.sourceAt ?? "");
  const hold = previous && Number.isFinite(previous.liters) && gap >= 0 && gap <= 180000
    && previous.telemetrySessionId === reading.telemetrySessionId && previous.ranged === ranged
    && Math.abs(center-previous.liters) <= 2.5
    && center > 0 && center < CAPACITY_LITERS && previous.liters > 0 && previous.liters < CAPACITY_LITERS
    && (!reading.levelRange || previous.liters >= reading.levelRange.minLiters && previous.liters <= reading.levelRange.maxLiters);
  return {liters: hold ? previous.liters : Math.round(center), sourceAt: reading.latestReadingAt,
    telemetrySessionId: reading.telemetrySessionId, ranged};
}

async function storedDisplayReference(db: D1DatabaseLike): Promise<LevelDisplayReference | null> {
  const row = await db.prepare("SELECT value FROM fuel_history_meta WHERE key='level_display_reference'").first<{value: string}>();
  try { return row ? JSON.parse(row.value) as LevelDisplayReference : null; } catch { return null; }
}

async function saveDisplayReference(db: D1DatabaseLike) {
  const sensor = await fuelSensorState(db);
  const next = nextLevelDisplayReference(await storedDisplayReference(db), sensor);
  await db.prepare(`INSERT INTO fuel_history_meta(key,value) VALUES ('level_display_reference',?)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value
    WHERE json_extract(excluded.value,'$.sourceAt') >= json_extract(fuel_history_meta.value,'$.sourceAt')`)
    .bind(JSON.stringify(next)).run();
}

export async function fuelSensorState(db: D1DatabaseLike) {
  const state = await db.prepare(`SELECT capacity_liters AS capacityLiters,baseline_level_liters AS baselineLevel,
      last_level_liters AS currentLevel,peak_level_liters AS peakLevel,last_reading_at AS latestReadingAt,
      active_receipt_id AS activeReceiptId,active_started_at AS activeStartedAt,warmup_started_at AS warmupStartedAt,
      telemetry_session_id AS telemetrySessionId
    FROM fuel_detection_state WHERE id=1`).first<Record<string, unknown>>();
  const active = Boolean(state?.activeReceiptId);
  const observedRiseLiters = round1(Math.max(0,
    Number(active ? state?.peakLevel : state?.currentLevel) - Number(state?.baselineLevel ?? 0)));
  const range = await db.prepare(`SELECT occurred_at AS occurredAt,min_liters AS minLiters,
    max_liters AS maxLiters,telemetry_session_id AS telemetrySessionId FROM fuel_level_ranges
    ORDER BY occurred_at DESC LIMIT 1`).first<{occurredAt: string; minLiters: number; maxLiters: number; telemetrySessionId: string | null}>();
  const rangeIsLatest = Boolean(range && range.occurredAt > String(state?.latestReadingAt ?? ""));
  const measurementQuality = await db.prepare("SELECT occurred_at AS occurredAt,quality AS status,telemetry_session_id AS telemetrySessionId FROM fuel_level_quality WHERE id=1")
    .first<{occurredAt: string; status: string; telemetrySessionId: string | null}>();
  return {
    measurementQuality,
    displayReference: await storedDisplayReference(db),
    capacityLiters: Number(state?.capacityLiters ?? CAPACITY_LITERS),
    currentLevel: rangeIsLatest ? (range!.minLiters+range!.maxLiters)/2 : Number(state?.currentLevel ?? 0),
    levelRange: rangeIsLatest ? {minLiters: range!.minLiters, maxLiters: range!.maxLiters} : null,
    latestReadingAt: rangeIsLatest ? range!.occurredAt : String(state?.latestReadingAt ?? ""),
    telemetrySessionId: rangeIsLatest ? range!.telemetrySessionId : state?.telemetrySessionId ? String(state.telemetrySessionId) : null,
    receiptThresholdLiters: RECEIPT_THRESHOLD_LITERS,
    acceptedVariationPercent: STABLE_PLATEAU_TOLERANCE_PERCENT,
    detectionStatus: rangeIsLatest ? "monitoring" : active ? "detecting" : state?.warmupStartedAt ? "warming_up"
      : observedRiseLiters >= RECEIPT_CONTINUATION_MINIMUM_LITERS ? "rising" : "monitoring",
    activeReceiptId: state?.activeReceiptId ? String(state.activeReceiptId) : null,
    activeStartedAt: state?.activeStartedAt ? String(state.activeStartedAt) : null,
    observedRiseLiters,
  };
}

export async function edgeRuntimeStatus(db: D1DatabaseLike): Promise<EdgeRuntimeStatus | null> {
  const row = await db.prepare(`SELECT module_id AS moduleId,site_id AS siteId,state,
    relay_energized AS relayEnergized,validator_online AS validatorOnline,nfc_ready AS nfcReady,
    k24_enabled AS k24Enabled,k24_healthy AS k24Healthy,tank_level_enabled AS tankLevelEnabled,
    telemetry_session_id AS telemetrySessionId,technology_adoption_stage AS technologyAdoptionStage,
    adoption_policy_revision AS adoptionPolicyRevision,occurred_at AS occurredAt
    FROM edge_runtime_status WHERE id=1`).first<Record<string, unknown>>();
  if (!row) return null;
  return {
    moduleId: String(row.moduleId), siteId: String(row.siteId), state: String(row.state),
    relayEnergized: row.relayEnergized === 1, validatorOnline: row.validatorOnline === 1,
    nfcReady: row.nfcReady === 1, k24Enabled: row.k24Enabled === 1,
    k24Healthy: row.k24Healthy === 1, tankLevelEnabled: row.tankLevelEnabled === 1,
    telemetrySessionId: row.telemetrySessionId ? String(row.telemetrySessionId) : null,
    technologyAdoptionStage: validAdoptionStage(row.technologyAdoptionStage) ? row.technologyAdoptionStage : "full",
    adoptionPolicyRevision: Math.max(1, Number(row.adoptionPolicyRevision ?? 1)),
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
    db.prepare("DELETE FROM fuel_receipt_reviews"),
    db.prepare("DELETE FROM fuel_movements"),
    db.prepare("DELETE FROM fuel_level_readings"),
    db.prepare("DELETE FROM fuel_level_ranges"),
    db.prepare("DELETE FROM fuel_level_quality"),
    db.prepare("DELETE FROM fuel_history_meta WHERE key IN ('level_display_reference','level_calibration')"),
    db.prepare(`UPDATE fuel_detection_state SET
      capacity_liters=?,baseline_level_liters=0,last_level_liters=0,peak_level_liters=0,
      active_receipt_id=NULL,active_started_at=NULL,
      baseline_started_at='1970-01-01T00:00:00.000Z',warmup_started_at=NULL,telemetry_session_id=NULL,
      last_reading_at='1970-01-01T00:00:00.000Z'
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
  const telemetrySessionId = optionalTelemetrySessionId(body.telemetrySessionId);
  if (body.telemetrySessionId != null && !telemetrySessionId) throw new Error("La sesión de telemetría no es válida.");
  const technologyAdoptionStage = validAdoptionStage(body.technologyAdoptionStage) ? body.technologyAdoptionStage : "full";
  const adoptionPolicyRevision = Number(body.adoptionPolicyRevision ?? 1);
  if (!Number.isInteger(adoptionPolicyRevision) || adoptionPolicyRevision <= 0) throw new Error("La revisión de adopción no es válida.");
  await db.prepare(`INSERT INTO edge_runtime_status(id,module_id,site_id,state,relay_energized,validator_online,nfc_ready,k24_enabled,k24_healthy,tank_level_enabled,telemetry_session_id,technology_adoption_stage,adoption_policy_revision,occurred_at)
    VALUES (1,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET module_id=excluded.module_id,site_id=excluded.site_id,
    state=excluded.state,relay_energized=excluded.relay_energized,validator_online=excluded.validator_online,
    nfc_ready=excluded.nfc_ready,k24_enabled=excluded.k24_enabled,k24_healthy=excluded.k24_healthy,
    tank_level_enabled=excluded.tank_level_enabled,telemetry_session_id=excluded.telemetry_session_id,
    technology_adoption_stage=excluded.technology_adoption_stage,adoption_policy_revision=excluded.adoption_policy_revision,
    occurred_at=excluded.occurred_at`).bind(
      moduleId, siteId, state, Number(body.relayEnergized), Number(body.validatorOnline), Number(body.nfcReady),
      Number(body.k24Enabled), Number(body.k24Healthy), Number(body.tankLevelEnabled), telemetrySessionId,
      technologyAdoptionStage, adoptionPolicyRevision,
      timestamp.toISOString(),
    ).run();
  return { recorded: true };
}

export async function ingestFuelLevelQuality(db: D1DatabaseLike, status: unknown, occurredAt: string, telemetrySessionId?: string | null) {
  if (typeof status !== "string" || !["valid","range","settling","warming_up","ambiguous_levels","insufficient_coverage","unavailable","calibration_pending"].includes(status)) throw new Error("Estado de lectura inválido.");
  const at = new Date(occurredAt), session = optionalTelemetrySessionId(telemetrySessionId);
  if (!Number.isFinite(at.getTime()) || at.getTime() <= 0 || at.getTime() > Date.now()+300000 || (telemetrySessionId != null && !session)) throw new Error("Fecha o sesión inválida.");
  await assertAfterFieldReset(db, at.toISOString());
  await db.prepare(`INSERT INTO fuel_level_quality(id,occurred_at,quality,telemetry_session_id) VALUES (1,?,?,?)
    ON CONFLICT(id) DO UPDATE SET occurred_at=excluded.occurred_at,quality=excluded.quality,telemetry_session_id=excluded.telemetry_session_id
    WHERE excluded.occurred_at >= fuel_level_quality.occurred_at`).bind(at.toISOString(), status, session).run();
  return {status: "quality", occurredAt: at.toISOString()};
}

export async function ingestFuelLevelRange(...args: Parameters<typeof ingestFuelLevelRangeEvidence>) {
  const result = await ingestFuelLevelRangeEvidence(...args);
  await saveDisplayReference(args[0]);
  return result;
}

async function levelCalibration(db: D1DatabaseLike) {
  const row = await db.prepare("SELECT value FROM fuel_history_meta WHERE key='level_calibration'").first<{value: string}>();
  return row ? JSON.parse(row.value) as {id: string; from: string} : null;
}

async function calibrationTransition(db: D1DatabaseLike, id: unknown) {
  if (id != null && (typeof id !== "string" || !id.trim() || id.length > 160)) throw new Error("Calibración de nivel inválida.");
  const previous = await levelCalibration(db);
  if (previous && id == null) throw new Error("La lectura debe identificar su calibración.");
  return {id: id as string | null | undefined, changed: id != null && id !== previous?.id};
}

function calibrationStatements(db: D1DatabaseLike, id: string, from: string) {
  const value = JSON.stringify({id, from});
  return [db.prepare(`INSERT INTO fuel_history_meta(key,value) VALUES ('level_calibration',?)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value`).bind(value),
    db.prepare("INSERT INTO fuel_history_meta(key,value) VALUES (?,?)").bind(`level_calibration:${from}`, value),
    db.prepare("DELETE FROM fuel_history_meta WHERE key='level_display_reference'")];
}

async function ingestFuelLevelRangeEvidence(db: D1DatabaseLike, bounds: unknown, occurredAt: string,
  source = "OCIO", telemetrySessionId?: string | null, calibrationId?: unknown) {
  const range = bounds as {minLiters?: number; maxLiters?: number} | null;
  if (!range || typeof range.minLiters !== "number" || typeof range.maxLiters !== "number"
    || !Number.isFinite(range.minLiters) || !Number.isFinite(range.maxLiters)
    || range.minLiters < 0 || range.maxLiters > CAPACITY_LITERS || range.minLiters >= range.maxLiters) throw new Error("Rango de nivel inválido.");
  const at = new Date(occurredAt);
  if (!Number.isFinite(at.getTime()) || at.getTime() <= 0 || at.getTime() > Date.now()+300000) throw new Error("Fecha de lectura inválida.");
  const iso = at.toISOString(), session = optionalTelemetrySessionId(telemetrySessionId);
  if (telemetrySessionId != null && !session) throw new Error("Sesión inválida.");
  await assertAfterFieldReset(db, iso);
  const prior = await db.prepare("SELECT min_liters AS low,max_liters AS high,source,telemetry_session_id AS session FROM fuel_level_ranges WHERE occurred_at=?")
    .bind(iso).first<{low: number; high: number; source: string; session: string | null}>();
  const normalizedSource = source.trim().slice(0,80) || "OCIO";
  if (prior) {
    if (prior.low !== range.minLiters || prior.high !== range.maxLiters || prior.source !== normalizedSource || prior.session !== session) throw new Error("Ya existe otra lectura con la misma fecha.");
    return {status: "duplicate", occurredAt: iso};
  }
  const latest = await fuelSensorState(db);
  if (iso <= latest.latestReadingAt) throw new Error("La lectura es anterior a la última muestra registrada.");
  const calibration = await calibrationTransition(db, calibrationId);
  await db.batch([
    db.prepare("INSERT INTO fuel_level_ranges(occurred_at,min_liters,max_liters,source,telemetry_session_id) VALUES (?,?,?,?,?)")
      .bind(iso, range.minLiters, range.maxLiters, normalizedSource, session),
    ...(calibration.changed ? calibrationStatements(db, calibration.id!, iso) : []),
  ]);
  // No insertar el punto medio en el detector de recepciones ni en la curva
  // histórica de lecturas puntuales: el intervalo es la evidencia original.
  return {status: "range", occurredAt: iso, levelRange: range, detectedLiters: 0, receiptId: null};
}

export async function ingestFuelLevelReading(...args: Parameters<typeof ingestFuelLevelPointEvidence>) {
  const result = await ingestFuelLevelPointEvidence(...args);
  await saveDisplayReference(args[0]);
  return result;
}

async function ingestFuelLevelPointEvidence(
  db: D1DatabaseLike,
  levelLiters: number,
  occurredAt: string,
  source = "OCIO",
  telemetrySessionId?: string | null,
  calibrationId?: unknown,
) {
  if (!Number.isFinite(levelLiters) || levelLiters < 0 || levelLiters > CAPACITY_LITERS) {
    throw new Error(`El nivel debe estar entre 0 y ${CAPACITY_LITERS} litros.`);
  }
  const timestamp = new Date(occurredAt);
  if (Number.isNaN(timestamp.getTime())) throw new Error("La fecha de lectura no es válida.");
  if (timestamp.getTime() > Date.now() + 5 * 60_000) throw new Error("La lectura no puede estar en el futuro.");
  const iso = timestamp.toISOString();
  await assertAfterFieldReset(db, iso);
  const priorRange = await db.prepare("SELECT occurred_at AS occurredAt FROM fuel_level_ranges ORDER BY occurred_at DESC LIMIT 1")
    .first<{occurredAt: string}>();
  if (priorRange && iso <= priorRange.occurredAt) throw new Error("La lectura es anterior al último intervalo registrado.");
  const normalizedSource = source.trim().slice(0, 80) || "OCIO";
  const normalizedSessionId = optionalTelemetrySessionId(telemetrySessionId);
  if (telemetrySessionId != null && !normalizedSessionId) throw new Error("La sesión de telemetría no es válida.");
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
      baseline_started_at AS baselineStartedAt,warmup_started_at AS warmupStartedAt,
      telemetry_session_id AS telemetrySessionId,
      last_reading_at AS lastReadingAt FROM fuel_detection_state WHERE id=1`).first<Record<string, unknown>>();
  if (!state) throw new Error("El detector de nivel no está inicializado.");
  if (iso <= String(state.lastReadingAt)) throw new Error("La lectura es anterior a la última muestra registrada.");

  const previousAt = new Date(String(state.lastReadingAt));
  const calibration = await calibrationTransition(db, calibrationId);
  const firstReading = String(state.lastReadingAt) === "1970-01-01T00:00:00.000Z";
  const sessionChanged = Boolean(normalizedSessionId && normalizedSessionId !== state.telemetrySessionId);
  const telemetryGap = !firstReading
    && timestamp.getTime() - previousAt.getTime() > TELEMETRY_GAP_MINUTES * 60_000;
  if (calibration.changed || firstReading || telemetryGap || (priorRange && priorRange.occurredAt > String(state.lastReadingAt))) {
    await db.batch([
      db.prepare("INSERT INTO fuel_level_readings(occurred_at,level_liters,source) VALUES (?,?,?)")
        .bind(iso, round1(levelLiters), normalizedSource),
      db.prepare(`UPDATE fuel_detection_state SET baseline_level_liters=?,last_level_liters=?,peak_level_liters=?,
        active_receipt_id=NULL,active_started_at=NULL,baseline_started_at=?,warmup_started_at=?,telemetry_session_id=?,
        last_reading_at=? WHERE id=1`)
        .bind(round1(levelLiters), round1(levelLiters), round1(levelLiters), iso, iso,
          normalizedSessionId ?? state.telemetrySessionId ?? null, iso),
      ...(calibration.changed ? calibrationStatements(db, calibration.id!, iso) : []),
    ]);
    return {
      status: calibration.changed ? "calibration_changed" : firstReading ? "initialized" : "warming_up",
      receiptId: null,
      detectedLiters: 0,
      levelLiters: round1(levelLiters),
      occurredAt: iso,
    };
  }

  const baseline = Number(state.baseline);
  const peak = Number(state.peak);
  const activeId = state.activeId ? String(state.activeId) : null;
  const effectiveSessionId = normalizedSessionId
    ?? (state.telemetrySessionId ? String(state.telemetrySessionId) : null);

  if (sessionChanged && !activeId) {
    await db.batch([
      db.prepare("INSERT INTO fuel_level_readings(occurred_at,level_liters,source) VALUES (?,?,?)")
        .bind(iso, round1(levelLiters), normalizedSource),
      detectorStateStatement(db, {
        baseline,
        lastLevel: levelLiters,
        peak: Math.max(peak, levelLiters),
        activeId: null,
        activeStartedAt: null,
        baselineStartedAt: String(state.baselineStartedAt),
        warmupStartedAt: iso,
        telemetrySessionId: effectiveSessionId,
        lastReadingAt: iso,
      }),
    ]);
    return { status: "warming_up", receiptId: null, detectedLiters: 0, levelLiters: round1(levelLiters), occurredAt: iso };
  }

  await db.prepare("INSERT INTO fuel_level_readings(occurred_at,level_liters,source) VALUES (?,?,?)")
    .bind(iso, round1(levelLiters), normalizedSource).run();

  const continuedReceipt = await extendRecentPendingReceipt(db, {
    currentLevel: levelLiters,
    occurredAt: timestamp,
    occurredAtIso: iso,
    telemetrySessionId: effectiveSessionId,
  });
  if (continuedReceipt) return continuedReceipt;

  let baselineEstimate = baseline;
  let baselineStartedAt = String(state.baselineStartedAt);
  let warmupRebased = false;
  const warmupStartedAt = state.warmupStartedAt ? String(state.warmupStartedAt) : null;
  if (warmupStartedAt && !activeId) {
    const warmupBuckets = await minuteLevelBuckets(db, new Date(warmupStartedAt), timestamp);
    const hasWarmupWindow = warmupBuckets.length >= WARMUP_MINUTE_BUCKETS
      && minuteSpan(warmupBuckets) >= WARMUP_MINUTE_BUCKETS - 1;
    if (!hasWarmupWindow) {
      await updateDetectorState(db, {
        baseline,
        lastLevel: levelLiters,
        peak: Math.max(peak, levelLiters),
        activeId: null,
        activeStartedAt: null,
        baselineStartedAt,
        warmupStartedAt,
        telemetrySessionId: effectiveSessionId,
        lastReadingAt: iso,
      });
      return { status: "warming_up", receiptId: null, detectedLiters: 0, levelLiters: round1(levelLiters), occurredAt: iso };
    }
    const warmupLevels = warmupBuckets.map((bucket) => bucket.levelLiters);
    const warmupPlateau = median(warmupLevels);
    const warmupSpread = Math.max(...warmupLevels) - Math.min(...warmupLevels);
    if (warmupSpread <= BASELINE_SETTLE_TOLERANCE_LITERS
      && Math.abs(warmupPlateau - baseline) < RECEIPT_THRESHOLD_LITERS) {
      baselineEstimate = warmupPlateau;
      baselineStartedAt = iso;
      warmupRebased = true;
    }
  }

  const sessionBuckets = await minuteLevelBuckets(
    db,
    new Date(Math.max(storedInstant(baselineStartedAt).getTime(),
      timestamp.getTime() - BASELINE_LOOKBACK_MINUTES * 60_000)),
    timestamp,
  );

  if (activeId) {
    return updateReceiptCandidate(db, {
      activeId,
      activeStartedAt: String(state.activeStartedAt ?? iso),
      baseline,
      peak,
      currentLevel: levelLiters,
      occurredAt: timestamp,
      occurredAtIso: iso,
      source: normalizedSource,
      telemetrySessionId: effectiveSessionId,
    });
  }

  const baselineBuckets = sessionBuckets.filter((bucket) => bucket.minute < minuteKey(timestamp));
  if (!warmupRebased && baselineBuckets.length > 0) {
    // Las caídas breves del ciclo OCIO no deben convertirse en una referencia
    // artificialmente baja. La mediana sólo puede bajar el ancla cuando el
    // conjunto reciente respalda el descenso.
    const recentBaseline = median(baselineBuckets.map((bucket) => bucket.levelLiters));
    if (recentBaseline < baselineEstimate - BASELINE_SETTLE_TOLERANCE_LITERS) {
      baselineEstimate = recentBaseline;
    }
  }
  const settledLevels = sessionBuckets.map((bucket) => bucket.levelLiters);
  const hasSettledWindow = sessionBuckets.length >= BASELINE_LOOKBACK_MINUTES
    && minuteSpan(sessionBuckets) >= BASELINE_LOOKBACK_MINUTES - 1;
  if (hasSettledWindow) {
    const settledLevel = median(settledLevels);
    const settledSpread = Math.max(...settledLevels) - Math.min(...settledLevels);
    if (settledSpread <= BASELINE_SETTLE_TOLERANCE_LITERS
      && Math.abs(settledLevel - baselineEstimate) < RECEIPT_THRESHOLD_LITERS) {
      baselineEstimate = settledLevel;
      baselineStartedAt = iso;
    }
  }

  const riseFromBaseline = levelLiters - baselineEstimate;
  if (riseFromBaseline >= RECEIPT_THRESHOLD_LITERS) {
    const candidateId = `FR-AUTO-${crypto.randomUUID()}`;
    await updateDetectorState(db, {
      baseline: baselineEstimate,
      lastLevel: levelLiters,
      peak: levelLiters,
      activeId: candidateId,
      activeStartedAt: iso,
      baselineStartedAt,
      warmupStartedAt: null,
      telemetrySessionId: effectiveSessionId,
      lastReadingAt: iso,
    });
    return {
      status: "started",
      receiptId: candidateId,
      detectedLiters: round1(riseFromBaseline),
      levelLiters: round1(levelLiters),
      occurredAt: iso,
    };
  }

  await updateDetectorState(db, {
    baseline: baselineEstimate,
    lastLevel: levelLiters,
    peak: baselineEstimate,
    activeId: null,
    activeStartedAt: null,
    baselineStartedAt,
    warmupStartedAt: null,
    telemetrySessionId: effectiveSessionId,
    lastReadingAt: iso,
  });
  return { status: "none", receiptId: null, detectedLiters: 0, levelLiters: round1(levelLiters), occurredAt: iso };
}

type DetectorStateUpdate = {
  baseline: number;
  lastLevel: number;
  peak: number;
  activeId: string | null;
  activeStartedAt: string | null;
  baselineStartedAt: string;
  warmupStartedAt: string | null;
  telemetrySessionId: string | null;
  lastReadingAt: string;
};

type MinuteLevelBucket = { minute: number; levelLiters: number };

async function extendRecentPendingReceipt(db: D1DatabaseLike, continuation: {
  currentLevel: number;
  occurredAt: Date;
  occurredAtIso: string;
  telemetrySessionId: string | null;
}) {
  const receipt = await db.prepare(`SELECT movements.id,movements.occurred_at AS occurredAt,
      movements.opening_level_liters AS openingLevel,movements.closing_level_liters AS closingLevel,
      movements.liters,movements.confidence,
      (SELECT reviews.occurred_at FROM fuel_receipt_reviews AS reviews
        WHERE reviews.movement_id=movements.id AND reviews.action='automatic_detected'
        ORDER BY reviews.occurred_at DESC LIMIT 1) AS detectedAt
    FROM fuel_movements AS movements
    WHERE movements.movement_type='receipt' AND movements.detected_automatically=1
      AND movements.detection_status='confirmed' AND movements.review_status='pending'
      AND NOT EXISTS (
        SELECT 1 FROM fuel_movements AS later
        WHERE later.id<>movements.id AND later.occurred_at>movements.occurred_at
      )
    ORDER BY movements.created_at DESC LIMIT 1`).first<Record<string, unknown>>();
  if (!receipt?.id || !receipt.detectedAt) return null;
  const calibration = await levelCalibration(db);
  if (calibration && storedInstant(String(receipt.occurredAt)).getTime() < new Date(calibration.from).getTime()) return null;
  const detectedAt = storedInstant(String(receipt.detectedAt));
  const continuationMinutes = (continuation.occurredAt.getTime() - detectedAt.getTime()) / 60_000;
  if (!Number.isFinite(continuationMinutes) || continuationMinutes < 0
    || continuationMinutes > RECEIPT_CONTINUATION_MINUTES) return null;

  const plateauFrom = new Date(continuation.occurredAt.getTime() - PLATEAU_WINDOW_MINUTES * 60_000);
  const plateauBuckets = await minuteLevelBuckets(db, plateauFrom, continuation.occurredAt);
  const hasFullPlateau = plateauBuckets.length >= PLATEAU_WINDOW_MINUTES
    && minuteSpan(plateauBuckets) >= PLATEAU_WINDOW_MINUTES - 1;
  if (!hasFullPlateau) return null;
  const plateauLevels = plateauBuckets.map((bucket) => bucket.levelLiters);
  const plateauLevel = median(plateauLevels);
  const toleranceLiters = CAPACITY_LITERS * STABLE_PLATEAU_TOLERANCE_PERCENT / 100;
  const plateauSpread = Math.max(...plateauLevels) - Math.min(...plateauLevels);
  const priorClosing = Number(receipt.closingLevel);
  if (plateauSpread > toleranceLiters
    || plateauLevel - priorClosing < RECEIPT_CONTINUATION_MINIMUM_LITERS) return null;

  const evidenceBuckets = await minuteLevelBuckets(db, detectedAt, continuation.occurredAt);
  if (evidenceBuckets.length === 0
    || Math.min(...evidenceBuckets.map((bucket) => bucket.levelLiters)) < priorClosing - toleranceLiters) return null;

  const totalLiters = round1(plateauLevel - Number(receipt.openingLevel));
  if (totalLiters <= Number(receipt.liters) || totalLiters > CAPACITY_LITERS) return null;
  const confidence = Math.max(Number(receipt.confidence),
    receiptConfidence(totalLiters, plateauSpread, plateauBuckets.length, toleranceLiters));
  const auditId = `${receipt.id}:continued:${crypto.randomUUID()}`;
  await db.batch([
    db.prepare(`UPDATE fuel_movements SET liters=?,closing_level_liters=?,original_liters=?,confidence=?,
      review_note='Recepción automática ampliada por continuidad del aumento de nivel'
      WHERE id=? AND review_status='pending'`)
      .bind(totalLiters, round1(plateauLevel), totalLiters, confidence, receipt.id),
    db.prepare(`INSERT INTO fuel_receipt_reviews(
      id,movement_id,action,previous_liters,resulting_liters,note,occurred_at
    ) VALUES (?,?,'automatic_detected',?,?,'Continuación sostenida consolidada en la misma recepción',?)`)
      .bind(auditId, receipt.id, Number(receipt.liters), totalLiters, continuation.occurredAtIso),
    detectorStateStatement(db, {
      baseline: plateauLevel,
      lastLevel: continuation.currentLevel,
      peak: plateauLevel,
      activeId: null,
      activeStartedAt: null,
      baselineStartedAt: continuation.occurredAtIso,
      warmupStartedAt: null,
      telemetrySessionId: continuation.telemetrySessionId,
      lastReadingAt: continuation.occurredAtIso,
    }),
  ]);
  return {
    status: "extended",
    receiptId: String(receipt.id),
    reviewStatus: "pending",
    detectedLiters: totalLiters,
    levelLiters: round1(continuation.currentLevel),
    occurredAt: continuation.occurredAtIso,
  };
}

async function updateReceiptCandidate(db: D1DatabaseLike, candidate: {
  activeId: string;
  activeStartedAt: string;
  baseline: number;
  peak: number;
  currentLevel: number;
  occurredAt: Date;
  occurredAtIso: string;
  source: string;
  telemetrySessionId: string | null;
}) {
  const startedAt = new Date(candidate.activeStartedAt);
  const activeMinutes = (candidate.occurredAt.getTime() - startedAt.getTime()) / 60_000;
  const plateauFrom = new Date(Math.max(
    startedAt.getTime(),
    candidate.occurredAt.getTime() - PLATEAU_WINDOW_MINUTES * 60_000,
  ));
  const plateauBuckets = await minuteLevelBuckets(db, plateauFrom, candidate.occurredAt);
  const plateauLevels = plateauBuckets.map((bucket) => bucket.levelLiters);
  const plateauLevel = plateauLevels.length > 0 ? median(plateauLevels) : candidate.currentLevel;
  const plateauSpread = plateauLevels.length > 0 ? Math.max(...plateauLevels) - Math.min(...plateauLevels) : 0;
  const stableRise = plateauLevel - candidate.baseline;
  const nextPeak = Math.max(candidate.peak, candidate.currentLevel, ...plateauLevels);
  const candidateReturned = plateauBuckets.length >= 2 && stableRise < CANDIDATE_RETURN_MARGIN_LITERS;
  const candidateTimedOut = activeMinutes >= CANDIDATE_TIMEOUT_MINUTES;

  if (candidateReturned || candidateTimedOut) {
    await updateDetectorState(db, {
      baseline: plateauLevel,
      lastLevel: candidate.currentLevel,
      peak: plateauLevel,
      activeId: null,
      activeStartedAt: null,
      baselineStartedAt: candidateTimedOut ? candidate.occurredAtIso : candidate.activeStartedAt,
      warmupStartedAt: null,
      telemetrySessionId: candidate.telemetrySessionId,
      lastReadingAt: candidate.occurredAtIso,
    });
    return {
      status: "cancelled",
      receiptId: null,
      detectedLiters: 0,
      levelLiters: round1(candidate.currentLevel),
      occurredAt: candidate.occurredAtIso,
    };
  }

  const toleranceLiters = CAPACITY_LITERS * STABLE_PLATEAU_TOLERANCE_PERCENT / 100;
  const hasFullPlateau = plateauBuckets.length >= PLATEAU_WINDOW_MINUTES
    && minuteSpan(plateauBuckets) >= PLATEAU_WINDOW_MINUTES - 1;
  const canConfirm = activeMinutes >= CONFIRMATION_MINUTES
    && hasFullPlateau
    && plateauSpread <= toleranceLiters
    && stableRise >= RECEIPT_THRESHOLD_LITERS;

  if (canConfirm) {
    const detectedLiters = round1(stableRise);
    const confidence = receiptConfidence(detectedLiters, plateauSpread, plateauBuckets.length, toleranceLiters);
    await db.batch([
      db.prepare(`INSERT INTO fuel_movements(
        id,movement_type,occurred_at,liters,opening_level_liters,closing_level_liters,
        source,reference_id,detail,detected_automatically,confidence,detection_status,review_status,original_liters
      ) VALUES (?,'receipt',?,?,?,?,?,?,'Aumento breve seguido de nivel sostenido confirmado por el sensor del estanque',1,?,'confirmed','pending',?)`)
        .bind(
          candidate.activeId,
          new Date(candidate.activeStartedAt).toISOString(),
          detectedLiters,
          round1(candidate.baseline),
          round1(plateauLevel),
          candidate.source,
          `AUTO-${new Date(candidate.activeStartedAt).toISOString().slice(0, 16)}`,
          confidence,
          detectedLiters,
        ),
      db.prepare(`INSERT INTO fuel_receipt_reviews(
        id,movement_id,action,previous_liters,resulting_liters,note,occurred_at
      ) VALUES (?,?,'automatic_detected',NULL,?,'Detección sostenida enviada a revisión humana',?)`)
        .bind(`${candidate.activeId}:detected`, candidate.activeId, detectedLiters, candidate.occurredAtIso),
      detectorStateStatement(db, {
        baseline: plateauLevel,
        lastLevel: candidate.currentLevel,
        peak: plateauLevel,
        activeId: null,
        activeStartedAt: null,
        baselineStartedAt: candidate.occurredAtIso,
        warmupStartedAt: null,
        telemetrySessionId: candidate.telemetrySessionId,
        lastReadingAt: candidate.occurredAtIso,
      }),
    ]);
    return {
      status: "confirmed",
      receiptId: candidate.activeId,
      reviewStatus: "pending",
      detectedLiters,
      levelLiters: round1(candidate.currentLevel),
      occurredAt: candidate.occurredAtIso,
    };
  }

  await updateDetectorState(db, {
    baseline: candidate.baseline,
    lastLevel: candidate.currentLevel,
    peak: nextPeak,
    activeId: candidate.activeId,
    activeStartedAt: candidate.activeStartedAt,
    baselineStartedAt: candidate.activeStartedAt,
    warmupStartedAt: null,
    telemetrySessionId: candidate.telemetrySessionId,
    lastReadingAt: candidate.occurredAtIso,
  });
  return {
    status: "accumulating",
    receiptId: candidate.activeId,
    detectedLiters: round1(nextPeak - candidate.baseline),
    levelLiters: round1(candidate.currentLevel),
    occurredAt: candidate.occurredAtIso,
  };
}

async function minuteLevelBuckets(db: D1DatabaseLike, from: Date, to: Date): Promise<MinuteLevelBucket[]> {
  const calibration = await levelCalibration(db);
  if (calibration && new Date(calibration.from).getTime() > from.getTime()) from = new Date(calibration.from);
  const readings = await db.prepare(`SELECT occurred_at AS occurredAt,level_liters AS levelLiters
    FROM fuel_level_readings WHERE occurred_at>=? AND occurred_at<=? ORDER BY occurred_at`)
    .bind(from.toISOString(), to.toISOString()).all<{ occurredAt: string; levelLiters: number }>();
  const levelsByMinute = new Map<number, number[]>();
  for (const reading of readings.results) {
    const minute = minuteKey(new Date(reading.occurredAt));
    const levels = levelsByMinute.get(minute) ?? [];
    levels.push(Number(reading.levelLiters));
    levelsByMinute.set(minute, levels);
  }
  return [...levelsByMinute.entries()]
    .sort(([left], [right]) => left - right)
    .map(([minute, levels]) => ({ minute, levelLiters: median(levels) }));
}

async function updateDetectorState(db: D1DatabaseLike, state: DetectorStateUpdate) {
  await detectorStateStatement(db, state).run();
}

function detectorStateStatement(db: D1DatabaseLike, state: DetectorStateUpdate) {
  return db.prepare(`UPDATE fuel_detection_state SET baseline_level_liters=?,last_level_liters=?,peak_level_liters=?,
    active_receipt_id=?,active_started_at=?,baseline_started_at=?,warmup_started_at=?,telemetry_session_id=?,last_reading_at=? WHERE id=1`)
    .bind(
      round1(state.baseline), round1(state.lastLevel), round1(state.peak), state.activeId, state.activeStartedAt,
      state.baselineStartedAt, state.warmupStartedAt, state.telemetrySessionId, state.lastReadingAt,
    );
}

function minuteKey(date: Date) { return Math.floor(date.getTime() / 60_000); }
function minuteSpan(buckets: MinuteLevelBucket[]) {
  return buckets.length < 2 ? 0 : buckets.at(-1)!.minute - buckets[0].minute;
}
function storedInstant(value: string) {
  return new Date(value.includes("T") ? value : `${value.replace(" ", "T")}Z`);
}
function median(values: number[]) {
  if (values.length === 0) throw new Error("No se puede calcular una mediana sin lecturas.");
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}
function receiptConfidence(delta: number, spread: number, buckets: number, tolerance: number) {
  const amplitudeScore = Math.min(1, Math.max(0,
    (delta - RECEIPT_THRESHOLD_LITERS) / (HIGH_CONFIDENCE_RECEIPT_LITERS - RECEIPT_THRESHOLD_LITERS)));
  const stabilityScore = 1 - Math.min(1, spread / tolerance);
  const durationScore = Math.min(1, buckets / CONFIRMATION_MINUTES);
  const calibrated = 0.82 + amplitudeScore * 0.12 + stabilityScore * 0.04 + durationScore * 0.01;
  // La interfaz redondea a porcentaje entero. Bajo 120 L se limita a 98,4 %
  // para que 99 % sólo represente una recepción sobre el umbral de alta confianza.
  return round3(Math.min(delta >= HIGH_CONFIDENCE_RECEIPT_LITERS ? 0.99 : 0.984, calibrated));
}

type ReceiptReviewInput = {
  requestId?: unknown;
  action?: unknown;
  liters?: unknown;
  documentReference?: unknown;
  note?: unknown;
};

export async function reviewFuelReceipt(
  db: D1DatabaseLike,
  movementId: string,
  input: ReceiptReviewInput,
  actor: ReceiptReviewActor,
) {
  const requestId = requestIdentifier(input.requestId);
  const reviewId = `FR-REVIEW-${requestId}`;
  const priorReview = await db.prepare("SELECT movement_id AS movementId FROM fuel_receipt_reviews WHERE id=?")
    .bind(reviewId).first<{ movementId: string }>();
  if (priorReview) {
    if (priorReview.movementId !== movementId) throw new Error("La solicitud ya fue utilizada para otra recepción.");
    const movement = await fuelMovementById(db, movementId);
    return { updated: false, movement };
  }

  const movement = await fuelMovementById(db, movementId);
  if (!movement || movement.type !== "receipt") throw new Error("La recepción no existe.");
  const action = input.action;
  if (action !== "approve" && action !== "correct" && action !== "reject") {
    throw new Error("La decisión de revisión no es válida.");
  }
  const note = boundedText(input.note, 500);
  const suppliedReference = boundedText(input.documentReference, 120);
  const documentReference = suppliedReference || movement.documentReference;
  let nextLiters = movement.liters;
  let nextStatus: ReceiptReviewStatus;

  if (action === "approve") {
    if (movement.reviewStatus !== "pending") throw new Error("Esta recepción ya fue revisada.");
    nextStatus = "approved";
  } else if (action === "reject") {
    if (movement.reviewStatus !== "pending") throw new Error("Sólo se puede rechazar una detección pendiente.");
    if (note.length < 10) throw new Error("Explica en al menos 10 caracteres por qué se rechaza la detección.");
    nextStatus = "rejected";
  } else {
    if (movement.reviewStatus === "rejected" || movement.reviewStatus === "not_required") {
      throw new Error("Esta recepción no admite correcciones.");
    }
    if (typeof input.liters !== "number" || !Number.isFinite(input.liters) || input.liters <= 0 || input.liters > CAPACITY_LITERS) {
      throw new Error(`El volumen corregido debe estar entre 0 y ${CAPACITY_LITERS} litros.`);
    }
    nextLiters = round3(input.liters);
    if (nextLiters === movement.liters && !suppliedReference) {
      throw new Error("Modifica el volumen o agrega una referencia documental para registrar la corrección.");
    }
    if (!documentReference || documentReference.length < 2) {
      throw new Error("La corrección requiere una guía, factura u otra referencia documental.");
    }
    if (note.length < 10) throw new Error("Explica la corrección en al menos 10 caracteres.");
    nextStatus = "corrected";
  }

  if (documentReference) await assertDocumentReferenceAvailable(db, documentReference, movementId);
  const reviewedAt = new Date().toISOString();
  await db.batch([
    db.prepare(`UPDATE fuel_movements SET liters=?,review_status=?,original_liters=COALESCE(original_liters,liters),
      document_reference=?,reviewed_by_user_id=?,reviewed_by_name=?,reviewed_at=?,review_note=? WHERE id=?`)
      .bind(nextLiters, nextStatus, documentReference, actor.id, actor.name, reviewedAt, note || null, movementId),
    db.prepare(`INSERT INTO fuel_receipt_reviews(
      id,movement_id,action,previous_liters,resulting_liters,document_reference,note,actor_user_id,actor_name,occurred_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?)`).bind(
      reviewId, movementId, action === "approve" ? "approved" : action === "correct" ? "corrected" : "rejected",
      movement.liters, nextLiters, documentReference, note, actor.id, actor.name, reviewedAt,
    ),
  ]);
  return { updated: true, movement: await fuelMovementById(db, movementId) };
}

type ManualReceiptInput = {
  requestId?: unknown;
  occurredAt?: unknown;
  liters?: unknown;
  documentReference?: unknown;
  source?: unknown;
  note?: unknown;
};

export async function createManualFuelReceipt(
  db: D1DatabaseLike,
  input: ManualReceiptInput,
  actor: ReceiptReviewActor,
) {
  const requestId = requestIdentifier(input.requestId);
  const movementId = `FR-MANUAL-${requestId}`;
  const existing = await fuelMovementById(db, movementId);
  if (existing) return { created: false, movement: existing };
  if (typeof input.occurredAt !== "string") throw new Error("Indica la fecha y hora de la recepción.");
  const timestamp = new Date(input.occurredAt);
  if (Number.isNaN(timestamp.getTime()) || timestamp.getTime() > Date.now() + 5 * 60_000) {
    throw new Error("La fecha de la recepción no es válida.");
  }
  if (typeof input.liters !== "number" || !Number.isFinite(input.liters) || input.liters <= 0 || input.liters > CAPACITY_LITERS) {
    throw new Error(`El volumen recibido debe estar entre 0 y ${CAPACITY_LITERS} litros.`);
  }
  const liters = round3(input.liters);
  const documentReference = boundedText(input.documentReference, 120);
  if (documentReference.length < 2) throw new Error("Ingresa la guía, factura u otra referencia de la recepción.");
  const note = boundedText(input.note, 500);
  if (note.length < 5) throw new Error("Agrega una nota breve que identifique la recepción.");
  const source = boundedText(input.source, 80) || "Registro manual";
  const iso = timestamp.toISOString();
  await assertAfterFieldReset(db, iso);
  await assertDocumentReferenceAvailable(db, documentReference, movementId);
  const [before, after, detector] = await Promise.all([
    db.prepare(`SELECT level_liters AS level FROM fuel_level_readings
      WHERE occurred_at<=? ORDER BY occurred_at DESC LIMIT 1`).bind(iso).first<{ level: number }>(),
    db.prepare(`SELECT level_liters AS level FROM fuel_level_readings
      WHERE occurred_at>=? ORDER BY occurred_at ASC LIMIT 1`).bind(iso).first<{ level: number }>(),
    db.prepare("SELECT last_level_liters AS level FROM fuel_detection_state WHERE id=1").first<{ level: number }>(),
  ]);
  const openingLevel = round1(Number(before?.level ?? detector?.level ?? 0));
  const closingLevel = round1(Number(after?.level ?? Math.min(CAPACITY_LITERS, openingLevel + liters)));
  const reviewedAt = new Date().toISOString();
  await db.batch([
    db.prepare(`INSERT INTO fuel_movements(
      id,movement_type,classification,occurred_at,liters,opening_level_liters,closing_level_liters,
      source,reference_id,detail,detected_automatically,confidence,detection_status,review_status,
      original_liters,document_reference,reviewed_by_user_id,reviewed_by_name,reviewed_at,review_note
    ) VALUES (?,'receipt','standard',?,?,?,?,?,?,?,0,1,'confirmed','approved',?,?,?,?,?,?)`).bind(
      movementId, iso, liters, openingLevel, closingLevel, source, `MANUAL-${requestId}`, note,
      liters, documentReference, actor.id, actor.name, reviewedAt, note,
    ),
    db.prepare(`INSERT INTO fuel_receipt_reviews(
      id,movement_id,action,previous_liters,resulting_liters,document_reference,note,actor_user_id,actor_name,occurred_at
    ) VALUES (?,?,'manual_created',NULL,?,?,?,?,?,?)`).bind(
      `FR-REVIEW-${requestId}`, movementId, liters, documentReference, note, actor.id, actor.name, reviewedAt,
    ),
  ]);
  return { created: true, movement: await fuelMovementById(db, movementId) };
}

async function assertDocumentReferenceAvailable(db: D1DatabaseLike, reference: string, movementId: string) {
  const duplicate = await db.prepare(`SELECT id FROM fuel_movements WHERE movement_type='receipt'
    AND document_reference=? AND id<>? AND review_status<>'rejected' LIMIT 1`).bind(reference, movementId).first<{ id: string }>();
  if (duplicate) throw new Error("La referencia documental ya está asociada a otra recepción.");
}

async function fuelMovementById(db: D1DatabaseLike, id: string) {
  const row = await db.prepare(`SELECT id,movement_type AS type,classification,occurred_at AS occurredAt,liters,
    opening_level_liters AS openingLevel,closing_level_liters AS closingLevel,source,reference_id AS reference,
    legacy_id AS legacyId,manual_mode_session_id AS manualModeSessionId,detail,
    operator_id AS operatorId,NULL AS operatorName,equipment_id AS equipmentId,NULL AS equipmentName,is_master AS isMaster,
    detected_automatically AS detectedAutomatically,confidence,detection_status AS status,review_status AS reviewStatus,
    original_liters AS originalLiters,document_reference AS documentReference,reviewed_by_user_id AS reviewedByUserId,
    reviewed_by_name AS reviewedByName,reviewed_at AS reviewedAt,review_note AS reviewNote
    FROM fuel_movements WHERE id=?`).bind(id).first<Record<string, unknown>>();
  return row ? toMovement(row) : null;
}

function requestIdentifier(value: unknown) {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/u.test(value)) {
    throw new Error("El identificador de la solicitud no es válido.");
  }
  return value;
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
  classification?: unknown;
  authorizationEvidence?: unknown;
  adoptionStage?: unknown;
  assistedMode?: unknown;
  equipmentIssue?: unknown;
  manualMode?: unknown;
  manualModeSessionId?: unknown;
};

export async function ingestEdgeFuelMovement(db: D1DatabaseLike, input: EdgeFuelMovementInput) {
  const suppliedId = boundedText(input.id, 128);
  if (!suppliedId || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(suppliedId)) throw new Error("El identificador del despacho no es válido.");
  if (input.type !== "dispatch") throw new Error("El canal edge sólo acepta despachos del PLC.");
  if (typeof input.manualMode !== "undefined" && typeof input.manualMode !== "boolean") throw new Error("La condición de modo manual no es válida.");
  const suppliedSessionId = optionalIdentifier(input.manualModeSessionId);
  if (input.manualModeSessionId != null && !suppliedSessionId) throw new Error("La sesión de modo manual no es válida.");
  const legacyManualId = suppliedId.startsWith("manual-segment-");
  const id = legacyManualId ? suppliedId.slice("manual-segment-".length) : suppliedId;
  if (!id || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(id)) throw new Error("El identificador del despacho no es válido.");
  const suppliedReference = boundedText(input.reference, 128);
  const manualMode = input.manualMode === true || legacyManualId || Boolean(suppliedSessionId);
  const manualModeSessionId = suppliedSessionId
    ?? (manualMode && suppliedReference && suppliedReference !== suppliedId ? optionalIdentifier(suppliedReference) : null);
  const legacyId = legacyManualId ? suppliedId : null;
  if (typeof input.classification !== "undefined"
    && input.classification !== "standard" && input.classification !== "pump_enablement") {
    throw new Error("La clasificación del movimiento no es válida.");
  }
  if (typeof input.liters !== "number" || !Number.isFinite(input.liters) || input.liters <= 0 || input.liters > CAPACITY_LITERS) {
    throw new Error(`El despacho debe estar entre 0 y ${CAPACITY_LITERS} litros.`);
  }
  const classification = input.liters < PUMP_ENABLEMENT_THRESHOLD_LITERS
    ? "pump_enablement"
    : input.classification ?? "standard";
  if (typeof input.occurredAt !== "string") throw new Error("La fecha del despacho no es válida.");
  const timestamp = new Date(input.occurredAt);
  if (Number.isNaN(timestamp.getTime())) throw new Error("La fecha del despacho no es válida.");
  if (timestamp.getTime() > Date.now() + 5 * 60_000) throw new Error("El despacho no puede estar en el futuro.");
  await assertAfterFieldReset(db, timestamp.toISOString());
  const existing = await db.prepare(`SELECT
      id,movement_type AS type,classification,occurred_at AS occurredAt,liters,
      opening_level_liters AS openingLevel,closing_level_liters AS closingLevel,
      source,reference_id AS reference,legacy_id AS legacyId,manual_mode_session_id AS manualModeSessionId,
      detail,operator_id AS operatorId,equipment_id AS equipmentId,
      is_master AS isMaster,authorization_evidence AS authorizationEvidence,adoption_stage AS adoptionStage,
      assisted_mode AS assistedMode,equipment_issue AS equipmentIssue,detected_automatically AS detectedAutomatically,
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
  const authorizationEvidence = normalizeAuthorizationEvidence(input.authorizationEvidence, { isMaster, unauthorized });
  const adoptionStage = input.adoptionStage == null ? null : validAdoptionStage(input.adoptionStage) ? input.adoptionStage : null;
  if (input.adoptionStage != null && !adoptionStage) throw new Error("La etapa de adopción del despacho no es válida.");
  if (typeof input.assistedMode !== "undefined" && typeof input.assistedMode !== "boolean") throw new Error("La condición asistida no es válida.");
  const assistedMode = input.assistedMode === true;
  const equipmentIssue = boundedText(input.equipmentIssue, 80) || null;
  if (classification === "pump_enablement" && input.liters >= PUMP_ENABLEMENT_THRESHOLD_LITERS) {
    throw new Error("Una habilitación de bomba debe registrar menos de 0,12 L.");
  }
  if (isMaster && !operatorId) throw new Error("Un despacho con tarjeta maestra requiere un operador responsable.");
  if ((authorizationEvidence === "full") && (!operatorId || !equipmentId)) throw new Error("La trazabilidad completa requiere operador y equipo.");
  if (authorizationEvidence === "rfid_only" && !operatorId) throw new Error("La autorización RFID requiere un operador.");
  if (existing) {
    const movement = toMovement(existing);
    if (
      movement.type !== "dispatch"
      || movement.classification !== classification
      || movement.occurredAt !== timestamp.toISOString()
      || movement.liters !== round3(input.liters)
      || movement.operatorId !== operatorId
      || movement.equipmentId !== equipmentId
      || movement.isMaster !== isMaster
      || movement.authorizationEvidence !== authorizationEvidence
      || movement.adoptionStage !== adoptionStage
      || movement.assistedMode !== assistedMode
      || movement.manualModeSessionId !== manualModeSessionId
      || movement.detectedAutomatically !== unauthorized
    ) throw new Error("El identificador del despacho ya pertenece a otro movimiento.");
    return { created: false, movement };
  }

  const state = await db.prepare(`SELECT last_level_liters AS lastLevel,
      active_receipt_id AS activeId FROM fuel_detection_state WHERE id=1`)
    .first<Record<string, unknown>>();
  if (!state) throw new Error("El detector de nivel no está inicializado.");
  const liters = round3(input.liters);
  const opening = round1(Math.max(0, Number(state.lastLevel)));
  const closing = round1(Math.max(0, opening - liters));
  const baseDetail = boundedText(input.detail, 200);
  const closeReason = boundedText((input as EdgeFuelMovementInput & { closeReason?: unknown }).closeReason, 80);
  const movementDetail = closeReason ? `${baseDetail} · Cierre: ${closeReason}`.slice(0, 240) : baseDetail;
  await db.batch([
    db.prepare(`INSERT INTO fuel_movements(
      id,movement_type,classification,occurred_at,liters,opening_level_liters,closing_level_liters,
      source,reference_id,legacy_id,manual_mode_session_id,detail,operator_id,equipment_id,is_master,authorization_evidence,adoption_stage,
      assisted_mode,equipment_issue,detected_automatically,confidence,detection_status
    ) VALUES (?,'dispatch',?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1,'confirmed')`).bind(
      id,
      classification,
      timestamp.toISOString(),
      liters,
      opening,
      closing,
      boundedText(input.source, 80) || "K24 + PLC",
      manualMode ? id : suppliedReference || id,
      legacyId,
      manualModeSessionId,
      movementDetail,
      operatorId,
      equipmentId,
      Number(isMaster),
      authorizationEvidence,
      adoptionStage,
      Number(assistedMode),
      equipmentIssue,
      Number(unauthorized),
    ),
    // El K24 mide el volumen despachado, pero no es una nueva muestra del OCIO.
    // Mantener last_level_liters evita que la siguiente publicación periódica
    // del mismo nivel absoluto reaparezca como una recepción "espejo".
    db.prepare(`UPDATE fuel_detection_state SET baseline_level_liters=last_level_liters,
      peak_level_liters=last_level_liters,active_receipt_id=NULL,active_started_at=NULL WHERE id=1`),
  ]);
  const movement = await db.prepare(`SELECT
      id,movement_type AS type,classification,occurred_at AS occurredAt,liters,
      opening_level_liters AS openingLevel,closing_level_liters AS closingLevel,
      source,reference_id AS reference,legacy_id AS legacyId,manual_mode_session_id AS manualModeSessionId,
      detail,operator_id AS operatorId,equipment_id AS equipmentId,
      is_master AS isMaster,authorization_evidence AS authorizationEvidence,adoption_stage AS adoptionStage,
      assisted_mode AS assistedMode,equipment_issue AS equipmentIssue,detected_automatically AS detectedAutomatically,
      confidence,detection_status AS status FROM fuel_movements WHERE id=?`).bind(id).first<Record<string, unknown>>();
  return { created: true, movement: movement ? toMovement(movement) : null };
}

async function migrateManualMovementIdentity(db: D1DatabaseLike) {
  const applied = await db.prepare("SELECT value FROM fuel_history_meta WHERE key=?")
    .bind(MANUAL_MOVEMENT_IDENTITY_MIGRATION_KEY).first<{ value: string }>();
  if (applied) return;

  const legacyRows = await db.prepare(`SELECT id,reference_id AS reference
    FROM fuel_movements WHERE movement_type='dispatch' AND (
      id LIKE 'manual-segment-%'
      OR source LIKE '%Modo manual%'
      OR source LIKE '%Adopción asistida%'
      OR detail LIKE '%Modo manual%'
      OR detail LIKE '%Adopción asistida%'
    )`).all<{ id: string; reference: string }>();
  const existingIds = new Set((await db.prepare("SELECT id FROM fuel_movements").all<{ id: string }>()).results.map((row) => row.id));
  const statements = [];
  let normalized = 0;
  for (const row of legacyRows.results) {
    const legacyId = row.id.startsWith("manual-segment-") ? row.id : null;
    const transactionId = legacyId ? row.id.slice("manual-segment-".length) : row.id;
    if (!transactionId || (transactionId !== row.id && existingIds.has(transactionId))) {
      throw new Error("No fue posible normalizar un identificador manual duplicado.");
    }
    const sessionId = row.reference && row.reference !== row.id ? row.reference : null;
    statements.push(db.prepare(`UPDATE fuel_movements SET
      id=?,reference_id=?,legacy_id=COALESCE(legacy_id,?),
      manual_mode_session_id=COALESCE(manual_mode_session_id,?) WHERE id=?`)
      .bind(transactionId, transactionId, legacyId, sessionId, row.id));
    existingIds.delete(row.id);
    existingIds.add(transactionId);
    normalized += 1;
  }
  const migratedAt = new Date().toISOString();
  statements.push(db.prepare("INSERT INTO fuel_history_meta(key,value) VALUES (?,?)")
    .bind(MANUAL_MOVEMENT_IDENTITY_MIGRATION_KEY, JSON.stringify({ migratedAt, normalized })));
  await db.batch(statements);
}

async function migrateLegacyPumpEnablements(db: D1DatabaseLike) {
  const applied = await db.prepare("SELECT value FROM fuel_history_meta WHERE key=?")
    .bind(PUMP_ENABLEMENT_CLASSIFICATION_MIGRATION_KEY).first<{ value: string }>();
  if (applied) return;
  const candidates = await db.prepare(`SELECT COUNT(*) AS total FROM fuel_movements
    WHERE movement_type='dispatch' AND classification='standard' AND liters<?`)
    .bind(PUMP_ENABLEMENT_THRESHOLD_LITERS).first<{ total: number }>();
  const migratedAt = new Date().toISOString();
  await db.batch([
    db.prepare(`UPDATE fuel_movements SET classification='pump_enablement'
      WHERE movement_type='dispatch' AND classification='standard' AND liters<?`)
      .bind(PUMP_ENABLEMENT_THRESHOLD_LITERS),
    db.prepare("INSERT INTO fuel_history_meta(key,value) VALUES (?,?)")
      .bind(PUMP_ENABLEMENT_CLASSIFICATION_MIGRATION_KEY, JSON.stringify({
        migratedAt,
        recategorized: Number(candidates?.total ?? 0),
      })),
  ]);
}

async function repairTransientReceipts(db: D1DatabaseLike) {
  const applied = await db.prepare("SELECT value FROM fuel_history_meta WHERE key=?")
    .bind(TRANSIENT_RECEIPT_REPAIR_KEY).first<{ value: string }>();
  if (applied) return;

  // El ciclo interno del OCIO generó saltos breves: una subida instantánea
  // seguida del nivel anterior, o la recuperación después de una caída falsa.
  // Se eliminan sólo recepciones automáticas respaldadas por esas lecturas.
  const result = await db.prepare(`SELECT DISTINCT receipt.id,receipt.liters
    FROM fuel_movements AS receipt
    WHERE receipt.movement_type='receipt'
      AND receipt.detected_automatically=1
      AND (
        EXISTS (
          SELECT 1 FROM fuel_level_readings AS start_reading
          JOIN fuel_level_readings AS before_jump
            ON unixepoch(before_jump.occurred_at)
              BETWEEN unixepoch(receipt.occurred_at)-5 AND unixepoch(receipt.occurred_at)-1
          WHERE start_reading.occurred_at=receipt.occurred_at
            AND start_reading.level_liters-before_jump.level_liters>=35
        )
        OR EXISTS (
          SELECT 1 FROM fuel_level_readings AS after_reading
          WHERE unixepoch(after_reading.occurred_at)
            BETWEEN unixepoch(receipt.occurred_at)+1 AND unixepoch(receipt.occurred_at)+120
            AND ABS(after_reading.level_liters-receipt.opening_level_liters)<=30
        )
        OR EXISTS (
          SELECT 1 FROM fuel_level_readings AS before_reading
          WHERE unixepoch(before_reading.occurred_at)
            BETWEEN unixepoch(receipt.occurred_at)-120 AND unixepoch(receipt.occurred_at)-1
            AND ABS(before_reading.level_liters-receipt.closing_level_liters)<=30
        )
      )`)
    .all<{ id: string; liters: number }>();
  const ids = result.results.map((row) => String(row.id));
  const removedLiters = round1(result.results.reduce((sum, row) => sum + Number(row.liters), 0));
  const repairedAt = new Date().toISOString();
  const statements = ids.map((id) => db.prepare("DELETE FROM fuel_movements WHERE id=?").bind(id));
  if (ids.length > 0) {
    statements.push(db.prepare(`UPDATE fuel_detection_state SET baseline_level_liters=last_level_liters,
      peak_level_liters=last_level_liters,active_receipt_id=NULL,active_started_at=NULL WHERE id=1`));
  }
  statements.push(db.prepare("INSERT INTO fuel_history_meta(key,value) VALUES (?,?)")
    .bind(TRANSIENT_RECEIPT_REPAIR_KEY, JSON.stringify({ repairedAt, removed: ids.length, removedLiters })));
  await db.batch(statements);
}

async function migrateSustainedReceiptDetector(db: D1DatabaseLike) {
  const applied = await db.prepare("SELECT value FROM fuel_history_meta WHERE key=?")
    .bind(DETECTOR_V2_MIGRATION_KEY).first<{ value: string }>();
  if (applied) return;
  const staleCandidates = await db.prepare(`SELECT COUNT(*) AS total FROM fuel_movements
    WHERE movement_type='receipt' AND detected_automatically=1 AND detection_status='accumulating'`)
    .first<{ total: number }>();
  const migratedAt = new Date().toISOString();
  await db.batch([
    db.prepare(`DELETE FROM fuel_movements
      WHERE movement_type='receipt' AND detected_automatically=1 AND detection_status='accumulating'`),
    db.prepare(`UPDATE fuel_detection_state SET active_receipt_id=NULL,active_started_at=NULL,
      baseline_level_liters=last_level_liters,peak_level_liters=last_level_liters,
      baseline_started_at=last_reading_at,warmup_started_at=NULL WHERE id=1`),
    db.prepare("INSERT INTO fuel_history_meta(key,value) VALUES (?,?)")
      .bind(DETECTOR_V2_MIGRATION_KEY, JSON.stringify({ migratedAt, removedAccumulating: Number(staleCandidates?.total ?? 0) })),
  ]);
}

async function migrateReceiptReviewWorkflow(db: D1DatabaseLike) {
  const applied = await db.prepare("SELECT value FROM fuel_history_meta WHERE key=?")
    .bind(RECEIPT_REVIEW_MIGRATION_KEY).first<{ value: string }>();
  if (applied) return;
  const migratedAt = new Date().toISOString();
  await db.batch([
    db.prepare(`UPDATE fuel_movements SET review_status='pending',original_liters=COALESCE(original_liters,liters),
      reviewed_by_user_id=NULL,reviewed_by_name=NULL,reviewed_at=NULL,
      review_note='Detección automática histórica pendiente de conciliación'
      WHERE movement_type='receipt' AND detected_automatically=1 AND review_status='not_required'`),
    db.prepare(`UPDATE fuel_movements SET review_status='approved',original_liters=COALESCE(original_liters,liters),
      reviewed_by_name='Confirmación histórica',reviewed_at=COALESCE(reviewed_at,created_at),
      review_note='Movimiento confirmado antes de habilitar el flujo de aprobación'
      WHERE movement_type='receipt' AND detected_automatically=0 AND review_status='not_required'`),
    db.prepare(`INSERT OR IGNORE INTO fuel_receipt_reviews(
      id,movement_id,action,previous_liters,resulting_liters,note,actor_name,occurred_at
    ) SELECT id || ':historical-auto-detected',id,'automatic_detected',NULL,liters,
      'Detección automática histórica enviada a conciliación','Migración del sistema',COALESCE(created_at,?)
      FROM fuel_movements WHERE movement_type='receipt' AND detected_automatically=1 AND review_status='pending'`).bind(migratedAt),
    db.prepare(`INSERT OR IGNORE INTO fuel_receipt_reviews(
      id,movement_id,action,previous_liters,resulting_liters,note,actor_name,occurred_at
    ) SELECT id || ':legacy-review',id,'approved',liters,liters,
      'Movimiento confirmado antes de habilitar el flujo de aprobación','Migración del sistema',COALESCE(created_at,?)
      FROM fuel_movements WHERE movement_type='receipt' AND detected_automatically=0 AND review_status='approved'`).bind(migratedAt),
    db.prepare("INSERT INTO fuel_history_meta(key,value) VALUES (?,?)")
      .bind(RECEIPT_REVIEW_MIGRATION_KEY, JSON.stringify({ migratedAt })),
  ]);
}

// V1.8.0 aprobaba automáticamente el historial al activar el flujo. Esta
// migración correctiva reabre sólo esas aprobaciones generadas por el sistema;
// jamás revierte una decisión ya tomada por una persona.
async function migrateHistoricalAutomaticReceiptsForReview(db: D1DatabaseLike) {
  const applied = await db.prepare("SELECT value FROM fuel_history_meta WHERE key=?")
    .bind(HISTORICAL_AUTOMATIC_REVIEW_MIGRATION_KEY).first<{ value: string }>();
  if (applied) return;
  const migratedAt = new Date().toISOString();
  await db.batch([
    db.prepare(`UPDATE fuel_movements AS movements SET
      review_status='pending',original_liters=COALESCE(original_liters,liters),
      reviewed_by_user_id=NULL,reviewed_by_name=NULL,reviewed_at=NULL,
      review_note='Detección automática histórica pendiente de conciliación'
      WHERE movement_type='receipt' AND detected_automatically=1 AND detection_status='confirmed'
        AND (
          review_status='not_required'
          OR (review_status='approved' AND NOT EXISTS (
            SELECT 1 FROM fuel_receipt_reviews AS reviews
            WHERE reviews.movement_id=movements.id
              AND reviews.action IN ('approved','corrected','rejected')
              AND reviews.id<>(movements.id || ':legacy-review')
          ))
        )`),
    db.prepare(`DELETE FROM fuel_receipt_reviews
      WHERE id IN (
        SELECT reviews.id FROM fuel_receipt_reviews AS reviews
        INNER JOIN fuel_movements AS movements ON movements.id=reviews.movement_id
        WHERE movements.movement_type='receipt' AND movements.detected_automatically=1
          AND movements.review_status='pending' AND reviews.id=(movements.id || ':legacy-review')
      )`),
    db.prepare(`INSERT OR IGNORE INTO fuel_receipt_reviews(
      id,movement_id,action,previous_liters,resulting_liters,note,actor_name,occurred_at
    ) SELECT movements.id || ':historical-auto-detected',movements.id,'automatic_detected',NULL,
      COALESCE(movements.original_liters,movements.liters),
      'Detección automática histórica enviada a conciliación','Migración del sistema',COALESCE(movements.created_at,?)
      FROM fuel_movements AS movements
      WHERE movements.movement_type='receipt' AND movements.detected_automatically=1
        AND movements.review_status='pending'
        AND NOT EXISTS (
          SELECT 1 FROM fuel_receipt_reviews AS reviews
          WHERE reviews.movement_id=movements.id AND reviews.action='automatic_detected'
        )`).bind(migratedAt),
    db.prepare("INSERT INTO fuel_history_meta(key,value) VALUES (?,?)")
      .bind(HISTORICAL_AUTOMATIC_REVIEW_MIGRATION_KEY, JSON.stringify({ migratedAt })),
  ]);
}

// Conserva las detecciones históricas ya visibles, pero corrige la certeza de
// las que aún no han sido decididas por una persona. Bajo 100 L el volumen está
// dentro o cerca de la banda de variación del OCIO y no merece certeza alta.
async function migrateAutomaticReceiptConfidence(db: D1DatabaseLike) {
  const applied = await db.prepare("SELECT value FROM fuel_history_meta WHERE key=?")
    .bind(RECEIPT_CONFIDENCE_MIGRATION_KEY).first<{ value: string }>();
  if (applied) return;
  const migratedAt = new Date().toISOString();
  await db.batch([
    db.prepare(`UPDATE fuel_movements SET confidence=ROUND(
      CASE
        WHEN COALESCE(original_liters,liters) < ?
          THEN MIN(0.79,MAX(0.25,COALESCE(original_liters,liters)/?))
        ELSE 0.87 + ((COALESCE(original_liters,liters)-?)/(?-?))*0.11
      END,3)
      WHERE movement_type='receipt' AND detected_automatically=1 AND review_status='pending'
        AND COALESCE(original_liters,liters) < ?`).bind(
      RECEIPT_THRESHOLD_LITERS,
      RECEIPT_THRESHOLD_LITERS,
      RECEIPT_THRESHOLD_LITERS,
      HIGH_CONFIDENCE_RECEIPT_LITERS,
      RECEIPT_THRESHOLD_LITERS,
      HIGH_CONFIDENCE_RECEIPT_LITERS,
    ),
    db.prepare("INSERT INTO fuel_history_meta(key,value) VALUES (?,?)")
      .bind(RECEIPT_CONFIDENCE_MIGRATION_KEY, JSON.stringify({ migratedAt })),
  ]);
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
      id,capacity_liters,baseline_level_liters,last_level_liters,peak_level_liters,
      active_receipt_id,active_started_at,baseline_started_at,warmup_started_at,telemetry_session_id,last_reading_at
    ) VALUES (1,?,?,?,?,NULL,NULL,?,NULL,NULL,?)`).bind(
      CAPACITY_LITERS, latest, latest, latest, "2026-08-10T14:30:00.000Z", "2026-08-10T14:30:00.000Z",
    ),
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
      classification: "standard",
      liters: round1(received), openingLevel: round1(receiptOpening), closingLevel: level,
      source: "Sensor OCIO", reference: `AUTO-OCIO-${monthKey}`,
      detail: "Recepción detectada por aumento sostenido del nivel", detectedAutomatically: true, confidence: 0.99, status: "confirmed",
      authorizationEvidence: "legacy", adoptionStage: null, assistedMode: false, equipmentIssue: null,
      reviewStatus: "approved", originalLiters: round1(received), documentReference: null,
      reviewedByUserId: null, reviewedByName: "Confirmación histórica", reviewedAt: null, reviewNote: null,
    });
    [7, 13, 19, 25].forEach((day, dispatchIndex) => {
      const liters = 172 + ((monthIndex * 31 + dispatchIndex * 47) % 88);
      const opening = level;
      level = round1(Math.max(180, level - liters));
      output.push({
        id: `FD-${monthKey}-${dispatchIndex + 1}`, type: "dispatch", occurredAt: new Date(Date.UTC(year, month, day, 14 + dispatchIndex, 10)).toISOString(),
        classification: "standard",
        liters: round1(opening - level), openingLevel: round1(opening), closingLevel: level,
        source: "PLC surtidor", reference: `TX-${monthKey}-${String(dispatchIndex + 1).padStart(3, "0")}`,
        detail: `${5 + dispatchIndex * 2} cargas trazables consolidadas`, detectedAutomatically: false, confidence: 1, status: "confirmed",
        authorizationEvidence: "legacy", adoptionStage: null, assistedMode: false, equipmentIssue: null,
        reviewStatus: "not_required", originalLiters: null, documentReference: null,
        reviewedByUserId: null, reviewedByName: null, reviewedAt: null, reviewNote: null,
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
      classification: "standard",
      source: "PLC surtidor", reference, detail, detectedAutomatically: false, confidence: 1, status: "confirmed",
      authorizationEvidence: "legacy", adoptionStage: null, assistedMode: false, equipmentIssue: null,
      reviewStatus: "not_required", originalLiters: null, documentReference: null,
      reviewedByUserId: null, reviewedByName: null, reviewedAt: null, reviewNote: null,
    });
  });
  return actual;
}

function toMovement(row: Record<string, unknown>): FuelMovement {
  return {
    id: String(row.id), type: row.type as FuelMovementType,
    classification: row.classification === "pump_enablement" ? "pump_enablement" : "standard",
    occurredAt: String(row.occurredAt),
    liters: Number(row.liters), openingLevel: Number(row.openingLevel), closingLevel: Number(row.closingLevel),
    source: String(row.source), reference: String(row.reference),
    legacyId: typeof row.legacyId === "string" && row.legacyId ? row.legacyId : null,
    manualModeSessionId: typeof row.manualModeSessionId === "string" && row.manualModeSessionId ? row.manualModeSessionId : null,
    detail: String(row.detail),
    operatorId: typeof row.operatorId === "string" && row.operatorId ? row.operatorId : null,
    operatorName: typeof row.operatorName === "string" && row.operatorName ? row.operatorName : null,
    equipmentId: typeof row.equipmentId === "string" && row.equipmentId ? row.equipmentId : null,
    equipmentName: typeof row.equipmentName === "string" && row.equipmentName ? row.equipmentName : null,
    isMaster: row.isMaster === 1 || row.isMaster === true,
    authorizationEvidence: normalizeAuthorizationEvidence(row.authorizationEvidence, {
      isMaster: row.isMaster === 1 || row.isMaster === true,
      unauthorized: row.detectedAutomatically === 1,
    }),
    adoptionStage: validAdoptionStage(row.adoptionStage) ? row.adoptionStage : null,
    assistedMode: row.assistedMode === 1 || row.assistedMode === true,
    equipmentIssue: typeof row.equipmentIssue === "string" && row.equipmentIssue ? row.equipmentIssue : null,
    detectedAutomatically: row.detectedAutomatically === 1, confidence: Number(row.confidence),
    status: row.status === "accumulating" ? "accumulating" : "confirmed",
    reviewStatus: receiptReviewStatus(row.reviewStatus),
    originalLiters: row.originalLiters == null ? null : Number(row.originalLiters),
    documentReference: typeof row.documentReference === "string" && row.documentReference ? row.documentReference : null,
    reviewedByUserId: typeof row.reviewedByUserId === "string" && row.reviewedByUserId ? row.reviewedByUserId : null,
    reviewedByName: typeof row.reviewedByName === "string" && row.reviewedByName ? row.reviewedByName : null,
    reviewedAt: typeof row.reviewedAt === "string" && row.reviewedAt ? row.reviewedAt : null,
    reviewNote: typeof row.reviewNote === "string" && row.reviewNote ? row.reviewNote : null,
  };
}

function receiptReviewStatus(value: unknown): ReceiptReviewStatus {
  return value === "pending" || value === "approved" || value === "corrected" || value === "rejected"
    ? value : "not_required";
}

function round1(value: number) { return Math.round(value * 10) / 10; }
function round3(value: number) { return Math.round(value * 1000) / 1000; }
function boundedText(value: unknown, max: number) { return typeof value === "string" ? value.trim().slice(0, max) : ""; }
function optionalTelemetrySessionId(value: unknown) {
  if (value === null || typeof value === "undefined" || value === "") return null;
  if (typeof value !== "string") return null;
  const identifier = value.trim();
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(identifier) ? identifier : null;
}
function optionalIdentifier(value: unknown) {
  if (value === null || typeof value === "undefined" || value === "") return null;
  if (typeof value !== "string") return null;
  const identifier = value.trim();
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(identifier) ? identifier : null;
}

function validAdoptionStage(value: unknown): value is MovementAdoptionStage {
  return value === "assisted" || value === "rfid_only" || value === "full";
}

function normalizeAuthorizationEvidence(
  value: unknown,
  context: { isMaster: boolean; unauthorized: boolean },
): AuthorizationEvidence {
  if (context.unauthorized) return "unauthorized";
  if (context.isMaster) return "master";
  return value === "full" || value === "rfid_only" || value === "assisted" || value === "legacy"
    ? value : "legacy";
}
