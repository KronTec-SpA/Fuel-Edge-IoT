import { ensureAlertsStore, listAlerts } from "./alerts-store";
import { authenticatedUser, json, type AuthEnvironment } from "./auth";
import { ensureFuelHistoryStore } from "./fuel-history-store";
import { ensureManagedEntityStore } from "./managed-entities-store";
import { audit, parsePermissions, type D1DatabaseLike } from "./user-store";

type ExportEnvironment = AuthEnvironment & {
  APP_DEMO_SEED?: string;
  FUEL_HISTORY_DEMO_SEED?: string;
};

export async function handleDataExportRequest(request: Request, env: ExportEnvironment): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname !== "/api/data-export") return null;
  if (request.method !== "GET") return json({ error: "Método no permitido." }, 405);

  const actor = await authenticatedUser(request, env);
  if (!actor || !env.DB) return json({ error: "Sesión no válida." }, 401);
  const dataset = exportDataset(url.searchParams.get("dataset"));
  if (!dataset) return json({ error: "Conjunto de datos no válido." }, 400);

  const db = env.DB;
  await Promise.all([
    ensureManagedEntityStore(db, runtimeValue(env, "APP_DEMO_SEED") === "true"),
    ensureFuelHistoryStore(db, runtimeValue(env, "FUEL_HISTORY_DEMO_SEED") === "true"),
    ensureAlertsStore(db),
  ]);

  const [levels, transactions, receiptReviews, users, operators, credentialEnrollments, equipment, associations, alerts] = await Promise.all([
    rows(db, `SELECT id,occurred_at AS occurredAt,level_liters AS levelLiters,source,created_at AS createdAt
      FROM fuel_level_readings ORDER BY occurred_at ASC,id ASC`),
    rows(db, `SELECT m.id,m.movement_type AS type,m.classification,m.occurred_at AS occurredAt,m.liters,
      m.opening_level_liters AS openingLevelLiters,m.closing_level_liters AS closingLevelLiters,
      m.source,m.reference_id AS reference,m.detail,m.operator_id AS operatorId,
      o.name AS operatorName,m.equipment_id AS equipmentId,e.name AS equipmentName,
      m.is_master AS isMaster,m.detected_automatically AS detectedAutomatically,
      m.confidence,m.detection_status AS status,m.review_status AS reviewStatus,
      m.original_liters AS originalLiters,m.document_reference AS documentReference,
      m.reviewed_by_user_id AS reviewedByUserId,m.reviewed_by_name AS reviewedByName,
      m.reviewed_at AS reviewedAt,m.review_note AS reviewNote,m.created_at AS createdAt
      FROM fuel_movements m
      LEFT JOIN managed_operators o ON o.id=m.operator_id
      LEFT JOIN managed_equipment e ON e.id=m.equipment_id
      ORDER BY m.occurred_at ASC,m.id ASC`),
    rows(db, `SELECT id,movement_id AS movementId,action,previous_liters AS previousLiters,
      resulting_liters AS resultingLiters,document_reference AS documentReference,note,
      actor_user_id AS actorUserId,actor_name AS actorName,occurred_at AS occurredAt
      FROM fuel_receipt_reviews ORDER BY occurred_at ASC,id ASC`),
    rows(db, `SELECT id,name,role,permissions,active,must_change_password AS mustChangePassword,
      is_master AS isMaster,created_at AS createdAt,last_login_at AS lastLoginAt
      FROM web_users ORDER BY is_master DESC,name COLLATE NOCASE`),
    rows(db, `SELECT id,name,credential_active AS credentialActive,
      credential_is_master AS credentialIsMaster,active,last_use AS lastUse,
      archived_at AS archivedAt,created_at AS createdAt,updated_at AS updatedAt
      FROM managed_operators ORDER BY archived_at IS NOT NULL,name COLLATE NOCASE`),
    rows(db, `SELECT operator_id AS operatorId,credential_active AS credentialActive,
      credential_is_master AS credentialIsMaster,created_at AS createdAt,updated_at AS updatedAt
      FROM managed_rfid_credentials ORDER BY created_at ASC`),
    rows(db, `SELECT id,name,kind,condition,module,site_id AS siteId,active,expiry,
      archived_at AS archivedAt,created_at AS createdAt,updated_at AS updatedAt
      FROM managed_equipment ORDER BY archived_at IS NOT NULL,name COLLATE NOCASE`),
    rows(db, `SELECT a.id,a.operator_id AS operatorId,o.name AS operatorName,
      a.equipment_id AS equipmentId,e.name AS equipmentName,e.kind AS equipmentKind,
      a.active,a.since,a.archived_at AS archivedAt,a.created_at AS createdAt,a.updated_at AS updatedAt
      FROM managed_associations a
      LEFT JOIN managed_operators o ON o.id=a.operator_id
      LEFT JOIN managed_equipment e ON e.id=a.equipment_id
      ORDER BY a.archived_at IS NOT NULL,a.created_at ASC`),
    listAlerts(db, false),
  ]);

  const normalizedTransactions = transactions.map((item) => ({
    ...item,
    isMaster: item.isMaster === 1,
    detectedAutomatically: item.detectedAutomatically === 1,
  }));
  const normalizedUsers = users.map((item) => ({
    ...item,
    permissions: typeof item.permissions === "string" ? parsePermissions(item.permissions) : [],
    active: item.active === 1,
    mustChangePassword: item.mustChangePassword === 1,
    isMaster: item.isMaster === 1,
  }));
  const normalizedOperators = operators.map((item) => ({
    ...item,
    credentialActive: item.credentialActive === 1,
    credentialIsMaster: item.credentialIsMaster === 1,
    active: item.active === 1,
  }));
  const normalizedCredentials = credentialEnrollments.map((item) => ({
    ...item,
    credentialActive: item.credentialActive === 1,
    credentialIsMaster: item.credentialIsMaster === 1,
  }));
  const normalizedEquipment = equipment.map((item) => ({ ...item, active: item.active === 1 }));
  const normalizedAssociations = associations.map((item) => ({ ...item, active: item.active === 1 }));
  const generatedAt = new Date().toISOString();
  const counts = {
    nivelesHistoricos: levels.length,
    transacciones: normalizedTransactions.length,
    revisionesRecepcion: receiptReviews.length,
    usuarios: normalizedUsers.length,
    operadores: normalizedOperators.length,
    equipos: normalizedEquipment.length,
    vinculacionesOperadorEquipo: normalizedAssociations.length,
    enrolamientosCredencial: normalizedCredentials.length,
    alertas: alerts.length,
  };
  const payload = {
    metadatos: {
      schemaVersion: 2,
      generatedAt,
      timeZone: "America/Santiago",
      location: "Fundo Santa Isabel",
      generatedBy: { id: actor.id, name: actor.name, role: actor.role },
      scope: "operational-sanitized",
      excludedSensitiveFields: [
        "password hashes",
        "email addresses and cryptographic email data",
        "operator RUT",
        "RFID credential identifiers and secrets",
        "authentication and recovery secrets",
      ],
      counts,
    },
    nivelesHistoricos: levels,
    transacciones: normalizedTransactions,
    revisionesRecepcion: receiptReviews,
    usuarios: normalizedUsers,
    operadores: normalizedOperators,
    equipos: normalizedEquipment,
    vinculacionesOperadorEquipo: normalizedAssociations,
    enrolamientosCredencial: normalizedCredentials,
    alertas: alerts,
  };

  await audit(db, "operational_data_exported", actor.id, actor.id, { dataset, counts });
  const date = dateInChile(generatedAt);
  if (dataset !== "all") {
    const file = exportCsv(dataset, {
      levels,
      transactions: normalizedTransactions,
      users: normalizedUsers,
      operators: normalizedOperators,
      equipment: normalizedEquipment,
      associations: normalizedAssociations,
      credentials: normalizedCredentials,
      alerts,
    });
    return new Response(`\uFEFF${file.content}\n`, {
      status: 200,
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="${file.name}-${date}.csv"`,
        "Cache-Control": "private, no-store, max-age=0",
        "X-Content-Type-Options": "nosniff",
      },
    });
  }
  return new Response(`${JSON.stringify(payload, null, 2)}\n`, {
    status: 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Disposition": `attachment; filename="base-datos-fundo-santa-isabel-${date}.json"`,
      "Cache-Control": "private, no-store, max-age=0",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

type ExportDataset = "all" | "levels" | "transactions" | "users" | "operators" | "equipment" | "associations" | "credentials" | "alerts";

function exportDataset(value: string | null): ExportDataset | null {
  const dataset = value ?? "all";
  return ["all", "levels", "transactions", "users", "operators", "equipment", "associations", "credentials", "alerts"].includes(dataset)
    ? dataset as ExportDataset
    : null;
}

function exportCsv(dataset: Exclude<ExportDataset, "all">, collections: Record<Exclude<ExportDataset, "all">, Array<Record<string, unknown>>>) {
  const definitions: Record<Exclude<ExportDataset, "all">, { name: string; columns: Array<[string, string]> }> = {
    levels: { name: "niveles-historicos", columns: [["id", "ID"], ["occurredAt", "Fecha"], ["levelLiters", "Nivel litros"], ["source", "Fuente"], ["createdAt", "Registrado"]] },
    transactions: { name: "transacciones", columns: [["id", "ID"], ["type", "Tipo"], ["classification", "Clasificación"], ["occurredAt", "Fecha"], ["liters", "Litros conciliados"], ["originalLiters", "Litros detectados"], ["openingLevelLiters", "Nivel inicial"], ["closingLevelLiters", "Nivel final"], ["operatorId", "ID operador"], ["operatorName", "Operador"], ["equipmentId", "ID equipo"], ["equipmentName", "Equipo"], ["source", "Fuente"], ["reference", "Referencia interna"], ["documentReference", "Referencia documental"], ["detail", "Detalle"], ["status", "Estado detector"], ["reviewStatus", "Estado conciliación"], ["reviewedByName", "Revisado por"], ["reviewedAt", "Fecha revisión"], ["reviewNote", "Motivo revisión"]] },
    users: { name: "usuarios-enrolados", columns: [["id", "ID"], ["name", "Nombre"], ["role", "Rol"], ["permissions", "Permisos"], ["active", "Activo"], ["mustChangePassword", "Cambio clave pendiente"], ["isMaster", "Usuario maestro"], ["createdAt", "Creado"], ["lastLoginAt", "Último acceso"]] },
    operators: { name: "operadores", columns: [["id", "ID"], ["name", "Nombre"], ["credentialActive", "Credencial activa"], ["credentialIsMaster", "Credencial maestra"], ["active", "Activo"], ["lastUse", "Último uso"], ["archivedAt", "Archivado"], ["createdAt", "Creado"], ["updatedAt", "Actualizado"]] },
    equipment: { name: "equipos", columns: [["id", "ID"], ["name", "Nombre"], ["kind", "Tipo"], ["condition", "Condición"], ["module", "Módulo"], ["siteId", "Fundo"], ["active", "Activo"], ["expiry", "Vigencia"], ["archivedAt", "Archivado"], ["createdAt", "Creado"], ["updatedAt", "Actualizado"]] },
    associations: { name: "vinculaciones-operador-equipo", columns: [["id", "ID"], ["operatorId", "ID operador"], ["operatorName", "Operador"], ["equipmentId", "ID equipo"], ["equipmentName", "Equipo"], ["equipmentKind", "Tipo equipo"], ["active", "Activa"], ["since", "Desde"], ["archivedAt", "Archivada"], ["createdAt", "Creada"], ["updatedAt", "Actualizada"]] },
    credentials: { name: "enrolamientos-rfid", columns: [["operatorId", "ID operador"], ["credentialActive", "Credencial activa"], ["credentialIsMaster", "Credencial maestra"], ["createdAt", "Creado"], ["updatedAt", "Actualizado"]] },
    alerts: { name: "alertas", columns: [["id", "ID"], ["severity", "Severidad"], ["priority", "Prioridad"], ["status", "Estado"], ["title", "Título"], ["detail", "Detalle"], ["time", "Fecha"], ["acknowledged", "Resuelta"]] },
  };
  const definition = definitions[dataset];
  const header = definition.columns.map(([, label]) => csvCell(label)).join(",");
  const body = collections[dataset].map((row) => definition.columns.map(([key]) => csvCell(row[key])).join(","));
  return { name: definition.name, content: [header, ...body].join("\r\n") };
}

function csvCell(value: unknown) {
  const text = Array.isArray(value) ? value.join(" | ") : value === null || value === undefined ? "" : String(value);
  return `"${text.replaceAll('"', '""')}"`;
}

async function rows(db: D1DatabaseLike, query: string) {
  return (await db.prepare(query).all<Record<string, unknown>>()).results;
}

function dateInChile(iso: string) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Santiago",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(iso));
}

function runtimeValue(env: ExportEnvironment, key: "APP_DEMO_SEED" | "FUEL_HISTORY_DEMO_SEED") {
  const bound = env[key];
  if (typeof bound === "string" && bound) return bound;
  try { return typeof process !== "undefined" ? process.env[key] : undefined; } catch { return undefined; }
}
