import { audit, type D1DatabaseLike } from "./user-store";

export const RELAY_TEST_MIN_DURATION_SECONDS = 5;
export const RELAY_TEST_MAX_DURATION_SECONDS = 60;
const COMMAND_TTL_MILLISECONDS = 45_000;
const RESULT_GRACE_MILLISECONDS = 30_000;
const initialized = new WeakSet<object>();

export async function ensureRelayTestStore(db: D1DatabaseLike) {
  const marker = db as unknown as object;
  if (initialized.has(marker)) return;
  await db.batch([
    db.prepare(`CREATE TABLE IF NOT EXISTS pump_test_transactions (
      id TEXT PRIMARY KEY,
      actor_user_id TEXT NOT NULL,
      transaction_type TEXT NOT NULL DEFAULT 'pump_test' CHECK(transaction_type='pump_test'),
      status TEXT NOT NULL CHECK(status IN ('pending','running','completed','failed','expired')),
      duration_seconds INTEGER NOT NULL CHECK(duration_seconds BETWEEN 5 AND 60),
      requested_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      started_at TEXT,
      completed_at TEXT,
      expires_at TEXT NOT NULL,
      error TEXT
    )`),
    db.prepare("CREATE INDEX IF NOT EXISTS idx_pump_test_status ON pump_test_transactions(status,requested_at)"),
    db.prepare("CREATE UNIQUE INDEX IF NOT EXISTS idx_pump_test_one_active ON pump_test_transactions((1)) WHERE status IN ('pending','running')"),
  ]);
  initialized.add(marker);
}

async function expireRelayTests(db: D1DatabaseLike) {
  await ensureRelayTestStore(db);
  await db.batch([
    db.prepare(`UPDATE pump_test_transactions SET status='expired',completed_at=CURRENT_TIMESTAMP,error='La Raspberry no tomó el comando dentro de la ventana segura.'
      WHERE status='pending' AND datetime(expires_at)<=datetime('now')`),
    db.prepare(`UPDATE pump_test_transactions SET status='failed',completed_at=CURRENT_TIMESTAMP,error='No se recibió el cierre confirmado de la prueba.'
      WHERE status='running' AND datetime(expires_at)<=datetime('now')`),
  ]);
}

export async function requestRelayTest(db: D1DatabaseLike, actorId: string, durationSeconds: number) {
  if (!Number.isInteger(durationSeconds)
    || durationSeconds < RELAY_TEST_MIN_DURATION_SECONDS
    || durationSeconds > RELAY_TEST_MAX_DURATION_SECONDS) {
    throw new RelayTestConflict("El tiempo de habilitación de la bomba no es válido.");
  }
  await expireRelayTests(db);
  const active = await db.prepare("SELECT id FROM pump_test_transactions WHERE status IN ('pending','running') LIMIT 1")
    .first<{ id: string }>();
  if (active) throw new RelayTestConflict("Ya hay una prueba de bomba en curso.");
  const id = `relay-test-${crypto.randomUUID()}`;
  const expiresAt = new Date(Date.now() + COMMAND_TTL_MILLISECONDS).toISOString();
  try {
    await db.prepare(`INSERT INTO pump_test_transactions(id,actor_user_id,status,duration_seconds,expires_at)
      VALUES (?,?,'pending',?,?)`).bind(id, actorId, durationSeconds, expiresAt).run();
  } catch (error) {
    if (error instanceof Error && /unique|constraint/iu.test(error.message)) {
      throw new RelayTestConflict("Ya hay una prueba de bomba en curso.");
    }
    throw error;
  }
  await audit(db, "pump_test_transaction_requested", actorId, null, {
    commandId: id,
    transactionType: "pump_test",
    durationSeconds,
  });
  return getRelayTest(db, id);
}

export async function takeRelayTestCommand(db: D1DatabaseLike) {
  await expireRelayTests(db);
  const command = await db.prepare(`SELECT id,duration_seconds AS durationSeconds,expires_at AS expiresAt
    FROM pump_test_transactions WHERE status='pending' AND datetime(expires_at)>datetime('now')
    ORDER BY requested_at LIMIT 1`).first<Record<string, unknown>>();
  if (!command) return null;
  const executionExpiresAt = new Date(
    Date.now() + Number(command.durationSeconds) * 1000 + RESULT_GRACE_MILLISECONDS,
  ).toISOString();
  await db.prepare(`UPDATE pump_test_transactions SET status='running',started_at=CURRENT_TIMESTAMP,expires_at=?
    WHERE id=? AND status='pending'`).bind(executionExpiresAt, command.id).run();
  return {
    id: String(command.id),
    transactionType: "pump_test",
    status: "running",
    durationSeconds: Number(command.durationSeconds),
    expiresAt: executionExpiresAt,
  };
}

export async function completeRelayTest(
  db: D1DatabaseLike,
  commandId: string,
  result: { success: boolean; error?: string },
) {
  await expireRelayTests(db);
  const command = await db.prepare(`SELECT id,actor_user_id AS actorUserId,status,duration_seconds AS durationSeconds
    FROM pump_test_transactions WHERE id=?`).bind(commandId)
    .first<{ id: string; actorUserId: string; status: string; durationSeconds: number }>();
  if (command?.status === "completed" && result.success) return getRelayTest(db, commandId);
  if (command?.status === "failed" && !result.success) return getRelayTest(db, commandId);
  if (!command || command.status !== "running") {
    throw new RelayTestConflict("La prueba de bomba ya no está activa.");
  }
  const status = result.success ? "completed" : "failed";
  const error = result.success ? null : (result.error?.trim() || "La Raspberry interrumpió la prueba.").slice(0, 200);
  await db.prepare(`UPDATE pump_test_transactions SET status=?,error=?,completed_at=CURRENT_TIMESTAMP WHERE id=?`)
    .bind(status, error, commandId).run();
  await audit(db, result.success ? "pump_test_transaction_completed" : "pump_test_transaction_interrupted", command.actorUserId, null, {
    commandId,
    transactionType: "pump_test",
    durationSeconds: Number(command.durationSeconds),
    error,
  });
  return getRelayTest(db, commandId);
}

export async function getRelayTest(db: D1DatabaseLike, commandId: string) {
  await expireRelayTests(db);
  const row = await db.prepare(`SELECT id,transaction_type AS transactionType,status,duration_seconds AS durationSeconds,
      requested_at AS requestedAt,started_at AS startedAt,completed_at AS completedAt,expires_at AS expiresAt,error
    FROM pump_test_transactions WHERE id=?`).bind(commandId).first<Record<string, unknown>>();
  if (!row) return null;
  return {
    ...row,
    durationSeconds: Number(row.durationSeconds),
    requestedAt: utcTimestamp(row.requestedAt),
    startedAt: utcTimestamp(row.startedAt),
    completedAt: utcTimestamp(row.completedAt),
    expiresAt: utcTimestamp(row.expiresAt),
  };
}

export class RelayTestConflict extends Error {}

function utcTimestamp(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const source = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/u.test(value)
    ? `${value.replace(" ", "T")}Z`
    : value;
  const timestamp = new Date(source);
  return Number.isNaN(timestamp.getTime()) ? null : timestamp.toISOString();
}
