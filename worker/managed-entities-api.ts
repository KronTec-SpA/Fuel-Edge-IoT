import { authenticatedUser, json, sameOrigin, type AuthEnvironment } from "./auth";
import { ensureManagedEntityStore, listManagedEntities, recordManagedAudit, type ManagedEntityType } from "./managed-entities-store";
import { parsePermissions, type D1DatabaseLike, type Permission, type StoredUser } from "./user-store";
import { readJsonBody, RequestBodyError } from "./request-body";
import { ensureEquipmentEnrollmentStore, queueEquipmentRegistryRemoval } from "./equipment-enrollment-store";

const permissionByType: Record<ManagedEntityType, Permission> = {
  operators: "manage_operators",
  equipment: "manage_equipment",
  associations: "manage_associations",
};
const equipmentKinds = ["Tractor", "Trilladora", "Cuatrimoto"] as const;

export async function handleManagedEntitiesRequest(request: Request, env: AuthEnvironment): Promise<Response | null> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith("/api/managed-entities")) return null;
  const actor = await authenticatedUser(request, env);
  if (!actor || !env.DB) return json({ error: "Sesión no válida." }, 401);
  const db = env.DB;
  await ensureManagedEntityStore(db, runtimeDemoSeed(env));
  const actorPermissions = parsePermissions(actor.permissions);

  if (request.method === "GET" && url.pathname === "/api/managed-entities") {
    const canManageAssociations = actorPermissions.includes("manage_associations");
    const canManageOperators = actorPermissions.includes("manage_operators");
    const canManageEquipment = actorPermissions.includes("manage_equipment");
    if (!canManageAssociations && !canManageOperators && !canManageEquipment) {
      return json({ error: "No tienes permiso para consultar estos registros." }, 403);
    }
    const entities = await listManagedEntities(db);
    return json({
      operators: canManageOperators || canManageAssociations ? entities.operators : [],
      equipment: canManageEquipment || canManageAssociations ? entities.equipment : [],
      associations: canManageAssociations ? entities.associations : [],
    }, 200);
  }
  if (!sameOrigin(request)) return json({ error: "Solicitud no permitida." }, 403);

  const match = url.pathname.match(/^\/api\/managed-entities\/(operators|equipment|associations)(?:\/([^/]+))?$/u);
  if (!match) return json({ error: "Ruta no encontrada." }, 404);
  const type = match[1] as ManagedEntityType;
  const id = match[2] ? decodeURIComponent(match[2]) : null;
  if (!actorPermissions.includes(permissionByType[type])) {
    return json({ error: "No tienes permiso para administrar estos registros." }, 403);
  }
  if (request.method === "POST" && !id) return createEntity(request, db, actor, type);
  if (request.method === "PATCH" && id) return updateEntity(request, db, actor, type, id);
  if (request.method === "DELETE" && id) return permanentlyDeleteEntity(db, actor, type, id);
  return json({ error: "Método no permitido." }, 405);
}

