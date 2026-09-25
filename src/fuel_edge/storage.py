"""Persistencia local durable para auditoría, transacciones y sincronización."""

from __future__ import annotations

import json
import sqlite3
from datetime import datetime, timezone
from pathlib import Path
from threading import RLock
from typing import Any
from uuid import NAMESPACE_URL, uuid5
from .volume_format import format_liters_cl


SCHEMA = """
CREATE TABLE IF NOT EXISTS ocio_calibration_state (
    site_id TEXT PRIMARY KEY, payload TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS ocio_calibration_history (
    id TEXT PRIMARY KEY, site_id TEXT NOT NULL, payload TEXT NOT NULL,
    previous_inventory_state TEXT
);
CREATE TABLE IF NOT EXISTS ocio_signal_diagnostics (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    occurred_at TEXT NOT NULL,
    payload TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ocio_diagnostics_time ON ocio_signal_diagnostics(occurred_at);
CREATE TABLE IF NOT EXISTS inventory_meter (
    id INTEGER PRIMARY KEY CHECK(id = 1),
    pulses INTEGER NOT NULL DEFAULT 0 CHECK(pulses >= 0)
);
INSERT OR IGNORE INTO inventory_meter(id,pulses) VALUES (1,0);
CREATE TABLE IF NOT EXISTS inventory_monitor_state (
    site_id TEXT PRIMARY KEY,
    payload TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS inventory_checks (
    id TEXT PRIMARY KEY,
    site_id TEXT NOT NULL,
    payload TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS inventory_balance_samples (
    id TEXT PRIMARY KEY,
    site_id TEXT NOT NULL,
    occurred_at TEXT NOT NULL,
    payload TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    occurred_at TEXT NOT NULL,
    event TEXT NOT NULL,
    previous_state TEXT NOT NULL,
    new_state TEXT NOT NULL,
    relay_energized INTEGER NOT NULL CHECK (relay_energized IN (0, 1)),
    payload TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS transactions (
    id TEXT PRIMARY KEY,
    operator_id TEXT NOT NULL,
    equipment_id TEXT,
    is_master INTEGER NOT NULL CHECK (is_master IN (0, 1)),
    opened_at TEXT NOT NULL,
    closed_at TEXT,
    close_reason TEXT,
    pulses INTEGER NOT NULL DEFAULT 0,
    liters REAL,
    status TEXT NOT NULL,
    authorization_evidence TEXT NOT NULL DEFAULT 'legacy',
    adoption_stage TEXT,
    equipment_issue TEXT
);

CREATE TABLE IF NOT EXISTS pump_test_transactions (
    id TEXT PRIMARY KEY,
    duration_seconds INTEGER NOT NULL CHECK (duration_seconds BETWEEN 5 AND 60),
    started_at TEXT NOT NULL,
    completed_at TEXT,
    status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'interrupted')),
    close_reason TEXT
);

CREATE TABLE IF NOT EXISTS manual_mode_sessions (
    id TEXT PRIMARY KEY,
    started_at TEXT NOT NULL,
    scheduled_end TEXT NOT NULL,
    completed_at TEXT,
    status TEXT NOT NULL CHECK (status IN ('active', 'completed', 'interrupted')),
    close_reason TEXT,
    purpose TEXT NOT NULL DEFAULT 'manual'
);

CREATE TABLE IF NOT EXISTS manual_mode_segments (
    id TEXT PRIMARY KEY,
    legacy_id TEXT UNIQUE,
    schedule_id TEXT NOT NULL,
    operator_id TEXT,
    credential_id TEXT,
    is_master INTEGER NOT NULL DEFAULT 0 CHECK (is_master IN (0, 1)),
    equipment_id TEXT,
    authorization_evidence TEXT NOT NULL DEFAULT 'assisted',
    adoption_stage TEXT,
    assisted_mode INTEGER NOT NULL DEFAULT 0 CHECK (assisted_mode IN (0, 1)),
    equipment_issue TEXT,
    opened_at TEXT NOT NULL,
    closed_at TEXT,
    close_reason TEXT,
    pulses INTEGER NOT NULL DEFAULT 0 CHECK (pulses >= 0),
    liters REAL,
    status TEXT NOT NULL CHECK (status IN ('active', 'closed')),
    FOREIGN KEY(schedule_id) REFERENCES manual_mode_sessions(id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_manual_mode_segment_active
ON manual_mode_segments(status) WHERE status = 'active';

CREATE TABLE IF NOT EXISTS unauthorized_flow_incidents (
    id TEXT PRIMARY KEY,
    started_at TEXT NOT NULL,
    last_pulse_at TEXT NOT NULL,
    pulses INTEGER NOT NULL CHECK (pulses > 0),
    closed_at TEXT,
    liters REAL,
    status TEXT NOT NULL CHECK (status IN ('active', 'closed'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_unauthorized_flow_active
ON unauthorized_flow_incidents(status) WHERE status = 'active';

CREATE TABLE IF NOT EXISTS technology_adoption_policy (
    site_id TEXT PRIMARY KEY,
    stage TEXT NOT NULL CHECK(stage IN ('assisted','rfid_only','full')),
    revision INTEGER NOT NULL CHECK(revision > 0),
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS outbox (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    topic TEXT NOT NULL,
    payload TEXT NOT NULL,
    dedupe_key TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    sent_at TEXT,
    attempt_count INTEGER NOT NULL DEFAULT 0,
    next_attempt_at TEXT,
    last_error TEXT,
    discarded_at TEXT
);

CREATE TABLE IF NOT EXISTS power_supply_events (
    id TEXT PRIMARY KEY,
    site_id TEXT,
    lost_at TEXT NOT NULL UNIQUE,
    restored_at TEXT,
    duration_seconds INTEGER CHECK (duration_seconds IS NULL OR duration_seconds >= 0),
    source TEXT NOT NULL CHECK (source IN ('ups_gpio24','operator_confirmed','reconstructed')),
    loss_boot_id TEXT,
    restore_boot_id TEXT,
    status TEXT NOT NULL CHECK (status IN ('open','closed')),
    recorded_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_power_supply_events_open
ON power_supply_events(status) WHERE status = 'open';

CREATE INDEX IF NOT EXISTS idx_power_supply_events_lost_at
ON power_supply_events(lost_at);

"""


def _is_pump_enablement(
    liters: float,
    threshold_liters: float | None,
) -> bool:
    return threshold_liters is not None and liters < threshold_liters


def _utc_datetime(value: str) -> datetime:
    normalized = value.strip().replace("Z", "+00:00")
    parsed = datetime.fromisoformat(normalized)
    if parsed.tzinfo is None:
        raise ValueError("la fecha eléctrica debe incluir zona horaria")
    return parsed.astimezone(timezone.utc)


def _power_event_id(lost_at: str) -> str:
    return f"power-{uuid5(NAMESPACE_URL, f'fuel-edge:power:{lost_at}')}"


