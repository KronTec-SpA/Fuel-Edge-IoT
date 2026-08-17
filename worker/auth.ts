import {
  audit,
  changePassword,
  ensureUserStore,
  findUserByDigest,
  findUserById,
  parsePermissions,
  recordLogin,
  type StoredUser,
  type UserStoreEnvironment,
} from "./user-store";
import { readJsonBody, RequestBodyError } from "./request-body";

const COOKIE_NAME = "fuel_edge_session";
const DEFAULT_SESSION_TTL_SECONDS = 8 * 60 * 60;
const MAX_LOGIN_BODY_BYTES = 4096;
const PBKDF2_PREFIX = "pbkdf2_sha256";

export interface AuthEnvironment extends UserStoreEnvironment {
  AUTH_ADMIN_EMAIL_DIGEST?: string;
  AUTH_ADMIN_PASSWORD_HASH?: string;
  AUTH_EMAIL_PEPPER?: string;
  AUTH_SESSION_SECRET?: string;
  AUTH_SESSION_TTL_SECONDS?: string;
  AUTH_DATA_KEY?: string;
  AUTH_RECOVERY_PEPPER?: string;
  AUTH_ADMIN_RECOVERY_DIGEST?: string;
  AUTH_BOOTSTRAP_VERSION?: string;
}

type SessionPayload = {
  sub: string;
  iat: number;
  exp: number;
  jti: string;
};

type LoginAttempt = {
  failures: number;
  blockedUntil: number;
  touchedAt: number;
};

const attempts = new Map<string, LoginAttempt>();
const encoder = new TextEncoder();
const decoder = new TextDecoder();

export async function handleAuthRequest(
  request: Request,
  env: AuthEnvironment,
): Promise<Response | null> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith("/api/auth/")) return null;

  if (request.method === "GET" && url.pathname === "/api/auth/session") {
    return sessionResponse(request, env);
  }
  if (request.method === "POST" && url.pathname === "/api/auth/login") {
    return loginResponse(request, env);
  }
  if (request.method === "POST" && url.pathname === "/api/auth/logout") {
    return logoutResponse(request);
  }
  if (request.method === "POST" && url.pathname === "/api/auth/change-password") {
    return changePasswordResponse(request, env);
  }
  if (request.method === "POST" && url.pathname === "/api/auth/recover") {
    return recoveryResponse(request, env);
  }
  return json({ error: "Ruta no encontrada." }, 404);
}

async function sessionResponse(request: Request, env: AuthEnvironment) {
  const config = readConfig(env);
  if (!config) return unavailable();
  await ensureUserStore(runtimeStoreEnv(env));
  const token = readCookie(request.headers.get("cookie"), COOKIE_NAME);
  const payload = token ? await verifySession(token, config.sessionSecret) : null;
  if (!payload) {
    return json({ authenticated: false }, 401);
  }
  if (env.DB) {
    const user = await findUserById(env.DB, payload.sub);
    if (!user || user.active !== 1) return json({ authenticated: false }, 401);
    return json({ authenticated: true, user: clientUser(user) }, 200);
  }
  if (payload.sub !== config.emailDigest) return json({ authenticated: false }, 401);
  return json({ authenticated: true, user: masterUser() }, 200);
}