async function createEntity(request: Request, db: D1DatabaseLike, actor: StoredUser, type: ManagedEntityType) {
  let body: Record<string, unknown>;
  try { body = await readJsonBody(request, 16 * 1024); } catch (error) { return bodyError(error); }
  const id = `${type === "operators" ? "op" : type === "equipment" ? "eq" : "as"}-${crypto.randomUUID()}`;
  if (type === "operators") {
    const name = text(body.name); const rut = text(body.rut);
    if (name.length < 3) return json({ error: "Escribe el nombre completo del operador." }, 400);
    if (!validChileanRut(rut)) return json({ error: "El RUT ingresado no es válido. Revisa el número y dígito verificador." }, 400);
    await db.prepare(`INSERT INTO managed_operators(
      id,name,rut,credential,credential_active,credential_is_master,active,last_use
    ) VALUES (?,?,?,'Sin enrolar',0,0,1,'Sin actividad')`).bind(id, name, formatChileanRut(rut)).run();
  } else if (type === "equipment") {
    const name = text(body.name); const kind = text(body.kind); const condition = text(body.condition);
    const expiry = condition === "Permanente" ? null : futureInstant(body.expiry);
    if (name.length < 3 || !equipmentKinds.includes(kind as typeof equipmentKinds[number])
      || !["Permanente", "Temporal", "Externo"].includes(condition)
      || (condition !== "Permanente" && !expiry)) return json({ error: "Revisa el tipo y la vigencia del equipo." }, 400);
    await db.prepare(`INSERT INTO managed_equipment(id,name,kind,condition,module,site_id,active,expiry) VALUES (?,?,?,?,?,?,1,?)`)
      .bind(id, name, kind, condition, text(body.module) || "Sin módulo", text(body.siteId), expiry).run();
  } else {
    const operatorId = text(body.operatorId); const equipmentId = text(body.equipmentId);
    const operator = await db.prepare("SELECT id FROM managed_operators WHERE id=? AND archived_at IS NULL AND active=1").bind(operatorId).first<{ id: string }>();
    const equipment = await db.prepare("SELECT id FROM managed_equipment WHERE id=? AND archived_at IS NULL AND active=1").bind(equipmentId).first<{ id: string }>();
    if (!operator || !equipment) return json({ error: "Selecciona un operador y equipo vigentes." }, 409);
    await db.prepare(`INSERT INTO managed_associations(id,operator_id,equipment_id,active,since) VALUES (?,?,?,?,?)`)
      .bind(id, operatorId, equipmentId, 1, text(body.since) || new Intl.DateTimeFormat("es-CL", { dateStyle: "medium" }).format(new Date())).run();
  }
  await recordManagedAudit(db, actor.id, "created", type, id);
  return json({ created: true, id }, 201);
}

async function updateEntity(request: Request, db: D1DatabaseLike, actor: StoredUser, type: ManagedEntityType, id: string) {
  let body: { active?: unknown; archived?: unknown };
  try { body = await readJsonBody(request, 4096); } catch (error) { return bodyError(error); }
  const table = tableFor(type);
  const existing = await db.prepare(`SELECT id, archived_at AS archivedAt FROM ${table} WHERE id=?`).bind(id).first<{ id: string; archivedAt: string | null }>();
  if (!existing) return json({ error: "Registro no encontrado." }, 404);
  if (typeof body.archived === "boolean") {
    if (body.archived) {
      await db.prepare(`UPDATE ${table} SET archived_at=CURRENT_TIMESTAMP,active=0,updated_at=CURRENT_TIMESTAMP WHERE id=?`).bind(id).run();
      if (type === "operators") {
        await db.prepare("UPDATE managed_operators SET credential_active=0 WHERE id=?").bind(id).run();
        await db.prepare("UPDATE managed_rfid_credentials SET credential_active=0,updated_at=CURRENT_TIMESTAMP WHERE operator_id=?").bind(id).run();
      }
      if (type === "operators") await archiveRelatedAssociations(db, "operator_id", id);
      if (type === "equipment") await archiveRelatedAssociations(db, "equipment_id", id);
    } else {
      if (type === "associations") {
        const validRelation = await db.prepare(`SELECT a.id FROM managed_associations a
          INNER JOIN managed_operators o ON o.id=a.operator_id
          INNER JOIN managed_equipment e ON e.id=a.equipment_id
          WHERE a.id=? AND o.archived_at IS NULL AND o.active=1 AND e.archived_at IS NULL AND e.active=1`)
          .bind(id).first<{ id: string }>();
        if (!validRelation) return json({ error: "Restaura y habilita primero el operador y el equipo relacionados." }, 409);
      }
      await db.prepare(`UPDATE ${table} SET archived_at=NULL,active=1,updated_at=CURRENT_TIMESTAMP WHERE id=?`).bind(id).run();
    }
    await recordManagedAudit(db, actor.id, body.archived ? "archived" : "restored", type, id);
    return json({ updated: true }, 200);
  }
  if (typeof body.active === "boolean") {
    if (existing.archivedAt) return json({ error: "Restaura el registro antes de cambiar su estado." }, 409);
    await db.prepare(`UPDATE ${table} SET active=?,updated_at=CURRENT_TIMESTAMP WHERE id=?`).bind(Number(body.active), id).run();
    await recordManagedAudit(db, actor.id, "status_changed", type, id, { active: body.active });
    return json({ updated: true }, 200);
  }
  return json({ error: "No hay cambios válidos." }, 400);
}

