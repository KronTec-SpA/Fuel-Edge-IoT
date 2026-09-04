import { authenticatedUser, confirmAdministratorPassword, json, sameOrigin, type AuthEnvironment } from "./auth";
import { edgeRuntimeStatus, ensureFuelHistoryStore } from "./fuel-history-store";
import { edgeSensorSecret, sensorKeyMatches } from "./fuel-history-api";
import { readJsonBody, RequestBodyError } from "./request-body";
import {
  completeRelayTest,
  ensureRelayTestStore,
  getRelayTest,
  RELAY_TEST_MAX_DURATION_SECONDS,
  RELAY_TEST_MIN_DURATION_SECONDS,
  RelayTestConflict,
  requestRelayTest,
  takeRelayTestCommand,
} from "./relay-test-store";
import { parsePermissions } from "./user-store";

type RelayTestEnvironment = AuthEnvironment & { FUEL_SENSOR_INGEST_KEY?: string };

export async function handleRelayTestRequest(request: Request, env: RelayTestEnvironment): Promise<Response | null> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith("/api/relay-test")) return null;
  if (!env.DB) return json({ error: "Base local no disponible." }, 503);
  await ensureRelayTestStore(env.DB);

  if (url.pathname === "/api/relay-test/commands/next" && request.method === "POST") {
    if (!await edgeAuthorized(request, env)) return json({ error: "Controlador edge no autorizado." }, 401);
    return json({ command: await takeRelayTestCommand(env.DB) }, 200);
  }
  const resultMatch = url.pathname.match(/^\/api\/relay-test\/commands\/([^/]+)\/result$/u);
  if (resultMatch && request.method === "POST") {
    if (!await edgeAuthorized(request, env)) return json({ error: "Controlador edge no autorizado." }, 401);
    try {
      const body = await readJsonBody(request, 4096) as { success?: unknown; error?: unknown };
      if (typeof body.success !== "boolean") return json({ error: "Resultado de prueba inválido." }, 400);
      const command = await completeRelayTest(env.DB, decodeURIComponent(resultMatch[1]), {
        success: body.success,
        error: typeof body.error === "string" ? body.error : undefined,
      });
      return json({ command }, 200);
    } catch (error) { return relayTestError(error); }
  }

  const actor = await authenticatedUser(request, env);
  if (!actor) return json({ error: "Sesión no válida." }, 401);
  if (!isAdministrator(actor.role) || !parsePermissions(actor.permissions).includes("manage_system")) {
    return json({ error: "No tienes permiso para probar la bomba." }, 403);
  }
  if (!sameOrigin(request) && request.method !== "GET") {
    return json({ error: "Solicitud no permitida." }, 403);
  }

  if (url.pathname === "/api/relay-test" && request.method === "POST") {
    try {
      const body = await readJsonBody(request, 4096) as { password?: unknown; durationSeconds?: unknown };
      if (typeof body.password !== "string" || body.password.length < 1 || body.password.length > 256) {
        return json({ error: "Ingresa la clave de administrador." }, 400);
      }
      if (!Number.isInteger(body.durationSeconds)
        || Number(body.durationSeconds) < RELAY_TEST_MIN_DURATION_SECONDS
        || Number(body.durationSeconds) > RELAY_TEST_MAX_DURATION_SECONDS) {
        return json({
          error: `El tiempo de habilitación debe estar entre ${RELAY_TEST_MIN_DURATION_SECONDS} y ${RELAY_TEST_MAX_DURATION_SECONDS} segundos.`,
        }, 400);
      }
      const confirmation = await confirmAdministratorPassword(request, env, body.password);
      if ("response" in confirmation) return confirmation.response;
      await ensureFuelHistoryStore(env.DB);
      const edge = await edgeRuntimeStatus(env.DB);
      const reportedAt = edge ? new Date(String(edge.occurredAt)).getTime() : Number.NaN;
      if (!edge || !Number.isFinite(reportedAt) || Date.now() - reportedAt > 30_000) {
        throw new RelayTestConflict("El PLC no tiene un reporte operacional reciente.");
      }
      if (edge.state !== "locked" || edge.relayEnergized) {
        throw new RelayTestConflict("El punto debe estar bloqueado y con el relé abierto.");
      }
      if (!edge.k24Enabled || !edge.k24Healthy) {
        throw new RelayTestConflict("K24 debe estar habilitado y saludable para probar la bomba.");
      }
      return json({ command: await requestRelayTest(env.DB, actor.id, Number(body.durationSeconds)) }, 202);
    } catch (error) { return relayTestError(error); }
  }
  const commandMatch = url.pathname.match(/^\/api\/relay-test\/([^/]+)$/u);
  if (commandMatch && request.method === "GET") {
    const command = await getRelayTest(env.DB, decodeURIComponent(commandMatch[1]));
    return command ? json({ command }, 200) : json({ error: "Prueba de bomba no encontrada." }, 404);
  }
  return json({ error: "Ruta no encontrada." }, 404);
}

function edgeAuthorized(request: Request, env: RelayTestEnvironment) {
  return sensorKeyMatches(request.headers.get("x-edge-sensor-key"), edgeSensorSecret(env));
}

function isAdministrator(role: string) {
  return role === "master" || role === "administrator";
}

function relayTestError(error: unknown) {
  if (error instanceof RelayTestConflict) return json({ error: error.message }, 409);
  if (error instanceof RequestBodyError) return json({ error: error.message }, error.status);
  return json({ error: "No fue posible completar la prueba de bomba." }, 500);
}
