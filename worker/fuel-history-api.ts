import { authenticatedUser, confirmAdministratorPassword, json, sameOrigin, type AuthEnvironment } from "./auth";
import { createManualFuelReceipt, edgeRuntimeStatus, ensureFuelHistoryStore, fuelSensorState, ingestEdgeFuelMovement, ingestEdgeRuntimeStatus, ingestFuelLevelReading, listFuelMovements, listPendingReceiptReviews, resetFuelHistoryStore, reviewFuelReceipt } from "./fuel-history-store";
import { ensureManagedEntityStore } from "./managed-entities-store";
import { parsePermissions } from "./user-store";
import { readJsonBody, RequestBodyError } from "./request-body";
import { getCommissioningState } from "./system-settings-store";

interface FuelHistoryEnvironment extends AuthEnvironment {
  FUEL_SENSOR_INGEST_KEY?: string;
  FUEL_HISTORY_DEMO_SEED?: string;
  APP_DEMO_SEED?: string;
  FUEL_SITE_ID?: string;
}

const FUEL_HISTORY_TIME_ZONE = "America/Santiago";
const fuelHistoryDateTime = new Intl.DateTimeFormat("en-CA", {
  timeZone: FUEL_HISTORY_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});

export async function handleFuelHistoryRequest(request: Request, env: FuelHistoryEnvironment): Promise<Response | null> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith("/api/fuel-history")) return null;
  if (!env.DB) return json({ error: "La base de datos local no está disponible." }, 503);
  await ensureManagedEntityStore(env.DB, runtimeValue(env, "APP_DEMO_SEED") === "true");
  await ensureFuelHistoryStore(env.DB, runtimeValue(env, "FUEL_HISTORY_DEMO_SEED") === "true");

  if (request.method === "GET" && url.pathname === "/api/fuel-history/status") {
    const actor = await authenticatedUser(request, env);
    if (!actor || !parsePermissions(actor.permissions).includes("view_dashboard")) {
      return json({ error: "No tienes permiso para consultar el estado operacional." }, 403);
    }
    const [edge, sensor] = await Promise.all([
      edgeRuntimeStatus(env.DB),
      fuelSensorState(env.DB),
    ]);
    return json({ edge, sensor }, 200);
  }

  if (request.method === "GET" && url.pathname === "/api/fuel-history") {
    const actor = await authenticatedUser(request, env);
    if (!actor || !parsePermissions(actor.permissions).includes("view_transactions")) {
      return json({ error: "No tienes permiso para consultar el histórico." }, 403);
    }
    const range = parseRange(url.searchParams.get("from"), url.searchParams.get("to"));
    if (!range) return json({ error: "El rango de fechas no es válido." }, 400);
    const [movements, pendingReceipts, sensor, edge] = await Promise.all([
      listFuelMovements(env.DB, range.fromIso, range.toExclusiveIso),
      listPendingReceiptReviews(env.DB),
      fuelSensorState(env.DB),
      edgeRuntimeStatus(env.DB),
    ]);
    const reconciledReceipts = movements.filter((item) => item.type === "receipt"
      && item.reviewStatus !== "pending" && item.reviewStatus !== "rejected");
    const receivedLiters = sum(reconciledReceipts.map((item) => item.liters));
    const dispatchedLiters = sum(movements.filter((item) => item.type === "dispatch" && item.classification === "standard").map((item) => item.liters));
    const pumpEnablementLiters = sum(movements.filter((item) => item.classification === "pump_enablement").map((item) => item.liters));
    return json({
      movements,
      pendingReceipts,
      summary: {
        receivedLiters, dispatchedLiters, pumpEnablementLiters,
        netLiters: round1(receivedLiters - dispatchedLiters),
        movementCount: movements.filter((item) => item.reviewStatus !== "pending" && item.reviewStatus !== "rejected").length,
        pendingReceiptCount: pendingReceipts.length,
      },
      sensor, edge,
    }, 200);
  }

  if (request.method === "POST" && url.pathname === "/api/fuel-history/receipts/manual") {
    if (!sameOrigin(request)) return json({ error: "Solicitud no permitida." }, 403);
    const actor = await authenticatedUser(request, env);
    if (!actor || !parsePermissions(actor.permissions).includes("manage_receipts")) {
      return json({ error: "No tienes permiso para registrar recepciones." }, 403);
    }
    let body: Record<string, unknown>;
    try { body = await readJsonBody(request, 16 * 1024); } catch (error) { return bodyError(error); }
    try {
      const result = await createManualFuelReceipt(env.DB, body, { id: actor.id, name: actor.name });
      return json(result, result.created ? 201 : 200);
    } catch (error) {
      return json({ error: error instanceof Error ? error.message : "No fue posible registrar la recepción." }, 400);
    }
  }

  const receiptReviewMatch = /^\/api\/fuel-history\/receipts\/([^/]+)\/review$/u.exec(url.pathname);
  if (request.method === "POST" && receiptReviewMatch) {
    if (!sameOrigin(request)) return json({ error: "Solicitud no permitida." }, 403);
    const actor = await authenticatedUser(request, env);
    if (!actor || !parsePermissions(actor.permissions).includes("manage_receipts")) {
      return json({ error: "No tienes permiso para revisar recepciones." }, 403);
    }
    let body: Record<string, unknown>;
    try { body = await readJsonBody(request, 16 * 1024); } catch (error) { return bodyError(error); }
    try {
      const movementId = decodeURIComponent(receiptReviewMatch[1]);
      const result = await reviewFuelReceipt(env.DB, movementId, body, { id: actor.id, name: actor.name });
      return json(result, 200);
    } catch (error) {
      return json({ error: error instanceof Error ? error.message : "No fue posible revisar la recepción." }, 400);
    }
  }

  if (request.method === "POST" && url.pathname === "/api/fuel-history/reset") {
    if (!sameOrigin(request)) return json({ error: "Solicitud no permitida." }, 403);
    let body: { password?: unknown };
    try { body = await readJsonBody(request, 4096); } catch (error) { return bodyError(error); }
    if (typeof body.password !== "string" || body.password.length < 1 || body.password.length > 256) {
      return json({ error: "Ingresa la clave de administrador." }, 400);
    }
    const confirmation = await confirmAdministratorPassword(request, env, body.password);
    if ("response" in confirmation) return confirmation.response;
    const actor = confirmation.user;
    if (actor.role !== "master" || actor.is_master !== 1
      || !parsePermissions(actor.permissions).includes("manage_system")) {
      return json({ error: "Sólo el usuario maestro del proveedor puede reiniciar la base de carga y nivel." }, 403);
    }
    const siteId = env.FUEL_SITE_ID?.trim() || "concha-y-toro-piloto";
    const commissioning = await getCommissioningState(env.DB, siteId);
    if (commissioning.status === "completed") {
      return json({ error: "La puesta en marcha está finalizada. Reábrela antes de habilitar un nuevo reinicio." }, 409);
    }
    const result = await resetFuelHistoryStore(env.DB, actor.id);
    return json({ reset: true, ...result, sensor: await fuelSensorState(env.DB) }, 200);
  }

  if (request.method === "POST" && url.pathname === "/api/fuel-history/readings") {
    const sensorAuthorized = await sensorKeyMatches(request.headers.get("x-edge-sensor-key"), edgeSensorSecret(env));
    const actor = sensorAuthorized ? null : await authenticatedUser(request, env);
    const userAuthorized = actor ? parsePermissions(actor.permissions).includes("manage_system") && sameOrigin(request) : false;
    if (!sensorAuthorized && !userAuthorized) return json({ error: "Lectura de sensor no autorizada." }, 403);
    let body: { levelLiters?: unknown; occurredAt?: unknown; source?: unknown; telemetrySessionId?: unknown };
    try { body = await readJsonBody(request, 4096); } catch (error) { return bodyError(error); }
    try {
      if (typeof body.levelLiters !== "number") throw new Error("El nivel debe ser un número.");
      if (body.telemetrySessionId != null && typeof body.telemetrySessionId !== "string") {
        throw new Error("La sesión de telemetría no es válida.");
      }
      const result = await ingestFuelLevelReading(
        env.DB,
        body.levelLiters,
        typeof body.occurredAt === "string" ? body.occurredAt : new Date().toISOString(),
        typeof body.source === "string" ? body.source : "OCIO",
        body.telemetrySessionId ?? null,
      );
      return json({ recorded: true, detection: result }, 201);
    } catch (error) {
      return json({ error: error instanceof Error ? error.message : "No fue posible registrar la lectura." }, 400);
    }
  }

  if (request.method === "POST" && url.pathname === "/api/fuel-history/movements") {
    if (!await sensorKeyMatches(request.headers.get("x-edge-sensor-key"), edgeSensorSecret(env))) {
      return json({ error: "Despacho edge no autorizado." }, 403);
    }
    let body: { id?: unknown; type?: unknown; occurredAt?: unknown; liters?: unknown; source?: unknown; reference?: unknown; detail?: unknown };
    try { body = await readJsonBody(request, 16 * 1024); } catch (error) { return bodyError(error); }
    try {
      const result = await ingestEdgeFuelMovement(env.DB, body);
      return json({ recorded: true, ...result }, result.created ? 201 : 200);
    } catch (error) {
      return json({ error: error instanceof Error ? error.message : "No fue posible registrar el despacho." }, 400);
    }
  }

  if (request.method === "POST" && url.pathname === "/api/fuel-history/status") {
    if (!await sensorKeyMatches(request.headers.get("x-edge-sensor-key"), edgeSensorSecret(env))) return json({ error: "Estado edge no autorizado." }, 403);
    let body: Record<string, unknown>;
    try { body = await readJsonBody(request, 8192); } catch (error) { return bodyError(error); }
    try { return json(await ingestEdgeRuntimeStatus(env.DB, body), 200); }
    catch (error) { return json({ error: error instanceof Error ? error.message : "Estado edge inválido." }, 400); }
  }
  return json({ error: "Ruta no encontrada." }, 404);
}