class EventStore:
    def __init__(self, path: str | Path) -> None:
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = RLock()
        # MQTT entrega eventos desde un trabajador. El lock mantiene una sola
        # operación activa aunque la conexión se comparta entre hilos.
        self.connection = sqlite3.connect(self.path, check_same_thread=False)
        with self._lock:
            self.connection.execute("PRAGMA foreign_keys = ON")
            self.connection.execute("PRAGMA journal_mode = WAL")
            self.connection.execute("PRAGMA synchronous = FULL")
            self.connection.execute("PRAGMA busy_timeout = 5000")
            self.connection.executescript(SCHEMA)
            self._migrate_outbox()
            self._migrate_adoption_columns()
            self._migrate_manual_mode_transaction_ids()
            self.connection.commit()

    def record_audit(self, payload: dict[str, Any]) -> int:
        with self._lock:
            cursor = self.connection.execute(
                """
                INSERT INTO audit_log(
                    occurred_at, event, previous_state, new_state, relay_energized, payload
                ) VALUES (?, ?, ?, ?, ?, ?)
                """,
                (
                    payload["occurred_at"],
                    payload["event"],
                    payload["previous_state"],
                    payload["new_state"],
                    int(payload["relay_energized"]),
                    json.dumps(
                        payload.get("metadata", {}),
                        separators=(",", ":"),
                        sort_keys=True,
                    ),
                ),
            )
            self.connection.commit()
            return int(cursor.lastrowid)

    def ocio_calibration(self, site_id: str) -> dict | None:
        with self._lock:
            row = self.connection.execute("SELECT payload FROM ocio_calibration_state WHERE site_id=?", (site_id,)).fetchone()
            return json.loads(row[0]) if row else None

    def apply_ocio_calibration(self, site_id: str, command: dict) -> tuple[dict, bool]:
        """Confirmación, archivo de referencia y respuesta web, en una transacción."""
        with self._lock, self.connection:
            current = self.ocio_calibration(site_id)
            changed = not current or current['confirmationId'] != command['confirmationId']
            if changed:
                if current and command['revision'] <= current['revision']:
                    raise ValueError('confirmación OCIO anterior a la aplicada')
                previous = self.connection.execute('SELECT payload FROM inventory_monitor_state WHERE site_id=?', (site_id,)).fetchone()
                current = {**command, 'siteId':site_id, 'appliedAt':datetime.now(timezone.utc).isoformat()}
                encoded = self._encode_payload(current)
                self.connection.execute('INSERT INTO ocio_calibration_history(id,site_id,payload,previous_inventory_state) VALUES (?,?,?,?)',
                    (current['confirmationId'],site_id,encoded,previous[0] if previous else None))
                self.connection.execute('INSERT INTO ocio_calibration_state(site_id,payload) VALUES (?,?) ON CONFLICT(site_id) DO UPDATE SET payload=excluded.payload', (site_id,encoded))
                self.connection.execute('DELETE FROM inventory_monitor_state WHERE site_id=?',(site_id,))
            elif current['fingerprint'] != command['fingerprint'] or current['revision'] != command['revision']:
                raise ValueError('confirmación OCIO reutilizada con otra configuración')
            self.connection.execute("INSERT OR IGNORE INTO outbox(topic,payload,dedupe_key) VALUES ('web/ocio-calibration-applied',?,?)",
                (self._encode_payload(current),'web/ocio-calibration:'+current['confirmationId']))
            return current, changed

    def record_ocio_diagnostics(self, samples: list[dict], *, site_id: str | None = None, telemetry_session_id: str | None = None) -> None:
        """Traza local de 24 h y entrega durable del histórico a la base central."""
        if not samples:
            return
        with self._lock, self.connection:
            self.connection.executemany(
                "INSERT INTO ocio_signal_diagnostics(occurred_at,payload) VALUES (?,?)",
                [(s["occurredAt"], self._encode_payload(s)) for s in samples],
            )
            if site_id is not None:
                for offset in range(0, len(samples), 30):
                    batch = samples[offset:offset + 30]
                    payload = {"siteId": site_id, "telemetrySessionId": telemetry_session_id,
                               "source": "OCIO", "samples": batch}
                    key = f"web/voltage-readings:{site_id}:{telemetry_session_id}:{batch[0]['occurredAt']}:{batch[-1]['occurredAt']}"
                    self.connection.execute(
                        "INSERT OR IGNORE INTO outbox(topic,payload,dedupe_key) VALUES (?,?,?)",
                        ("web/voltage-readings", self._encode_payload(payload), key),
                    )
            self.connection.execute(
                "DELETE FROM ocio_signal_diagnostics WHERE julianday(occurred_at) "
                "< julianday(?) - 1", (samples[-1]["occurredAt"],),
            )

    def record_inventory_pulses(self, count: int) -> None:
        """Total físico independiente del cierre de una carga y de su autorización."""
        if not isinstance(count, int) or isinstance(count, bool) or count <= 0:
            raise ValueError("count debe ser un entero positivo")
        with self._lock, self.connection:
            self.connection.execute(
                "UPDATE inventory_meter SET pulses=pulses+? WHERE id=1", (count,)
            )

    def inventory_pulses(self) -> int:
        with self._lock:
            return int(self.connection.execute(
                "SELECT pulses FROM inventory_meter WHERE id=1"
            ).fetchone()[0])

    def inventory_state(self, site_id: str) -> dict[str, Any] | None:
        with self._lock:
            row = self.connection.execute(
                "SELECT payload FROM inventory_monitor_state WHERE site_id=?", (site_id,)
            ).fetchone()
            return json.loads(row[0]) if row else None

    def save_inventory_state(
        self, site_id: str, state: dict[str, Any], *,
        check: dict[str, Any] | None = None,
        alert: dict[str, Any] | None = None,
        balance_sample: dict[str, Any] | None = None,
    ) -> None:
        """Referencia, evidencia y alarma se confirman juntas, incluso sin red."""
        with self._lock, self.connection:
            if balance_sample is not None:
                encoded = self._encode_payload(balance_sample)
                self.connection.execute(
                    "INSERT OR IGNORE INTO inventory_balance_samples(id,site_id,occurred_at,payload) "
                    "VALUES (?,?,?,?)",
                    (balance_sample["id"], site_id, balance_sample["occurredAt"], encoded),
                )
                self.connection.execute(
                    "INSERT OR IGNORE INTO outbox(topic,payload,dedupe_key) "
                    "VALUES ('web/inventory-balance',?,?)",
                    (encoded, f"web/inventory-balance:{balance_sample['id']}"),
                )
            if check is not None:
                self.connection.execute(
                    "INSERT OR IGNORE INTO inventory_checks(id,site_id,payload) VALUES (?,?,?)",
                    (check["id"], site_id, self._encode_payload(check)),
                )
            if alert is not None:
                self.connection.execute(
                    "INSERT OR IGNORE INTO outbox(topic,payload,dedupe_key) VALUES ('web/alert',?,?)",
                    (self._encode_payload(alert), f"web/alert:{alert['id']}"),
                )
            self.connection.execute(
                "INSERT INTO inventory_monitor_state(site_id,payload) VALUES (?,?) "
                "ON CONFLICT(site_id) DO UPDATE SET payload=excluded.payload",
                (site_id, self._encode_payload(state)),
            )

    def open_transaction(
        self,
        transaction_id: str,
        operator_id: str,
        equipment_id: str | None,
        is_master: bool,
        opened_at: str,
        *,
        authorization_evidence: str = "legacy",
        adoption_stage: str | None = None,
        equipment_issue: str | None = None,
    ) -> None:
        with self._lock:
            self.connection.execute(
                """
                INSERT INTO transactions(
                    id,operator_id,equipment_id,is_master,opened_at,status,
                    authorization_evidence,adoption_stage,equipment_issue
                ) VALUES (?, ?, ?, ?, ?, 'authorized', ?, ?, ?)
                """,
                (
                    transaction_id,
                    operator_id,
                    equipment_id,
                    int(is_master),
                    opened_at,
                    authorization_evidence,
                    adoption_stage,
                    equipment_issue,
                ),
            )
            self.connection.commit()

    def close_transaction(
        self,
        transaction_id: str,
        closed_at: str,
        close_reason: str,
        pulses: int,
        liters: float | None,
        pump_enablement_threshold_liters: float | None = None,
    ) -> None:
        with self._lock:
            row = self.connection.execute(
                """SELECT operator_id,equipment_id,is_master,opened_at,status,
                    authorization_evidence,adoption_stage,equipment_issue
                FROM transactions WHERE id = ?""",
                (transaction_id,),
            ).fetchone()
            if row is None:
                raise LookupError(f"transacción desconocida: {transaction_id}")
            if row[4] == "closed":
                return
            cursor = self.connection.execute(
                """
                UPDATE transactions
                SET closed_at = ?, close_reason = ?, pulses = ?, liters = ?, status = 'closed'
                WHERE id = ? AND status != 'closed'
                """,
                (closed_at, close_reason, pulses, liters, transaction_id),
            )
            if cursor.rowcount != 1:
                raise RuntimeError("la transacción no pudo cerrarse de forma atómica")
            if liters is not None and liters > 0:
                pump_enablement = _is_pump_enablement(
                    float(liters), pump_enablement_threshold_liters
                )
                payload = {
                    "id": transaction_id,
                    "type": "dispatch",
                    "occurredAt": closed_at,
                    "liters": round(float(liters), 3),
                    "source": (
                        "K24 + PLC · Habilitación de bomba"
                        if pump_enablement
                        else "K24 + PLC"
                    ),
                    "reference": transaction_id,
                    "detail": (
                        f"{row[0]} · Habilitación de bomba · "
                        "Menos de 0,12 L sin flujo posterior"
                        if pump_enablement
                        else (
                            f"{row[0]} · Carga excepcional · Tarjeta maestra"
                            if bool(row[2])
                            else f"{row[0]} · {row[1] or 'Equipo no informado'}"
                        )
                    ),
                    "classification": (
                        "pump_enablement" if pump_enablement else "standard"
                    ),
                    "operatorId": row[0],
                    "equipmentId": row[1],
                    "isMaster": bool(row[2]),
                    "openedAt": row[3],
                    "closeReason": close_reason,
                    "pulses": pulses,
                    "authorizationEvidence": row[5],
                    "adoptionStage": row[6],
                    "assistedMode": False,
                    "equipmentIssue": row[7],
                }
                self.connection.execute(
                    "INSERT OR IGNORE INTO outbox(topic,payload,dedupe_key) VALUES (?,?,?)",
                    (
                        "web/fuel-movement",
                        self._encode_payload(payload),
                        f"web/fuel-movement:{transaction_id}",
                    ),
                )
            self.connection.commit()

    def downgrade_transaction_evidence(
        self,
        transaction_id: str,
        equipment_issue: str,
    ) -> None:
        with self._lock:
            cursor = self.connection.execute(
                """UPDATE transactions SET equipment_id=NULL,
                    authorization_evidence='rfid_only',equipment_issue=?
                WHERE id=? AND status<>'closed' AND equipment_id IS NOT NULL""",
                (equipment_issue, transaction_id),
            )
            if cursor.rowcount != 1:
                self.connection.rollback()
                raise RuntimeError("la evidencia activa no pudo degradarse de forma atómica")
            self.connection.commit()

    def open_pump_test_transaction(
        self,
        transaction_id: str,
        duration_seconds: int,
        started_at: str,
    ) -> None:
        if not transaction_id or not 5 <= duration_seconds <= 60:
            raise ValueError("transacción de prueba de bomba inválida")
        with self._lock:
            self.connection.execute(
                """INSERT INTO pump_test_transactions(
                    id,duration_seconds,started_at,status
                ) VALUES (?,?,?,'running')""",
                (transaction_id, duration_seconds, started_at),
            )
            self.connection.commit()

    def close_pump_test_transaction(
        self,
        transaction_id: str,
        completed_at: str,
        status: str,
        close_reason: str | None,
    ) -> None:
        if status not in {"completed", "interrupted"}:
            raise ValueError("estado final de prueba de bomba inválido")
        with self._lock:
            cursor = self.connection.execute(
                """UPDATE pump_test_transactions
                SET completed_at=?,status=?,close_reason=?
                WHERE id=? AND status='running'""",
                (completed_at, status, close_reason, transaction_id),
            )
            if cursor.rowcount != 1:
                self.connection.rollback()
                raise RuntimeError("la transacción de prueba de bomba no pudo cerrarse")
            self.connection.commit()

    def open_manual_mode_session(
        self,
        schedule_id: str,
        started_at: str,
        scheduled_end: str,
        purpose: str = "manual",
    ) -> None:
        if not schedule_id:
            raise ValueError("sesión de modo manual sin identificador")
        with self._lock:
            self.connection.execute(
                """INSERT INTO manual_mode_sessions(
                    id,started_at,scheduled_end,status,purpose
                ) VALUES (?,?,?,'active',?)
                ON CONFLICT(id) DO UPDATE SET
                    started_at=excluded.started_at,
                    scheduled_end=excluded.scheduled_end,
                    completed_at=NULL,status='active',close_reason=NULL,purpose=excluded.purpose
                WHERE manual_mode_sessions.status IN ('active','interrupted')""",
                (schedule_id, started_at, scheduled_end, purpose),
            )
            row = self.connection.execute(
                "SELECT status FROM manual_mode_sessions WHERE id=?", (schedule_id,)
            ).fetchone()
            if row is None or row[0] != "active":
                self.connection.rollback()
                raise RuntimeError("la sesión de modo manual no quedó activa")
            self.connection.commit()

    def recover_active_manual_mode(
        self,
        recovered_at: str,
        pulses_per_liter: float,
        pump_enablement_threshold_liters: float | None = None,
    ) -> str | None:
        """Cierra el segmento dejado por un reinicio antes de reanudar la ventana."""

        with self._lock:
            row = self.connection.execute(
                """SELECT id,schedule_id FROM manual_mode_segments
                WHERE status='active' LIMIT 1"""
            ).fetchone()
            if row is None:
                return None
            segment_id, schedule_id = str(row[0]), str(row[1])
            self.close_manual_mode_segment(
                segment_id,
                recovered_at,
                "edge_restarted",
                pulses_per_liter,
                pump_enablement_threshold_liters,
            )
            self.connection.execute(
                """UPDATE manual_mode_sessions SET
                    completed_at=?,status='interrupted',close_reason='edge_restarted'
                WHERE id=? AND status='active'""",
                (recovered_at, schedule_id),
            )
            self.connection.commit()
            return schedule_id

    def open_manual_mode_segment(
        self,
        segment_id: str,
        schedule_id: str,
        opened_at: str,
        *,
        operator_id: str | None = None,
        credential_id: str | None = None,
        is_master: bool = False,
        equipment_id: str | None = None,
        authorization_evidence: str = "assisted",
        adoption_stage: str | None = None,
        assisted_mode: bool = False,
        equipment_issue: str | None = None,
    ) -> None:
        if not segment_id or not schedule_id:
            raise ValueError("segmento de modo manual inválido")
        with self._lock:
            active = self.connection.execute(
                "SELECT id FROM manual_mode_segments WHERE status='active' LIMIT 1"
            ).fetchone()
            if active is not None:
                raise RuntimeError("ya existe un segmento de modo manual activo")
            self.connection.execute(
                """INSERT INTO manual_mode_segments(
                    id,schedule_id,operator_id,credential_id,is_master,equipment_id,
                    authorization_evidence,adoption_stage,assisted_mode,equipment_issue,
                    opened_at,status
                ) VALUES (?,?,?,?,?,?,?,?,?,?,?,'active')""",
                (
                    segment_id,
                    schedule_id,
                    operator_id,
                    credential_id,
                    int(is_master),
                    equipment_id,
                    authorization_evidence,
                    adoption_stage,
                    int(assisted_mode),
                    equipment_issue,
                    opened_at,
                ),
            )
            self.connection.commit()

    def record_manual_mode_pulses(self, segment_id: str, pulses: int) -> int:
        if not segment_id or pulses <= 0:
            raise ValueError("segmento y pulsos de modo manual deben ser válidos")
        with self._lock:
            cursor = self.connection.execute(
                """UPDATE manual_mode_segments SET pulses=pulses+?
                WHERE id=? AND status='active'""",
                (pulses, segment_id),
            )
            if cursor.rowcount != 1:
                self.connection.rollback()
                raise RuntimeError("no existe un segmento manual activo para registrar pulsos")
            row = self.connection.execute(
                "SELECT pulses FROM manual_mode_segments WHERE id=?", (segment_id,)
            ).fetchone()
            self.connection.commit()
            return int(row[0])

    def close_manual_mode_segment(
        self,
        segment_id: str,
        closed_at: str,
        close_reason: str,
        pulses_per_liter: float,
        pump_enablement_threshold_liters: float | None = None,
    ) -> tuple[int, float]:
        if pulses_per_liter <= 0:
            raise ValueError("pulses_per_liter debe ser positivo")
        with self._lock:
            row = self.connection.execute(
                """SELECT schedule_id,operator_id,credential_id,is_master,equipment_id,
                    authorization_evidence,adoption_stage,assisted_mode,equipment_issue,
                    opened_at,pulses,status,liters
                FROM manual_mode_segments WHERE id=?""",
                (segment_id,),
            ).fetchone()
            if row is None:
                raise LookupError(f"segmento manual desconocido: {segment_id}")
            pulses = int(row[10])
            liters = float(row[12]) if row[12] is not None else pulses / pulses_per_liter
            if row[11] == "closed":
                return pulses, liters
            cursor = self.connection.execute(
                """UPDATE manual_mode_segments SET
                    closed_at=?,close_reason=?,liters=?,status='closed'
                WHERE id=? AND status='active'""",
                (closed_at, close_reason, liters, segment_id),
            )
            if cursor.rowcount != 1:
                self.connection.rollback()
                raise RuntimeError("el segmento manual no pudo cerrarse")
            if pulses > 0:
                tagged = row[1] is not None
                mode_label = "Adopción asistida" if bool(row[7]) else "Modo manual"
                pump_enablement = _is_pump_enablement(
                    liters, pump_enablement_threshold_liters
                )
                payload = {
                    "id": segment_id,
                    "type": "dispatch",
                    "occurredAt": closed_at,
                    "liters": round(liters, 3),
                    "source": (
                        f"K24 + PLC · {mode_label} · Habilitación de bomba"
                        if pump_enablement
                        else f"K24 + PLC · {mode_label}"
                    ),
                    "reference": segment_id,
                    "manualModeSessionId": str(row[0]),
                    "detail": (
                        "Habilitación de bomba · Menos de 0,12 L sin flujo posterior · "
                        + (
                            f"Consumo imputado a {row[1]} · {mode_label}"
                            if tagged
                            else f"{mode_label} sin tag presentado"
                        )
                        if pump_enablement
                        else (
                            f"{row[1]} · Consumo imputado por tag · {mode_label}"
                            if tagged
                            else f"{mode_label} · Consumo sin tag presentado"
                        )
                    ),
                    "classification": (
                        "pump_enablement" if pump_enablement else "standard"
                    ),
                    "operatorId": row[1],
                    "equipmentId": row[4],
                    "isMaster": bool(row[3]),
                    "credentialId": row[2],
                    "manualMode": True,
                    "authorizationEvidence": row[5],
                    "adoptionStage": row[6],
                    "assistedMode": bool(row[7]),
                    "equipmentIssue": row[8],
                    "openedAt": row[9],
                    "closeReason": close_reason,
                    "pulses": pulses,
                }
                self.connection.execute(
                    "INSERT OR IGNORE INTO outbox(topic,payload,dedupe_key) VALUES (?,?,?)",
                    (
                        "web/fuel-movement",
                        self._encode_payload(payload),
                        f"web/fuel-movement:{segment_id}",
                    ),
                )
            self.connection.commit()
            return pulses, liters

    def close_manual_mode_session(
        self,
        schedule_id: str,
        completed_at: str,
        status: str,
        close_reason: str,
    ) -> None:
        if status not in {"completed", "interrupted"}:
            raise ValueError("estado final de modo manual inválido")
        with self._lock:
            cursor = self.connection.execute(
                """UPDATE manual_mode_sessions SET
                    completed_at=?,status=?,close_reason=?
                WHERE id=? AND status='active'""",
                (completed_at, status, close_reason, schedule_id),
            )
            if cursor.rowcount != 1:
                existing = self.connection.execute(
                    "SELECT status FROM manual_mode_sessions WHERE id=?", (schedule_id,)
                ).fetchone()
                if existing is None or existing[0] == "active":
                    self.connection.rollback()
                    raise RuntimeError("la sesión manual no pudo cerrarse")
            self.connection.commit()

    def active_unauthorized_flow(self) -> tuple[str, str, str, int] | None:
        with self._lock:
            row = self.connection.execute(
                """SELECT id,started_at,last_pulse_at,pulses
                FROM unauthorized_flow_incidents WHERE status='active' LIMIT 1"""
            ).fetchone()
            if row is None:
                return None
            return str(row[0]), str(row[1]), str(row[2]), int(row[3])

    def record_unauthorized_flow_pulses(
        self,
        incident_id: str,
        started_at: str,
        last_pulse_at: str,
        pulses: int,
    ) -> int:
        if not incident_id or pulses <= 0:
            raise ValueError("incidente y pulsos no autorizados deben ser válidos")
        with self._lock:
            self.connection.execute(
                """INSERT INTO unauthorized_flow_incidents(
                    id,started_at,last_pulse_at,pulses,status
                ) VALUES (?,?,?,?,'active')
                ON CONFLICT(id) DO UPDATE SET
                    last_pulse_at=excluded.last_pulse_at,
                    pulses=unauthorized_flow_incidents.pulses+excluded.pulses
                WHERE unauthorized_flow_incidents.status='active'""",
                (incident_id, started_at, last_pulse_at, pulses),
            )
            row = self.connection.execute(
                "SELECT pulses,status FROM unauthorized_flow_incidents WHERE id=?",
                (incident_id,),
            ).fetchone()
            if row is None or row[1] != "active":
                self.connection.rollback()
                raise RuntimeError("el incidente de flujo no autorizado no está activo")
            self.connection.commit()
            return int(row[0])

    def close_unauthorized_flow(
        self,
        incident_id: str,
        closed_at: str,
        pulses_per_liter: float,
        pump_enablement_threshold_liters: float | None = None,
    ) -> tuple[int, float]:
        if pulses_per_liter <= 0:
            raise ValueError("pulses_per_liter debe ser positivo")
        with self._lock:
            row = self.connection.execute(
                """SELECT started_at,last_pulse_at,pulses,status,liters
                FROM unauthorized_flow_incidents WHERE id=?""",
                (incident_id,),
            ).fetchone()
            if row is None:
                raise LookupError(f"incidente desconocido: {incident_id}")
            pulses = int(row[2])
            liters = float(row[4]) if row[4] is not None else pulses / pulses_per_liter
            if row[3] == "closed":
                return pulses, liters
            cursor = self.connection.execute(
                """UPDATE unauthorized_flow_incidents
                SET closed_at=?,liters=?,status='closed'
                WHERE id=? AND status='active'""",
                (closed_at, liters, incident_id),
            )
            if cursor.rowcount != 1:
                self.connection.rollback()
                raise RuntimeError("el incidente no pudo cerrarse de forma atómica")

            pump_enablement = _is_pump_enablement(
                liters, pump_enablement_threshold_liters
            )
            movement = {
                "id": incident_id,
                "type": "dispatch",
                "occurredAt": closed_at,
                "liters": round(liters, 3),
                "source": (
                    "K24 · Habilitación de bomba"
                    if pump_enablement
                    else "K24 · Detección independiente"
                ),
                "reference": incident_id,
                "detail": (
                    "Habilitación de bomba · Menos de 0,12 L sin flujo posterior"
                    if pump_enablement
                    else (
                        "Flujo no autorizado · Sin operador ni equipo · "
                        "Posible bypass de bomba detectado por K24"
                    )
                ),
                "classification": (
                    "pump_enablement" if pump_enablement else "standard"
                ),
                "operatorId": None,
                "equipmentId": None,
                "isMaster": False,
                "unauthorized": not pump_enablement,
                "openedAt": row[0],
                "closeReason": "unauthorized_flow",
                "pulses": pulses,
            }
            alert = {
                "id": f"edge-alert-{incident_id}",
                "severity": "info" if pump_enablement else "critical",
                "priority": "low" if pump_enablement else "urgent",
                "title": (
                    "Habilitación de bomba sin carga"
                    if pump_enablement
                    else "Flujo de petróleo sin autorización"
                ),
                "detail": (
                    f"K24 registró {pulses} pulsos ({format_liters_cl(liters)} L) "
                    + (
                        "y no detectó suministro posterior durante la ventana de inicio."
                        if pump_enablement
                        else "sin una autorización activa. Posible bypass de la bomba."
                    )
                ),
                "occurredAt": row[0],
            }
            for topic, payload, dedupe_key in (
                (
                    "web/fuel-movement",
                    movement,
                    f"web/fuel-movement:{incident_id}",
                ),
                ("web/alert", alert, f"web/alert:{incident_id}"),
            ):
                self.connection.execute(
                    """INSERT INTO outbox(topic,payload,dedupe_key) VALUES (?,?,?)
                    ON CONFLICT(dedupe_key) DO UPDATE SET
                    topic=excluded.topic,payload=excluded.payload,
                    created_at=CURRENT_TIMESTAMP,sent_at=NULL,attempt_count=0,
                    next_attempt_at=NULL,last_error=NULL,discarded_at=NULL""",
                    (topic, self._encode_payload(payload), dedupe_key),
                )
            self.connection.commit()
            return pulses, liters

    def record_power_loss(
        self,
        *,
        lost_at: str,
        source: str = "ups_gpio24",
        loss_boot_id: str | None = None,
        site_id: str | None = None,
    ) -> str:
        if source not in {"ups_gpio24", "operator_confirmed", "reconstructed"}:
            raise ValueError("origen de corte eléctrico inválido")
        normalized_lost_at = _utc_datetime(lost_at).isoformat()
        event_id = _power_event_id(normalized_lost_at)
        with self._lock, self.connection:
            self.connection.execute(
                """INSERT OR IGNORE INTO power_supply_events(
                    id,site_id,lost_at,source,loss_boot_id,status
                ) VALUES (?,?,?,?,?,'open')""",
                (event_id, site_id, normalized_lost_at, source, loss_boot_id),
            )
            row = self.connection.execute(
                "SELECT id,lost_at,source FROM power_supply_events WHERE status='open' LIMIT 1"
            ).fetchone()
            if row is None:
                raise RuntimeError("no se pudo guardar el corte eléctrico abierto")
            # El hook UPS no espera a la red. Corte y alarma se confirman en la
            # misma transacción antes del apagado, incluso si falta el site_id.
            self._enqueue_power_alert_locked({
                "id": str(row[0]), "lostAt": str(row[1]), "source": str(row[2]),
            })
            return str(row[0])

    def close_open_power_loss(
        self,
        *,
        site_id: str,
        restored_at: str,
        restore_boot_id: str | None = None,
    ) -> dict[str, Any] | None:
        restored = _utc_datetime(restored_at)
        with self._lock, self.connection:
            row = self.connection.execute(
                """SELECT id,lost_at,source,loss_boot_id
                FROM power_supply_events WHERE status='open' LIMIT 1"""
            ).fetchone()
            if row is None:
                return None
            lost = _utc_datetime(str(row[1]))
            if restored < lost:
                restored = datetime.now(timezone.utc)
            duration_seconds = max(0, int((restored - lost).total_seconds()))
            payload = {
                "id": str(row[0]),
                "siteId": site_id,
                "lostAt": lost.isoformat(),
                "restoredAt": restored.isoformat(),
                "durationSeconds": duration_seconds,
                "source": str(row[2]),
                "lossBootId": str(row[3]) if row[3] else None,
                "restoreBootId": restore_boot_id,
            }
            self.connection.execute(
                """UPDATE power_supply_events SET
                    site_id=?,restored_at=?,duration_seconds=?,restore_boot_id=?,status='closed'
                WHERE id=? AND status='open'""",
                (
                    site_id,
                    payload["restoredAt"],
                    duration_seconds,
                    restore_boot_id,
                    payload["id"],
                ),
            )
            self._enqueue_power_event_locked(payload)
            self._enqueue_power_alert_locked(payload)
            self.connection.commit()
            return payload

    def record_completed_power_outage(
        self,
        *,
        site_id: str,
        lost_at: str,
        restored_at: str,
        source: str = "operator_confirmed",
        loss_boot_id: str | None = None,
        restore_boot_id: str | None = None,
    ) -> dict[str, Any]:
        if source not in {"ups_gpio24", "operator_confirmed", "reconstructed"}:
            raise ValueError("origen de corte eléctrico inválido")
        lost = _utc_datetime(lost_at)
        restored = _utc_datetime(restored_at)
        if restored <= lost:
            raise ValueError("la recuperación debe ser posterior al corte")
        normalized_lost_at = lost.isoformat()
        event_id = _power_event_id(normalized_lost_at)
        duration_seconds = int((restored - lost).total_seconds())
        payload = {
            "id": event_id,
            "siteId": site_id,
            "lostAt": normalized_lost_at,
            "restoredAt": restored.isoformat(),
            "durationSeconds": duration_seconds,
            "source": source,
            "lossBootId": loss_boot_id,
            "restoreBootId": restore_boot_id,
        }
        with self._lock, self.connection:
            self.connection.execute(
                """INSERT INTO power_supply_events(
                    id,site_id,lost_at,restored_at,duration_seconds,source,
                    loss_boot_id,restore_boot_id,status
                ) VALUES (?,?,?,?,?,?,?,?, 'closed')
                ON CONFLICT(id) DO UPDATE SET
                    site_id=excluded.site_id,restored_at=excluded.restored_at,
                    duration_seconds=excluded.duration_seconds,source=excluded.source,
                    loss_boot_id=COALESCE(excluded.loss_boot_id,power_supply_events.loss_boot_id),
                    restore_boot_id=COALESCE(excluded.restore_boot_id,power_supply_events.restore_boot_id),
                    status='closed'""",
                (
                    event_id,
                    site_id,
                    payload["lostAt"],
                    payload["restoredAt"],
                    duration_seconds,
                    source,
                    loss_boot_id,
                    restore_boot_id,
                ),
            )
            self._enqueue_power_event_locked(payload)
            self._enqueue_power_alert_locked(payload)
            self.connection.commit()
        return payload

    def power_supply_events(self) -> list[dict[str, Any]]:
        with self._lock:
            rows = self.connection.execute(
                """SELECT id,site_id,lost_at,restored_at,duration_seconds,source,
                    loss_boot_id,restore_boot_id,status
                FROM power_supply_events ORDER BY lost_at DESC"""
            ).fetchall()
        return [
            {
                "id": str(row[0]),
                "siteId": str(row[1]) if row[1] else None,
                "lostAt": str(row[2]),
                "restoredAt": str(row[3]) if row[3] else None,
                "durationSeconds": int(row[4]) if row[4] is not None else None,
                "source": str(row[5]),
                "lossBootId": str(row[6]) if row[6] else None,
                "restoreBootId": str(row[7]) if row[7] else None,
                "status": str(row[8]),
            }
            for row in rows
        ]

    def _enqueue_power_alert_locked(self, payload: dict[str, Any]) -> None:
        source = {
            "ups_gpio24": "Detectado por la UPS del PLC.",
            "operator_confirmed": "Corte confirmado por el operador.",
            "reconstructed": "Corte reconstruido a partir del registro eléctrico.",
        }[payload["source"]]
        if payload.get("restoredAt"):
            hours, remainder = divmod(int(payload["durationSeconds"]), 3600)
            minutes, seconds = divmod(remainder, 60)
            restored = _utc_datetime(payload["restoredAt"]).strftime("%d/%m/%Y %H:%M:%S UTC")
            detail = (f"{source} Recuperación registrada: {restored}. "
                      f"Duración registrada: {hours} h {minutes} min {seconds} s. "
                      "La recuperación no confirma la cuadratura del inventario; revisar su resultado.")
        else:
            detail = f"{source} Suministro interrumpido; recuperación aún no registrada."
        alert = {
            "id": f"edge-alert-{payload['id']}", "severity": "warning", "priority": "high",
            "title": "Corte eléctrico", "detail": f"{detail} Registro: {payload['id']}.",
            "occurredAt": payload["lostAt"],
        }
        # La recuperación actualiza la misma alarma. Reintentar el mismo dato
        # no crea otra ni vuelve a enviar una versión que ya fue entregada.
        self.connection.execute(
            """INSERT INTO outbox(topic,payload,dedupe_key) VALUES ('web/alert',?,?)
            ON CONFLICT(dedupe_key) DO UPDATE SET
                payload=excluded.payload,created_at=CURRENT_TIMESTAMP,sent_at=NULL,
                attempt_count=0,next_attempt_at=NULL,last_error=NULL,discarded_at=NULL
            WHERE outbox.payload<>excluded.payload""",
            (self._encode_payload(alert), f"web/alert:{alert['id']}"),
        )

    def _enqueue_power_event_locked(self, payload: dict[str, Any]) -> None:
        self.connection.execute(
            """INSERT INTO outbox(topic,payload,dedupe_key) VALUES (?,?,?)
            ON CONFLICT(dedupe_key) DO UPDATE SET
                topic=excluded.topic,payload=excluded.payload,
                created_at=CURRENT_TIMESTAMP,sent_at=NULL,attempt_count=0,
                next_attempt_at=NULL,last_error=NULL,discarded_at=NULL""",
            (
                "web/power-event",
                self._encode_payload(payload),
                f"web/power-event:{payload['id']}",
            ),
        )

    def enqueue(
        self,
        topic: str,
        payload: dict[str, Any],
        *,
        dedupe_key: str | None = None,
    ) -> int:
        if not topic or len(topic) > 120:
            raise ValueError("topic inválido")
        encoded = self._encode_payload(payload)
        with self._lock:
            cursor = self.connection.execute(
                "INSERT OR IGNORE INTO outbox(topic,payload,dedupe_key) VALUES (?,?,?)",
                (topic, encoded, dedupe_key),
            )
            if cursor.rowcount == 0 and dedupe_key is not None:
                existing = self.connection.execute(
                    "SELECT id FROM outbox WHERE dedupe_key = ?", (dedupe_key,)
                ).fetchone()
                if existing is None:
                    raise RuntimeError("no se pudo recuperar el evento idempotente")
                self.connection.commit()
                return int(existing[0])
            self.connection.commit()
            return int(cursor.lastrowid)

    def enqueue_tank_level(
        self,
        *,
        level_liters: float,
        occurred_at: str,
        source: str = "OCIO",
        telemetry_session_id: str | None = None,
        min_liters: float | None = None,
        max_liters: float | None = None,
        calibration_id: str | None = None,
    ) -> int:
        payload: dict[str, Any] = {
            "levelLiters": round(level_liters, 3),
            "occurredAt": occurred_at,
            "source": source,
        }
        if telemetry_session_id is not None:
            payload["telemetrySessionId"] = telemetry_session_id
        if calibration_id is not None:
            if not isinstance(calibration_id, str) or not calibration_id or len(calibration_id) > 160:
                raise ValueError("calibration_id inválido")
            payload["calibrationId"] = calibration_id
        if min_liters is not None or max_liters is not None:
            from math import isfinite
            if min_liters is None or max_liters is None or not all(isfinite(v) for v in (min_liters, max_liters)) or not 0 <= min_liters <= level_liters <= max_liters:
                raise ValueError("intervalo de nivel inválido")
            payload.pop("levelLiters")
            payload["levelRange"] = {"minLiters": min_liters, "maxLiters": max_liters}
        return self.enqueue(
            "web/level-reading",
            payload,
            dedupe_key=f"web/level-reading:{occurred_at}",
        )

    def enqueue_latest(self, topic: str, payload: dict[str, Any], dedupe_key: str) -> int:
        if not topic or not dedupe_key:
            raise ValueError("topic y dedupe_key son obligatorios")
        encoded = self._encode_payload(payload)
        with self._lock:
            self.connection.execute(
                """INSERT INTO outbox(topic,payload,dedupe_key) VALUES (?,?,?)
                ON CONFLICT(dedupe_key) DO UPDATE SET topic=excluded.topic,payload=excluded.payload,
                created_at=CURRENT_TIMESTAMP,sent_at=NULL,attempt_count=0,next_attempt_at=NULL,
                last_error=NULL,discarded_at=NULL""",
                (topic, encoded, dedupe_key),
            )
            row = self.connection.execute(
                "SELECT id FROM outbox WHERE dedupe_key=?", (dedupe_key,)
            ).fetchone()
            self.connection.commit()
            if row is None:
                raise RuntimeError("no se pudo guardar el último estado")
            return int(row[0])

    def pending(
        self,
        topics: tuple[str, ...] | None = None,
        *,
        limit: int = 100,
    ) -> list[tuple[int, str, dict[str, Any]]]:
        if not 1 <= limit <= 1000:
            raise ValueError("limit debe estar entre 1 y 1000")
        with self._lock:
            parameters: list[Any] = []
            topic_filter = ""
            if topics:
                topic_filter = f" AND topic IN ({','.join('?' for _ in topics)})"
                parameters.extend(topics)
            parameters.append(limit)
            rows = self.connection.execute(
                f"""SELECT id,topic,payload FROM outbox
                WHERE sent_at IS NULL AND discarded_at IS NULL
                  AND (next_attempt_at IS NULL OR next_attempt_at <= CURRENT_TIMESTAMP)
                  {topic_filter}
                ORDER BY id LIMIT ?""",
                parameters,
            ).fetchall()
            valid: list[tuple[int, str, dict[str, Any]]] = []
            for row in rows:
                try:
                    payload = json.loads(row[2])
                    if not isinstance(payload, dict):
                        raise ValueError("payload no es objeto")
                except (json.JSONDecodeError, ValueError, TypeError) as exc:
                    self._mark_failed_locked(int(row[0]), f"invalid_payload:{type(exc).__name__}")
                    continue
                valid.append((int(row[0]), str(row[1]), payload))
            self.connection.commit()
            return valid

    def mark_sent(self, event_id: int) -> None:
        with self._lock:
            self.connection.execute(
                """UPDATE outbox SET sent_at=CURRENT_TIMESTAMP,next_attempt_at=NULL,
                last_error=NULL WHERE id=? AND discarded_at IS NULL""",
                (event_id,),
            )
            self.connection.commit()

    def mark_retry(self, event_id: int, error: str, retry_seconds: float) -> None:
        with self._lock:
            row = self.connection.execute(
                "SELECT attempt_count FROM outbox WHERE id=? AND sent_at IS NULL",
                (event_id,),
            ).fetchone()
            if row is None:
                return
            delay = max(1, min(3600, int(retry_seconds) * (2 ** min(int(row[0]), 9))))
            self.connection.execute(
                """UPDATE outbox SET attempt_count=attempt_count+1,last_error=?,
                next_attempt_at=datetime('now', ?) WHERE id=? AND sent_at IS NULL""",
                (error[:240], f"+{delay} seconds", event_id),
            )
            self.connection.commit()

    def prune_outbox(self, sent_retention_days: int = 30) -> int:
        days = max(1, min(365, int(sent_retention_days)))
        with self._lock:
            cursor = self.connection.execute(
                "DELETE FROM outbox WHERE sent_at < datetime('now', ?)",
                (f"-{days} days",),
            )
            self.connection.commit()
            return int(cursor.rowcount)

    def mark_failed(self, event_id: int, error: str) -> None:
        with self._lock:
            self._mark_failed_locked(event_id, error)
            self.connection.commit()

    def technology_adoption_policy(self, site_id: str) -> tuple[str, int] | None:
        with self._lock:
            row = self.connection.execute(
                "SELECT stage,revision FROM technology_adoption_policy WHERE site_id=?",
                (site_id,),
            ).fetchone()
            return (str(row[0]), int(row[1])) if row is not None else None

    def save_technology_adoption_policy(
        self,
        site_id: str,
        stage: str,
        revision: int,
        updated_at: str,
    ) -> None:
        if stage not in {"assisted", "rfid_only", "full"} or revision <= 0:
            raise ValueError("política de adopción inválida")
        with self._lock:
            self.connection.execute(
                """INSERT INTO technology_adoption_policy(site_id,stage,revision,updated_at)
                VALUES (?,?,?,?) ON CONFLICT(site_id) DO UPDATE SET
                    stage=excluded.stage,revision=excluded.revision,updated_at=excluded.updated_at
                WHERE excluded.revision>=technology_adoption_policy.revision""",
                (site_id, stage, revision, updated_at),
            )
            self.connection.commit()

    def close(self) -> None:
        with self._lock:
            self.connection.close()

    def _mark_failed_locked(self, event_id: int, error: str) -> None:
        self.connection.execute(
            """UPDATE outbox SET attempt_count=attempt_count+1,last_error=?,
            discarded_at=CURRENT_TIMESTAMP WHERE id=? AND sent_at IS NULL""",
            (error[:240], event_id),
        )

    def _migrate_outbox(self) -> None:
        columns = {
            row[1]
            for row in self.connection.execute("PRAGMA table_info(outbox)").fetchall()
        }
        migrations = {
            "dedupe_key": "ALTER TABLE outbox ADD COLUMN dedupe_key TEXT",
            "attempt_count": "ALTER TABLE outbox ADD COLUMN attempt_count INTEGER NOT NULL DEFAULT 0",
            "next_attempt_at": "ALTER TABLE outbox ADD COLUMN next_attempt_at TEXT",
            "last_error": "ALTER TABLE outbox ADD COLUMN last_error TEXT",
            "discarded_at": "ALTER TABLE outbox ADD COLUMN discarded_at TEXT",
        }
        for column, statement in migrations.items():
            if column not in columns:
                self.connection.execute(statement)
        self.connection.execute("DROP INDEX IF EXISTS idx_outbox_dedupe_key")
        self.connection.execute(
            "CREATE UNIQUE INDEX idx_outbox_dedupe_key ON outbox(dedupe_key)"
        )
        self.connection.execute(
            "CREATE INDEX IF NOT EXISTS idx_outbox_delivery ON outbox(topic,sent_at,discarded_at,next_attempt_at,id)"
        )
        self.connection.execute(
            "CREATE INDEX IF NOT EXISTS idx_outbox_sent ON outbox(sent_at)"
        )

    def _migrate_adoption_columns(self) -> None:
        table_migrations = {
            "transactions": {
                "authorization_evidence": "ALTER TABLE transactions ADD COLUMN authorization_evidence TEXT NOT NULL DEFAULT 'legacy'",
                "adoption_stage": "ALTER TABLE transactions ADD COLUMN adoption_stage TEXT",
                "equipment_issue": "ALTER TABLE transactions ADD COLUMN equipment_issue TEXT",
            },
            "manual_mode_sessions": {
                "purpose": "ALTER TABLE manual_mode_sessions ADD COLUMN purpose TEXT NOT NULL DEFAULT 'manual'",
            },
            "manual_mode_segments": {
                "legacy_id": "ALTER TABLE manual_mode_segments ADD COLUMN legacy_id TEXT",
                "equipment_id": "ALTER TABLE manual_mode_segments ADD COLUMN equipment_id TEXT",
                "authorization_evidence": "ALTER TABLE manual_mode_segments ADD COLUMN authorization_evidence TEXT NOT NULL DEFAULT 'assisted'",
                "adoption_stage": "ALTER TABLE manual_mode_segments ADD COLUMN adoption_stage TEXT",
                "assisted_mode": "ALTER TABLE manual_mode_segments ADD COLUMN assisted_mode INTEGER NOT NULL DEFAULT 0",
                "equipment_issue": "ALTER TABLE manual_mode_segments ADD COLUMN equipment_issue TEXT",
            },
        }
        for table, migrations in table_migrations.items():
            columns = {
                row[1]
                for row in self.connection.execute(
                    f"PRAGMA table_info({table})"
                ).fetchall()
            }
            for column, statement in migrations.items():
                if column not in columns:
                    self.connection.execute(statement)
        self.connection.execute(
            """CREATE UNIQUE INDEX IF NOT EXISTS idx_manual_mode_segment_legacy_id
            ON manual_mode_segments(legacy_id) WHERE legacy_id IS NOT NULL"""
        )

    def _migrate_manual_mode_transaction_ids(self) -> None:
        """Normaliza cargas manuales antiguas al UUID usado por una carga normal.

        Las versiones anteriores anteponían ``manual-segment-`` al UUID y
        publicaban el ID de la sesión como referencia visible. Se conserva el
        identificador anterior en ``legacy_id`` y la sesión sigue disponible
        en el payload, pero la identidad primaria pasa a ser el UUID de la carga.
        """

        prefix = "manual-segment-"
        rows = self.connection.execute(
            """SELECT id,schedule_id FROM manual_mode_segments
            WHERE id LIKE 'manual-segment-%'"""
        ).fetchall()
        if not rows:
            return

        identifiers: dict[str, tuple[str, str]] = {}
        for old_id, schedule_id in rows:
            old_identifier = str(old_id)
            transaction_id = old_identifier[len(prefix) :]
            if not transaction_id:
                continue
            conflict = self.connection.execute(
                "SELECT 1 FROM manual_mode_segments WHERE id=?", (transaction_id,)
            ).fetchone()
            if conflict is not None:
                raise RuntimeError(
                    "la migración de identidad manual encontró un UUID duplicado"
                )
            identifiers[old_identifier] = (transaction_id, str(schedule_id))

        outbox_rows = self.connection.execute(
            """SELECT id,payload,dedupe_key FROM outbox
            WHERE topic='web/fuel-movement'"""
        ).fetchall()
        for event_id, encoded, dedupe_key in outbox_rows:
            try:
                payload = json.loads(str(encoded))
            except (json.JSONDecodeError, TypeError):
                continue
            if not isinstance(payload, dict):
                continue
            migration = identifiers.get(str(payload.get("id", "")))
            if migration is None:
                continue
            transaction_id, schedule_id = migration
            payload["id"] = transaction_id
            payload["reference"] = transaction_id
            payload["manualModeSessionId"] = schedule_id
            next_dedupe_key = (
                f"web/fuel-movement:{transaction_id}"
                if str(dedupe_key).startswith("web/fuel-movement:manual-segment-")
                else dedupe_key
            )
            self.connection.execute(
                "UPDATE outbox SET payload=?,dedupe_key=? WHERE id=?",
                (self._encode_payload(payload), next_dedupe_key, event_id),
            )

        for old_identifier, (transaction_id, _) in identifiers.items():
            self.connection.execute(
                """UPDATE manual_mode_segments SET id=?,legacy_id=?
                WHERE id=?""",
                (transaction_id, old_identifier, old_identifier),
            )

    @staticmethod
    def _encode_payload(payload: dict[str, Any]) -> str:
        encoded = json.dumps(payload, separators=(",", ":"), sort_keys=True)
        if len(encoded.encode("utf-8")) > 64 * 1024:
            raise ValueError("payload excede 64 KiB")
        return encoded
