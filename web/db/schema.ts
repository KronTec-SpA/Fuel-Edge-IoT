import { sql } from "drizzle-orm";
import { index, integer, primaryKey, real, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const voltageReadings = sqliteTable("voltage_readings", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  siteId: text("site_id").notNull(),
  telemetrySessionId: text("telemetry_session_id").notNull().default(""),
  occurredAt: text("occurred_at").notNull(),
  source: text("source").notNull(),
  volts: real("volts").notNull(),
  rawAdc: real("raw_adc").notNull(),
  quality: text("quality").notNull(),
  calibrationId: text("calibration_id"),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  index("idx_voltage_readings_occurred").on(table.occurredAt),
  uniqueIndex("idx_voltage_readings_identity").on(table.siteId, table.telemetrySessionId, table.source, table.occurredAt),
]);

export const fuelLevelQuality = sqliteTable("fuel_level_quality", {
  id: integer("id").primaryKey(),
  occurredAt: text("occurred_at").notNull(),
  quality: text("quality").notNull(),
  telemetrySessionId: text("telemetry_session_id"),
});

export const fuelLevelRanges = sqliteTable("fuel_level_ranges", {
  occurredAt: text("occurred_at").primaryKey(),
  minLiters: real("min_liters").notNull(),
  maxLiters: real("max_liters").notNull(),
  source: text("source").notNull(),
  telemetrySessionId: text("telemetry_session_id"),
});

export const ocioCalibrationSettings = sqliteTable("ocio_calibration_settings", {
  siteId: text("site_id").primaryKey(),
  intervalDays: integer("interval_days").notNull().default(365),
  revision: integer("revision").notNull().default(0),
  confirmationId: text("confirmation_id"),
  calibratedAt: text("calibrated_at"),
  calibratedBy: text("calibrated_by"),
  calibratedByName: text("calibrated_by_name"),
  nextDueAt: text("next_due_at"),
  fingerprint: text("fingerprint"),
  appliedRevision: integer("applied_revision").notNull().default(0),
  appliedAt: text("applied_at"),
  controllerFingerprint: text("controller_fingerprint"),
  controllerSeenAt: text("controller_seen_at"),
  controllerSessionId: text("controller_session_id"),
  controllerPending: integer("controller_pending"),
});

export const ocioCalibrationEvents = sqliteTable("ocio_calibration_events", {
  id: text("id").primaryKey(), siteId: text("site_id").notNull(),
  kind: text("kind").notNull(), revision: integer("revision").notNull(),
  occurredAt: text("occurred_at").notNull(), actorId: text("actor_id").notNull(),
  actorName: text("actor_name").notNull(), intervalDays: integer("interval_days").notNull(),
  nextDueAt: text("next_due_at"), fingerprint: text("fingerprint"), appliedAt: text("applied_at"),
}, table => [index("idx_ocio_calibration_events_site").on(table.siteId,table.occurredAt)]);

export const inventoryBalanceAnchors = sqliteTable("inventory_balance_anchors", {
  id: text("id").primaryKey(),
  siteId: text("site_id").notNull().unique(),
  originalSiteId: text("original_site_id"),
  archivedAt: text("archived_at"),
  payload: text("payload").notNull(),
});

export const inventoryBalanceSamples = sqliteTable("inventory_balance_samples", {
  id: text("id").primaryKey(),
  anchorId: text("anchor_id").notNull().references(() => inventoryBalanceAnchors.id),
  occurredAt: text("occurred_at").notNull(),
  localDate: text("local_date").notNull(),
  payload: text("payload").notNull(),
}, table => [
  index("idx_inventory_balance_time").on(table.anchorId, table.occurredAt),
  index("idx_inventory_balance_day").on(table.anchorId, table.localDate, table.occurredAt),
]);

export const inventoryBalanceAlarmState = sqliteTable("inventory_balance_alarm_state", {
  anchorId: text("anchor_id").primaryKey().references(() => inventoryBalanceAnchors.id),
  episode: integer("episode").notNull().default(0),
  sign: integer("sign").notNull().default(0),
  tier: integer("tier").notNull().default(0),
  lastSeenAt: text("last_seen_at").notNull().default(""),
});