async function loginResponse(request: Request, env: AuthEnvironment) {
  if (!sameOrigin(request)) return json({ error: "Solicitud no permitida." }, 403);
  const config = readConfig(env);
  if (!config) return unavailable();
  await ensureUserStore(runtimeStoreEnv(env));

  let payload: { email?: unknown; password?: unknown };
  try {
    payload = await readJsonBody(request, MAX_LOGIN_BODY_BYTES);
  } catch (error) {
    return bodyError(error);
  }
  if (typeof payload.email !== "string" || typeof payload.password !== "string") {
    return json({ error: "Correo o contraseña incorrectos." }, 401);
  }

  const email = payload.email.trim().toLocaleLowerCase("en-US").normalize("NFKC");
  const remoteKey = request.headers.get("cf-connecting-ip")
    ?? request.headers.get("x-real-ip")
    ?? request.headers.get("x-forwarded-for")?.split(",").at(-1)?.trim()
    ?? "local";
  const attemptKey = `${remoteKey}:${await emailDigest(email, config.emailPepper)}`;
  const remoteAttemptKey = `remote:${remoteKey}`;
  const retryAfter = Math.max(blockedSeconds(attemptKey), blockedSeconds(remoteAttemptKey));
  if (retryAfter > 0) {
    return json(
      { error: "Demasiados intentos. Espera antes de volver a intentar." },
      429,
      { "Retry-After": String(retryAfter) },
    );
  }

  const suppliedEmailDigest = await emailDigest(email, config.emailPepper);
  const storedUser = env.DB ? await findUserByDigest(env.DB, suppliedEmailDigest) : null;
  const emailMatches = storedUser
    ? constantTimeEqual(suppliedEmailDigest, storedUser.email_digest)
    : constantTimeEqual(suppliedEmailDigest, config.emailDigest);
  const passwordMatches = await verifyPassword(
    payload.password,
    storedUser?.password_hash ?? config.passwordHash,
  );
  if (!emailMatches || !passwordMatches || (storedUser ? storedUser.active !== 1 : suppliedEmailDigest !== config.emailDigest)) {
    recordFailure(attemptKey);
    recordFailure(remoteAttemptKey);
    return json({ error: "Correo o contraseña incorrectos." }, 401);
  }

  attempts.delete(attemptKey);
  attempts.delete(remoteAttemptKey);
  const now = Math.floor(Date.now() / 1000);
  const token = await signSession({
    sub: storedUser?.id ?? config.emailDigest,
    iat: now,
    exp: now + config.sessionTtlSeconds,
    jti: randomBase64Url(18),
  }, config.sessionSecret);
  if (storedUser && env.DB) {
    await recordLogin(env.DB, storedUser.id);
    await audit(env.DB, "login_succeeded", storedUser.id, storedUser.id);
  }
  return json(
    { authenticated: true, user: storedUser ? clientUser(storedUser) : masterUser() },
    200,
    { "Set-Cookie": sessionCookie(request, token, config.sessionTtlSeconds) },
  );
}

export async function authenticatedUser(request: Request, env: AuthEnvironment): Promise<StoredUser | null> {
  const config = readConfig(env);
  if (!config || !env.DB) return null;
  await ensureUserStore(runtimeStoreEnv(env));
  const token = readCookie(request.headers.get("cookie"), COOKIE_NAME);
  const payload = token ? await verifySession(token, config.sessionSecret) : null;
  if (!payload) return null;
  const user = await findUserById(env.DB, payload.sub);
  return user?.active === 1 ? user : null;
}

export async function confirmAdministratorPassword(
  request: Request,
  env: AuthEnvironment,
  password: string,
): Promise<{ user: StoredUser } | { response: Response }> {
  const user = await authenticatedUser(request, env);
  if (!user || !env.DB) return { response: json({ error: "Sesión no válida." }, 401) };
  if (user.role !== "master" && user.role !== "administrator") {
    return { response: json({ error: "Esta operación requiere una cuenta administradora." }, 403) };
  }

  const remoteKey = request.headers.get("cf-connecting-ip")
    ?? request.headers.get("x-real-ip")
    ?? request.headers.get("x-forwarded-for")?.split(",").at(-1)?.trim()
    ?? "local";
  const attemptKey = `administrator-confirmation:${remoteKey}:${user.id}`;
  const retryAfter = blockedSeconds(attemptKey);
  if (retryAfter > 0) {
    return {
      response: json(
        { error: "Demasiados intentos. Espera antes de volver a intentar." },
        429,
        { "Retry-After": String(retryAfter) },
      ),
    };
  }

  if (!await verifyPassword(password, user.password_hash)) {
    recordFailure(attemptKey);
    await audit(env.DB, "administrator_confirmation_failed", user.id, user.id);
    return { response: json({ error: "La clave de administrador no es correcta." }, 401) };
  }
  attempts.delete(attemptKey);
  return { user };
}

