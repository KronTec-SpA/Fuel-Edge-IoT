import { authenticatedUser, json, sameOrigin, type AuthEnvironment } from "./auth";
import { edgeSensorSecret, sensorKeyMatches } from "./fuel-history-api";
import { ensureFuelHistoryStore } from "./fuel-history-store";
import { readJsonBody, RequestBodyError } from "./request-body";
import { parsePermissions } from "./user-store";
import {
  deactivateTechnologyAdoptionProgram,
  ensureTechnologyAdoptionStore,
  startTechnologyAdoptionProgram,
  technologyAdoptionDashboard,
  technologyAdoptionSettings,
  TechnologyAdoptionConflict,
  updateTechnologyAdoptionSettings,
  validTechnologyAdoptionStage,
} from "./technology-adoption-store";

type TechnologyAdoptionEnvironment = AuthEnvironment & {
  FUEL_SENSOR_INGEST_KEY?: string;
  FUEL_SITE_ID?: string;
};

export async function handleTechnologyAdoptionRequest(request: Request, env: TechnologyAdoptionEnvironment): Promise<Response | null> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith("/api/technology-adoption")) return null;
  if (!env.DB) return json({ error: "Base local no disponible." }, 503);
  await Promise.all([ensureTechnologyAdoptionStore(env.DB), ensureFuelHistoryStore(env.DB)]);
  const siteId = env.FUEL_SITE_ID?.trim() || "concha-y-toro-piloto";

  if (url.pathname === "/api/technology-adoption/edge/current" && request.method === "POST") {
    if (!await sensorKeyMatches(request.headers.get("x-edge-sensor-key"), edgeSensorSecret(env))) {
      return json({ error: "Controlador edge no autorizado." }, 401);
    }
    const settings = await technologyAdoptionSettings(env.DB, siteId);
    return json({ policy: { siteId, stage: settings.stage, revision: settings.revision, updatedAt: settings.updatedAt } }, 200);
  }

  const actor = await authenticatedUser(request, env);
  if (!actor) return json({ error: "Sesión no válida." }, 401);
  if (!parsePermissions(actor.permissions).includes("view_dashboard")) {
    return json({ error: "No tienes permiso para consultar la adopción tecnológica." }, 403);
  }
  if (url.pathname === "/api/technology-adoption" && request.method === "GET") {
    return json(await technologyAdoptionDashboard(env.DB, siteId), 200);
  }
  if (url.pathname === "/api/technology-adoption/start" && request.method === "POST") {
    if (!sameOrigin(request)) return json({ error: "Solicitud no permitida." }, 403);
    if (!(["master", "administrator"] as string[]).includes(actor.role)
      || !parsePermissions(actor.permissions).includes("manage_system")) {
      return json({ error: "Sólo administración puede iniciar la adopción tecnológica." }, 403);
    }
    try {
      const settings = await startTechnologyAdoptionProgram(env.DB, siteId, { id: actor.id });
      return json({ settings, dashboard: await technologyAdoptionDashboard(env.DB, siteId) }, 201);
    } catch (error) {
      if (error instanceof TechnologyAdoptionConflict) return json({ error: error.message }, 409);
      return json({ error: "No fue posible iniciar la adopción tecnológica." }, 500);
    }
  }
  if (url.pathname === "/api/technology-adoption/deactivate" && request.method === "POST") {
    if (!sameOrigin(request)) return json({ error: "Solicitud no permitida." }, 403);
    if (!(["master", "administrator"] as string[]).includes(actor.role)
      || !parsePermissions(actor.permissions).includes("manage_system")) {
      return json({ error: "Sólo administración puede desactivar la adopción tecnológica." }, 403);
    }
    try {
      const settings = await deactivateTechnologyAdoptionProgram(env.DB, siteId, { id: actor.id });
      return json({ settings, dashboard: await technologyAdoptionDashboard(env.DB, siteId) }, 200);
    } catch (error) {
      if (error instanceof TechnologyAdoptionConflict) return json({ error: error.message }, 409);
      return json({ error: "No fue posible desactivar la adopción tecnológica." }, 500);
    }
  }
  if (url.pathname === "/api/technology-adoption" && request.method === "PUT") {
    if (!sameOrigin(request)) return json({ error: "Solicitud no permitida." }, 403);
    if (!(["master", "administrator"] as string[]).includes(actor.role)
      || !parsePermissions(actor.permissions).includes("manage_system")) {
      return json({ error: "Sólo administración puede cambiar la etapa de adopción." }, 403);
    }
    try {
      const body = await readJsonBody(request, 8192) as { stage?: unknown; reviewAt?: unknown; note?: unknown };
      if (!validTechnologyAdoptionStage(body.stage)) return json({ error: "La etapa de adopción no es válida." }, 400);
      if (body.reviewAt != null && typeof body.reviewAt !== "string") return json({ error: "La fecha de revisión no es válida." }, 400);
      if (typeof body.note !== "string") return json({ error: "Explica brevemente el motivo de la decisión." }, 400);
      const settings = await updateTechnologyAdoptionSettings(env.DB, siteId, { id: actor.id }, {
        stage: body.stage,
        reviewAt: body.reviewAt || null,
        note: body.note,
      });
      return json({ settings, dashboard: await technologyAdoptionDashboard(env.DB, siteId) }, 200);
    } catch (error) {
      if (error instanceof TechnologyAdoptionConflict) return json({ error: error.message }, 409);
      if (error instanceof RequestBodyError) return json({ error: error.message }, error.status);
      return json({ error: "No fue posible actualizar la adopción tecnológica." }, 500);
    }
  }
  return json({ error: "Ruta no encontrada." }, 404);
}
