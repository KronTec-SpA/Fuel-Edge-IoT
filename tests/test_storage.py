import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path
from threading import Thread

from fuel_edge.domain import EdgeEvent, FuelEdgeMachine
from fuel_edge.storage import EventStore, format_liters_cl


class EventStoreTests(unittest.TestCase):
    def test_liters_use_chilean_number_format_in_alert_text(self) -> None:
        self.assertEqual(format_liters_cl(1.93), "1,930")
        self.assertEqual(format_liters_cl(1930), "1.930,000")

    def test_worker_thread_can_persist_mqtt_event(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            store = EventStore(Path(directory) / "edge.db")
            errors = []

            def write_from_worker() -> None:
                try:
                    store.enqueue("edge/audit", {"source": "mqtt-worker"})
                except Exception as exc:  # pragma: no cover - sólo se inspecciona al fallar
                    errors.append(exc)

            worker = Thread(target=write_from_worker)
            worker.start()
            worker.join()

            self.assertEqual(errors, [])
            self.assertEqual(store.pending()[0][2], {"source": "mqtt-worker"})
            store.close()

    def test_outbox_persists_and_marks_events(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            store = EventStore(Path(directory) / "edge.db")
            event_id = store.enqueue("telemetry/test", {"value": 7})

            self.assertEqual(store.pending(), [(event_id, "telemetry/test", {"value": 7})])
            store.mark_sent(event_id)
            self.assertEqual(store.pending(), [])
            store.close()

    def test_audit_and_transaction_are_persisted(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            store = EventStore(Path(directory) / "edge.db")
            machine = FuelEdgeMachine()
            record = machine.apply(
                EdgeEvent.ASSIGN, module_id="module-01", site_id="site-01"
            )
            audit_id = store.record_audit(machine.audit_payload(record))
            self.assertGreater(audit_id, 0)

            now = datetime.now(timezone.utc).isoformat()
            store.open_transaction("tx-01", "operator-01", "tractor-01", False, now)
            store.close_transaction("tx-01", now, "k24_inactivity", 1000, 10.0)
            row = store.connection.execute(
                "SELECT status, pulses, liters FROM transactions WHERE id = 'tx-01'"
            ).fetchone()
            self.assertEqual(row, ("closed", 1000, 10.0))
            web_events = store.pending(("web/fuel-movement",))
            self.assertEqual(len(web_events), 1)
            self.assertEqual(web_events[0][2]["liters"], 10.0)
            store.close_transaction("tx-01", now, "duplicate", 1000, 10.0)
            self.assertEqual(len(store.pending(("web/fuel-movement",))), 1)
            store.close()

    def test_corrupt_outbox_payload_is_quarantined(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            store = EventStore(Path(directory) / "edge.db")
            cursor = store.connection.execute(
                "INSERT INTO outbox(topic,payload) VALUES ('web/level-reading','not-json')"
            )
            store.connection.commit()
            self.assertEqual(store.pending(("web/level-reading",)), [])
            row = store.connection.execute(
                "SELECT discarded_at,last_error FROM outbox WHERE id=?", (cursor.lastrowid,)
            ).fetchone()
            self.assertIsNotNone(row[0])
            self.assertIn("invalid_payload", row[1])
            store.close()

    def test_power_loss_is_closed_on_recovery_and_enqueued_for_web(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            store = EventStore(Path(directory) / "edge.db")
            event_id = store.record_power_loss(
                lost_at="2026-08-24T23:20:03+00:00",
                loss_boot_id="boot-before",
            )
            self.assertEqual(
                store.record_power_loss(
                    lost_at="2026-08-24T23:20:04+00:00",
                    loss_boot_id="boot-before",
                ),
                event_id,
            )

            payload = store.close_open_power_loss(
                site_id="fundo-prueba",
                restored_at="2026-08-25T01:18:05+00:00",
                restore_boot_id="boot-after",
            )

            self.assertIsNotNone(payload)
            assert payload is not None
            self.assertEqual(payload["durationSeconds"], 7082)
            self.assertEqual(payload["source"], "ups_gpio24")
            self.assertEqual(store.power_supply_events()[0]["status"], "closed")
            queued = store.pending(("web/power-event",))
            self.assertEqual(len(queued), 1)
            self.assertEqual(queued[0][2], payload)
            self.assertIsNone(store.close_open_power_loss(
                site_id="fundo-prueba",
                restored_at="2026-08-25T01:18:06+00:00",
            ))
            store.close()

    def test_confirmed_power_outage_import_is_idempotent(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            store = EventStore(Path(directory) / "edge.db")
            arguments = {
                "site_id": "fundo-prueba",
                "lost_at": "2026-08-24T23:20:03+00:00",
                "restored_at": "2026-08-25T01:18:05+00:00",
                "source": "operator_confirmed",
            }
            first = store.record_completed_power_outage(**arguments)
            second = store.record_completed_power_outage(**arguments)
            self.assertEqual(first, second)
            self.assertEqual(len(store.power_supply_events()), 1)
            self.assertEqual(len(store.pending(("web/power-event",))), 1)
            store.close()

    def test_master_dispatch_is_structured_and_auditable_without_equipment(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            store = EventStore(Path(directory) / "edge.db")
            now = datetime.now(timezone.utc).isoformat()
            store.open_transaction("tx-master", "operator-emergency", None, True, now)
            store.close_transaction("tx-master", now, "k24_inactivity", 250, 25.0)

            payload = store.pending(("web/fuel-movement",))[0][2]

            self.assertEqual(payload["operatorId"], "operator-emergency")
            self.assertIsNone(payload["equipmentId"])
            self.assertTrue(payload["isMaster"])
            self.assertIn("Tarjeta maestra", payload["detail"])
            store.close()

    def test_legacy_manual_segment_ids_are_migrated_without_losing_session_trace(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "edge.db"
            old_id = "manual-segment-bbc8b607-dd88-4785-a5c1-d638cd0fb851"
            transaction_id = "bbc8b607-dd88-4785-a5c1-d638cd0fb851"
            schedule_id = "manual-mode-bbc8b607-dd88-4785-a5c1-d638cd0fb851"
            now = datetime.now(timezone.utc).isoformat()
            store = EventStore(path)
            store.connection.execute(
                """INSERT INTO manual_mode_sessions(id,started_at,scheduled_end,status)
                VALUES (?,?,?,'completed')""",
                (schedule_id, now, now),
            )
            store.connection.execute(
                """INSERT INTO manual_mode_segments(
                    id,schedule_id,opened_at,closed_at,pulses,liters,status
                ) VALUES (?,?,?,?,1,0.01,'closed')""",
                (old_id, schedule_id, now, now),
            )
            store.enqueue(
                "web/fuel-movement",
                {
                    "id": old_id,
                    "type": "dispatch",
                    "reference": schedule_id,
                    "manualMode": True,
                },
                dedupe_key=f"web/fuel-movement:{old_id}",
            )
            store.close()

            migrated = EventStore(path)
            row = migrated.connection.execute(
                "SELECT id,legacy_id,schedule_id FROM manual_mode_segments"
            ).fetchone()
            self.assertEqual(row, (transaction_id, old_id, schedule_id))
            payload = migrated.pending(("web/fuel-movement",))[0][2]
            self.assertEqual(payload["id"], transaction_id)
            self.assertEqual(payload["reference"], transaction_id)
            self.assertEqual(payload["manualModeSessionId"], schedule_id)
            migrated.close()
