import { authenticatedUser, json, sameOrigin, type AuthEnvironment } from "./auth";
import { edgeSensorSecret, sensorKeyMatches } from "./fuel-history-api";
import { readJsonBody, RequestBodyError } from "./request-body";
import {
  getBluetoothSettings,
  listLinkedBluetoothObservations,
  markBluetoothSettingsApplied,
  recordBluetoothObservation,
  updateBluetoothSettings,
  validRssiThreshold,
} from "./system-settings-store";
import { parsePermissions } from "./user-store";

type SettingsEnvironment = AuthEnvironment & {
  FUEL_SENSOR_INGEST_KEY?: string;
  FUEL_SITE_ID?: string;
};

export async function handleSystemSettingsRequest(request: Request, env: SettingsEnvironment): Promise<Response | null> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith("/api/system-settings/")) return null;
  if (!env.DB) return json({ error: "Base local no disponible." }, 503);
  const siteId = env.FUEL_SITE_ID?.trim() || "concha-y-toro-piloto";

  if (url.pathname === "/api/system-settings/bluetooth/current" && request.method === "POST") {
    if (!await edgeAuthorized(request, env)) return json({ error: "Controlador edge no autorizado." }, 403);
    return json({ settings: await getBluetoothSettings(env.DB, siteId) }, 200);
  }
  if (url.pathname === "/api/system-settings/bluetooth/applied" && request.method === "POST") {
    if (!await edgeAuthorized(request, env)) return json({ error: "Controlador edge no autorizado." }, 403);
    try {
      const body = await readJsonBody(request, 4096) as Record<string, unknown>;
      if (!validRssiThreshold(body.rssiThreshold) || !Number.isInteger(body.revision) || Number(body.revision) < 1) {
        return json({ error: "Confirmación Bluetooth inválida." }, 400);
      }
      return json({ settings: await markBluetoothSettingsApplied(
        env.DB, siteId, body.rssiThreshold, Number(body.revision),
      ) }, 200);
    } catch (error) { return bodyError(error); }
  }
  if (url.pathname === "/api/system-settings/bluetooth/observation" && request.method === "POST") {
    if (!await edgeAuthorized(request, env)) return json({ error: "Controlador edge no autorizado." }, 403);
    try {
      const body = await readJsonBody(request, 4096) as Record<string, unknown>;
      const moduleId = identifier(body.moduleId);
      const rssi = body.rssi;
      if (!moduleId || typeof rssi !== "number" || !Number.isInteger(rssi) || rssi < -127 || rssi > 20) {
        return json({ error: "Observación Bluetooth inválida." }, 400);
      }
      return json({ settings: await recordBluetoothObservation(env.DB, siteId, moduleId, rssi) }, 200);
    } catch (error) { return bodyError(error); }
  }

  const actor = await authenticatedUser(request, env);
  const permissions = actor ? parsePermissions(actor.permissions) : [];
  if (url.pathname === "/api/system-settings/bluetooth/observations" && request.method === "GET") {
    if (!actor || !permissions.includes("view_dashboard")) {
      return json({ error: "No tienes permiso para ver el mapa de máquinas." }, 403);
    }
    return json({ observations: await listLinkedBluetoothObservations(env.DB, siteId) }, 200);
  }
  if (!actor || !permissions.includes("manage_system")) {
    return json({ error: "No tienes permiso para calibrar Bluetooth." }, 403);
  }
  if (url.pathname === "/api/system-settings/bluetooth" && request.method === "GET") {
    return json({ settings: await getBluetoothSettings(env.DB, siteId) }, 200);
  }
  if (url.pathname === "/api/system-settings/bluetooth" && request.method === "PUT") {
    if (!sameOrigin(request)) return json({ error: "Solicitud no permitida." }, 403);
    try {
      const body = await readJsonBody(request, 4096) as Record<string, unknown>;
      if (!validRssiThreshold(body.rssiThreshold)) {
        return json({ error: "El umbral debe estar entre -100 y -35 dBm." }, 400);
      }
      return json({ settings: await updateBluetoothSettings(env.DB, siteId, body.rssiThreshold, actor.id) }, 200);
    } catch (error) { return bodyError(error); }
  }
  return json({ error: "Ruta no encontrada." }, 404);
}

function edgeAuthorized(request: Request, env: SettingsEnvironment) {
  return sensorKeyMatches(request.headers.get("x-edge-sensor-key"), edgeSensorSecret(env));
}

function identifier(value: unknown) {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/u.test(value) ? value : "";
}

function bodyError(error: unknown) {
  if (error instanceof RequestBodyError) return json({ error: error.message }, error.status);
  return json({ error: "Solicitud inválida." }, 400);
}
