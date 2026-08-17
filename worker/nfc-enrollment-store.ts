import { ensureManagedEntityStore, recordManagedAudit } from "./managed-entities-store";
import { edgeRfidCredentialSnapshot, UNASSIGNED_RFID_OPERATOR_ID } from "./rfid-credentials-store";
import type { D1DatabaseLike } from "./user-store";

const initialized = new WeakSet<object>();

export async function ensureNfcEnrollmentStore(db: D1DatabaseLike) {
  const marker = db as unknown as object;
  if (initialized.has(marker)) return;
  await ensureManagedEntityStore(db);
  await db.batch([
    db.prepare(`CREATE TABLE IF NOT EXISTS nfc_enrollment_commands (
      id TEXT PRIMARY KEY,
      operator_id TEXT NOT NULL,
      actor_user_id TEXT NOT NULL,
      is_master INTEGER NOT NULL DEFAULT 0 CHECK(is_master IN (0,1)),
      previous_credential_id TEXT,
      replaced_master_credential_id TEXT,
      status TEXT NOT NULL CHECK(status IN ('pending','reading','completed','failed','cancelled','expired')),
      credential_id TEXT,
      error TEXT,
      requested_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      started_at TEXT,
      completed_at TEXT,
      expires_at TEXT NOT NULL
    )`),
    db.prepare("CREATE INDEX IF NOT EXISTS idx_nfc_enrollment_status ON nfc_enrollment_commands(status,requested_at)"),
    db.prepare(`CREATE TABLE IF NOT EXISTS nfc_identification_commands (
      id TEXT PRIMARY KEY,
      actor_user_id TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('pending','reading','completed','failed','cancelled','expired')),
      credential_id TEXT,
      operator_id TEXT,
      error TEXT,
      requested_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      started_at TEXT,
      completed_at TEXT,
      expires_at TEXT NOT NULL
    )`),
    db.prepare("CREATE INDEX IF NOT EXISTS idx_nfc_identification_status ON nfc_identification_commands(status,requested_at)"),
  ]);
  await ensureNfcEnrollmentColumns(db);
  initialized.add(marker);
}

async function ensureNfcEnrollmentColumns(db: D1DatabaseLike) {
  const columns = await db.prepare("PRAGMA table_info(nfc_enrollment_commands)").all<{ name: string }>();
  const missing = [
    ["is_master", "is_master INTEGER NOT NULL DEFAULT 0 CHECK(is_master IN (0,1))"],
    ["previous_credential_id", "previous_credential_id TEXT"],
    ["replaced_master_credential_id", "replaced_master_credential_id TEXT"],
  ] as const;
  for (const [name, definition] of missing) {
    if (!columns.results.some((column) => column.name === name)) {
      await db.prepare(`ALTER TABLE nfc_enrollment_commands ADD COLUMN ${definition}`).run();
    }
  }
}

