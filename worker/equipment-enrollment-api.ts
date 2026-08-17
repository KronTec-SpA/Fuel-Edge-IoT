import { authenticatedUser, json, sameOrigin, type AuthEnvironment } from "./auth";
import { edgeSensorSecret, sensorKeyMatches } from "./fuel-history-api";
import {
  completeEquipmentScan,
  completeEquipmentRegistryRemoval,
  completeEnrollmentCommand,
  EnrollmentConflict,
  ensureEquipmentEnrollmentStore,
  latestEquipmentScan,
  listEnrollmentCandidates,
  recordEquipmentSighting,
  requestEquipmentEnrollment,
  requestEquipmentScan,
  takeEquipmentRegistryRemoval,
  takeEquipmentScan,
  takeEnrollmentCommand,
} from "./equipment-enrollment-store";
import { readJsonBody, RequestBodyError } from "./request-body";
import { parsePermissions } from "./user-store";
import { ensureManagedEntityStore } from "./managed-entities-store";

type EnrollmentEnvironment = AuthEnvironment & { FUEL_SENSOR_INGEST_KEY?: string };
const equipmentKinds = ["Tractor", "Trilladora", "Cuatrimoto"] as const;

export async function handleEquipmentEnrollmentRequest(request: Request, env: EnrollmentEnvironment): Promise<Response | null> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith("/api/equipment-enrollment")) return null;
  if (!env.DB) return json({ error: "La base de datos local no está disponible." }, 503);
  await ensureEquipmentEnrollmentStore(env.DB);

  if (url.pathname === "/api/equipment-enrollment/sightings" && request.method === "POST") {
    if (!await edgeAuthorized(request, env)) return json({ error: "Servicio de enrolamiento no autorizado." }, 403);
    let body: Record<string, unknown>;
    try { body = await readJsonBody(request, 8192); } catch (error) { return bodyError(error); }
    const sighting = parseSighting(body);
    if (!sighting) return json({ error: "Reporte del MIM inválido." }, 400);
    await recordEquipmentSighting(env.DB, sighting);
    return json({ recorded: true }, 201);
  }

  if (url.pathname === "/api/equipment-enrollment/commands/next" && request.method === "POST") {
    if (!await edgeAuthorized(request, env)) return json({ error: "Servicio de enrolamiento no autorizado." }, 403);
    let body: Record<string, unknown>;
    try { body = await readJsonBody(request, 4096); } catch (error) { return bodyError(error); }
    const moduleId = identifier(body.moduleId);
    if (!moduleId) return json({ error: "Módulo inválido." }, 400);
    return json({ command: await takeEnrollmentCommand(env.DB, moduleId) }, 200);
  }

  if (url.pathname === "/api/equipment-enrollment/removals/next" && request.method === "POST") {
    if (!await edgeAuthorized(request, env)) return json({ error: "Servicio de baja de MIM no autorizado." }, 403);
    return json({ command: await takeEquipmentRegistryRemoval(env.DB) }, 200);
  }

  const removalResultMatch = url.pathname.match(/^\/api\/equipment-enrollment\/removals\/([^/]+)\/result$/u);
  if (removalResultMatch && request.method === "POST") {
    if (!await edgeAuthorized(request, env)) return json({ error: "Servicio de baja de MIM no autorizado." }, 403);
    let body: Record<string, unknown>;
    try { body = await readJsonBody(request, 4096); } catch (error) { return bodyError(error); }
    if (typeof body.success !== "boolean") return json({ error: "Resultado de baja inválido." }, 400);
    try {
      return json(await completeEquipmentRegistryRemoval(env.DB, decodeURIComponent(removalResultMatch[1]), {
        success: body.success,
        error: typeof body.error === "string" ? body.error : undefined,
      }), 200);
    } catch (error) {
      return conflict(error);
    }
  }

  if (url.pathname === "/api/equipment-enrollment/scan/next" && request.method === "POST") {
    if (!await edgeAuthorized(request, env)) return json({ error: "Servicio de enrolamiento no autorizado." }, 403);
    return json({ scan: await takeEquipmentScan(env.DB) }, 200);
  }

  const scanResultMatch = url.pathname.match(/^\/api\/equipment-enrollment\/scan\/([^/]+)\/result$/u);
  if (scanResultMatch && request.method === "POST") {
    if (!await edgeAuthorized(request, env)) return json({ error: "Servicio de enrolamiento no autorizado." }, 403);
    let body: Record<string, unknown>;
    try { body = await readJsonBody(request, 4096); } catch (error) { return bodyError(error); }
    const discovered = nonNegativeInteger(body.discovered);
    const verified = nonNegativeInteger(body.verified);
    if (typeof body.success !== "boolean" || discovered === null || verified === null || verified > discovered) {
      return json({ error: "Resultado de búsqueda de MIM inválido." }, 400);
    }
    try {
      const scan = await completeEquipmentScan(env.DB, decodeURIComponent(scanResultMatch[1]), {
        success: body.success,
        discovered,
        verified,
        error: typeof body.error === "string" ? body.error : undefined,
      });
      return json({ scan }, 200);
    } catch (error) {
      return conflict(error);
    }
  }

  if (url.pathname === "/api/equipment-enrollment/authorization/resolve" && request.method === "POST") {
    if (!await edgeAuthorized(request, env)) return json({ error: "Controlador edge no autorizado." }, 403);
    let body: Record<string, unknown>;
    try { body = await readJsonBody(request, 4096); } catch (error) { return bodyError(error); }
    const operatorId = identifier(body.operatorId);
    const equipmentId = identifier(body.equipmentId);
    const moduleId = identifier(body.moduleId);
    const siteId = identifier(body.siteId);
    if (!operatorId || !equipmentId || !moduleId || !siteId) return json({ error: "Consulta de autorización inválida." }, 400);
    await ensureManagedEntityStore(env.DB);
    const record = await env.DB.prepare(`SELECT e.active,e.expiry,
        EXISTS(SELECT 1 FROM managed_associations a
          WHERE a.operator_id=? AND a.equipment_id=e.id AND a.active=1 AND a.archived_at IS NULL) AS associationActive
      FROM managed_equipment e
      WHERE e.id=? AND e.module=? AND e.site_id=? AND e.archived_at IS NULL LIMIT 1`)
      .bind(operatorId, equipmentId, moduleId, siteId).first<Record<string, unknown>>();
    return json({
      equipment: record ? {
        active: record.active === 1,
        associationActive: record.associationActive === 1,
        assignmentValidUntil: record.expiry ? String(record.expiry) : null,
      } : { active: false, associationActive: false, assignmentValidUntil: null },
    }, 200);
  }

  const resultMatch = url.pathname.match(/^\/api\/equipment-enrollment\/commands\/([^/]+)\/result$/u);
  if (resultMatch && request.method === "POST") {
    if (!await edgeAuthorized(request, env)) return json({ error: "Servicio de enrolamiento no autorizado." }, 403);
    let body: Record<string, unknown>;
    try { body = await readJsonBody(request, 4096); } catch (error) { return bodyError(error); }
    if (typeof body.success !== "boolean") return json({ error: "Resultado inválido." }, 400);
    try {
      const result = await completeEnrollmentCommand(env.DB, decodeURIComponent(resultMatch[1]), {
        success: body.success,
        error: typeof body.error === "string" ? body.error : undefined,
      });
      return json(result, 200);
    } catch (error) {
      return conflict(error);
    }
  }

  const actor = await authenticatedUser(request, env);
  if (!actor) return json({ error: "Sesión no válida." }, 401);
  if (!parsePermissions(actor.permissions).includes("manage_equipment")) {
    return json({ error: "No tienes permiso para enrolar equipos." }, 403);
  }
  if (request.method === "GET" && url.pathname === "/api/equipment-enrollment") {
    return json({
      candidates: await listEnrollmentCandidates(env.DB),
      scan: await latestEquipmentScan(env.DB),
    }, 200);
  }
  if (request.method === "POST" && url.pathname === "/api/equipment-enrollment/scan") {
    if (!sameOrigin(request)) return json({ error: "Solicitud no permitida." }, 403);
    return json({ scan: await requestEquipmentScan(env.DB, actor.id) }, 202);
  }
  const claimMatch = url.pathname.match(/^\/api\/equipment-enrollment\/([^/]+)\/claim$/u);
  if (claimMatch && request.method === "POST") {
    if (!sameOrigin(request)) return json({ error: "Solicitud no permitida." }, 403);
    let body: Record<string, unknown>;
    try { body = await readJsonBody(request, 4096); } catch (error) { return bodyError(error); }
    const name = label(body.name, 80);
    const kind = label(body.kind, 20);
    const validUntil = futureInstant(body.validUntil);
    if (name.length < 3) return json({ error: "Escribe un nombre de al menos 3 caracteres." }, 400);
    if (!equipmentKinds.includes(kind as typeof equipmentKinds[number])) return json({ error: "Selecciona Tractor, Trilladora o Cuatrimoto." }, 400);
    if (!validUntil) return json({ error: "Selecciona un vencimiento futuro de hasta un año." }, 400);
    try {
      const result = await requestEquipmentEnrollment(env.DB, decodeURIComponent(claimMatch[1]), {
        name,
        kind: kind as typeof equipmentKinds[number],
        validUntil,
      }, actor.id);
      return json(result, 202);
    } catch (error) {
      return conflict(error);
    }
  }
  return json({ error: "Ruta no encontrada." }, 404);
}

