import { authenticatedUser, json, sameOrigin, type AuthEnvironment } from "./auth";
import { edgeSensorSecret, sensorKeyMatches } from "./fuel-history-api";
import { readJsonBody, RequestBodyError } from "./request-body";
import {
  cancelManualModeSchedule,
  createManualModeSchedule,
  currentManualModeSchedule,
  desiredManualModeSchedule,
  ensureManualModeStore,
  ManualModeConflict,
  ManualModeNotFound,
  reportManualModeState,
  type ManualModeState,
  type ManualModePurpose,
} from "./manual-mode-store";
import { technologyAdoptionSettings } from "./technology-adoption-store";

type ManualModeEnvironment = AuthEnvironment & {
  FUEL_SENSOR_INGEST_KEY?: string;
  FUEL_SITE_ID?: string;
};

export async function handleManualModeRequest(request: Request, env: ManualModeEnvironment): Promise<Response | null> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith("/api/manual-mode")) return null;
  if (!env.DB) return json({ error: "Base local no disponible." }, 503);
  await ensureManualModeStore(env.DB);

  if (url.pathname === "/api/manual-mode/edge/current" && request.method === "POST") {
    if (!await edgeAuthorized(request, env)) return json({ error: "Controlador edge no autorizado." }, 401);
    return json({ schedule: await desiredManualModeSchedule(env.DB) }, 200);
  }
  const edgeStateMatch = url.pathname.match(/^\/api\/manual-mode\/edge\/([^/]+)\/state$/u);
  if (edgeStateMatch && request.method === "POST") {
    if (!await edgeAuthorized(request, env)) return json({ error: "Controlador edge no autorizado." }, 401);
    try {
      const body = await readJsonBody(request, 4096) as { state?: unknown; error?: unknown };
      if (!isManualModeState(body.state)) return json({ error: "Estado de modo manual inválido." }, 400);
      const schedule = await reportManualModeState(
        env.DB,
        decodeURIComponent(edgeStateMatch[1]),
        body.state,
        typeof body.error === "string" ? body.error : undefined,
      );
      return json({ schedule }, 200);
    } catch (error) { return manualModeError(error); }
  }

  const actor = await authenticatedUser(request, env);
  if (!actor) return json({ error: "Sesión no válida." }, 401);
  if (!canManageManualMode(actor.role)) {
    return json({ error: "No tienes permiso para administrar el modo manual." }, 403);
  }
  if (request.method !== "GET" && !sameOrigin(request)) {
    return json({ error: "Solicitud no permitida." }, 403);
  }
  if (url.pathname === "/api/manual-mode" && request.method === "GET") {
    return json({ schedule: await currentManualModeSchedule(env.DB) }, 200);
  }
  if (url.pathname === "/api/manual-mode" && request.method === "POST") {
    try {
      const body = await readJsonBody(request, 4096) as { startAt?: unknown; endAt?: unknown; purpose?: unknown };
      if (typeof body.startAt !== "string" || typeof body.endAt !== "string") {
        return json({ error: "Selecciona el inicio y el fin del modo manual." }, 400);
      }
      const siteId = env.FUEL_SITE_ID?.trim() || "concha-y-toro-piloto";
      const purpose: ManualModePurpose = body.purpose === "adoption_assisted" ? "adoption_assisted" : "manual";
      if (body.purpose != null && body.purpose !== "manual" && body.purpose !== "adoption_assisted") {
        return json({ error: "El propósito del período no es válido." }, 400);
      }
      if (purpose === "adoption_assisted") {
        const adoption = await technologyAdoptionSettings(env.DB, siteId);
        if (adoption.stage !== "assisted") {
          return json({ error: "Las sesiones asistidas sólo están disponibles en la etapa Aprendizaje asistido." }, 409);
        }
      }
      const schedule = await createManualModeSchedule(
        env.DB,
        { id: actor.id, role: actor.role },
        siteId,
        body.startAt,
        body.endAt,
        purpose,
      );
      return json({ schedule }, 201);
    } catch (error) { return manualModeError(error); }
  }
  const scheduleMatch = url.pathname.match(/^\/api\/manual-mode\/([^/]+)$/u);
  if (scheduleMatch && request.method === "DELETE") {
    try {
      const schedule = await cancelManualModeSchedule(env.DB, decodeURIComponent(scheduleMatch[1]), actor.id);
      return json({ schedule }, 200);
    } catch (error) { return manualModeError(error); }
  }
  return json({ error: "Ruta no encontrada." }, 404);
}

function edgeAuthorized(request: Request, env: ManualModeEnvironment) {
  return sensorKeyMatches(request.headers.get("x-edge-sensor-key"), edgeSensorSecret(env));
}

function canManageManualMode(role: string) {
  return role === "master" || role === "administrator" || role === "supervisor";
}

function isManualModeState(value: unknown): value is ManualModeState {
  return value === "active" || value === "completed" || value === "failed";
}

function manualModeError(error: unknown) {
  if (error instanceof ManualModeConflict) return json({ error: error.message }, 409);
  if (error instanceof ManualModeNotFound) return json({ error: "Período de modo manual no encontrado." }, 404);
  if (error instanceof RequestBodyError) return json({ error: error.message }, error.status);
  return json({ error: "No fue posible actualizar el modo manual." }, 500);
}