export async function requestNfcEnrollment(
  db: D1DatabaseLike,
  operatorId: string | null,
  actorId: string,
  options: { isMaster?: boolean; replaceMasterCredentialId?: string } = {},
) {
  const operator = operatorId ? await db.prepare(`SELECT id,name,credential,credential_active AS credentialActive
    FROM managed_operators WHERE id=? AND active=1 AND archived_at IS NULL`).bind(operatorId)
    .first<{ id: string; name: string; credential: string; credentialActive: number }>() : null;
  if (operatorId && !operator) throw new NfcEnrollmentConflict("El operador no está disponible para enrolamiento.");
  const isMaster = options.isMaster === true;
  if (isMaster && !operator) throw new NfcEnrollmentConflict("La tarjeta maestra debe quedar asignada a un operador vigente.");
  const currentMaster = isMaster ? await db.prepare(`SELECT o.id,o.name,c.credential_id AS credential
    FROM managed_rfid_credentials c INNER JOIN managed_operators o ON o.id=c.operator_id
    WHERE c.credential_is_master=1 AND c.credential_active=1 AND o.archived_at IS NULL LIMIT 1`)
    .first<{ id: string; name: string; credential: string }>() : null;
  if (currentMaster && options.replaceMasterCredentialId !== currentMaster.credential) {
    throw new NfcMasterReplacementRequired({
      operatorId: currentMaster.id,
      operatorName: currentMaster.name,
      credentialId: currentMaster.credential,
    });
  }
  const id = `nfc-enroll-${crypto.randomUUID()}`;
  const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();
  const previousCredentialId = operator?.credentialActive === 1 && operator.credential !== "Sin enrolar"
    ? operator.credential
    : null;
  const storedOperatorId = operatorId ?? UNASSIGNED_RFID_OPERATOR_ID;
  const requestMetadata = {
    commandId: id,
    isMaster,
    previousCredentialId,
    replacedMasterCredentialId: currentMaster?.credential ?? null,
    masterReplacementApproved: Boolean(currentMaster),
  };
  await db.batch([
    db.prepare(`UPDATE nfc_enrollment_commands SET status='cancelled',completed_at=CURRENT_TIMESTAMP,error='Reemplazado por una nueva solicitud.'
      WHERE status IN ('pending','reading')`),
    db.prepare(`UPDATE nfc_identification_commands SET status='cancelled',completed_at=CURRENT_TIMESTAMP,error='Reemplazada por una solicitud de enrolamiento.'
      WHERE status IN ('pending','reading')`),
    db.prepare(`INSERT INTO nfc_enrollment_commands(
      id,operator_id,actor_user_id,is_master,previous_credential_id,replaced_master_credential_id,status,expires_at
    ) VALUES (?,?,?,?,?,?,'pending',?)`).bind(
      id, storedOperatorId, actorId, Number(isMaster), previousCredentialId, currentMaster?.credential ?? null, expiresAt,
    ),
    db.prepare(`INSERT INTO managed_entity_audit(actor_user_id,event,entity_type,entity_id,metadata)
      VALUES (?,'nfc_enrollment_requested','rfid_credentials',?,?)`).bind(actorId, operatorId ?? id, JSON.stringify(requestMetadata)),
    ...(currentMaster ? [db.prepare(`INSERT INTO managed_entity_audit(actor_user_id,event,entity_type,entity_id,metadata)
      VALUES (?,'nfc_master_replacement_approved','operators',?,?)`).bind(actorId, operatorId, JSON.stringify({
        commandId: id,
        previousOperatorId: currentMaster.id,
        previousCredentialId: currentMaster.credential,
      }))] : []),
  ]);
  return { id, operatorId, operatorName: operator?.name ?? "Sin asignar", isMaster, status: "pending", expiresAt };
}

export async function takeNfcEnrollmentCommand(db: D1DatabaseLike) {
  await db.prepare(`UPDATE nfc_enrollment_commands SET status='expired',completed_at=CURRENT_TIMESTAMP,error='La ventana de lectura venció.'
    WHERE status IN ('pending','reading') AND datetime(expires_at) <= datetime('now')`).run();
  const command = await db.prepare(`SELECT id,operator_id AS operatorId,is_master AS isMaster,
    previous_credential_id AS previousCredentialId,replaced_master_credential_id AS replacedMasterCredentialId,
    expires_at AS expiresAt
    FROM nfc_enrollment_commands WHERE status IN ('pending','reading') AND datetime(expires_at) > datetime('now')
    ORDER BY requested_at LIMIT 1`).first<Record<string, unknown>>();
  if (!command) return null;
  const unavailable = await db.prepare(`SELECT credential_id AS credential FROM managed_rfid_credentials
    WHERE credential_active=1 AND (operator_id IS NULL OR operator_id<>?)`).bind(String(command.operatorId)).all<{ credential: string }>();
  const unavailableCredentialIds = [...new Set(
    unavailable.results
      .map((row) => row.credential)
      .filter((credentialId) => /^nfc-[a-f0-9]{8,20}$/u.test(credentialId)),
  )];
  await db.prepare("UPDATE nfc_enrollment_commands SET status='reading',started_at=COALESCE(started_at,CURRENT_TIMESTAMP) WHERE id=?")
    .bind(String(command.id)).run();
  const deactivatedCredentialIds = [...new Set(
    [command.previousCredentialId, command.replacedMasterCredentialId]
      .filter((value): value is string => typeof value === "string" && value.length > 0),
  )];
  return {
    id: String(command.id),
    operatorId: String(command.operatorId),
    isMaster: command.isMaster === 1 || command.isMaster === true,
    operatorActive: command.operatorId !== UNASSIGNED_RFID_OPERATOR_ID,
    deactivatedCredentialIds,
    unavailableCredentialIds,
    expiresAt: String(command.expiresAt),
    status: "reading",
  };
}

