export const ALL_PERMISSIONS = [
  "view_dashboard",
  "view_transactions",
  "manage_alerts",
  "manage_operators",
  "manage_equipment",
  "manage_associations",
  "manage_users",
  "manage_system",
] as const;

export type Permission = typeof ALL_PERMISSIONS[number];
export type UserRole = "master" | "administrator" | "supervisor" | "viewer";

export type StoredUser = {
  id: string;
  email_digest: string;
  email_encrypted: string | null;
  name: string;
  role: UserRole;
  permissions: string;
  password_hash: string;
  active: number;
  must_change_password: number;
  is_master: number;
  bootstrap_version: string | null;
  created_at: string;
  updated_at: string;
  last_login_at: string | null;
};

export type PublicUser = {
  id: string;
  email: string | null;
  name: string;
  role: UserRole;
  permissions: Permission[];
  active: boolean;
  mustChangePassword: boolean;
  isMaster: boolean;
  createdAt: string;
  lastLoginAt: string | null;
};

export interface D1PreparedLike {
  bind(...values: unknown[]): D1PreparedLike;
  run(): Promise<unknown>;
  first<T>(): Promise<T | null>;
  all<T>(): Promise<{ results: T[] }>;
}

export interface D1DatabaseLike {
  prepare(query: string): D1PreparedLike;
  batch(statements: D1PreparedLike[]): Promise<unknown>;
}

export interface UserStoreEnvironment {
  DB?: D1DatabaseLike;
  AUTH_ADMIN_EMAIL_DIGEST?: string;
  AUTH_ADMIN_PASSWORD_HASH?: string;
  AUTH_BOOTSTRAP_VERSION?: string;
  AUTH_DATA_KEY?: string;
}

const initialized = new WeakSet<object>();
const initializing = new WeakMap<object, Promise<void>>();

export function rolePermissions(role: UserRole): Permission[] {
  if (role === "master" || role === "administrator") return [...ALL_PERMISSIONS];
  if (role === "supervisor") {
    return [
      "view_dashboard",
      "view_transactions",
      "manage_alerts",
      "manage_operators",
      "manage_equipment",
      "manage_associations",
    ];
  }
  return ["view_dashboard", "view_transactions"];
}

export function parsePermissions(value: string): Permission[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is Permission =>
      typeof item === "string" && ALL_PERMISSIONS.includes(item as Permission));
  } catch {
    return [];
  }
}

export async function ensureUserStore(env: UserStoreEnvironment) {
  if (!env.DB) return false;
  const marker = env.DB as unknown as object;
  if (!initialized.has(marker)) {
    let pending = initializing.get(marker);
    if (!pending) {
      pending = (async () => {
        await env.DB!.batch([
          env.DB!.prepare(`CREATE TABLE IF NOT EXISTS web_users (
        id TEXT PRIMARY KEY,
        email_digest TEXT NOT NULL,
        email_encrypted TEXT,
        name TEXT NOT NULL,
        role TEXT NOT NULL CHECK (role IN ('master','administrator','supervisor','viewer')),
        permissions TEXT NOT NULL,
        password_hash TEXT NOT NULL,
        active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
        must_change_password INTEGER NOT NULL DEFAULT 1 CHECK (must_change_password IN (0,1)),
        is_master INTEGER NOT NULL DEFAULT 0 CHECK (is_master IN (0,1)),
        bootstrap_version TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        last_login_at TEXT
      )`),
          env.DB!.prepare("CREATE UNIQUE INDEX IF NOT EXISTS idx_web_users_email_digest ON web_users(email_digest)"),
          env.DB!.prepare(`CREATE TABLE IF NOT EXISTS web_access_audit (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        actor_user_id TEXT,
        event TEXT NOT NULL,
        target_user_id TEXT,
        occurred_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        metadata TEXT NOT NULL DEFAULT '{}'
      )`),
          env.DB!.prepare("CREATE INDEX IF NOT EXISTS idx_web_access_audit_occurred_at ON web_access_audit(occurred_at)"),
        ]);
        await env.DB!.prepare("PRAGMA optimize").run();
        await bootstrapMaster(env);
        initialized.add(marker);
      })().finally(() => initializing.delete(marker));
      initializing.set(marker, pending);
    }
    await pending;
  }
  return true;
}

async function bootstrapMaster(env: UserStoreEnvironment) {
  if (!env.DB || !env.AUTH_ADMIN_EMAIL_DIGEST || !env.AUTH_ADMIN_PASSWORD_HASH || !env.AUTH_BOOTSTRAP_VERSION) return;
  const id = "usr-master";
  const permissions = JSON.stringify(rolePermissions("master"));
  await env.DB.prepare(`INSERT INTO web_users(
      id, email_digest, email_encrypted, name, role, permissions, password_hash,
      active, must_change_password, is_master, bootstrap_version
    ) VALUES (?, ?, NULL, 'Pedro Coloma', 'master', ?, ?, 1, 0, 1, ?)
    ON CONFLICT(id) DO UPDATE SET
      email_digest = CASE WHEN web_users.bootstrap_version IS NOT excluded.bootstrap_version THEN excluded.email_digest ELSE web_users.email_digest END,
      password_hash = CASE WHEN web_users.bootstrap_version IS NOT excluded.bootstrap_version THEN excluded.password_hash ELSE web_users.password_hash END,
      active = 1,
      must_change_password = CASE WHEN web_users.bootstrap_version IS NOT excluded.bootstrap_version THEN 0 ELSE web_users.must_change_password END,
      bootstrap_version = excluded.bootstrap_version,
      updated_at = CASE WHEN web_users.bootstrap_version IS NOT excluded.bootstrap_version THEN CURRENT_TIMESTAMP ELSE web_users.updated_at END`)
    .bind(id, env.AUTH_ADMIN_EMAIL_DIGEST, permissions, env.AUTH_ADMIN_PASSWORD_HASH, env.AUTH_BOOTSTRAP_VERSION)
    .run();
}

