import { audit, type D1DatabaseLike } from "./user-store";
import { ensureManualModeStore } from "./manual-mode-store";

export type TechnologyAdoptionStage = "assisted" | "rfid_only" | "full";
export type TechnologyAdoptionProgramStatus = "inactive" | "active" | "completed";

export type TechnologyAdoptionSettings = {
  siteId: string;
  stage: TechnologyAdoptionStage;
  programStatus: TechnologyAdoptionProgramStatus;
  revision: number;
  programStartedAt: string;
  completedAt: string | null;
  stageStartedAt: string;
  reviewAt: string | null;
  updatedBy: string | null;
  updatedByName: string | null;
  updatedAt: string;
  note: string;
};

const initialized = new WeakSet<object>();

export async function ensureTechnologyAdoptionStore(db: D1DatabaseLike) {
  const marker = db as unknown as object;
  if (initialized.has(marker)) return;
  await db.batch([
    db.prepare(`CREATE TABLE IF NOT EXISTS technology_adoption_settings (
      site_id TEXT PRIMARY KEY,
      stage TEXT NOT NULL DEFAULT 'full' CHECK(stage IN ('assisted','rfid_only','full')),
      program_status TEXT NOT NULL DEFAULT 'inactive' CHECK(program_status IN ('inactive','active','completed')),
      revision INTEGER NOT NULL DEFAULT 1 CHECK(revision > 0),
      program_started_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      completed_at TEXT,
      stage_started_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      review_at TEXT,
      updated_by TEXT,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      note TEXT NOT NULL DEFAULT 'Política segura inicial: trazabilidad completa.'
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS technology_adoption_transitions (
      id TEXT PRIMARY KEY,
      site_id TEXT NOT NULL,
      from_stage TEXT NOT NULL CHECK(from_stage IN ('assisted','rfid_only','full')),
      to_stage TEXT NOT NULL CHECK(to_stage IN ('assisted','rfid_only','full')),
      reason TEXT NOT NULL,
      actor_user_id TEXT NOT NULL,
      occurred_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`),
    db.prepare("CREATE INDEX IF NOT EXISTS idx_adoption_transitions_site_time ON technology_adoption_transitions(site_id,occurred_at)"),
  ]);
  const columns = await db.prepare("PRAGMA table_info(technology_adoption_settings)").all<{ name: string }>();
  if (!columns.results.some((column) => column.name === "program_status")) {
    await db.prepare("ALTER TABLE technology_adoption_settings ADD COLUMN program_status TEXT NOT NULL DEFAULT 'inactive' CHECK(program_status IN ('inactive','active','completed'))").run();
  }
  if (!columns.results.some((column) => column.name === "completed_at")) {
    await db.prepare("ALTER TABLE technology_adoption_settings ADD COLUMN completed_at TEXT").run();
  }
  await db.prepare("PRAGMA optimize").run();
  initialized.add(marker);
}

export async function technologyAdoptionSettings(db: D1DatabaseLike, siteId: string) {
  await ensureTechnologyAdoptionStore(db);
  await db.prepare(`INSERT OR IGNORE INTO technology_adoption_settings(site_id)
    VALUES (?)`).bind(siteId).run();
  const row = await db.prepare(`SELECT
      settings.site_id AS siteId,settings.stage,settings.program_status AS programStatus,settings.revision,
      settings.program_started_at AS programStartedAt,settings.completed_at AS completedAt,
      settings.stage_started_at AS stageStartedAt,
      settings.review_at AS reviewAt,settings.updated_by AS updatedBy,
      users.name AS updatedByName,settings.updated_at AS updatedAt,settings.note
    FROM technology_adoption_settings AS settings
    LEFT JOIN web_users AS users ON users.id=settings.updated_by
    WHERE settings.site_id=?`).bind(siteId).first<Record<string, unknown>>();
  if (!row) throw new Error("No fue posible inicializar la política de adopción tecnológica.");
  return normalizeSettings(row);
}

