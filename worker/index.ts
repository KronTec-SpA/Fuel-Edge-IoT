/** Cloudflare Worker entry point for the vinext-starter template. */
import handler from "vinext/server/app-router-entry";
import { handleAuthRequest, type AuthEnvironment } from "./auth";
import { handleUsersRequest } from "./users-api";
import { handleManagedEntitiesRequest } from "./managed-entities-api";
import { handleFuelHistoryRequest } from "./fuel-history-api";
import { handleAlertsRequest } from "./alerts-api";
import { handleEquipmentEnrollmentRequest } from "./equipment-enrollment-api";
import { handleNfcEnrollmentRequest } from "./nfc-enrollment-api";
import { handleNfcIdentificationRequest } from "./nfc-identification-api";
import { handleRfidCredentialsRequest } from "./rfid-credentials-api";
import { handleSystemSettingsRequest } from "./system-settings-api";
import { handleRelayTestRequest } from "./relay-test-api";
import { handleManualModeRequest } from "./manual-mode-api";
import { handleDataExportRequest } from "./data-export-api";
import { handleTechnologyAdoptionRequest } from "./technology-adoption-api";
import type { D1DatabaseLike } from "./user-store";

interface Env extends AuthEnvironment {
  ASSETS: Fetcher;
}

interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
}

type LocalDatabaseGlobal = typeof globalThis & {
  __FUEL_EDGE_LOCAL_DB__?: D1DatabaseLike;
};

function runtimeEnvironment(env: Env): Env {
  const localDatabase = (globalThis as LocalDatabaseGlobal).__FUEL_EDGE_LOCAL_DB__;
  return localDatabase ? { ...env, DB: localDatabase } : env;
}

// Image security config. SVG sources with .svg extension auto-skip the
// optimization endpoint on the client side (served directly, no proxy).
// To route SVGs through the optimizer (with security headers), set
// dangerouslyAllowSVG: true in next.config.js and uncomment below:
// const imageConfig: ImageConfig = { dangerouslyAllowSVG: true };

const worker = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const runtimeEnv = runtimeEnvironment(env);

    const authResponse = await handleAuthRequest(request, runtimeEnv);
    if (authResponse) return authResponse;
    const usersResponse = await handleUsersRequest(request, runtimeEnv);
    if (usersResponse) return usersResponse;
    const managedEntitiesResponse = await handleManagedEntitiesRequest(request, runtimeEnv);
    if (managedEntitiesResponse) return managedEntitiesResponse;
    const enrollmentResponse = await handleEquipmentEnrollmentRequest(request, runtimeEnv);
    if (enrollmentResponse) return enrollmentResponse;
    const nfcEnrollmentResponse = await handleNfcEnrollmentRequest(request, runtimeEnv);
    if (nfcEnrollmentResponse) return nfcEnrollmentResponse;
    const nfcIdentificationResponse = await handleNfcIdentificationRequest(request, runtimeEnv);
    if (nfcIdentificationResponse) return nfcIdentificationResponse;
    const rfidCredentialsResponse = await handleRfidCredentialsRequest(request, runtimeEnv);
    if (rfidCredentialsResponse) return rfidCredentialsResponse;
    const systemSettingsResponse = await handleSystemSettingsRequest(request, runtimeEnv);
    if (systemSettingsResponse) return systemSettingsResponse;
    const relayTestResponse = await handleRelayTestRequest(request, runtimeEnv);
    if (relayTestResponse) return relayTestResponse;
    const manualModeResponse = await handleManualModeRequest(request, runtimeEnv);
    if (manualModeResponse) return manualModeResponse;
    const technologyAdoptionResponse = await handleTechnologyAdoptionRequest(request, runtimeEnv);
    if (technologyAdoptionResponse) return technologyAdoptionResponse;
    const dataExportResponse = await handleDataExportRequest(request, runtimeEnv);
    if (dataExportResponse) return dataExportResponse;
    const fuelHistoryResponse = await handleFuelHistoryRequest(request, runtimeEnv);
    if (fuelHistoryResponse) return fuelHistoryResponse;
    const alertsResponse = await handleAlertsRequest(request, runtimeEnv);
    if (alertsResponse) return alertsResponse;

    if (url.pathname === "/_vinext/image") return new Response("Not found", { status: 404 });

    return handler.fetch(request, runtimeEnv, ctx);
  },
};

export default worker;