async function permanentlyDeleteEntity(db: D1DatabaseLike, actor: StoredUser, type: ManagedEntityType, id: string) {
  if (actor.role !== "master" || actor.is_master !== 1) return json({ error: "Sólo el administrador maestro del proveedor puede limpiar la base de datos." }, 403);
  const table = tableFor(type);
  const existing = await db.prepare(`SELECT id,archived_at AS archivedAt${type === "equipment" ? ",module" : ""} FROM ${table} WHERE id=?`).bind(id)
    .first<{ id: string; archivedAt: string | null; module?: string }>();
  if (!existing) return json({ error: "Registro no encontrado." }, 404);
  if (!existing.archivedAt) return json({ error: "El registro debe estar archivado antes de eliminarlo definitivamente." }, 409);
  if (type !== "associations") {
    const column = type === "operators" ? "operator_id" : "equipment_id";
    const relation = await db.prepare(`SELECT id FROM managed_associations WHERE ${column}=? LIMIT 1`).bind(id).first<{ id: string }>();
    if (relation) return json({ error: "Elimina primero sus asociaciones históricas para conservar la integridad." }, 409);
  }
  await recordManagedAudit(db, actor.id, "permanently_deleted", type, id);
  if (type === "operators") {
    await db.prepare(`UPDATE managed_rfid_credentials SET operator_id=NULL,credential_active=0,
      updated_at=CURRENT_TIMESTAMP WHERE operator_id=?`).bind(id).run();
  }
  if (type === "equipment" && existing.module && existing.module !== "Sin módulo") {
    await ensureEquipmentEnrollmentStore(db);
    await queueEquipmentRegistryRemoval(db, existing.module, id, actor.id);
    await db.prepare("DELETE FROM equipment_enrollment_candidates WHERE module_id=?").bind(existing.module).run();
  }
  await db.prepare(`DELETE FROM ${table} WHERE id=?`).bind(id).run();
  return json({ deleted: true }, 200);
}

async function archiveRelatedAssociations(db: D1DatabaseLike, column: "operator_id" | "equipment_id", id: string) {
  await db.prepare(`UPDATE managed_associations SET archived_at=COALESCE(archived_at,CURRENT_TIMESTAMP),active=0,updated_at=CURRENT_TIMESTAMP WHERE ${column}=?`).bind(id).run();
}

function tableFor(type: ManagedEntityType) {
  if (type === "operators") return "managed_operators";
  if (type === "equipment") return "managed_equipment";
  return "managed_associations";
}

function text(value: unknown) { return typeof value === "string" ? value.trim().slice(0, 120) : ""; }
function validChileanRut(value: string) {
  const compact = value.replace(/[.\s-]/gu, "").toUpperCase();
  if (!/^\d{7,8}[0-9K]$/u.test(compact)) return false;
  const digits = compact.slice(0, -1);
  let sum = 0; let multiplier = 2;
  for (let index = digits.length - 1; index >= 0; index -= 1) {
    sum += Number(digits[index]) * multiplier;
    multiplier = multiplier === 7 ? 2 : multiplier + 1;
  }
  const result = 11 - (sum % 11);
  const verifier = result === 11 ? "0" : result === 10 ? "K" : String(result);
  return verifier === compact.at(-1);
}
function formatChileanRut(value: string) {
  const compact = value.replace(/[.\s-]/gu, "").toUpperCase();
  const verifier = compact.slice(-1); const body = compact.slice(0, -1);
  return `${body.replace(/\B(?=(\d{3})+(?!\d))/gu, ".")}-${verifier}`;
}
function futureInstant(value: unknown) {
  if (typeof value !== "string" || !value) return null;
  const instant = new Date(value);
  return Number.isFinite(instant.getTime()) && instant.getTime() > Date.now() ? instant.toISOString() : null;
}
function bodyError(error: unknown) {
  if (error instanceof RequestBodyError) return json({ error: error.message }, error.status);
  return json({ error: "Solicitud inválida." }, 400);
}

function runtimeDemoSeed(env: AuthEnvironment) {
  const bound = (env as AuthEnvironment & { APP_DEMO_SEED?: string }).APP_DEMO_SEED;
  if (typeof bound === "string") return bound === "true";
  try { return typeof process !== "undefined" && process.env.APP_DEMO_SEED === "true"; } catch { return false; }
}