export async function startTechnologyAdoptionProgram(
  db: D1DatabaseLike,
  siteId: string,
  actor: { id: string },
) {
  const current = await technologyAdoptionSettings(db, siteId);
  if (current.programStatus === "completed") {
    throw new TechnologyAdoptionConflict("El programa de adopción tecnológica ya fue completado.");
  }
  if (current.programStatus === "active") {
    throw new TechnologyAdoptionConflict("La etapa de adopción tecnológica ya está activa.");
  }
  const revision = current.revision + 1;
  const note = "Inicio de la etapa de adopción tecnológica.";
  const result = await db.batch([
    db.prepare(`UPDATE technology_adoption_settings SET
        stage='assisted',program_status='active',revision=?,program_started_at=CURRENT_TIMESTAMP,
        completed_at=NULL,stage_started_at=CURRENT_TIMESTAMP,review_at=NULL,
        updated_by=?,updated_at=CURRENT_TIMESTAMP,note=?
      WHERE site_id=? AND revision=? AND program_status='inactive'`).bind(revision, actor.id, note, siteId, current.revision),
    db.prepare(`INSERT INTO technology_adoption_transitions(
      id,site_id,from_stage,to_stage,reason,actor_user_id
    ) SELECT ?,?,?,?,?,? WHERE changes()>0`).bind(
      `adoption-transition-${crypto.randomUUID()}`,
      siteId,
      current.stage,
      "assisted",
      note,
      actor.id,
    ),
  ]);
  requirePolicyUpdated(result);
  await audit(db, "technology_adoption_started", actor.id, null, {
    siteId,
    fromStage: current.stage,
    toStage: "assisted",
    revision,
  });
  return technologyAdoptionSettings(db, siteId);
}

export async function deactivateTechnologyAdoptionProgram(
  db: D1DatabaseLike,
  siteId: string,
  actor: { id: string },
) {
  const current = await technologyAdoptionSettings(db, siteId);
  if (current.programStatus !== "active") {
    throw new TechnologyAdoptionConflict(current.programStatus === "completed"
      ? "El programa de adopción tecnológica ya fue completado."
      : "La etapa de adopción tecnológica no está activa.");
  }
  await ensureManualModeStore(db);
  const revision = current.revision + 1;
  const note = "Programa desactivado por administración; se restaura la trazabilidad completa.";
  const statements = [
    db.prepare(`UPDATE technology_adoption_settings SET
        stage='full',program_status='inactive',revision=?,completed_at=NULL,
        stage_started_at=CURRENT_TIMESTAMP,review_at=NULL,updated_by=?,updated_at=CURRENT_TIMESTAMP,note=?
      WHERE site_id=? AND program_status='active' AND revision=?`).bind(revision, actor.id, note, siteId, current.revision),
  ];
  if (current.stage !== "full") {
    statements.push(db.prepare(`INSERT INTO technology_adoption_transitions(
      id,site_id,from_stage,to_stage,reason,actor_user_id
    ) SELECT ?,?,?,?,?,? WHERE changes()>0`).bind(
      `adoption-transition-${crypto.randomUUID()}`,
      siteId,
      current.stage,
      "full",
      note,
      actor.id,
    ));
  }
  // Retire the assisted window in the same transaction as the policy. The
  // existing edge reconciliation closes its segment when the schedule is null.
  statements.push(db.prepare(`UPDATE manual_mode_schedules SET
      status='cancelled',cancelled_at=CURRENT_TIMESTAMP,completed_at=CURRENT_TIMESTAMP,error=NULL
    WHERE site_id=? AND purpose='adoption_assisted' AND status IN ('scheduled','active')
      AND EXISTS (SELECT 1 FROM technology_adoption_settings
        WHERE site_id=? AND program_status='inactive' AND revision=?)`).bind(siteId, siteId, revision));
  requirePolicyUpdated(await db.batch(statements));
  await audit(db, "technology_adoption_deactivated", actor.id, null, {
    siteId,
    fromStage: current.stage,
    toStage: "full",
    revision,
    assistedSessionsCancelled: true,
  });
  return technologyAdoptionSettings(db, siteId);
}

