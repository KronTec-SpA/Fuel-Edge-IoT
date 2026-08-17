import { authenticatedUser, json, sameOrigin, type AuthEnvironment } from "./auth";
import { edgeSensorSecret, sensorKeyMatches } from "./fuel-history-api";
import { ensureAlertsStore, ingestEdgeAlert, isAlertPriority, isAlertStatus, listAlerts, recordAlertUpdate } from "./alerts-store";
import { readJsonBody, RequestBodyError } from "./request-body";
import { parsePermissions } from "./user-store";

export async function handleAlertsRequest(request: Request, env: AuthEnvironment & { FUEL_SENSOR_INGEST_KEY?: string }): Promise<Response | null> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith("/api/alerts")) return null;
  if (!env.DB) return json({ error: "La base de datos local no está disponible." }, 503);
  await ensureAlertsStore(env.DB);

  if (request.method === "POST" && url.pathname === "/api/alerts/edge") {
    if (!await sensorKeyMatches(request.headers.get("x-edge-sensor-key"), edgeSensorSecret(env))) return json({ error: "Alerta edge no autorizada." }, 403);
    let body: Record<string, unknown>;
    try { body = await readJsonBody(request, 16 * 1024); } catch (error) { return bodyError(error); }
    try { return json(await ingestEdgeAlert(env.DB, body), 201); }
    catch (error) { return json({ error: error instanceof Error ? error.message : "Alerta inválida." }, 400); }
  }

  const actor = await authenticatedUser(request, env);
  if (!actor) return json({ error: "Sesión no válida." }, 401);
  if (request.method === "GET" && url.pathname === "/api/alerts") {
    if (!parsePermissions(actor.permissions).includes("view_dashboard")) return json({ error: "No tienes permiso para consultar alertas." }, 403);
    const canManage = parsePermissions(actor.permissions).includes("manage_alerts");
    return json({ alerts: await listAlerts(env.DB, canManage) }, 200);
  }
  const match = url.pathname.match(/^\/api\/alerts\/([^/]+)\/action$/u);
  if (request.method === "POST" && match) {
    if (!sameOrigin(request)) return json({ error: "Solicitud no permitida." }, 403);
    if (!parsePermissions(actor.permissions).includes("manage_alerts")) return json({ error: "No tienes permiso para actualizar alertas." }, 403);
    let body: { description?: unknown; status?: unknown; priority?: unknown };
    try { body = await readJsonBody(request, 4096); } catch (error) { return bodyError(error); }
    const description = typeof body.description === "string" ? body.description.trim() : "";
    if (description.length < 10 || description.length > 500) return json({ error: "Describe la acción realizada (10 a 500 caracteres)." }, 400);
    const status = body.status === undefined ? "resolved" : body.status;
    const priority = body.priority === undefined ? null : body.priority;
    if (!isAlertStatus(status)) return json({ error: "Estado de alerta inválido." }, 400);
    if (priority !== null && !isAlertPriority(priority)) return json({ error: "Prioridad de alerta inválida." }, 400);
    try {
      await recordAlertUpdate(env.DB, decodeURIComponent(match[1]), actor.id, actor.name, description, status, priority);
      return json({ updated: true, resolved: status === "resolved" }, 200);
    } catch (error) {
      return json({ error: error instanceof Error ? error.message : "No fue posible actualizar la alerta." }, 409);
    }
  }
  return json({ error: "Ruta no encontrada." }, 404);
}

function bodyError(error: unknown) {
  if (error instanceof RequestBodyError) return json({ error: error.message }, error.status);
  return json({ error: "Solicitud inválida." }, 400);
}
