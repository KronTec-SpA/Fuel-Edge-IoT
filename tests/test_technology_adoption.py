from __future__ import annotations

import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

from fuel_edge.access import AccessContext, TechnologyAdoptionStage
from fuel_edge.domain import EdgeEvent, EdgeState, FuelEdgeMachine
from fuel_edge.manual_mode import ManualModeCoordinator
from fuel_edge.service import FuelEdgeService
from fuel_edge.storage import EventStore
from fuel_edge.technology_adoption import (
    TechnologyAdoptionCoordinator,
    TechnologyAdoptionPolicy,
)


class _PolicyWeb:
    def __init__(self, policy: TechnologyAdoptionPolicy) -> None:
        self.policy = policy

    def current_policy(self) -> TechnologyAdoptionPolicy:
        return self.policy


class TechnologyAdoptionTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.path = Path(self.temporary.name) / "edge.db"
        self.store = EventStore(self.path)
        self.machine = FuelEdgeMachine()
        self.service = FuelEdgeService(self.machine, self.store, pulses_per_liter=100)
        self.service.assign("rpi-01", "fundo-01")

    def tearDown(self) -> None:
        self.store.close()
        self.temporary.cleanup()

    def test_coordinator_applies_and_persists_the_policy_revision(self) -> None:
        web = _PolicyWeb(
            TechnologyAdoptionPolicy(
                site_id="fundo-01",
                stage=TechnologyAdoptionStage.RFID_ONLY,
                revision=2,
            )
        )
        coordinator = TechnologyAdoptionCoordinator(web, self.service)

        self.assertTrue(coordinator.refresh())
        self.assertEqual(
            self.machine.technology_adoption_stage,
            TechnologyAdoptionStage.RFID_ONLY,
        )
        self.assertEqual(self.store.technology_adoption_policy("fundo-01"), ("rfid_only", 2))

        restarted_machine = FuelEdgeMachine()
        restarted = FuelEdgeService(restarted_machine, self.store, pulses_per_liter=100)
        restarted.assign("rpi-01", "fundo-01")
        self.assertEqual(
            restarted_machine.technology_adoption_stage,
            TechnologyAdoptionStage.RFID_ONLY,
        )
        self.assertEqual(restarted_machine.adoption_policy_revision, 2)

    def test_same_revision_cannot_be_reinterpreted_as_another_stage(self) -> None:
        self.service.update_technology_adoption_policy("rfid_only", 2)

        with self.assertRaisesRegex(ValueError, "revisión de adopción"):
            self.service.update_technology_adoption_policy("assisted", 2)

    def test_deactivation_clears_assisted_context_for_new_activity(self) -> None:
        self.service.update_technology_adoption_policy("assisted", 2)
        self.service.start_manual_mode(
            "adoption-old", ends_at=datetime.now(timezone.utc) + timedelta(hours=1),
            purpose="adoption_assisted",
        )
        self.service.record_k24_pulse(200)

        class ClosedWindowWeb:
            def current_schedule(self):
                return None

            def report_state(self, schedule_id, state):
                self.report = (schedule_id, state)

        web = ClosedWindowWeb()
        coordinator = ManualModeCoordinator(web, self.service)
        self.service.update_technology_adoption_policy("full", 3)
        coordinator.refresh()
        self.assertEqual(web.report, ("adoption-old", "completed"))
        self.assertIs(self.machine.state, EdgeState.LOCKED)
        self.assertFalse(self.machine.relay.is_energized)
        self.assertIsNone(self.machine.manual_mode_schedule_id)
        self.assertIsNone(self.machine.active_adoption_stage)
        self.assertEqual(self.machine.manual_mode_purpose, "manual")
        old = self.store.pending(("web/fuel-movement",))[0][2]
        self.assertTrue(old["assistedMode"])
        self.assertEqual(old["adoptionStage"], "assisted")

        self.service.present_credential("tag-new")
        denied = self.service.authorize(AccessContext(
            credential_id="tag-new", operator_id="op-new",
            credential_active=True, operator_active=True,
        ))
        self.assertIs(denied.event, EdgeEvent.AUTHORIZATION_DENIED)
        self.assertFalse(self.machine.relay.is_energized)

        self.service.start_manual_mode(
            "manual-new", ends_at=datetime.now(timezone.utc) + timedelta(hours=1),
        )
        self.service.record_k24_pulse(300)
        self.service.stop_manual_mode()
        new = next(payload for _, _, payload in self.store.pending(("web/fuel-movement",))
                   if payload.get("manualModeSessionId") == "manual-new")
        self.assertFalse(new["assistedMode"])
        self.assertIsNone(new["adoptionStage"])

        self.service.present_credential("tag-full")
        authorized = self.service.authorize(AccessContext(
            credential_id="tag-full", operator_id="op-full",
            credential_active=True, operator_active=True,
            equipment_id="tractor", equipment_active=True,
            equipment_present=True, equipment_authenticated=True,
            association_active=True,
            assignment_valid_until=datetime.now(timezone.utc) + timedelta(days=1),
        ))
        self.assertIs(authorized.event, EdgeEvent.AUTHORIZATION_GRANTED)
        self.service.record_k24_pulse(400)
        self.service.apply(EdgeEvent.NFC_REMOVED, reason="nfc_removed")
        self.service.tick()
        normal = next(payload for _, _, payload in self.store.pending(("web/fuel-movement",))
                      if payload.get("operatorId") == "op-full")
        self.assertEqual(normal["authorizationEvidence"], "full")
        self.assertEqual(normal["adoptionStage"], "full")
        self.assertFalse(normal["assistedMode"])
        self.assertFalse(normal.get("manualMode", False))

        restarted_machine = FuelEdgeMachine()
        restarted = FuelEdgeService(restarted_machine, self.store, pulses_per_liter=100)
        restarted.assign("rpi-01", "fundo-01")
        self.assertIs(restarted_machine.technology_adoption_stage, TechnologyAdoptionStage.FULL)
        self.assertEqual(restarted_machine.manual_mode_purpose, "manual")

    def test_policy_from_another_site_is_rejected(self) -> None:
        coordinator = TechnologyAdoptionCoordinator(
            _PolicyWeb(
                TechnologyAdoptionPolicy(
                    site_id="otro-fundo",
                    stage=TechnologyAdoptionStage.ASSISTED,
                    revision=2,
                )
            ),
            self.service,
        )

        with self.assertRaisesRegex(ValueError, "otro fundo"):
            coordinator.refresh()

    def test_mim_loss_downgrades_the_active_ledger_without_cutting_the_relay(self) -> None:
        self.service.update_technology_adoption_policy("rfid_only", 2)
        self.service.present_credential("tag-01")
        self.service.authorize(
            AccessContext(
                credential_id="tag-01",
                operator_id="operator-01",
                credential_active=True,
                operator_active=True,
                equipment_id="tractor-01",
                equipment_active=True,
                equipment_present=True,
                equipment_authenticated=True,
                association_active=True,
                assignment_valid_until=datetime.now(timezone.utc) + timedelta(days=1),
            )
        )
        transaction_id = self.machine.transaction_id

        self.service.downgrade_active_equipment("equipment_presence_lost")

        self.assertTrue(self.machine.relay.is_energized)
        row = self.store.connection.execute(
            """SELECT equipment_id,authorization_evidence,equipment_issue
            FROM transactions WHERE id=?""",
            (transaction_id,),
        ).fetchone()
        self.assertEqual(row, (None, "rfid_only", "equipment_presence_lost"))


if __name__ == "__main__":
    unittest.main()