export async function updateTechnologyAdoptionSettings(
  db: D1DatabaseLike,
  siteId: string,
  actor: { id: string },
  input: { stage: TechnologyAdoptionStage; reviewAt: string | null; note: string },
) {
  const current = await technologyAdoptionSettings(db, siteId);
  if (current.programStatus !== "active") {
    throw new TechnologyAdoptionConflict(current.programStatus === "completed"
      ? "El programa de adopción tecnológica ya fue completado."
      : "Inicia la etapa de adopción tecnológica desde Sistema antes de revisarla.");
  }
  if (current.stage !== input.stage && Math.abs(stageNumber(current.stage) - stageNumber(input.stage)) !== 1) {
    throw new TechnologyAdoptionConflict("Avanza o retrocede una etapa a la vez para conservar una transición controlada.");
  }
  const note = input.note.trim().replace(/\s+/gu, " ").slice(0, 500);
  if (note.length < 8) throw new TechnologyAdoptionConflict("Explica brevemente el motivo de la decisión.");
  const reviewAt = normalizeReviewAt(input.reviewAt);
  const changedStage = current.stage !== input.stage;
  if (changedStage) {
    await ensureManualModeStore(db);
    const openAssistedSession = await db.prepare(`SELECT id FROM manual_mode_schedules
      WHERE purpose='adoption_assisted' AND status IN ('scheduled','active') LIMIT 1`).first<{ id: string }>();
    if (openAssistedSession) {
      throw new TechnologyAdoptionConflict("Finaliza o cancela la sesión asistida antes de cambiar la etapa.");
    }
  }
  const revision = current.revision + 1;
  const completing = changedStage && input.stage === "full";
  const statements = [
    db.prepare(`UPDATE technology_adoption_settings SET
        stage=?,revision=?,stage_started_at=CASE WHEN stage<>? THEN CURRENT_TIMESTAMP ELSE stage_started_at END,
        program_status=?,completed_at=CASE WHEN ?='completed' THEN CURRENT_TIMESTAMP ELSE completed_at END,
        review_at=?,updated_by=?,updated_at=CURRENT_TIMESTAMP,note=?
      WHERE site_id=? AND revision=? AND program_status='active'`).bind(input.stage, revision, input.stage, completing ? "completed" : "active",
      completing ? "completed" : "active", completing ? null : reviewAt, actor.id, note, siteId, current.revision),
  ];
  if (changedStage) {
    statements.push(db.prepare(`INSERT INTO technology_adoption_transitions(
      id,site_id,from_stage,to_stage,reason,actor_user_id
    ) SELECT ?,?,?,?,?,? WHERE changes()>0`).bind(
      `adoption-transition-${crypto.randomUUID()}`,
      siteId,
      current.stage,
      input.stage,
      note,
      actor.id,
    ));
  }
  requirePolicyUpdated(await db.batch(statements));
  await audit(db, completing ? "technology_adoption_completed" : changedStage ? "technology_adoption_stage_changed" : "technology_adoption_review_updated", actor.id, null, {
    siteId,
    fromStage: current.stage,
    toStage: input.stage,
    reviewAt,
    revision,
    note,
  });
  return technologyAdoptionSettings(db, siteId);
}

