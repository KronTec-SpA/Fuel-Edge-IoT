import { ensureManagedEntityStore } from "./managed-entities-store";
import type { D1DatabaseLike } from "./user-store";

export const UNASSIGNED_RFID_OPERATOR_ID = "__rfid_inventory_unassigned__";
const credentialPattern = /^nfc-[a-f0-9]{8,20}$/u;

export async function listRfidCredentials(db: D1DatabaseLike) {
  await ensureManagedEntityStore(db);
  const rows = await db.prepare(`SELECT c.credential_id AS credentialId,
    c.credential_active AS credentialActive,c.credential_is_master AS credentialIsMaster,
    c.operator_id AS operatorId,c.created_at AS createdAt,c.updated_at AS updatedAt,
    o.name AS operatorName,o.rut AS operatorRut,o.active AS operatorActive,
    o.archived_at AS operatorArchivedAt
    FROM managed_rfid_credentials c
    LEFT JOIN managed_operators o ON o.id=c.operator_id
    ORDER BY c.credential_is_master DESC,c.created_at DESC,c.credential_id`).all<Record<string, unknown>>();
  return rows.results.map((row) => ({
    credentialId: String(row.credentialId),
    credentialActive: row.credentialActive === 1 || row.credentialActive === true,
    credentialIsMaster: row.credentialIsMaster === 1 || row.credentialIsMaster === true,
    operatorId: typeof row.operatorId === "string" ? row.operatorId : null,
    operatorName: typeof row.operatorName === "string" ? row.operatorName : null,
    operatorRut: typeof row.operatorRut === "string" ? row.operatorRut : null,
    operatorActive: row.operatorActive === 1 || row.operatorActive === true,
    operatorArchivedAt: typeof row.operatorArchivedAt === "string" ? row.operatorArchivedAt : null,
    createdAt: String(row.createdAt),
    updatedAt: String(row.updatedAt),
  }));
}

export async function edgeRfidCredentialSnapshot(db: D1DatabaseLike) {
  const credentials = await listRfidCredentials(db);
  return credentials
    .filter((item) => typeof item.credentialId === "string" && credentialPattern.test(item.credentialId))
    .map((item) => ({
      credentialId: item.credentialId,
      operatorId: typeof item.operatorId === "string" ? item.operatorId : null,
      credentialActive: item.credentialActive === true,
      operatorActive: item.operatorActive === true && !item.operatorArchivedAt,
      isMaster: item.credentialIsMaster === true,
    }));
}

export async function assignRfidCredential(
  db: D1DatabaseLike,
  credentialId: string,
  operatorId: string | null,
  actorId: string,
) {
  await ensureManagedEntityStore(db);
  const credential = await db.prepare(`SELECT credential_id AS credentialId,
    credential_is_master AS credentialIsMaster,operator_id AS operatorId
    FROM managed_rfid_credentials WHERE credential_id=?`).bind(credentialId)
    .first<{ credentialId: string; credentialIsMaster: number; operatorId: string | null }>();
  if (!credential) throw new RfidCredentialConflict("La credencial RFID no existe.");
  if (credential.credentialIsMaster === 1 && !operatorId) {
    throw new RfidCredentialConflict("La tarjeta maestra debe permanecer vinculada a una persona responsable.");
  }
  let operator: { id: string } | null = null;
  if (operatorId) {
    operator = await db.prepare(`SELECT id FROM managed_operators
      WHERE id=? AND active=1 AND archived_at IS NULL`).bind(operatorId).first<{ id: string }>();
    if (!operator) throw new RfidCredentialConflict("Selecciona un operador vigente.");
    const occupied = await db.prepare(`SELECT credential_id AS credentialId
      FROM managed_rfid_credentials WHERE operator_id=? AND credential_id<>? LIMIT 1`)
      .bind(operatorId, credentialId).first<{ credentialId: string }>();
    if (occupied) throw new RfidCredentialConflict("El operador ya tiene una credencial RFID asignada.");
    if (credential.credentialIsMaster === 1) {
      const activeMaster = await db.prepare(`SELECT credential_id AS credentialId
        FROM managed_rfid_credentials WHERE credential_is_master=1 AND credential_active=1
        AND credential_id<>? LIMIT 1`).bind(credentialId).first<{ credentialId: string }>();
      if (activeMaster) throw new RfidCredentialConflict("Ya existe una tarjeta maestra activa en el sistema.");
    }
  }
  const statements = [];
  if (credential.operatorId && credential.operatorId !== operatorId) {
    statements.push(db.prepare(`UPDATE managed_operators SET credential='Sin enrolar',credential_active=0,
      credential_is_master=0,updated_at=CURRENT_TIMESTAMP WHERE id=? AND credential=?`)
      .bind(credential.operatorId, credentialId));
  }
  if (operatorId) {
    statements.push(db.prepare(`UPDATE managed_operators SET credential=?,credential_active=1,
      credential_is_master=?,updated_at=CURRENT_TIMESTAMP WHERE id=?`)
      .bind(credentialId, credential.credentialIsMaster, operatorId));
  }
  statements.push(
    db.prepare(`UPDATE managed_rfid_credentials SET operator_id=?,credential_active=1,
      updated_at=CURRENT_TIMESTAMP WHERE credential_id=?`).bind(operatorId, credentialId),
    db.prepare(`INSERT INTO managed_entity_audit(actor_user_id,event,entity_type,entity_id,metadata)
      VALUES (?,'rfid_assignment_changed','rfid_credentials',?,?)`).bind(actorId, credentialId, JSON.stringify({
        previousOperatorId: credential.operatorId,
        operatorId,
        isMaster: credential.credentialIsMaster === 1,
      })),
  );
  await db.batch(statements);
  return { updated: true };
}

export async function deleteRfidCredential(db: D1DatabaseLike, credentialId: string, actorId: string) {
  await ensureManagedEntityStore(db);
  const credential = await db.prepare(`SELECT credential_id AS credentialId,operator_id AS operatorId,
    credential_is_master AS credentialIsMaster FROM managed_rfid_credentials WHERE credential_id=?`)
    .bind(credentialId).first<{ credentialId: string; operatorId: string | null; credentialIsMaster: number }>();
  if (!credential) throw new RfidCredentialConflict("La credencial RFID no existe.");
  await db.batch([
    ...(credential.operatorId ? [db.prepare(`UPDATE managed_operators SET credential='Sin enrolar',credential_active=0,
      credential_is_master=0,updated_at=CURRENT_TIMESTAMP WHERE id=? AND credential=?`)
      .bind(credential.operatorId, credentialId)] : []),
    db.prepare("DELETE FROM managed_rfid_credentials WHERE credential_id=?").bind(credentialId),
    db.prepare(`INSERT INTO managed_entity_audit(actor_user_id,event,entity_type,entity_id,metadata)
      VALUES (?,'rfid_credential_deleted','rfid_credentials',?,?)`).bind(actorId, credentialId, JSON.stringify({
        operatorId: credential.operatorId,
        isMaster: credential.credentialIsMaster === 1,
      })),
  ]);
  return { deleted: true };
}

export class RfidCredentialConflict extends Error {}