export async function completeNfcEnrollment(
  db: D1DatabaseLike,
  commandId: string,
  result: { success: boolean; credentialId?: string; error?: string },
) {
  const command = await db.prepare(`SELECT id,operator_id AS operatorId,actor_user_id AS actorUserId,
    is_master AS isMaster,previous_credential_id AS previousCredentialId,
    replaced_master_credential_id AS replacedMasterCredentialId,status,credential_id AS credentialId
    FROM nfc_enrollment_commands WHERE id=?`).bind(commandId)
    .first<{ id: string; operatorId: string; actorUserId: string; isMaster: number; previousCredentialId: string | null; replacedMasterCredentialId: string | null; status: string; credentialId: string | null }>();
  const credentialId = result.credentialId?.trim();
  if (command?.status === "completed" && result.success && credentialId === command.credentialId) {
    return { completed: true, success: true, credentialId, isMaster: command.isMaster === 1 };
  }
  if (command?.status === "failed" && !result.success) {
    return { completed: true, success: false };
  }
  if (!command || !["pending", "reading"].includes(command.status)) {
    throw new NfcEnrollmentConflict("La ventana de enrolamiento ya no está activa.");
  }
  if (!result.success) {
    const error = (result.error ?? "No se pudo leer la credencial.").slice(0, 200);
    await db.prepare("UPDATE nfc_enrollment_commands SET status='failed',error=?,completed_at=CURRENT_TIMESTAMP WHERE id=?")
      .bind(error, commandId).run();
    return { completed: true, success: false };
  }
  if (!credentialId || !/^nfc-[a-f0-9]{8,20}$/u.test(credentialId)) {
    throw new NfcEnrollmentConflict("El validador entregó una credencial inválida.");
  }
  const assignedOperatorId = command.operatorId === UNASSIGNED_RFID_OPERATOR_ID ? null : command.operatorId;
  const owner = await db.prepare(`SELECT credential_id AS id FROM managed_rfid_credentials
    WHERE credential_id=? AND credential_active=1 AND (operator_id IS NULL OR operator_id<>?) LIMIT 1`)
    .bind(credentialId, assignedOperatorId).first<{ id: string }>();
  if (owner) throw new NfcEnrollmentConflict("La credencial ya pertenece a otro operador.");
  const isMaster = command.isMaster === 1;
  const deactivatedCredentialIds = [...new Set(
    [command.previousCredentialId, command.replacedMasterCredentialId]
      .filter((value): value is string => typeof value === "string" && value.length > 0 && value !== credentialId),
  )];
  await db.batch([
    db.prepare(`UPDATE managed_rfid_credentials SET operator_id=NULL,credential_active=0,updated_at=CURRENT_TIMESTAMP
      WHERE ?=1 AND credential_is_master=1 AND credential_active=1 AND credential_id<>?`)
      .bind(Number(isMaster), credentialId),
    db.prepare(`UPDATE managed_rfid_credentials SET operator_id=NULL,credential_active=0,updated_at=CURRENT_TIMESTAMP
      WHERE operator_id=? AND credential_id<>?`).bind(assignedOperatorId, credentialId),
    db.prepare(`UPDATE managed_operators SET credential_active=0,updated_at=CURRENT_TIMESTAMP
      WHERE ?=1 AND credential_is_master=1 AND credential_active=1 AND id<>?`).bind(Number(isMaster), command.operatorId),
    db.prepare(`INSERT INTO managed_rfid_credentials(
      credential_id,credential_active,credential_is_master,operator_id
    ) VALUES (?,1,?,?) ON CONFLICT(credential_id) DO UPDATE SET
      credential_active=1,credential_is_master=excluded.credential_is_master,
      operator_id=excluded.operator_id,updated_at=CURRENT_TIMESTAMP`)
      .bind(credentialId, Number(isMaster), assignedOperatorId),
    db.prepare(`UPDATE managed_operators SET credential=?,credential_active=1,credential_is_master=?,active=1,updated_at=CURRENT_TIMESTAMP
      WHERE id=?`).bind(credentialId, Number(isMaster), assignedOperatorId),
    db.prepare("UPDATE nfc_enrollment_commands SET status='completed',credential_id=?,error=NULL,completed_at=CURRENT_TIMESTAMP WHERE id=?")
      .bind(credentialId, commandId),
    db.prepare(`INSERT INTO managed_entity_audit(actor_user_id,event,entity_type,entity_id,metadata)
      VALUES (?,'nfc_enrollment_completed','rfid_credentials',?,?)`).bind(command.actorUserId, assignedOperatorId ?? credentialId, JSON.stringify({
        commandId,
        credentialId,
        operatorId: assignedOperatorId,
        isMaster,
        deactivatedCredentialIds,
      })),
  ]);
  return { completed: true, success: true, credentialId, isMaster };
}

