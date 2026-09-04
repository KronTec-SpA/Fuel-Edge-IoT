import {
  authenticatedUser,
  emailDigest,
  hashPassword,
  json,
  sameOrigin,
  type AuthEnvironment,
} from "./auth";
import {
  ALL_PERMISSIONS,
  audit,
  deleteUser,
  encryptEmail,
  findUserByDigest,
  findUserById,
  insertUser,
  listUsers,
  parsePermissions,
  publicUser,
  rolePermissions,
  setTemporaryPassword,
  updateUser,
  type Permission,
  type D1DatabaseLike,
  type UserRole,
} from "./user-store";
import { readJsonBody, RequestBodyError } from "./request-body";

const ROLES = ["administrator", "supervisor", "viewer"] as const;

export async function handleUsersRequest(request: Request, env: AuthEnvironment): Promise<Response | null> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith("/api/users")) return null;
  const actor = await authenticatedUser(request, env);
  if (!actor || !env.DB) return json({ error: "Sesión no válida." }, 401);
  if (!parsePermissions(actor.permissions).includes("manage_users")) {
    return json({ error: "No tienes permiso para administrar usuarios." }, 403);
  }
  const dataKey = env.AUTH_DATA_KEY;
  const emailPepper = env.AUTH_EMAIL_PEPPER;
  if (!dataKey || !emailPepper) return json({ error: "Protección de datos no configurada." }, 503);
  const protectedEnv = env as AuthEnvironment & { DB: D1DatabaseLike };

  if (request.method !== "GET" && !sameOrigin(request)) {
    return json({ error: "Solicitud no permitida." }, 403);
  }

  if (request.method === "GET" && url.pathname === "/api/users") {
    return json({ users: await listUsers(env.DB, dataKey) }, 200);
  }
  if (request.method === "POST" && url.pathname === "/api/users") {
    return createUserResponse(request, protectedEnv, actor.id, dataKey, emailPepper);
  }

  const match = url.pathname.match(/^\/api\/users\/([^/]+)(\/reset-password)?$/u);
  if (!match) return json({ error: "Ruta no encontrada." }, 404);
  const userId = decodeURIComponent(match[1]);
  if (request.method === "PATCH" && !match[2]) {
    return updateUserResponse(request, protectedEnv, actor.id, userId, dataKey);
  }
  if (request.method === "DELETE" && !match[2]) {
    return deleteUserResponse(protectedEnv, actor.id, actor.is_master === 1, userId);
  }
  if (request.method === "POST" && match[2] === "/reset-password") {
    return resetPasswordResponse(protectedEnv, actor.id, userId);
  }
  return json({ error: "Método no permitido." }, 405);
}

async function deleteUserResponse(
  env: AuthEnvironment & { DB: D1DatabaseLike },
  actorId: string,
  actorIsMaster: boolean,
  userId: string,
) {
  if (!actorIsMaster) return json({ error: "Sólo el usuario maestro puede eliminar cuentas definitivamente." }, 403);
  const existing = await findUserById(env.DB, userId);
  if (!existing) return json({ error: "Usuario no encontrado." }, 404);
  if (existing.id === actorId) return json({ error: "No puedes eliminar la cuenta con la que estás trabajando." }, 409);
  if (existing.is_master === 1) return json({ error: "La cuenta maestra no puede eliminarse." }, 409);
  await deleteUser(env.DB, userId);
  await audit(env.DB, "user_deleted", actorId, userId, { name: existing.name, role: existing.role });
  return json({ deleted: true }, 200);
}