async function changePasswordResponse(request: Request, env: AuthEnvironment) {
  if (!sameOrigin(request)) return json({ error: "Solicitud no permitida." }, 403);
  const user = await authenticatedUser(request, env);
  if (!user || !env.DB) return json({ error: "Sesión no válida." }, 401);
  let body: { newPassword?: unknown };
  try {
    body = await readJsonBody(request, 4096);
  } catch (error) {
    return bodyError(error);
  }
  if (typeof body.newPassword !== "string" || !strongPassword(body.newPassword)) {
    return json({ error: "Usa al menos 12 caracteres, mayúscula, minúscula, número y símbolo." }, 400);
  }
  await changePassword(env.DB, user.id, await hashPassword(body.newPassword));
  await audit(env.DB, "password_changed", user.id, user.id);
  return json({ changed: true }, 200);
}

async function recoveryResponse(request: Request, env: AuthEnvironment) {
  if (!sameOrigin(request)) return json({ error: "Solicitud no permitida." }, 403);
  const config = readConfig(env);
  if (!config || !env.DB || !config.recoveryPepper || !config.recoveryDigest) return unavailable();
  await ensureUserStore(runtimeStoreEnv(env));
  let body: { email?: unknown; recoveryCode?: unknown; newPassword?: unknown };
  try {
    body = await readJsonBody(request, 8192);
  } catch (error) {
    return bodyError(error);
  }
  if (typeof body.email !== "string" || typeof body.recoveryCode !== "string" || typeof body.newPassword !== "string") {
    return json({ error: "Datos de recuperación incorrectos." }, 400);
  }
  if (!strongPassword(body.newPassword)) {
    return json({ error: "La nueva clave debe tener 12 caracteres, mayúscula, minúscula, número y símbolo." }, 400);
  }
  const normalizedEmail = body.email.trim().toLocaleLowerCase("en-US").normalize("NFKC");
  const suppliedEmail = await emailDigest(normalizedEmail, config.emailPepper);
  const suppliedRecovery = await recoveryDigest(body.recoveryCode, config.recoveryPepper);
  if (!constantTimeEqual(suppliedEmail, config.emailDigest) || !constantTimeEqual(suppliedRecovery, config.recoveryDigest)) {
    return json({ error: "Datos de recuperación incorrectos." }, 401);
  }
  const master = await findUserByDigest(env.DB, config.emailDigest);
  if (!master) return unavailable();
  await changePassword(env.DB, master.id, await hashPassword(body.newPassword));
  await audit(env.DB, "master_password_recovered", null, master.id);
  return json({ recovered: true }, 200, { "Set-Cookie": expiredSessionCookie(request) });
}

function logoutResponse(request: Request) {
  if (!sameOrigin(request)) return json({ error: "Solicitud no permitida." }, 403);
  return json(
    { authenticated: false },
    200,
    { "Set-Cookie": expiredSessionCookie(request) },
  );
}

function readConfig(env: AuthEnvironment) {
  const emailDigestValue = secret(env, "AUTH_ADMIN_EMAIL_DIGEST");
  const passwordHash = secret(env, "AUTH_ADMIN_PASSWORD_HASH");
  const emailPepper = secret(env, "AUTH_EMAIL_PEPPER");
  const sessionSecret = secret(env, "AUTH_SESSION_SECRET");
  if (!emailDigestValue || !passwordHash || !emailPepper || !sessionSecret) return null;
  const ttl = Number(secret(env, "AUTH_SESSION_TTL_SECONDS") ?? DEFAULT_SESSION_TTL_SECONDS);
  return {
    emailDigest: emailDigestValue,
    passwordHash,
    emailPepper,
    sessionSecret,
    dataKey: secret(env, "AUTH_DATA_KEY") ?? "",
    recoveryPepper: secret(env, "AUTH_RECOVERY_PEPPER"),
    recoveryDigest: secret(env, "AUTH_ADMIN_RECOVERY_DIGEST"),
    sessionTtlSeconds: Number.isInteger(ttl) && ttl >= 900 && ttl <= 86400
      ? ttl
      : DEFAULT_SESSION_TTL_SECONDS,
  };
}

function runtimeStoreEnv(env: AuthEnvironment): UserStoreEnvironment {
  return {
    DB: env.DB,
    AUTH_ADMIN_EMAIL_DIGEST: secret(env, "AUTH_ADMIN_EMAIL_DIGEST"),
    AUTH_ADMIN_PASSWORD_HASH: secret(env, "AUTH_ADMIN_PASSWORD_HASH"),
    AUTH_BOOTSTRAP_VERSION: secret(env, "AUTH_BOOTSTRAP_VERSION"),
    AUTH_DATA_KEY: secret(env, "AUTH_DATA_KEY"),
  };
}