export async function technologyAdoptionDashboard(db: D1DatabaseLike, siteId: string) {
  const settings = await technologyAdoptionSettings(db, siteId);
  const [metricsRow, historyRows, edge] = await Promise.all([
    db.prepare(`SELECT
        COUNT(*) AS totalLoads,COALESCE(SUM(liters),0) AS totalLiters,
        COALESCE(SUM(CASE WHEN operator_id IS NOT NULL THEN 1 ELSE 0 END),0) AS identifiedLoads,
        COALESCE(SUM(CASE WHEN operator_id IS NOT NULL THEN liters ELSE 0 END),0) AS identifiedLiters,
        COALESCE(SUM(CASE WHEN authorization_evidence='full' THEN 1 ELSE 0 END),0) AS fullLoads,
        COALESCE(SUM(CASE WHEN authorization_evidence='full' THEN liters ELSE 0 END),0) AS fullLiters,
        COALESCE(SUM(CASE WHEN assisted_mode=1 THEN 1 ELSE 0 END),0) AS assistedLoads,
        COALESCE(SUM(CASE WHEN assisted_mode=1 THEN liters ELSE 0 END),0) AS assistedLiters
      FROM fuel_movements
      WHERE movement_type='dispatch' AND classification='standard' AND is_master=0
        AND detected_automatically=0 AND datetime(occurred_at)>=datetime(?)`).bind(settings.programStartedAt).first<Record<string, unknown>>(),
    db.prepare(`SELECT transitions.id,transitions.from_stage AS fromStage,transitions.to_stage AS toStage,
        transitions.reason,transitions.occurred_at AS occurredAt,users.name AS actorName
      FROM technology_adoption_transitions AS transitions
      LEFT JOIN web_users AS users ON users.id=transitions.actor_user_id
      WHERE transitions.site_id=? ORDER BY transitions.occurred_at DESC LIMIT 12`).bind(siteId).all<Record<string, unknown>>(),
    db.prepare(`SELECT technology_adoption_stage AS stage,adoption_policy_revision AS revision,occurred_at AS occurredAt
      FROM edge_runtime_status WHERE id=1`).first<Record<string, unknown>>(),
  ]);
  const totalLiters = Number(metricsRow?.totalLiters ?? 0);
  const identifiedLiters = Number(metricsRow?.identifiedLiters ?? 0);
  const fullLiters = Number(metricsRow?.fullLiters ?? 0);
  const metrics = {
    days: 30,
    totalLoads: Number(metricsRow?.totalLoads ?? 0),
    totalLiters: round1(totalLiters),
    identifiedLoads: Number(metricsRow?.identifiedLoads ?? 0),
    identifiedLiters: round1(identifiedLiters),
    rfidCoverage: percentage(identifiedLiters, totalLiters),
    fullLoads: Number(metricsRow?.fullLoads ?? 0),
    fullLiters: round1(fullLiters),
    fullCoverage: percentage(fullLiters, totalLiters),
    assistedLoads: Number(metricsRow?.assistedLoads ?? 0),
    assistedLiters: round1(Number(metricsRow?.assistedLiters ?? 0)),
  };
  return {
    settings,
    metrics,
    recommendation: adoptionRecommendation(settings.stage, metrics),
    edgeApplication: edge ? {
      stage: validTechnologyAdoptionStage(edge.stage) ? edge.stage : null,
      revision: Number(edge.revision ?? 0),
      occurredAt: typeof edge.occurredAt === "string" ? edge.occurredAt : null,
      applied: edge.stage === settings.stage && Number(edge.revision) === settings.revision
        && Date.now() - Date.parse(String(edge.occurredAt)) >= 0
        && Date.now() - Date.parse(String(edge.occurredAt)) <= 30_000,
    } : null,
    history: historyRows.results.map((row) => ({
      id: String(row.id),
      fromStage: row.fromStage as TechnologyAdoptionStage,
      toStage: row.toStage as TechnologyAdoptionStage,
      reason: String(row.reason),
      actorName: typeof row.actorName === "string" && row.actorName ? row.actorName : "Usuario autorizado",
      occurredAt: String(row.occurredAt),
    })),
  };
}

export function validTechnologyAdoptionStage(value: unknown): value is TechnologyAdoptionStage {
  return value === "assisted" || value === "rfid_only" || value === "full";
}

export class TechnologyAdoptionConflict extends Error {}

