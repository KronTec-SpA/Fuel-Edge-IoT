import { authenticatedUser, json, sameOrigin, type AuthEnvironment } from "./auth";
import { readJsonBody, RequestBodyError } from "./request-body";
import { parsePermissions } from "./user-store";
import {
  assignRfidCredential,
  deleteRfidCredential,
  listRfidCredentials,
  RfidCredentialConflict,
} from "./rfid-credentials-store";

export async function handleRfidCredentialsRequest(request: Request, env: AuthEnvironment): Promise<Response | null> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith("/api/rfid-credentials")) return null;
  if (!env.DB) return json({ error: "Base local no disponible." }, 503);
  const actor = await authenticatedUser(request, env);
  if (!actor) return json({ error: "Sesión no válida." }, 401);
  if (!parsePermissions(actor.permissions).includes("manage_operators")) {
    return json({ error: "No tienes permiso para administrar credenciales RFID." }, 403);
  }
  if (!sameOrigin(request) && request.method !== "GET") return json({ error: "Solicitud no permitida." }, 403);

  if (url.pathname === "/api/rfid-credentials" && request.method === "GET") {
    return json({ credentials: await listRfidCredentials(env.DB) }, 200);
  }
  const match = url.pathname.match(/^\/api\/rfid-credentials\/([^/]+)$/u);
  if (!match) return json({ error: "Ruta no encontrada." }, 404);
  const credentialId = decodeURIComponent(match[1]);
  try {
    if (request.method === "PATCH") {
      const body = await readJsonBody(request, 4096) as { operatorId?: unknown };
      if (body.operatorId !== null && typeof body.operatorId !== "string") {
        return json({ error: "Selecciona un operador válido." }, 400);
      }
      return json(await assignRfidCredential(env.DB, credentialId, body.operatorId || null, actor.id), 200);
    }
    if (request.method === "DELETE") {
      if (actor.role !== "master" || actor.is_master !== 1) {
        return json({ error: "Sólo el administrador maestro puede eliminar credenciales de la base local." }, 403);
      }
      return json(await deleteRfidCredential(env.DB, credentialId, actor.id), 200);
    }
  } catch (error) {
    if (error instanceof RfidCredentialConflict) return json({ error: error.message }, 409);
    if (error instanceof RequestBodyError) return json({ error: error.message }, error.status);
    return json({ error: "No fue posible actualizar la credencial RFID." }, 500);
  }
  return json({ error: "Método no permitido." }, 405);
}
