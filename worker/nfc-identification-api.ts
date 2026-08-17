import { authenticatedUser, json, sameOrigin, type AuthEnvironment } from "./auth";
import { parsePermissions } from "./user-store";
import { readJsonBody, RequestBodyError } from "./request-body";
import {
  cancelNfcIdentification,
  completeNfcIdentification,
  ensureNfcEnrollmentStore,
  getNfcIdentification,
  NfcEnrollmentConflict,
  requestNfcIdentification,
  takeNfcIdentificationCommand,
} from "./nfc-enrollment-store";

type NfcEnvironment = AuthEnvironment & { FUEL_SENSOR_INGEST_KEY?: string };

export async function handleNfcIdentificationRequest(request: Request, env: NfcEnvironment): Promise<Response | null> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith("/api/nfc-identification")) return null;
  if (!env.DB) return json({ error: "Base local no disponible." }, 503);
  await ensureNfcEnrollmentStore(env.DB);

  if (url.pathname === "/api/nfc-identification/commands/next" && request.method === "POST") {
    if (!edgeAuthorized(request, env)) return json({ error: "Validador NFC no autorizado." }, 401);
    return json({ command: await takeNfcIdentificationCommand(env.DB) }, 200);
  }
  const resultMatch = url.pathname.match(/^\/api\/nfc-identification\/commands\/([^/]+)\/result$/u);
  if (resultMatch && request.method === "POST") {
    if (!edgeAuthorized(request, env)) return json({ error: "Validador NFC no autorizado." }, 401);
    try {
      const body = await readJsonBody(request, 4096) as { success?: unknown; credentialId?: unknown; error?: unknown };
      if (typeof body.success !== "boolean") return json({ error: "Resultado NFC inválido." }, 400);
      return json(await completeNfcIdentification(env.DB, decodeURIComponent(resultMatch[1]), {
        success: body.success,
        credentialId: typeof body.credentialId === "string" ? body.credentialId : undefined,
        error: typeof body.error === "string" ? body.error : undefined,
      }), 200);
    } catch (error) { return identificationError(error); }
  }

  const actor = await authenticatedUser(request, env);
  if (!actor) return json({ error: "Sesión no válida." }, 401);
  if (!parsePermissions(actor.permissions).includes("manage_operators")) {
    return json({ error: "No tienes permiso para identificar credenciales." }, 403);
  }
  if (!sameOrigin(request) && request.method !== "GET") return json({ error: "Solicitud no permitida." }, 403);

  if (url.pathname === "/api/nfc-identification" && request.method === "POST") {
    try { return json({ command: await requestNfcIdentification(env.DB, actor.id) }, 202); }
    catch (error) { return identificationError(error); }
  }
  const commandMatch = url.pathname.match(/^\/api\/nfc-identification\/([^/]+)$/u);
  if (commandMatch && request.method === "GET") {
    const command = await getNfcIdentification(env.DB, decodeURIComponent(commandMatch[1]));
    return command ? json({ command }, 200) : json({ error: "Identificación no encontrada." }, 404);
  }
  if (commandMatch && request.method === "DELETE") {
    const cancelled = await cancelNfcIdentification(env.DB, decodeURIComponent(commandMatch[1]), actor.id);
    return cancelled ? json({ cancelled: true }, 200) : json({ error: "Identificación no encontrada." }, 404);
  }
  return json({ error: "Ruta no encontrada." }, 404);
}

function edgeAuthorized(request: Request, env: NfcEnvironment) {
  const expected = env.FUEL_SENSOR_INGEST_KEY;
  const supplied = request.headers.get("x-edge-sensor-key");
  if (!expected || !supplied || expected.length !== supplied.length) return false;
  let difference = 0;
  for (let index = 0; index < expected.length; index += 1) difference |= expected.charCodeAt(index) ^ supplied.charCodeAt(index);
  return difference === 0;
}

function identificationError(error: unknown) {
  if (error instanceof NfcEnrollmentConflict) return json({ error: error.message }, 409);
  if (error instanceof RequestBodyError) return json({ error: error.message }, error.status);
  return json({ error: "No fue posible identificar la credencial NFC." }, 500);
}