export async function getNfcEnrollment(db: D1DatabaseLike, commandId: string, operatorId?: string) {
  const command = await db.prepare(`SELECT id,operator_id AS operatorId,is_master AS isMaster,status,credential_id AS credentialId,error,
    requested_at AS requestedAt,started_at AS startedAt,completed_at AS completedAt,expires_at AS expiresAt
    FROM nfc_enrollment_commands WHERE id=?`).bind(commandId).first<Record<string, unknown>>();
  if (!command || (operatorId && command.operatorId !== operatorId)) return null;
  return { ...command, isMaster: command.isMaster === 1 || command.isMaster === true };
}

export async function cancelNfcEnrollment(db: D1DatabaseLike, commandId: string, actorId: string) {
  const command = await db.prepare("SELECT operator_id AS operatorId,status FROM nfc_enrollment_commands WHERE id=?")
    .bind(commandId).first<{ operatorId: string; status: string }>();
  if (!command) return false;
  if (["pending", "reading"].includes(command.status)) {
    await db.prepare("UPDATE nfc_enrollment_commands SET status='cancelled',completed_at=CURRENT_TIMESTAMP,error='Cancelado por el usuario.' WHERE id=?")
      .bind(commandId).run();
    await recordManagedAudit(db, actorId, "nfc_enrollment_cancelled", "operators", command.operatorId, { commandId });
  }
  return true;
}

export async function requestNfcIdentification(db: D1DatabaseLike, actorId: string) {
  await db.prepare(`UPDATE nfc_enrollment_commands SET status='expired',completed_at=CURRENT_TIMESTAMP,error='La ventana de lectura venció.'
    WHERE status IN ('pending','reading') AND datetime(expires_at) <= datetime('now')`).run();
  const enrollment = await db.prepare("SELECT id FROM nfc_enrollment_commands WHERE status IN ('pending','reading') LIMIT 1")
    .first<{ id: string }>();
  if (enrollment) throw new NfcEnrollmentConflict("Hay un enrolamiento NFC en curso. Complétalo o cancélalo antes de identificar otra credencial.");
  const id = `nfc-identify-${crypto.randomUUID()}`;
  const expiresAt = new Date(Date.now() + 60 * 1000).toISOString();
  await db.batch([
    db.prepare(`UPDATE nfc_identification_commands SET status='cancelled',completed_at=CURRENT_TIMESTAMP,error='Reemplazada por una nueva consulta.'
      WHERE status IN ('pending','reading')`),
    db.prepare(`INSERT INTO nfc_identification_commands(id,actor_user_id,status,expires_at)
      VALUES (?,?,'pending',?)`).bind(id, actorId, expiresAt),
  ]);
  await recordManagedAudit(db, actorId, "nfc_identification_requested", "operators", id, { commandId: id });
  return { id, status: "pending", expiresAt };
}

export async function takeNfcIdentificationCommand(db: D1DatabaseLike) {
  await db.prepare(`UPDATE nfc_identification_commands SET status='expired',completed_at=CURRENT_TIMESTAMP,error='La ventana de identificación venció.'
    WHERE status IN ('pending','reading') AND datetime(expires_at) <= datetime('now')`).run();
  const command = await db.prepare(`SELECT id,expires_at AS expiresAt
    FROM nfc_identification_commands WHERE status IN ('pending','reading') AND datetime(expires_at) > datetime('now')
    ORDER BY requested_at LIMIT 1`).first<Record<string, string>>();
  if (!command) return null;
  await db.prepare("UPDATE nfc_identification_commands SET status='reading',started_at=COALESCE(started_at,CURRENT_TIMESTAMP) WHERE id=?")
    .bind(command.id).run();
  return { ...command, status: "reading", purpose: "identification" };
}