async function createUserResponse(
  request: Request,
  env: AuthEnvironment & { DB: D1DatabaseLike },
  actorId: string,
  dataKey: string,
  emailPepper: string,
) {
  let body: { name?: unknown; email?: unknown; role?: unknown; permissions?: unknown };
  try {
    body = await readJsonBody(request, 16 * 1024);
  } catch (error) {
    return bodyError(error);
  }
  const name = typeof body.name === "string" ? body.name.trim() : "";
  const email = typeof body.email === "string"
    ? body.email.trim().toLocaleLowerCase("en-US").normalize("NFKC")
    : "";
  const role = validRole(body.role);
  if (name.length < 3 || name.length > 80 || !/^\S+@\S+\.\S+$/u.test(email) || !role) {
    return json({ error: "Revisa el nombre, correo y tipo de usuario." }, 400);
  }
  const digest = await emailDigest(email, emailPepper);
  if (await findUserByDigest(env.DB, digest)) {
    return json({ error: "Ya existe una cuenta con ese correo." }, 409);
  }
  const permissions = sanitizePermissions(role, body.permissions);
  const temporaryPassword = generateTemporaryPassword();
  const id = `usr-${crypto.randomUUID()}`;
  await insertUser(env.DB, {
    id,
    emailDigest: digest,
    emailEncrypted: await encryptEmail(email, dataKey),
    name,
    role,
    permissions,
    passwordHash: await hashPassword(temporaryPassword),
  });
  await audit(env.DB, "user_created", actorId, id, { role, permissions });
  const created = await findUserById(env.DB, id);
  return json({ user: created ? await publicUser(created, dataKey) : null, temporaryPassword }, 201);
}

async function updateUserResponse(
  request: Request,
  env: AuthEnvironment & { DB: D1DatabaseLike },
  actorId: string,
  userId: string,
  dataKey: string,
) {
  const existing = await findUserById(env.DB, userId);
  if (!existing) return json({ error: "Usuario no encontrado." }, 404);
  if (existing.is_master === 1) return json({ error: "La cuenta maestra se protege mediante recuperación física." }, 409);
  let body: { name?: unknown; role?: unknown; permissions?: unknown; active?: unknown };
  try {
    body = await readJsonBody(request, 16 * 1024);
  } catch (error) {
    return bodyError(error);
  }
  const role = validRole(body.role);
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!role || name.length < 3 || name.length > 80 || typeof body.active !== "boolean") {
    return json({ error: "Datos de usuario inválidos." }, 400);
  }
  const permissions = sanitizePermissions(role, body.permissions);
  await updateUser(env.DB, userId, { name, role, permissions, active: body.active });
  await audit(env.DB, "user_updated", actorId, userId, { role, permissions, active: body.active });
  const updated = await findUserById(env.DB, userId);
  return json({ user: updated ? await publicUser(updated, dataKey) : null }, 200);
}

async function resetPasswordResponse(
  env: AuthEnvironment & { DB: D1DatabaseLike },
  actorId: string,
  userId: string,
) {
  const user = await findUserById(env.DB, userId);
  if (!user) return json({ error: "Usuario no encontrado." }, 404);
  if (user.is_master === 1) return json({ error: "Usa la recuperación maestra o la consola física." }, 409);
  const temporaryPassword = generateTemporaryPassword();
  await setTemporaryPassword(env.DB, userId, await hashPassword(temporaryPassword));
  await audit(env.DB, "password_reset_by_admin", actorId, userId);
  return json({ temporaryPassword }, 200);
}

function validRole(value: unknown): UserRole | null {
  return typeof value === "string" && ROLES.includes(value as typeof ROLES[number])
    ? value as UserRole
    : null;
}

function sanitizePermissions(role: UserRole, value: unknown): Permission[] {
  const maximum = rolePermissions(role);
  if (!Array.isArray(value)) return maximum;
  const requested = value.filter((permission): permission is Permission =>
    typeof permission === "string" && ALL_PERMISSIONS.includes(permission as Permission));
  const allowed = maximum.filter((permission) => requested.includes(permission));
  return allowed.includes("view_dashboard") ? allowed : ["view_dashboard", ...allowed];
}

function generateTemporaryPassword() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%";
  const random = crypto.getRandomValues(new Uint8Array(14));
  return `Aa1!${Array.from(random, (byte) => alphabet[byte % alphabet.length]).join("")}`;
}

function bodyError(error: unknown) {
  if (error instanceof RequestBodyError) return json({ error: error.message }, error.status);
  return json({ error: "Solicitud inválida." }, 400);
}