export const webUsers = sqliteTable("web_users", {
  id: text("id").primaryKey(),
  emailDigest: text("email_digest").notNull(),
  emailEncrypted: text("email_encrypted"),
  name: text("name").notNull(),
  role: text("role").notNull(),
  permissions: text("permissions").notNull(),
  passwordHash: text("password_hash").notNull(),
  active: integer("active", { mode: "boolean" }).notNull().default(true),
  mustChangePassword: integer("must_change_password", { mode: "boolean" }).notNull().default(true),
  isMaster: integer("is_master", { mode: "boolean" }).notNull().default(false),
  bootstrapVersion: text("bootstrap_version"),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  lastLoginAt: text("last_login_at"),
}, (table) => [
  uniqueIndex("idx_web_users_email_digest").on(table.emailDigest),
]);

export const webAccessAudit = sqliteTable("web_access_audit", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  actorUserId: text("actor_user_id"),
  event: text("event").notNull(),
  targetUserId: text("target_user_id"),
  occurredAt: text("occurred_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  metadata: text("metadata").notNull().default("{}"),
}, (table) => [
  index("idx_web_access_audit_occurred_at").on(table.occurredAt),
]);

export const webAccessMeta = sqliteTable("web_access_meta", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
});

export const managedOperators = sqliteTable("managed_operators", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  rut: text("rut").notNull(),
  credential: text("credential").notNull(),
  credentialActive: integer("credential_active", { mode: "boolean" }).notNull().default(true),
  credentialIsMaster: integer("credential_is_master", { mode: "boolean" }).notNull().default(false),
  active: integer("active", { mode: "boolean" }).notNull().default(true),
  lastUse: text("last_use").notNull().default("Sin actividad"),
  archivedAt: text("archived_at"),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  index("idx_managed_operators_archived").on(table.archivedAt),
  uniqueIndex("idx_managed_operators_single_active_master").on(table.credentialIsMaster)
    .where(sql`credential_is_master=1 AND credential_active=1 AND archived_at IS NULL`),
]);

export const managedRfidCredentials = sqliteTable("managed_rfid_credentials", {
  credentialId: text("credential_id").primaryKey(),
  credentialActive: integer("credential_active", { mode: "boolean" }).notNull().default(true),
  credentialIsMaster: integer("credential_is_master", { mode: "boolean" }).notNull().default(false),
  operatorId: text("operator_id"),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  uniqueIndex("idx_managed_rfid_one_per_operator").on(table.operatorId)
    .where(sql`operator_id IS NOT NULL`),
  uniqueIndex("idx_managed_rfid_single_active_master").on(table.credentialIsMaster)
    .where(sql`credential_is_master=1 AND credential_active=1`),
  index("idx_managed_rfid_operator").on(table.operatorId),
]);

export const managedEquipment = sqliteTable("managed_equipment", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  kind: text("kind").notNull(),
  condition: text("condition").notNull(),
  module: text("module").notNull(),
  siteId: text("site_id").notNull().default(""),
  active: integer("active", { mode: "boolean" }).notNull().default(true),
  expiry: text("expiry"),
  archivedAt: text("archived_at"),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  index("idx_managed_equipment_archived").on(table.archivedAt),
  index("idx_managed_equipment_module_site_expiry").on(table.module, table.siteId, table.expiry),
]);

export const managedAssociations = sqliteTable("managed_associations", {
  id: text("id").primaryKey(),
  operatorId: text("operator_id").notNull(),
  equipmentId: text("equipment_id").notNull(),
  active: integer("active", { mode: "boolean" }).notNull().default(true),
  since: text("since").notNull(),
  archivedAt: text("archived_at"),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  index("idx_managed_associations_archived").on(table.archivedAt),
  index("idx_managed_associations_operator").on(table.operatorId),
  index("idx_managed_associations_equipment").on(table.equipmentId),
]);

export const managedEntityAudit = sqliteTable("managed_entity_audit", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  actorUserId: text("actor_user_id").notNull(),
  event: text("event").notNull(),
  entityType: text("entity_type").notNull(),
  entityId: text("entity_id").notNull(),
  occurredAt: text("occurred_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  metadata: text("metadata").notNull().default("{}"),
}, (table) => [index("idx_managed_entity_audit_occurred").on(table.occurredAt)]);

export const managedStoreMeta = sqliteTable("managed_store_meta", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
});

export const validatorBluetoothSettings = sqliteTable("validator_bluetooth_settings", {
  siteId: text("site_id").primaryKey(),
  rssiThreshold: integer("rssi_threshold").notNull().default(-70),
  revision: integer("revision").notNull().default(1),
  updatedBy: text("updated_by"),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  appliedThreshold: integer("applied_threshold"),
  appliedRevision: integer("applied_revision"),
  appliedAt: text("applied_at"),
  lastObservedRssi: integer("last_observed_rssi"),
  lastObservedModule: text("last_observed_module"),
  observedAt: text("observed_at"),
});