async function edgeAuthorized(request: Request, env: EnrollmentEnvironment) {
  return sensorKeyMatches(request.headers.get("x-edge-sensor-key"), edgeSensorSecret(env));
}

function parseSighting(body: Record<string, unknown>) {
  const moduleId = identifier(body.moduleId);
  const siteId = identifier(body.siteId);
  const equipmentId = body.equipmentId === null || body.equipmentId === "" ? null : identifier(body.equipmentId);
  const deviceName = body.deviceName === null || body.deviceName === "" ? null : label(body.deviceName, 80);
  const firmware = label(body.firmware, 32);
  const rssi = body.rssi;
  const occurredAt = typeof body.occurredAt === "string" ? new Date(body.occurredAt) : new Date();
  if (!moduleId || !siteId || !firmware || typeof rssi !== "number" || !Number.isInteger(rssi)
    || rssi < -127 || rssi > 20 || Number.isNaN(occurredAt.getTime()) || occurredAt.getTime() > Date.now() + 60_000) return null;
  return {
    moduleId, siteId, equipmentId, deviceName, firmware, rssi,
    claimed: body.claimed === true,
    occurredAt: occurredAt.toISOString(),
  };
}

function identifier(value: unknown) {
  if (typeof value !== "string") return "";
  const text = value.trim();
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/u.test(text) ? text : "";
}
function label(value: unknown, maximum: number) { return typeof value === "string" ? value.trim().slice(0, maximum) : ""; }
function nonNegativeInteger(value: unknown) {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 10_000 ? value : null;
}
function futureInstant(value: unknown) {
  if (typeof value !== "string" || !value) return null;
  const instant = new Date(value);
  const maximum = Date.now() + 366 * 24 * 60 * 60 * 1000;
  return Number.isFinite(instant.getTime()) && instant.getTime() > Date.now() && instant.getTime() <= maximum
    ? instant.toISOString() : null;
}
function bodyError(error: unknown) {
  if (error instanceof RequestBodyError) return json({ error: error.message }, error.status);
  return json({ error: "Solicitud inválida." }, 400);
}
function conflict(error: unknown) {
  if (error instanceof EnrollmentConflict) return json({ error: error.message }, 409);
  return json({ error: "No fue posible completar el enrolamiento." }, 500);
}