export async function findUserByDigest(db: D1DatabaseLike, digest: string) {
  return db.prepare("SELECT * FROM web_users WHERE email_digest = ? LIMIT 1")
    .bind(digest).first<StoredUser>();
}

export async function findUserById(db: D1DatabaseLike, id: string) {
  return db.prepare("SELECT * FROM web_users WHERE id = ? LIMIT 1")
    .bind(id).first<StoredUser>();
}

export async function listUsers(db: D1DatabaseLike, dataKey: string): Promise<PublicUser[]> {
  const result = await db.prepare("SELECT * FROM web_users ORDER BY is_master DESC, name COLLATE NOCASE")
    .all<StoredUser>();
  return Promise.all(result.results.map((user) => publicUser(user, dataKey)));
}

export async function publicUser(user: StoredUser, dataKey: string): Promise<PublicUser> {
  return {
    id: user.id,
    email: user.email_encrypted ? await decryptEmail(user.email_encrypted, dataKey) : null,
    name: user.name,
    role: user.role,
    permissions: parsePermissions(user.permissions),
    active: user.active === 1,
    mustChangePassword: user.must_change_password === 1,
    isMaster: user.is_master === 1,
    createdAt: user.created_at,
    lastLoginAt: user.last_login_at,
  };
}

export async function insertUser(db: D1DatabaseLike, values: {
  id: string;
  emailDigest: string;
  emailEncrypted: string;
  name: string;
  role: UserRole;
  permissions: Permission[];
  passwordHash: string;
}) {
  return db.prepare(`INSERT INTO web_users(
      id, email_digest, email_encrypted, name, role, permissions, password_hash,
      active, must_change_password, is_master
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, 1, 0)`)
    .bind(
      values.id,
      values.emailDigest,
      values.emailEncrypted,
      values.name,
      values.role,
      JSON.stringify(values.permissions),
      values.passwordHash,
    ).run();
}

export async function updateUser(db: D1DatabaseLike, id: string, values: {
  name: string;
  role: UserRole;
  permissions: Permission[];
  active: boolean;
}) {
  return db.prepare(`UPDATE web_users SET
      name = ?, role = ?, permissions = ?, active = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ? AND is_master = 0`)
    .bind(values.name, values.role, JSON.stringify(values.permissions), Number(values.active), id)
    .run();
}

export async function deleteUser(db: D1DatabaseLike, id: string) {
  return db.prepare("DELETE FROM web_users WHERE id = ? AND is_master = 0")
    .bind(id).run();
}

export async function setTemporaryPassword(db: D1DatabaseLike, id: string, passwordHash: string) {
  return db.prepare(`UPDATE web_users SET
      password_hash = ?, must_change_password = 1, updated_at = CURRENT_TIMESTAMP
    WHERE id = ? AND is_master = 0`)
    .bind(passwordHash, id).run();
}

export async function changePassword(db: D1DatabaseLike, id: string, passwordHash: string) {
  return db.prepare(`UPDATE web_users SET
      password_hash = ?, must_change_password = 0, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?`)
    .bind(passwordHash, id).run();
}

export async function recordLogin(db: D1DatabaseLike, id: string) {
  await db.prepare("UPDATE web_users SET last_login_at = CURRENT_TIMESTAMP WHERE id = ?")
    .bind(id).run();
}

export async function audit(db: D1DatabaseLike, event: string, actor: string | null, target: string | null, metadata: object = {}) {
  await db.prepare(`INSERT INTO web_access_audit(actor_user_id, event, target_user_id, metadata)
    VALUES (?, ?, ?, ?)`)
    .bind(actor, event, target, JSON.stringify(metadata)).run();
}

export async function encryptEmail(email: string, dataKey: string) {
  const key = await crypto.subtle.importKey("raw", fromBase64Url(dataKey), "AES-GCM", false, ["encrypt"]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt(
    { name: "AES-GCM", iv }, key, new TextEncoder().encode(email),
  ));
  return `${toBase64Url(iv)}.${toBase64Url(ciphertext)}`;
}

async function decryptEmail(value: string, dataKey: string) {
  const [ivValue, ciphertextValue] = value.split(".");
  if (!ivValue || !ciphertextValue) return null;
  try {
    const key = await crypto.subtle.importKey("raw", fromBase64Url(dataKey), "AES-GCM", false, ["decrypt"]);
    const plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: fromBase64Url(ivValue) }, key, fromBase64Url(ciphertextValue),
    );
    return new TextDecoder().decode(plaintext);
  } catch {
    return null;
  }
}

function toBase64Url(bytes: Uint8Array) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function fromBase64Url(value: string) {
  const normalized = value.replaceAll("-", "+").replaceAll("_", "/");
  const padding = "=".repeat((4 - normalized.length % 4) % 4);
  return Uint8Array.from(atob(normalized + padding), (character) => character.charCodeAt(0));
}