export const validatorBluetoothObservations = sqliteTable("validator_bluetooth_observations", {
  siteId: text("site_id").notNull(),
  moduleId: text("module_id").notNull(),
  rssi: integer("rssi").notNull(),
  observedAt: text("observed_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  primaryKey({ columns: [table.siteId, table.moduleId] }),
  index("idx_validator_bluetooth_observations_site_time").on(table.siteId, table.observedAt),
]);

export const siteCommissioning = sqliteTable("site_commissioning", {
  siteId: text("site_id").primaryKey(),
  status: text("status").notNull().default("in_progress"),
  cycle: integer("cycle").notNull().default(1),
  startedAt: text("started_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  completedAt: text("completed_at"),
  completedBy: text("completed_by"),
  reopenedAt: text("reopened_at"),
  reopenedBy: text("reopened_by"),
  reopenReason: text("reopen_reason"),
  powerIncidentType: text("power_incident_type"),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

export const powerSupplyEvents = sqliteTable("power_supply_events", {
  id: text("id").primaryKey(),
  siteId: text("site_id").notNull(),
  lostAt: text("lost_at").notNull(),
  restoredAt: text("restored_at").notNull(),
  durationSeconds: integer("duration_seconds").notNull(),
  source: text("source").notNull(),
  lossBootId: text("loss_boot_id"),
  restoreBootId: text("restore_boot_id"),
  recordedAt: text("recorded_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  index("idx_power_supply_events_site_lost").on(table.siteId, table.lostAt),
]);

export const equipmentEnrollmentCandidates = sqliteTable("equipment_enrollment_candidates", {
  moduleId: text("module_id").primaryKey(),
  siteId: text("site_id").notNull(),
  deviceName: text("device_name"),
  equipmentId: text("equipment_id"),
  firmware: text("firmware").notNull(),
  rssi: integer("rssi").notNull(),
  claimed: integer("claimed", { mode: "boolean" }).notNull().default(false),
  status: text("status").notNull().default("detected"),
  lastSeen: text("last_seen").notNull(),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [index("idx_equipment_enrollment_candidates_last_seen").on(table.lastSeen)]);

export const equipmentEnrollmentCommands = sqliteTable("equipment_enrollment_commands", {
  id: text("id").primaryKey(),
  moduleId: text("module_id").notNull(),
  siteId: text("site_id").notNull(),
  equipmentId: text("equipment_id").notNull(),
  requestedName: text("requested_name").notNull(),
  kind: text("kind").notNull().default("Tractor"),
  condition: text("condition").notNull().default("Permanente"),
  validUntil: text("valid_until"),
  status: text("status").notNull().default("pending"),
  requestedBy: text("requested_by").notNull(),
  error: text("error"),
  requestedAt: text("requested_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  completedAt: text("completed_at"),
}, (table) => [
  index("idx_equipment_enrollment_commands_status_module").on(table.status, table.moduleId, table.requestedAt),
  uniqueIndex("idx_equipment_enrollment_commands_active").on(table.moduleId)
    .where(sql`status IN ('pending','enrolling')`),
]);

export const equipmentScanRequests = sqliteTable("equipment_scan_requests", {
  id: text("id").primaryKey(),
  status: text("status").notNull().default("pending"),
  durationSeconds: integer("duration_seconds").notNull().default(25),
  requestedBy: text("requested_by").notNull(),
  requestedAt: text("requested_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  startedAt: text("started_at"),
  completedAt: text("completed_at"),
  discovered: integer("discovered").notNull().default(0),
  verified: integer("verified").notNull().default(0),
  error: text("error"),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [index("idx_equipment_scan_requests_status_requested").on(table.status, table.requestedAt)]);

export const equipmentRegistryRemovals = sqliteTable("equipment_registry_removals", {
  id: text("id").primaryKey(),
  moduleId: text("module_id").notNull(),
  equipmentId: text("equipment_id").notNull(),
  status: text("status").notNull().default("pending"),
  requestedBy: text("requested_by").notNull(),
  error: text("error"),
  requestedAt: text("requested_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  startedAt: text("started_at"),
  completedAt: text("completed_at"),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  index("idx_equipment_registry_removals_status_requested").on(table.status, table.requestedAt),
  uniqueIndex("idx_equipment_registry_removals_active_module").on(table.moduleId)
    .where(sql`status IN ('pending','processing')`),
]);

export const fuelHistoryMeta = sqliteTable("fuel_history_meta", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
});

export const fuelMovements = sqliteTable("fuel_movements", {
  id: text("id").primaryKey(),
  movementType: text("movement_type").notNull(),
  classification: text("classification").notNull().default("standard"),
  occurredAt: text("occurred_at").notNull(),
  liters: real("liters").notNull(),
  openingLevelLiters: real("opening_level_liters").notNull(),
  closingLevelLiters: real("closing_level_liters").notNull(),
  source: text("source").notNull(),
  referenceId: text("reference_id").notNull(),
  legacyId: text("legacy_id"),
  manualModeSessionId: text("manual_mode_session_id"),
  detail: text("detail").notNull().default(""),
  operatorId: text("operator_id"),
  equipmentId: text("equipment_id"),
  isMaster: integer("is_master", { mode: "boolean" }).notNull().default(false),
  authorizationEvidence: text("authorization_evidence").notNull().default("legacy"),
  adoptionStage: text("adoption_stage"),
  assistedMode: integer("assisted_mode", { mode: "boolean" }).notNull().default(false),
  equipmentIssue: text("equipment_issue"),
  detectedAutomatically: integer("detected_automatically", { mode: "boolean" }).notNull().default(false),
  confidence: real("confidence").notNull().default(1),
  detectionStatus: text("detection_status").notNull().default("confirmed"),
  reviewStatus: text("review_status").notNull().default("not_required"),
  originalLiters: real("original_liters"),
  documentReference: text("document_reference"),
  reviewedByUserId: text("reviewed_by_user_id"),
  reviewedByName: text("reviewed_by_name"),
  reviewedAt: text("reviewed_at"),
  reviewNote: text("review_note"),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  index("idx_fuel_movements_occurred").on(table.occurredAt),
  index("idx_fuel_movements_type_occurred").on(table.movementType, table.occurredAt),
  index("idx_fuel_movements_receipt_review").on(table.movementType, table.reviewStatus, table.occurredAt),
  uniqueIndex("idx_fuel_movements_legacy_id").on(table.legacyId).where(sql`legacy_id IS NOT NULL`),
]);

export const fuelReceiptReviews = sqliteTable("fuel_receipt_reviews", {
  id: text("id").primaryKey(),
  movementId: text("movement_id").notNull(),
  action: text("action").notNull(),
  previousLiters: real("previous_liters"),
  resultingLiters: real("resulting_liters"),
  documentReference: text("document_reference"),
  note: text("note").notNull().default(""),
  actorUserId: text("actor_user_id"),
  actorName: text("actor_name"),
  occurredAt: text("occurred_at").notNull(),
}, (table) => [
  index("idx_fuel_receipt_reviews_movement").on(table.movementId, table.occurredAt),
]);

export const pumpTestTransactions = sqliteTable("pump_test_transactions", {
  id: text("id").primaryKey(),
  actorUserId: text("actor_user_id").notNull(),
  transactionType: text("transaction_type").notNull().default("pump_test"),
  status: text("status").notNull().default("pending"),
  durationSeconds: integer("duration_seconds").notNull(),
  requestedAt: text("requested_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  startedAt: text("started_at"),
  completedAt: text("completed_at"),
  expiresAt: text("expires_at").notNull(),
  error: text("error"),
}, (table) => [index("idx_pump_test_status").on(table.status, table.requestedAt)]);

export const manualModeSchedules = sqliteTable("manual_mode_schedules", {
  id: text("id").primaryKey(),
  actorUserId: text("actor_user_id").notNull(),
  actorRole: text("actor_role").notNull(),
  siteId: text("site_id").notNull(),
  purpose: text("purpose").notNull().default("manual"),
  status: text("status").notNull().default("scheduled"),
  startAt: text("start_at").notNull(),
  endAt: text("end_at").notNull(),
  requestedAt: text("requested_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  startedAt: text("started_at"),
  completedAt: text("completed_at"),
  cancelledAt: text("cancelled_at"),
  error: text("error"),
}, (table) => [index("idx_manual_mode_status_start").on(table.status, table.startAt)]);

export const technologyAdoptionSettings = sqliteTable("technology_adoption_settings", {
  siteId: text("site_id").primaryKey(),
  stage: text("stage").notNull().default("full"),
  programStatus: text("program_status").notNull().default("inactive"),
  revision: integer("revision").notNull().default(1),
  programStartedAt: text("program_started_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  completedAt: text("completed_at"),
  stageStartedAt: text("stage_started_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  reviewAt: text("review_at"),
  updatedBy: text("updated_by"),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  note: text("note").notNull().default("Política segura inicial: trazabilidad completa."),
});

export const technologyAdoptionTransitions = sqliteTable("technology_adoption_transitions", {
  id: text("id").primaryKey(),
  siteId: text("site_id").notNull(),
  fromStage: text("from_stage").notNull(),
  toStage: text("to_stage").notNull(),
  reason: text("reason").notNull(),
  actorUserId: text("actor_user_id").notNull(),
  occurredAt: text("occurred_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [index("idx_adoption_transitions_site_time").on(table.siteId, table.occurredAt)]);

export const fuelLevelReadings = sqliteTable("fuel_level_readings", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  occurredAt: text("occurred_at").notNull(),
  levelLiters: real("level_liters").notNull(),
  source: text("source").notNull().default("OCIO"),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [index("idx_fuel_level_readings_occurred").on(table.occurredAt)]);

export const fuelDetectionState = sqliteTable("fuel_detection_state", {
  id: integer("id").primaryKey(),
  capacityLiters: real("capacity_liters").notNull(),
  baselineLevelLiters: real("baseline_level_liters").notNull(),
  lastLevelLiters: real("last_level_liters").notNull(),
  peakLevelLiters: real("peak_level_liters").notNull(),
  activeReceiptId: text("active_receipt_id"),
  activeStartedAt: text("active_started_at"),
  baselineStartedAt: text("baseline_started_at").notNull().default("1970-01-01T00:00:00.000Z"),
  warmupStartedAt: text("warmup_started_at"),
  telemetrySessionId: text("telemetry_session_id"),
  lastReadingAt: text("last_reading_at").notNull(),
});

export const systemAlerts = sqliteTable("system_alerts", {
  id: text("id").primaryKey(),
  severity: text("severity").notNull(),
  priority: text("priority").notNull().default("medium"),
  status: text("status").notNull().default("pending"),
  parentAlertId: text("parent_alert_id"),
  rootAlertId: text("root_alert_id"),
  reopenSequence: integer("reopen_sequence").notNull().default(0),
  reopenedByUserId: text("reopened_by_user_id"),
  reopenedByName: text("reopened_by_name"),
  reopenReason: text("reopen_reason"),
  title: text("title").notNull(),
  detail: text("detail").notNull(),
  occurredAt: text("occurred_at").notNull(),
  acknowledgedAt: text("acknowledged_at"),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [index("idx_system_alerts_occurred").on(table.occurredAt)]);

export const systemAlertActions = sqliteTable("system_alert_actions", {
  id: text("id").primaryKey(),
  alertId: text("alert_id").notNull().unique().references(() => systemAlerts.id, { onDelete: "restrict" }),
  actorUserId: text("actor_user_id").notNull(),
  actorName: text("actor_name").notNull(),
  description: text("description").notNull(),
  occurredAt: text("occurred_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [index("idx_system_alert_actions_alert").on(table.alertId, table.occurredAt)]);

export const systemAlertComments = sqliteTable("system_alert_comments", {
  id: text("id").primaryKey(),
  alertId: text("alert_id").notNull().references(() => systemAlerts.id, { onDelete: "restrict" }),
  actorUserId: text("actor_user_id").notNull(),
  actorName: text("actor_name").notNull(),
  comment: text("comment").notNull(),
  eventType: text("event_type").notNull().default("follow_up"),
  statusAfter: text("status_after").notNull(),
  priorityAfter: text("priority_after").notNull(),
  powerIncidentTypeAfter: text("power_incident_type_after"),
  occurredAt: text("occurred_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [index("idx_system_alert_comments_alert").on(table.alertId, table.occurredAt)]);

export const edgeRuntimeStatus = sqliteTable("edge_runtime_status", {
  id: integer("id").primaryKey(),
  moduleId: text("module_id").notNull(),
  siteId: text("site_id").notNull(),
  state: text("state").notNull(),
  relayEnergized: integer("relay_energized", { mode: "boolean" }).notNull(),
  validatorOnline: integer("validator_online", { mode: "boolean" }).notNull(),
  nfcReady: integer("nfc_ready", { mode: "boolean" }).notNull().default(false),
  k24Enabled: integer("k24_enabled", { mode: "boolean" }).notNull().default(false),
  k24Healthy: integer("k24_healthy", { mode: "boolean" }).notNull(),
  tankLevelEnabled: integer("tank_level_enabled", { mode: "boolean" }).notNull().default(false),
  telemetrySessionId: text("telemetry_session_id"),
  technologyAdoptionStage: text("technology_adoption_stage").notNull().default("full"),
  adoptionPolicyRevision: integer("adoption_policy_revision").notNull().default(1),
  occurredAt: text("occurred_at").notNull(),
});