function parseRange(from: string | null, to: string | null) {
  const startDate = parseIsoDate(from);
  const endDate = parseIsoDate(to);
  if (!startDate || !endDate || startDate.utcDay > endDate.utcDay) return null;
  if (endDate.utcDay - startDate.utcDay > 5 * 366 * 24 * 60 * 60 * 1000) return null;
  const nextDate = new Date(endDate.utcDay);
  nextDate.setUTCDate(nextDate.getUTCDate() + 1);
  return {
    fromIso: localDateBoundaryIso(startDate),
    toExclusiveIso: localDateBoundaryIso({
      year: nextDate.getUTCFullYear(),
      month: nextDate.getUTCMonth() + 1,
      day: nextDate.getUTCDate(),
      utcDay: nextDate.getTime(),
    }),
  };
}

type IsoDate = { year: number; month: number; day: number; utcDay: number };

function parseIsoDate(value: string | null): IsoDate | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value ?? "");
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const utcDay = Date.UTC(year, month - 1, day);
  const date = new Date(utcDay);
  if (date.getUTCFullYear() !== year || date.getUTCMonth() + 1 !== month || date.getUTCDate() !== day) return null;
  return { year, month, day, utcDay };
}

function localDateBoundaryIso(date: IsoDate) {
  let candidate = date.utcDay;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const rendered = zonedDateTimeParts(candidate);
    const renderedUtc = Date.UTC(rendered.year, rendered.month - 1, rendered.day, rendered.hour, rendered.minute, rendered.second);
    candidate += date.utcDay - renderedUtc;
    const resolved = zonedDateTimeParts(candidate);
    if (resolved.year === date.year && resolved.month === date.month && resolved.day === date.day
      && resolved.hour === 0 && resolved.minute === 0 && resolved.second === 0) {
      return new Date(candidate).toISOString();
    }
  }

  // On the spring DST transition, Chile can skip local midnight. In that case,
  // use the first real instant whose calendar date is the requested local day.
  let low = date.utcDay - 36 * 60 * 60 * 1000;
  let high = date.utcDay + 36 * 60 * 60 * 1000;
  const targetKey = localDateKey(date);
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (localDateKey(zonedDateTimeParts(middle)) < targetKey) low = middle + 1;
    else high = middle;
  }
  return new Date(low).toISOString();
}

