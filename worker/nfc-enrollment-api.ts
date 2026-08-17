import { authenticatedUser, json, sameOrigin, type AuthEnvironment } from "./auth";
import { parsePermissions } from "./user-store";
import { readJsonBody, RequestBodyError } from "./request-body";
import {
  cancelNfcEnrollment,
  completeNfcEnrollment,
  ensureNfcEnrollmentStore,
  getNfcEnrollment,
  getEdgeRfidCredentialSnapshot,
  NfcEnrollmentConflict,
  NfcMasterReplacementRequired,
  requestNfcEnrollment,
  takeNfcIdentificationCommand,
  takeNfcEnrollmentCommand,
} from "./nfc-enrollment-store";

type NfcEnvironment = AuthEnvironment & { FUEL_SENSOR_INGEST_KEY?: string };

export async function handleNfcEnrollmentRequest(request: Request, env: NfcEnvironment): Promise<Response | null> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith("/api/nfc-enrollment")) return null;
  if (!env.DB) return json({ error: "Base local no disponible." }, 503);
  await ensureNfcEnrollmentStore(env.DB);

  if (url.pathname === "/api/nfc-enrollment/commands/next" && request.method === "POST") {
    if (!edgeAuthorized(request, env)) return json({ error: "Validador NFC no autorizado." }, 401);
    const [identificationCommand, command, credentials] = await Promise.all([
      takeNfcIdentificationCommand(env.DB),
      takeNfcEnrollmentCommand(env.DB),
      getEdgeRfidCredentialSnapshot(env.DB),
    ]);
    return json({ identificationCommand, command, credentials }, 200);
  }
  const resultMatch = url.pathname.match(/^\/api\/nfc-enrollment\/commands\/([^/]+)\/result$/u);
  if (resultMatch && request.method === "POST") {
    if (!edgeAuthorized(request, env)) return json({ error: "Validador NFC no autorizado." }, 401);
    try {
      const body = await readJsonBody(request, 4096) as { success?: unknown; credentialId?: unknown; error?: unknown };
      if (typeof body.success !== "boolean") return json({ error: "Resultado NFC inválido." }, 400);
      const result = await completeNfcEnrollment(env.DB, decodeURIComponent(resultMatch[1]), {
        success: body.success,
        credentialId: typeof body.credentialId === "string" ? body.credentialId : undefined,
        error: typeof body.error === "string" ? body.error : undefined,
      });
      return json(result, 200);
    } catch (error) { return enrollmentError(error); }
  }

  const actor = await authenticatedUser(request, env);
  if (!actor) return json({ error: "Sesión no válida." }, 401);
  if (!parsePermissions(actor.permissions).includes("manage_operators")) {
    return json({ error: "No tienes permiso para enrolar credenciales." }, 403);
  }
  if (
    url.pathname === "/api/nfc-enrollment"
    && request.method === "POST"
    && (actor.role !== "master" || actor.is_master !== 1)
  ) {
    return json({
      error: "Sólo la cuenta maestra del proveedor tecnológico puede enrolar nuevas credenciales RFID.",
    }, 403);
  }
  if (!sameOrigin(request) && request.method !== "GET") return json({ error: "Solicitud no permitida." }, 403);

  if (url.pathname === "/api/nfc-enrollment" && request.method === "POST") {
    try {
      const body = await readJsonBody(request, 4096) as {
        operatorId?: unknown;
        isMaster?: unknown;
        replaceMasterCredentialId?: unknown;
      };
      if (typeof body.operatorId !== "undefined" && (typeof body.operatorId !== "string" || !body.operatorId)) {
        return json({ error: "Operador inválido." }, 400);
      }
      if (typeof body.isMaster !== "undefined" && typeof body.isMaster !== "boolean") {
        return json({ error: "El tipo de credencial no es válido." }, 400);
      }
      if (typeof body.replaceMasterCredentialId !== "undefined" && typeof body.replaceMasterCredentialId !== "string") {
        return json({ error: "La aprobación de reemplazo no es válida." }, 400);
      }
      return json({ command: await requestNfcEnrollment(env.DB, typeof body.operatorId === "string" ? body.operatorId : null, actor.id, {
        isMaster: body.isMaster === true,
        replaceMasterCredentialId: typeof body.replaceMasterCredentialId === "string" ? body.replaceMasterCredentialId : undefined,
      }) }, 202);
    } catch (error) { return enrollmentError(error); }
  }
  const commandMatch = url.pathname.match(/^\/api\/nfc-enrollment\/([^/]+)$/u);
  if (commandMatch && request.method === "GET") {
    const command = await getNfcEnrollment(env.DB, decodeURIComponent(commandMatch[1]));
    return command ? json({ command }, 200) : json({ error: "Enrolamiento no encontrado." }, 404);
  }
  if (commandMatch && request.method === "DELETE") {
    const cancelled = await cancelNfcEnrollment(env.DB, decodeURIComponent(commandMatch[1]), actor.id);
    return cancelled ? json({ cancelled: true }, 200) : json({ error: "Enrolamiento no encontrado." }, 404);
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

function enrollmentError(error: unknown) {
  if (error instanceof NfcMasterReplacementRequired) {
    return json({
      error: error.message,
      code: "MASTER_REPLACEMENT_REQUIRED",
      currentMaster: error.currentMaster,
    }, 409);
  }
  if (error instanceof NfcEnrollmentConflict) return json({ error: error.message }, 409);
  if (error instanceof RequestBodyError) return json({ error: error.message }, error.status);
  return json({ error: "No fue posible completar el enrolamiento NFC." }, 500);
}