export async function completeNfcIdentification(
  db: D1DatabaseLike,
  commandId: string,
  result: { success: boolean; credentialId?: string; error?: string },
) {
  const command = await db.prepare(`SELECT id,actor_user_id AS actorUserId,status,credential_id AS credentialId
    FROM nfc_identification_commands WHERE id=?`).bind(commandId)
    .first<{ id: string; actorUserId: string; status: string; credentialId: string | null }>();
  const credentialId = result.credentialId?.trim();
  if (command?.status === "completed" && result.success && credentialId === command.credentialId) {
    return { completed: true, success: true, credentialId };
  }
  if (command?.status === "failed" && !result.success) return { completed: true, success: false };
  if (!command || !["pending", "reading"].includes(command.status)) {
    throw new NfcEnrollmentConflict("La ventana de identificación ya no está activa.");
  }
  if (!result.success) {
    const error = (result.error ?? "No se pudo leer la credencial.").slice(0, 200);
    await db.prepare("UPDATE nfc_identification_commands SET status='failed',error=?,completed_at=CURRENT_TIMESTAMP WHERE id=?")
      .bind(error, commandId).run();
    return { completed: true, success: false };
  }
  if (!credentialId || !/^nfc-[a-f0-9]{8,20}$/u.test(credentialId)) {
    throw new NfcEnrollmentConflict("El validador entregó una credencial inválida.");
  }
  const credential = await db.prepare(`SELECT credential_id AS credentialId,operator_id AS operatorId
    FROM managed_rfid_credentials WHERE credential_id=?`).bind(credentialId)
    .first<{ credentialId: string; operatorId: string | null }>();
  await db.prepare(`UPDATE nfc_identification_commands SET status='completed',credential_id=?,operator_id=?,error=NULL,completed_at=CURRENT_TIMESTAMP
    WHERE id=?`).bind(credentialId, credential?.operatorId ?? null, commandId).run();
  await recordManagedAudit(db, command.actorUserId, "nfc_identification_completed", "operators", credential?.operatorId ?? credentialId, {
    commandId, credentialId, registered: Boolean(credential),
  });
  return { completed: true, success: true, credentialId, registered: Boolean(credential) };
}

export async function getNfcIdentification(db: D1DatabaseLike, commandId: string) {
  await db.prepare(`UPDATE nfc_identification_commands SET status='expired',completed_at=CURRENT_TIMESTAMP,error='La ventana de identificación venció.'
    WHERE id=? AND status IN ('pending','reading') AND datetime(expires_at) <= datetime('now')`).bind(commandId).run();
  const command = await db.prepare(`SELECT c.id,c.status,c.credential_id AS credentialId,c.error,
    c.requested_at AS requestedAt,c.started_at AS startedAt,c.completed_at AS completedAt,c.expires_at AS expiresAt,
    r.credential_id AS registeredCredentialId,
    o.id AS operatorId,o.name AS operatorName,o.rut AS operatorRut,o.active AS operatorActive,
    o.credential_active AS credentialActive,o.credential_is_master AS credentialIsMaster,o.archived_at AS operatorArchivedAt
    FROM nfc_identification_commands c
    LEFT JOIN managed_rfid_credentials r ON r.credential_id=c.credential_id
    LEFT JOIN managed_operators o ON o.id=r.operator_id WHERE c.id=?`)
    .bind(commandId).first<Record<string, unknown>>();
  if (!command) return null;
  const operator = typeof command.operatorId === "string" ? {
    id: command.operatorId,
    name: command.operatorName,
    rut: command.operatorRut,
    active: command.operatorActive === 1 || command.operatorActive === true,
    credentialActive: command.credentialActive === 1 || command.credentialActive === true,
    credentialIsMaster: command.credentialIsMaster === 1 || command.credentialIsMaster === true,
    archivedAt: command.operatorArchivedAt,
  } : null;
  return {
    id: command.id,
    status: command.status,
    credentialId: command.credentialId,
    error: command.error,
    requestedAt: command.requestedAt,
    startedAt: command.startedAt,
    completedAt: command.completedAt,
    expiresAt: command.expiresAt,
    registered: typeof command.registeredCredentialId === "string",
    operator,
  };
}

export async function getEdgeRfidCredentialSnapshot(db: D1DatabaseLike) {
  await ensureNfcEnrollmentStore(db);
  return edgeRfidCredentialSnapshot(db);
}

export async function cancelNfcIdentification(db: D1DatabaseLike, commandId: string, actorId: string) {
  const command = await db.prepare("SELECT status FROM nfc_identification_commands WHERE id=?")
    .bind(commandId).first<{ status: string }>();
  if (!command) return false;
  if (["pending", "reading"].includes(command.status)) {
    await db.prepare("UPDATE nfc_identification_commands SET status='cancelled',completed_at=CURRENT_TIMESTAMP,error='Cancelada por el usuario.' WHERE id=?")
      .bind(commandId).run();
    await recordManagedAudit(db, actorId, "nfc_identification_cancelled", "operators", commandId, { commandId });
  }
  return true;
}

export class NfcEnrollmentConflict extends Error {}

export class NfcMasterReplacementRequired extends NfcEnrollmentConflict {
  readonly currentMaster: { operatorId: string; operatorName: string; credentialId: string };

  constructor(currentMaster: { operatorId: string; operatorName: string; credentialId: string }) {
    super("Ya existe una tarjeta maestra activa. Debes aprobar que la anterior se desactive antes de enrolar la nueva.");
    this.name = "NfcMasterReplacementRequired";
    this.currentMaster = currentMaster;
  }
}