function zonedDateTimeParts(timestamp: number) {
  const parts = Object.fromEntries(fuelHistoryDateTime.formatToParts(timestamp).map((part) => [part.type, part.value]));
  return {
    year: Number(parts.year), month: Number(parts.month), day: Number(parts.day),
    hour: Number(parts.hour), minute: Number(parts.minute), second: Number(parts.second),
  };
}

function localDateKey(date: { year: number; month: number; day: number }) {
  return date.year * 10_000 + date.month * 100 + date.day;
}

function sum(values: number[]) { return round1(values.reduce((total, value) => total + value, 0)); }
function round1(value: number) { return Math.round(value * 10) / 10; }
function bodyError(error: unknown) {
  if (error instanceof RequestBodyError) return json({ error: error.message }, error.status);
  return json({ error: "Solicitud inválida." }, 400);
}
export async function sensorKeyMatches(supplied?: string | null, expected?: string) {
  if (!supplied || !expected || expected.length < 24) return false;
  const encoder = new TextEncoder();
  const [left, right] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(supplied)),
    crypto.subtle.digest("SHA-256", encoder.encode(expected)),
  ]);
  const leftBytes = new Uint8Array(left); const rightBytes = new Uint8Array(right);
  let difference = 0;
  for (let index = 0; index < leftBytes.length; index += 1) difference |= leftBytes[index] ^ rightBytes[index];
  return difference === 0;
}

export function edgeSensorSecret(env: { FUEL_SENSOR_INGEST_KEY?: string }) {
  if (typeof env.FUEL_SENSOR_INGEST_KEY === "string" && env.FUEL_SENSOR_INGEST_KEY) return env.FUEL_SENSOR_INGEST_KEY;
  try { return typeof process !== "undefined" ? process.env.FUEL_SENSOR_INGEST_KEY : undefined; } catch { return undefined; }
}

function runtimeValue(env: FuelHistoryEnvironment, key: "FUEL_SENSOR_INGEST_KEY" | "FUEL_HISTORY_DEMO_SEED" | "APP_DEMO_SEED") {
  const bound = env[key];
  if (typeof bound === "string" && bound) return bound;
  try { return typeof process !== "undefined" ? process.env[key] : undefined; } catch { return undefined; }
}
