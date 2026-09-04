import { authenticatedUser, confirmAdministratorPassword, json, sameOrigin, type AuthEnvironment } from "./auth";
import { edgeSensorSecret, sensorKeyMatches } from "./fuel-history-api";
import { ensureFuelHistoryStore } from "./fuel-history-store";
import { readJsonBody, RequestBodyError } from "./request-body";
import {
  completeCommissioning,
  getCommissioningState,
  getBluetoothSettings,
  listPowerSupplyEvents,
  listLinkedBluetoothObservations,
  markBluetoothSettingsApplied,
  recordBluetoothObservation,
  reopenCommissioning,
  savePowerSupplyEvent,
  updateBluetoothSettings,
  validRssiThreshold,
  type PowerSupplyEvent,
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

  if (url.pathname === "/api/system-settings/power-events/edge" && request.method === "POST") {
    if (!await edgeAuthorized(request, env)) return json({ error: "Controlador edge no autorizado." }, 403);
    try {
      const body = await readJsonBody(request, 8192) as Record<string, unknown>;
      const event = validatedPowerSupplyEvent(body, siteId);
      if (!event) return json({ error: "Evento de suministro eléctrico inválido." }, 400);
      return json({ event: await savePowerSupplyEvent(env.DB, event) }, 201);
    } catch (error) { return bodyError(error); }
  }

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
  if (url.pathname === "/api/system-settings/power-events" && request.method === "GET") {
    if (!actor || !permissions.includes("manage_system")) {
      return json({ error: "No tienes permiso para consultar el suministro eléctrico." }, 403);
    }
    const days = Number.parseInt(url.searchParams.get("days") ?? "30", 10);
    return json(await listPowerSupplyEvents(env.DB, siteId, days), 200);
  }
  if (url.pathname === "/api/system-settings/bluetooth/observations" && request.method === "GET") {
    if (!actor || !permissions.includes("view_dashboard")) {
      return json({ error: "No tienes permiso para ver el mapa de máquinas." }, 403);
    }
    return json({ observations: await listLinkedBluetoothObservations(env.DB, siteId) }, 200);
  }
  if (url.pathname === "/api/system-settings/commissioning" && request.method === "GET") {
    if (!actor || actor.role !== "master" || actor.is_master !== 1 || !permissions.includes("manage_system")) {
      return json({ error: "Sólo el usuario maestro del proveedor puede consultar la puesta en marcha." }, 403);
    }
    await ensureFuelHistoryStore(env.DB, false);
    return json({ commissioning: await getCommissioningState(env.DB, siteId) }, 200);
  }
  if (url.pathname === "/api/system-settings/commissioning" && request.method === "POST") {
    if (!sameOrigin(request)) return json({ error: "Solicitud no permitida." }, 403);
    if (!actor || actor.role !== "master" || actor.is_master !== 1 || !permissions.includes("manage_system")) {
      return json({ error: "Sólo el usuario maestro del proveedor puede cambiar la puesta en marcha." }, 403);
    }
    let body: Record<string, unknown>;
    try { body = await readJsonBody(request, 8192) as Record<string, unknown>; }
    catch (error) { return bodyError(error); }
    if (typeof body.password !== "string" || body.password.length < 1 || body.password.length > 256) {
      return json({ error: "Ingresa la clave de administrador." }, 400);
    }
    if (body.action !== "complete" && body.action !== "reopen") {
      return json({ error: "Acción de puesta en marcha inválida." }, 400);
    }
    const reason = typeof body.reason === "string" ? body.reason.trim() : "";
    if (body.action === "reopen" && (reason.length < 10 || reason.length > 500)) {
      return json({ error: "Describe el motivo del rechazo en 10 a 500 caracteres." }, 400);
    }
    const confirmation = await confirmAdministratorPassword(request, env, body.password);
    if ("response" in confirmation) return confirmation.response;
    if (confirmation.user.role !== "master" || confirmation.user.is_master !== 1
      || !parsePermissions(confirmation.user.permissions).includes("manage_system")) {
      return json({ error: "Sólo el usuario maestro del proveedor puede cambiar la puesta en marcha." }, 403);
    }
    await ensureFuelHistoryStore(env.DB, false);
    try {
      const commissioning = body.action === "complete"
        ? await completeCommissioning(env.DB, siteId, confirmation.user.id)
        : await reopenCommissioning(env.DB, siteId, confirmation.user.id, reason);
      return json({ updated: true, commissioning }, 200);
    } catch (error) {
      return json({ error: error instanceof Error ? error.message : "No fue posible cambiar la puesta en marcha." }, 409);
    }
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

function validatedPowerSupplyEvent(
  body: Record<string, unknown>,
  configuredSiteId: string,
): PowerSupplyEvent | null {
  const id = identifier(body.id);
  if (!id || body.siteId !== configuredSiteId) return null;
  if (body.source !== "ups_gpio24" && body.source !== "operator_confirmed" && body.source !== "reconstructed") {
    return null;
  }
  if (typeof body.lostAt !== "string" || typeof body.restoredAt !== "string") return null;
  const lostAt = new Date(body.lostAt);
  const restoredAt = new Date(body.restoredAt);
  if (!Number.isFinite(lostAt.getTime()) || !Number.isFinite(restoredAt.getTime()) || restoredAt <= lostAt) {
    return null;
  }
  const durationSeconds = Math.floor((restoredAt.getTime() - lostAt.getTime()) / 1000);
  if (durationSeconds > 10 * 365 * 24 * 60 * 60) return null;
  const lossBootId = optionalBootId(body.lossBootId);
  const restoreBootId = optionalBootId(body.restoreBootId);
  if (lossBootId === undefined || restoreBootId === undefined) return null;
  return {
    id,
    siteId: configuredSiteId,
    lostAt: lostAt.toISOString(),
    restoredAt: restoredAt.toISOString(),
    durationSeconds,
    source: body.source,
    lossBootId,
    restoreBootId,
  };
}

function optionalBootId(value: unknown): string | null | undefined {
  if (value === null || value === undefined) return null;
  return typeof value === "string" && /^[A-Fa-f0-9-]{1,80}$/u.test(value) ? value : undefined;
}

function bodyError(error: unknown) {
  if (error instanceof RequestBodyError) return json({ error: error.message }, error.status);
  return json({ error: "Solicitud inválida." }, 400);
}
