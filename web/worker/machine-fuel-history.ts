import type { D1DatabaseLike } from "./user-store";
import type { MachineFuelHistory, MachineFuelTotal, MachineFuelLoads, MachineFuelLoad } from "../shared/machine-fuel-history";

// Use the same historical dispatches as the ledger, aggregated before any row limit.
// Zero-volume pump enablements, receipts and rejected records are not fuel supplied to machines.
const dispatchWhere = `m.movement_type='dispatch' AND m.classification='standard'
  AND m.liters>0 AND m.detection_status='confirmed' AND m.review_status NOT IN ('pending','rejected')`;

export async function machineFuelHistory(db: D1DatabaseLike, from?: string, toExclusive?: string): Promise<MachineFuelHistory> {
  const range = from && toExclusive ? " AND m.occurred_at>=? AND m.occurred_at<?" : "";
  const result = await db.prepare(`SELECT NULLIF(TRIM(m.equipment_id),'') AS equipmentId,
    COALESCE(NULLIF(TRIM(e.name),''),NULLIF(TRIM(m.equipment_id),''),'Sin máquina identificada') AS name,
    COALESCE(e.kind,'Otro') AS kind,SUM(m.liters) AS liters,COUNT(*) AS loads,MAX(m.occurred_at) AS lastAt
    FROM fuel_movements m LEFT JOIN managed_equipment e ON e.id=m.equipment_id
    WHERE ${dispatchWhere}${range} GROUP BY NULLIF(TRIM(m.equipment_id),'')
    ORDER BY liters DESC,name COLLATE NOCASE,equipmentId`).bind(...(range ? [from!, toExclusive!] : [])).all<MachineFuelTotal>();
  return { machines: result.results.filter((row) => row.equipmentId !== null), unassigned: result.results.find((row) => row.equipmentId === null) ?? null };
}

export async function machineFuelLoads(db: D1DatabaseLike, from: string, toExclusive: string, equipmentId: string | null, page: number): Promise<MachineFuelLoads> {
  const pageSize = 25;
  const where = `${dispatchWhere} AND m.occurred_at>=? AND m.occurred_at<? AND NULLIF(TRIM(m.equipment_id),'') IS ?`;
  const [count, result] = await Promise.all([
    db.prepare(`SELECT COUNT(*) AS total FROM fuel_movements m WHERE ${where}`).bind(from, toExclusive, equipmentId).first<{ total: number }>(),
    db.prepare(`SELECT m.id,m.occurred_at AS occurredAt,m.liters,m.reference_id AS reference,m.source,
      COALESCE(NULLIF(o.name,''),m.operator_id,'Sin operador identificado') AS operator
      FROM fuel_movements m LEFT JOIN managed_operators o ON o.id=m.operator_id
      WHERE ${where} ORDER BY m.occurred_at DESC,m.id DESC LIMIT ? OFFSET ?`)
      .bind(from, toExclusive, equipmentId, pageSize, (page - 1) * pageSize).all<MachineFuelLoad>(),
  ]);
  return { movements: result.results, total: count?.total ?? 0, page, pageSize };
}