type AuthSecretKey = Exclude<keyof AuthEnvironment, "DB">;

function secret(env: AuthEnvironment, key: AuthSecretKey) {
  const binding = env[key];
  if (typeof binding === "string" && binding) return binding;
  try {
    return typeof process !== "undefined" ? process.env[key] : undefined;
  } catch {
    return undefined;
  }
}

export async function verifyPassword(password: string, encoded: string) {
  const [prefix, iterationsValue, saltValue, expectedValue] = encoded.split("$");
  const iterations = Number(iterationsValue);
  if (
    prefix !== PBKDF2_PREFIX
    || !Number.isInteger(iterations)
    || iterations < 310000
    || iterations > 1000000
    || !saltValue
    || !expectedValue
  ) return false;
  try {
    const key = await crypto.subtle.importKey(
      "raw",
      encoder.encode(password.normalize("NFKC")),
      "PBKDF2",
      false,
      ["deriveBits"],
    );
    const expected = fromBase64Url(expectedValue);
    const derived = new Uint8Array(await crypto.subtle.deriveBits(
      { name: "PBKDF2", hash: "SHA-256", iterations, salt: fromBase64Url(saltValue) },
      key,
      expected.byteLength * 8,
    ));
    return constantTimeEqualBytes(derived, expected);
  } catch {
    return false;
  }
}

export async function hashPassword(password: string) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iterations = 600000;
  const key = await crypto.subtle.importKey(
    "raw", encoder.encode(password.normalize("NFKC")), "PBKDF2", false, ["deriveBits"],
  );
  const derived = new Uint8Array(await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", iterations, salt }, key, 256,
  ));
  return `${PBKDF2_PREFIX}$${iterations}$${toBase64Url(salt)}$${toBase64Url(derived)}`;
}

export function strongPassword(password: string) {
  return password.length >= 12
    && /[a-z]/u.test(password)
    && /[A-Z]/u.test(password)
    && /\d/u.test(password)
    && /[^A-Za-z0-9]/u.test(password);
}

export async function emailDigest(email: string, pepper: string) {
  const key = await crypto.subtle.importKey(
    "raw",
    fromBase64Url(pepper),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return toBase64Url(new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(email))));
}

async function recoveryDigest(code: string, pepper: string) {
  return emailDigest(code.replaceAll("-", "").trim().toUpperCase(), pepper);
}

async function signSession(payload: SessionPayload, secretValue: string) {
  const encodedPayload = toBase64Url(encoder.encode(JSON.stringify(payload)));
  const signature = await hmac(encodedPayload, secretValue);
  return `${encodedPayload}.${signature}`;
}

async function verifySession(token: string, secretValue: string): Promise<SessionPayload | null> {
  const [encodedPayload, suppliedSignature, extra] = token.split(".");
  if (!encodedPayload || !suppliedSignature || extra) return null;
  const expectedSignature = await hmac(encodedPayload, secretValue);
  if (!constantTimeEqual(suppliedSignature, expectedSignature)) return null;
  try {
    const payload = JSON.parse(decoder.decode(fromBase64Url(encodedPayload))) as Partial<SessionPayload>;
    const now = Math.floor(Date.now() / 1000);
    if (
      typeof payload.sub !== "string"
      || typeof payload.iat !== "number"
      || typeof payload.exp !== "number"
      || typeof payload.jti !== "string"
      || payload.iat > now + 60
      || payload.exp <= now
      || payload.exp - payload.iat > 86400
    ) return null;
    return payload as SessionPayload;
  } catch {
    return null;
  }
}

async function hmac(value: string, secretValue: string) {
  const key = await crypto.subtle.importKey(
    "raw",
    fromBase64Url(secretValue),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return toBase64Url(new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(value))));
}

export function sameOrigin(request: Request) {
  const origin = request.headers.get("origin");
  if (!origin) return true;
  try {
    const requestUrl = new URL(request.url);
    const forwardedHost = request.headers.get("x-forwarded-host")?.split(",")[0]?.trim();
    const forwardedProtocol = request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim();
    const expected = `${forwardedProtocol ?? requestUrl.protocol.replace(":", "")}://${forwardedHost ?? requestUrl.host}`;
    return new URL(origin).origin === expected;
  } catch {
    return false;
  }
}

