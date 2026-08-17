import { resolve } from "node:path";
import { startProdServer } from "vinext/server/prod-server";
import { createLocalD1 } from "./local-d1.mjs";

const host = process.env.HOST ?? "127.0.0.1";
const port = Number.parseInt(process.env.PORT ?? "8080", 10);
const databasePath = process.env.LOCAL_SQLITE_PATH
  ?? "/var/lib/fuel-edge-web/fuel-edge.sqlite3";

if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error("PORT debe ser un puerto TCP válido.");
}

const database = createLocalD1(databasePath);
Object.defineProperty(globalThis, "__FUEL_EDGE_LOCAL_DB__", {
  configurable: false,
  enumerable: false,
  writable: false,
  value: database,
});

let server;
try {
  ({ server } = await startProdServer({
    host,
    port,
    outDir: resolve(process.cwd(), "dist"),
  }));
} catch (error) {
  database.close();
  throw error;
}

let stopping = false;
function stop(signal) {
  if (stopping) return;
  stopping = true;
  const forcedExit = setTimeout(() => process.exit(1), 10_000);
  forcedExit.unref();
  server.close(() => {
    clearTimeout(forcedExit);
    database.close();
    process.exit(signal === "SIGTERM" ? 0 : 130);
  });
}

process.on("SIGTERM", () => stop("SIGTERM"));
process.on("SIGINT", () => stop("SIGINT"));