function requirePolicyUpdated(result: unknown) {
  const updates = result as { meta?: { changes?: number } }[];
  if (updates[0]?.meta?.changes !== 1) {
    throw new TechnologyAdoptionConflict("La adopción cambió desde otra solicitud. Actualiza la pantalla antes de continuar.");
  }
}

function normalizeSettings(row: Record<string, unknown>): TechnologyAdoptionSettings {
  return {
    siteId: String(row.siteId),
    stage: validTechnologyAdoptionStage(row.stage) ? row.stage : "full",
    programStatus: validTechnologyAdoptionProgramStatus(row.programStatus) ? row.programStatus : "inactive",
    revision: Number(row.revision),
    programStartedAt: String(row.programStartedAt),
    completedAt: typeof row.completedAt === "string" && row.completedAt ? row.completedAt : null,
    stageStartedAt: String(row.stageStartedAt),
    reviewAt: typeof row.reviewAt === "string" && row.reviewAt ? row.reviewAt : null,
    updatedBy: typeof row.updatedBy === "string" && row.updatedBy ? row.updatedBy : null,
    updatedByName: typeof row.updatedByName === "string" && row.updatedByName ? row.updatedByName : null,
    updatedAt: String(row.updatedAt),
    note: String(row.note ?? ""),
  };
}

function validTechnologyAdoptionProgramStatus(value: unknown): value is TechnologyAdoptionProgramStatus {
  return value === "inactive" || value === "active" || value === "completed";
}

function stageNumber(stage: TechnologyAdoptionStage) {
  return stage === "assisted" ? 1 : stage === "rfid_only" ? 2 : 3;
}

function normalizeReviewAt(value: string | null) {
  if (!value) return null;
  const date = new Date(value);
  const now = Date.now();
  if (!Number.isFinite(date.getTime()) || date.getTime() <= now || date.getTime() > now + 366 * 24 * 60 * 60 * 1000) {
    throw new TechnologyAdoptionConflict("La próxima revisión debe ser una fecha futura dentro de un año.");
  }
  return date.toISOString();
}

function percentage(value: number, total: number) {
  return total > 0 ? Math.round(value / total * 1000) / 10 : 0;
}

function round1(value: number) {
  return Math.round(value * 10) / 10;
}

function adoptionRecommendation(stage: TechnologyAdoptionStage, metrics: { totalLoads: number; rfidCoverage: number; fullCoverage: number }) {
  if (metrics.totalLoads < 10) {
    const remaining = 10 - metrics.totalLoads;
    return { ready: false, title: `Realiza ${remaining} ${remaining === 1 ? "carga más" : "cargas más"} para completar el aprendizaje`, detail: "Con 10 cargas de la etapa se puede evaluar el hábito sin apresurar la siguiente decisión." };
  }
  if (stage === "assisted") {
    const ready = metrics.rfidCoverage >= 90;
    return ready
      ? { ready, title: "El fundo está preparado para Identidad RFID", detail: "La cobertura RFID de la etapa supera el 90 %. La etapa ya está lista para revisión." }
      : { ready, title: "Próximo hábito: identificar al operador", detail: `Faltan ${Math.max(0, 90 - metrics.rfidCoverage).toFixed(1)} puntos para la referencia de 90 % con RFID.` };
  }
  if (stage === "rfid_only") {
    const ready = metrics.fullCoverage >= 80;
    return ready
      ? { ready, title: "El fundo está preparado para Trazabilidad completa", detail: "La mayoría de las cargas ya incorpora MIM, RFID y asociación válida." }
      : { ready, title: "Próximo hábito: activar el MIM", detail: `Faltan ${Math.max(0, 80 - metrics.fullCoverage).toFixed(1)} puntos para la referencia de 80 % con trazabilidad completa.` };
  }
  return { ready: true, title: "Trazabilidad completa integrada", detail: "El sistema mantiene RFID, MIM y asociación como evidencia mínima sin perder las métricas de adopción." };
}