function bodyError(error: unknown) {
  if (error instanceof RequestBodyError) return json({ error: error.message }, error.status);
  return json({ error: "Solicitud inválida." }, 400);
}

function sessionCookie(request: Request, token: string, maxAge: number) {
  return [
    `${COOKIE_NAME}=${token}`,
    "Path=/",
    `Max-Age=${maxAge}`,
    "HttpOnly",
    "SameSite=Strict",
    isSecureRequest(request) ? "Secure" : "",
  ].filter(Boolean).join("; ");
}

function expiredSessionCookie(request: Request) {
  return [
    `${COOKIE_NAME}=`,
    "Path=/",
    "Max-Age=0",
    "HttpOnly",
    "SameSite=Strict",
    isSecureRequest(request) ? "Secure" : "",
  ].filter(Boolean).join("; ");
}

function isSecureRequest(request: Request) {
  const forwarded = request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim();
  return forwarded === "https" || new URL(request.url).protocol === "https:";
}

function readCookie(header: string | null, name: string) {
  if (!header) return null;
  for (const part of header.split(";")) {
    const [key, ...value] = part.trim().split("=");
    if (key === name) return value.join("=");
  }
  return null;
}

function blockedSeconds(key: string) {
  pruneAttempts();
  const attempt = attempts.get(key);
  if (!attempt || attempt.blockedUntil <= Date.now()) return 0;
  return Math.max(1, Math.ceil((attempt.blockedUntil - Date.now()) / 1000));
}

function recordFailure(key: string) {
  const current = attempts.get(key) ?? { failures: 0, blockedUntil: 0, touchedAt: 0 };
  const failures = current.failures + 1;
  const delay = failures >= 5 ? Math.min(15 * 60_000, 60_000 * 2 ** (failures - 5)) : 0;
  attempts.set(key, { failures, blockedUntil: Date.now() + delay, touchedAt: Date.now() });
}

function pruneAttempts() {
  const cutoff = Date.now() - 24 * 60 * 60_000;
  for (const [key, attempt] of attempts) {
    if (attempt.touchedAt < cutoff) attempts.delete(key);
  }
}

function masterUser() {
  return { name: "Pedro Coloma", role: "Usuario maestro", roleCode: "master", permissions: ["view_dashboard", "view_transactions", "manage_alerts", "manage_operators", "manage_equipment", "manage_associations", "manage_users", "manage_system"], mustChangePassword: false };
}

function clientUser(user: StoredUser) {
  const labels: Record<string, string> = {
    master: "Usuario maestro",
    administrator: "Administrador",
    supervisor: "Supervisor operacional",
    viewer: "Consulta",
  };
  return {
    name: user.name,
    role: labels[user.role] ?? user.role,
    roleCode: user.role,
    permissions: parsePermissions(user.permissions),
    mustChangePassword: user.must_change_password === 1,
  };
}

function unavailable() {
  return json({ error: "El acceso seguro aún no está configurado." }, 503);
}

export function json(body: object, status: number, extraHeaders: Record<string, string> = {}) {
  return Response.json(body, {
    status,
    headers: {
      "Cache-Control": "no-store",
      "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
      ...extraHeaders,
    },
  });
}

function randomBase64Url(length: number) {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return toBase64Url(bytes);
}

function toBase64Url(bytes: Uint8Array) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function fromBase64Url(value: string) {
  const normalized = value.replaceAll("-", "+").replaceAll("_", "/");
  const padding = "=".repeat((4 - normalized.length % 4) % 4);
  const binary = atob(normalized + padding);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function constantTimeEqual(left: string, right: string) {
  return constantTimeEqualBytes(encoder.encode(left), encoder.encode(right));
}

function constantTimeEqualBytes(left: Uint8Array, right: Uint8Array) {
  let difference = left.byteLength ^ right.byteLength;
  const length = Math.max(left.byteLength, right.byteLength);
  for (let index = 0; index < length; index += 1) {
    difference |= (left[index % Math.max(1, left.byteLength)] ?? 0)
      ^ (right[index % Math.max(1, right.byteLength)] ?? 0);
  }
  return difference === 0;
}
