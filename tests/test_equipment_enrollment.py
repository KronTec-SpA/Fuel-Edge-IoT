from __future__ import annotations

import asyncio
from concurrent.futures import ThreadPoolExecutor
import hashlib
import hmac
from pathlib import Path
import sys
import tempfile
from threading import Barrier, Lock
import types
import unittest
from unittest.mock import patch

from fuel_edge.equipment_enrollment import (
    ADVERTISEMENT_COMPANY_ID,
    ADVERTISEMENT_FLAG_CONFIGURED,
    ADVERTISEMENT_FLAG_ENROLLMENT_READY,
    BleEnrollmentRuntime,
    CHALLENGE_UUID,
    CLAIM_DOMAIN,
    EquipmentIdentity,
    EquipmentRegistryRemovalCoordinator,
    IDENTITY_UUID,
    ModuleCredential,
    PROTOCOL_VERSION,
    RESPONSE_UUID,
    WIFI_PROTOCOL_VERSION,
    WifiEnrollmentCoordinator,
    build_claim_packet,
    expected_auth_response,
    load_equipment_registry,
    parse_identity,
    remove_equipment_registry_module,
    wifi_claim_receipt,
    wifi_client_proof,
    wifi_response_proof,
    wifi_server_proof,
)


SECRET = bytes(range(32))


class EquipmentEnrollmentTests(unittest.TestCase):
    def test_parses_unclaimed_factory_identity(self) -> None:
        identity = parse_identity(
            b'{"version":4,"module_id":"xiao-001","equipment_id":"",'
            b'"site_id":"","device_name":"","firmware":"0.6.0",'
            b'"claimed":false}'
        )
        self.assertEqual(identity.module_id, "xiao-001")
        self.assertFalse(identity.claimed)
        with self.assertRaises(ValueError):
            parse_identity(
                b'{"version":2,"module_id":"xiao-001","equipment_id":"",'
                b'"site_id":"","device_name":"",'
                b'"firmware":"0.3.0","claimed":false}'
            )

    def test_ble_v4_response_binds_both_nonces_and_identity(self) -> None:
        credential = ModuleCredential("xiao-001", SECRET)
        identity = EquipmentIdentity("xiao-001", "", "", "", "0.6.0", False)
        challenge = bytes(range(32, 64))
        module_nonce = bytes(range(64, 96))
        response = expected_auth_response(
            credential, identity, challenge, module_nonce
        )
        expected_tag = hmac.new(
            SECRET,
            b"fuel-edge/equipment/v1\x00xiao-001\x00\x00"
            + challenge
            + module_nonce,
            hashlib.sha256,
        ).digest()
        self.assertEqual(response, module_nonce + expected_tag)
        self.assertEqual(len(response), 64)
        self.assertNotEqual(
            response,
            expected_auth_response(
                credential, identity, challenge, bytes(reversed(module_nonce))
            ),
        )
        self.assertNotEqual(
            response,
            expected_auth_response(
                credential,
                identity,
                bytes(reversed(challenge)),
                module_nonce,
            ),
        )
        assigned_identity = EquipmentIdentity(
            "xiao-001",
            "eq-001",
            "campo-prueba",
            "Tractor Azul",
            "0.6.0",
            True,
        )
        self.assertNotEqual(
            response,
            expected_auth_response(
                credential, assigned_identity, challenge, module_nonce
            ),
        )

    def test_claim_packet_contains_signed_site_equipment_and_name(self) -> None:
        credential = ModuleCredential("xiao-001", SECRET)
        nonce = bytes(range(16))
        packet = build_claim_packet(
            credential,
            site_id="campo-norte",
            equipment_id="eq-001",
            name="Tractor Azul",
            nonce=nonce,
        )
        self.assertEqual(packet[0], PROTOCOL_VERSION)
        self.assertEqual(packet[1:17], nonce)
        payload_without_tag = packet[:-32]
        self.assertEqual(
            payload_without_tag,
            bytes([PROTOCOL_VERSION])
            + nonce
            + bytes([len(b"campo-norte")])
            + b"campo-norte"
            + bytes([len(b"eq-001")])
            + b"eq-001"
            + bytes([len(b"Tractor Azul")])
            + b"Tractor Azul",
        )
        tag = packet[-32:]
        message = (
            CLAIM_DOMAIN
            + b"xiao-001\x00"
            + nonce
            + b"campo-norte\x00eq-001\x00Tractor Azul"
        )
        self.assertEqual(tag, hmac.new(SECRET, message, hashlib.sha256).digest())
        self.assertLessEqual(len(payload_without_tag), 209)

    def test_registry_requires_private_permissions(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "registry.toml"
            path.write_text(
                '[[modules]]\nmodule_id="xiao-001"\n'
                f'secret_hex="{SECRET.hex()}"\nactive=true\n',
                encoding="utf-8",
            )
            path.chmod(0o600)
            self.assertEqual(load_equipment_registry(path)["xiao-001"].secret, SECRET)
            path.chmod(0o644)
            with self.assertRaises(PermissionError):
                load_equipment_registry(path)

    def test_permanent_removal_atomically_drops_mim_from_private_registry(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "registry.toml"
            path.write_text(
                "\n".join((
                    "[[modules]]",
                    'module_id="xiao-001"',
                    f'secret_hex="{SECRET.hex()}"',
                    "active=true",
                    "[[modules]]",
                    'module_id="xiao-002"',
                    f'secret_hex="{bytes(reversed(SECRET)).hex()}"',
                    "active=true",
                    "",
                )),
                encoding="utf-8",
            )
            path.chmod(0o600)

            self.assertTrue(remove_equipment_registry_module(path, "xiao-001"))
            remaining = load_equipment_registry(path)

            self.assertEqual(set(remaining), {"xiao-002"})
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)
            self.assertFalse(remove_equipment_registry_module(path, "xiao-001"))

    def test_registry_removal_coordinator_confirms_and_forces_validator_sync(self) -> None:
        class RemovalWeb:
            command = {"id": "mim-remove-01", "moduleId": "xiao-001"}

            def __init__(self) -> None:
                self.results = []

            def next_registry_removal_sync(self):
                return self.command

            def registry_removal_result_sync(self, command_id, **result):
                self.results.append((command_id, result))
                self.command = None

        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "registry.toml"
            path.write_text(
                '[[modules]]\nmodule_id="xiao-001"\n'
                f'secret_hex="{SECRET.hex()}"\nactive=true\n',
                encoding="utf-8",
            )
            path.chmod(0o600)
            web = RemovalWeb()
            synchronizations = []
            coordinator = EquipmentRegistryRemovalCoordinator(
                web, path, on_change=lambda: synchronizations.append(True)
            )

            self.assertTrue(coordinator.refresh())
            self.assertEqual(load_equipment_registry(path), {})
            self.assertEqual(synchronizations, [True])
            self.assertEqual(web.results, [("mim-remove-01", {"success": True})])

    def test_wifi_proofs_bind_both_nonces_action_and_payload(self) -> None:
        credential = ModuleCredential("xiao-001", SECRET)
        client_nonce = bytes(range(32))
        server_nonce = bytes(range(32, 64))
        server = wifi_server_proof(
            credential, client_nonce, server_nonce, "status", 30
        )
        status = wifi_client_proof(
            credential,
            client_nonce,
            server_nonce,
            "status",
            '{"firmware":"1.0.0","bleProtocol":4,"rssi":-40}',
        )
        confirm = wifi_client_proof(
            credential,
            client_nonce,
            server_nonce,
            "confirm",
            '{"commandId":"enr-1"}',
        )
        self.assertEqual(len(server), 32)
        self.assertEqual(
            server,
            hmac.new(
                SECRET,
                b"fuel-edge/equipment/wifi/server/v2\x00"
                + b"xiao-001\x00"
                + client_nonce
                + server_nonce
                + b"status\x00"
                + (30).to_bytes(4, "big"),
                hashlib.sha256,
            ).digest(),
        )
        self.assertEqual(
            status,
            hmac.new(
                SECRET,
                b"fuel-edge/equipment/wifi/client/v2\x00"
                + b"xiao-001\x00"
                + client_nonce
                + server_nonce
                + b"status\x00"
                + b'{"firmware":"1.0.0","bleProtocol":4,"rssi":-40}',
                hashlib.sha256,
            ).digest(),
        )
        self.assertNotEqual(
            server,
            wifi_server_proof(
                credential, client_nonce, server_nonce, "confirm", 30
            ),
        )
        self.assertNotEqual(
            server,
            wifi_server_proof(
                credential, client_nonce, server_nonce, "status", 29
            ),
        )
        self.assertNotEqual(status, confirm)
        claim_digest = hashlib.sha256(b"claim").digest()
        self.assertEqual(
            wifi_claim_receipt(credential, "enr-1", claim_digest),
            hmac.new(
                SECRET,
                b"fuel-edge/equipment/wifi/receipt/v2\x00"
                + b"xiao-001\x00enr-1"
                + claim_digest,
                hashlib.sha256,
            ).digest(),
        )

    def test_wifi_response_proof_has_unambiguous_v2_framing(self) -> None:
        credential = ModuleCredential("xiao-001", SECRET)
        client_nonce = bytes(range(32))
        server_nonce = bytes(range(32, 64))
        payload = '{"firmware":"1.0.0","bleProtocol":4,"rssi":-40}'
        claim = bytes(range(64))
        proof = wifi_response_proof(
            credential,
            client_nonce,
            server_nonce,
            "status",
            payload,
            "claim",
            command_id="enr-1",
            claim=claim,
        )
        fields = (
            b"xiao-001",
            client_nonce,
            server_nonce,
            b"status",
            payload.encode(),
            b"claim",
            b"enr-1",
            claim,
        )
        preimage = b"fuel-edge/equipment/wifi/response/v2\x00" + b"".join(
            len(field).to_bytes(4, "big") + field for field in fields
        )
        self.assertEqual(proof, hmac.new(SECRET, preimage, hashlib.sha256).digest())
        self.assertNotEqual(
            proof,
            wifi_response_proof(
                credential,
                client_nonce,
                server_nonce,
                "status",
                payload + " ",
                "claim",
                command_id="enr-1",
                claim=claim,
            ),
        )
        self.assertNotEqual(
            proof,
            wifi_response_proof(
                credential,
                client_nonce,
                server_nonce,
                "status",
                payload,
                "claim",
                command_id="enr-1",
                claim=claim[:-1] + b"\xff",
            ),
        )
        self.assertNotEqual(
            proof,
            wifi_response_proof(
                credential,
                client_nonce,
                server_nonce,
                "status",
                payload,
                "pending",
            ),
        )

    def test_wifi_enrollment_requires_authentication_and_returns_signed_claim(self) -> None:
        credential = ModuleCredential("xiao-001", SECRET)

        class Web:
            sighting = None
            result = None

            def sighting_sync(self, identity, site_id, rssi):
                self.sighting = (identity, site_id, rssi)

            def next_command_sync(self, module_id):
                return {
                    "id": "enr-001",
                    "moduleId": module_id,
                    "siteId": "campo-prueba",
                    "equipmentId": "eq-001",
                    "name": "Tractor Azul",
                }

            def result_sync(self, command_id, *, success, error=None):
                self.result = (command_id, success, error)

        web = Web()
        coordinator = WifiEnrollmentCoordinator(
            "campo-prueba", {credential.module_id: credential}, web
        )
        client_nonce = bytes(range(32))
        challenge = coordinator.challenge({
            "version": WIFI_PROTOCOL_VERSION,
            "moduleId": credential.module_id,
            "action": "status",
            "clientNonce": client_nonce.hex(),
        })
        self.assertEqual(challenge["version"], WIFI_PROTOCOL_VERSION)
        self.assertEqual(challenge["action"], "status")
        server_nonce = bytes.fromhex(challenge["serverNonce"])
        self.assertEqual(
            bytes.fromhex(challenge["serverProof"]),
            wifi_server_proof(
                credential,
                client_nonce,
                server_nonce,
                "status",
                challenge["expiresInSeconds"],
            ),
        )
        payload = '{"firmware":"0.6.0","bleProtocol":4,"rssi":-43}'
        request = {
            "version": WIFI_PROTOCOL_VERSION,
            "moduleId": credential.module_id,
            "clientNonce": client_nonce.hex(),
            "serverNonce": server_nonce.hex(),
            "payload": payload,
            "clientProof": wifi_client_proof(
                credential, client_nonce, server_nonce, "status", payload
            ).hex(),
        }
        with self.assertRaises(PermissionError):
            coordinator.authenticated(
                "status", dict(request, clientProof="00" * 32)
            )
        response = coordinator.authenticated("status", request)
        self.assertEqual(response["state"], "claim")
        self.assertEqual(response["commandId"], "enr-001")
        self.assertEqual(
            bytes.fromhex(response["serverProof"]),
            wifi_response_proof(
                credential,
                client_nonce,
                server_nonce,
                "status",
                payload,
                "claim",
                command_id="enr-001",
                claim=bytes.fromhex(response["claim"]),
            ),
        )
        self.assertEqual(
            response["receipt"],
            wifi_claim_receipt(
                credential, "enr-001", bytes.fromhex(response["claimHash"])
            ).hex(),
        )
        self.assertEqual(web.sighting[1:], ("campo-prueba", -43))

        confirm_payload = (
            '{"commandId":"enr-001","claimHash":"'
            + response["claimHash"]
            + '","receipt":"'
            + response["receipt"]
            + '"}'
        )
        confirm_client_nonce = bytes(range(64, 96))
        confirm_challenge = coordinator.challenge({
            "version": WIFI_PROTOCOL_VERSION,
            "moduleId": credential.module_id,
            "action": "confirm",
            "clientNonce": confirm_client_nonce.hex(),
        })
        confirm_server_nonce = bytes.fromhex(confirm_challenge["serverNonce"])
        confirm_request = {
            "version": WIFI_PROTOCOL_VERSION,
            "moduleId": credential.module_id,
            "clientNonce": confirm_client_nonce.hex(),
            "serverNonce": confirm_server_nonce.hex(),
            "payload": confirm_payload,
            "clientProof": wifi_client_proof(
                credential,
                confirm_client_nonce,
                confirm_server_nonce,
                "confirm",
                confirm_payload,
            ).hex(),
        }
        confirmation = coordinator.authenticated("confirm", confirm_request)
        self.assertEqual(confirmation["state"], "confirmed")
        self.assertEqual(confirmation["commandId"], "enr-001")
        self.assertEqual(
            bytes.fromhex(confirmation["serverProof"]),
            wifi_response_proof(
                credential,
                confirm_client_nonce,
                confirm_server_nonce,
                "confirm",
                confirm_payload,
                "confirmed",
                command_id="enr-001",
            ),
        )
        self.assertEqual(web.result, ("enr-001", True, None))

        rejected_nonce = bytes(range(96, 128))
        rejected_challenge = coordinator.challenge({
            "version": WIFI_PROTOCOL_VERSION,
            "moduleId": credential.module_id,
            "action": "status",
            "clientNonce": rejected_nonce.hex(),
        })
        rejected = dict(
            request,
            clientNonce=rejected_nonce.hex(),
            serverNonce=rejected_challenge["serverNonce"],
            clientProof="00" * 32,
        )
        with self.assertRaises(PermissionError):
            coordinator.authenticated("status", rejected)

    def test_wifi_challenge_is_single_use(self) -> None:
        credential = ModuleCredential("xiao-001", SECRET)

        class Web:
            def __init__(self):
                self.sightings = 0

            def sighting_sync(self, identity, site_id, rssi):
                self.sightings += 1

            def next_command_sync(self, module_id):
                return None

        web = Web()
        coordinator = WifiEnrollmentCoordinator(
            "campo-prueba", {credential.module_id: credential}, web
        )
        client_nonce = bytes(range(32))
        challenge = coordinator.challenge({
            "version": WIFI_PROTOCOL_VERSION,
            "moduleId": credential.module_id,
            "action": "status",
            "clientNonce": client_nonce.hex(),
        })
        server_nonce = bytes.fromhex(challenge["serverNonce"])
        payload = '{"firmware":"0.6.0","bleProtocol":4,"rssi":-43}'
        request = {
            "version": WIFI_PROTOCOL_VERSION,
            "moduleId": credential.module_id,
            "clientNonce": client_nonce.hex(),
            "serverNonce": server_nonce.hex(),
            "payload": payload,
            "clientProof": wifi_client_proof(
                credential, client_nonce, server_nonce, "status", payload
            ).hex(),
        }
        response = coordinator.authenticated("status", request)
        self.assertEqual(response["state"], "pending")
        self.assertEqual(
            bytes.fromhex(response["serverProof"]),
            wifi_response_proof(
                credential,
                client_nonce,
                server_nonce,
                "status",
                payload,
                "pending",
            ),
        )
        with self.assertRaises(PermissionError):
            coordinator.authenticated("status", request)
        self.assertEqual(web.sightings, 1)

    def test_wifi_concurrent_replay_allows_exactly_one_side_effect(self) -> None:
        credential = ModuleCredential("xiao-001", SECRET)

        class Web:
            def __init__(self):
                self.sightings = 0
                self.lock = Lock()

            def sighting_sync(self, identity, site_id, rssi):
                with self.lock:
                    self.sightings += 1

            def next_command_sync(self, module_id):
                return None

        web = Web()
        coordinator = WifiEnrollmentCoordinator(
            "campo-prueba", {credential.module_id: credential}, web
        )
        client_nonce = bytes(range(32))
        challenge = coordinator.challenge({
            "version": WIFI_PROTOCOL_VERSION,
            "moduleId": credential.module_id,
            "action": "status",
            "clientNonce": client_nonce.hex(),
        })
        server_nonce = bytes.fromhex(challenge["serverNonce"])
        payload = '{"firmware":"0.6.0","bleProtocol":4,"rssi":-43}'
        request = {
            "version": WIFI_PROTOCOL_VERSION,
            "moduleId": credential.module_id,
            "clientNonce": client_nonce.hex(),
            "serverNonce": server_nonce.hex(),
            "payload": payload,
            "clientProof": wifi_client_proof(
                credential, client_nonce, server_nonce, "status", payload
            ).hex(),
        }
        barrier = Barrier(2)

        def authenticate() -> str:
            barrier.wait(timeout=2)
            try:
                coordinator.authenticated("status", request)
            except PermissionError:
                return "denied"
            return "accepted"

        with ThreadPoolExecutor(max_workers=2) as executor:
            outcomes = list(executor.map(lambda _index: authenticate(), range(2)))
        self.assertCountEqual(outcomes, ["accepted", "denied"])
        self.assertEqual(web.sightings, 1)

    def test_wifi_expired_or_wrong_action_challenge_is_consumed(self) -> None:
        credential = ModuleCredential("xiao-001", SECRET)

        class Web:
            sightings = 0

            def sighting_sync(self, identity, site_id, rssi):
                self.sightings += 1

            def next_command_sync(self, module_id):
                return None

        now = [100.0]
        web = Web()
        coordinator = WifiEnrollmentCoordinator(
            "campo-prueba",
            {credential.module_id: credential},
            web,
            challenge_ttl_seconds=2,
            clock=lambda: now[0],
        )
        client_nonce = bytes(range(32))
        challenge = coordinator.challenge({
            "version": WIFI_PROTOCOL_VERSION,
            "moduleId": credential.module_id,
            "action": "status",
            "clientNonce": client_nonce.hex(),
        })
        server_nonce = bytes.fromhex(challenge["serverNonce"])
        payload = '{"firmware":"0.6.0","bleProtocol":4,"rssi":-43}'
        request = {
            "version": WIFI_PROTOCOL_VERSION,
            "moduleId": credential.module_id,
            "clientNonce": client_nonce.hex(),
            "serverNonce": server_nonce.hex(),
            "payload": payload,
            "clientProof": wifi_client_proof(
                credential, client_nonce, server_nonce, "status", payload
            ).hex(),
        }
        now[0] += 2
        with self.assertRaises(PermissionError):
            coordinator.authenticated("status", request)

        now[0] += 1
        client_nonce = bytes(range(32, 64))
        challenge = coordinator.challenge({
            "version": WIFI_PROTOCOL_VERSION,
            "moduleId": credential.module_id,
            "action": "status",
            "clientNonce": client_nonce.hex(),
        })
        server_nonce = bytes.fromhex(challenge["serverNonce"])
        confirm_payload = '{"commandId":"enr-1"}'
        wrong_action = {
            "version": WIFI_PROTOCOL_VERSION,
            "moduleId": credential.module_id,
            "clientNonce": client_nonce.hex(),
            "serverNonce": server_nonce.hex(),
            "payload": confirm_payload,
            "clientProof": wifi_client_proof(
                credential,
                client_nonce,
                server_nonce,
                "confirm",
                confirm_payload,
            ).hex(),
        }
        with self.assertRaises(PermissionError):
            coordinator.authenticated("confirm", wrong_action)
        retry = dict(
            wrong_action,
            payload=payload,
            clientProof=wifi_client_proof(
                credential, client_nonce, server_nonce, "status", payload
            ).hex(),
        )
        with self.assertRaises(PermissionError):
            coordinator.authenticated("status", retry)
        self.assertEqual(web.sightings, 0)

    def test_wifi_challenge_cache_and_inputs_are_bounded(self) -> None:
        credentials = {
            f"xiao-00{index}": ModuleCredential(
                f"xiao-00{index}", bytes([index]) * 32
            )
            for index in range(1, 4)
        }
        coordinator = WifiEnrollmentCoordinator(
            "campo-prueba",
            credentials,
            object(),
            max_challenges=3,
            max_challenges_per_module=2,
        )

        def issue(module_id: str, marker: int) -> dict[str, object]:
            return coordinator.challenge({
                "version": WIFI_PROTOCOL_VERSION,
                "moduleId": module_id,
                "action": "status",
                "clientNonce": (bytes([marker]) * 32).hex(),
            })

        first = issue("xiao-001", 1)
        issue("xiao-001", 2)
        issue("xiao-001", 3)
        self.assertEqual(len(coordinator._challenges), 2)
        issue("xiao-002", 4)
        issue("xiao-003", 5)
        self.assertEqual(len(coordinator._challenges), 3)
        module_counts: dict[str, int] = {}
        for challenge in coordinator._challenges.values():
            module_counts[challenge.module_id] = (
                module_counts.get(challenge.module_id, 0) + 1
            )
        self.assertTrue(all(count <= 2 for count in module_counts.values()))

        payload = '{"firmware":"0.6.0","bleProtocol":4,"rssi":-43}'
        client_nonce = bytes([1]) * 32
        server_nonce = bytes.fromhex(str(first["serverNonce"]))
        with self.assertRaises(PermissionError):
            coordinator.authenticated("status", {
                "version": WIFI_PROTOCOL_VERSION,
                "moduleId": "xiao-001",
                "clientNonce": client_nonce.hex(),
                "serverNonce": server_nonce.hex(),
                "payload": payload,
                "clientProof": wifi_client_proof(
                    credentials["xiao-001"],
                    client_nonce,
                    server_nonce,
                    "status",
                    payload,
                ).hex(),
            })
        with self.assertRaises(ValueError):
            coordinator.challenge({
                "version": 1,
                "moduleId": "xiao-001",
                "action": "status",
                "clientNonce": (b"x" * 32).hex(),
            })
        with self.assertRaises(ValueError):
            coordinator.challenge({
                "version": WIFI_PROTOCOL_VERSION,
                "moduleId": "xiao-001",
                "clientNonce": (b"x" * 32).hex(),
            })
        with self.assertRaises(ValueError):
            WifiEnrollmentCoordinator(
                "campo-prueba", credentials, object(), max_challenges=0
            )
        with self.assertRaises(ValueError):
            WifiEnrollmentCoordinator(
                "campo-prueba",
                credentials,
                object(),
                challenge_ttl_seconds=121,
            )
        with self.assertRaises(ValueError):
            wifi_client_proof(
                credentials["xiao-001"],
                b"a" * 32,
                b"b" * 32,
                "status",
                "x" * 4097,
            )
        with self.assertRaises(ValueError):
            wifi_response_proof(
                credentials["xiao-001"],
                b"a" * 32,
                b"b" * 32,
                "status",
                "{}",
                "claim",
                command_id="enr-1",
                claim=b"x" * 257,
            )
        with self.assertRaises(ValueError):
            wifi_client_proof(
                ModuleCredential("x" * 64, SECRET),
                b"a" * 32,
                b"b" * 32,
                "status",
                "{}",
            )
        with self.assertRaises(ValueError):
            wifi_response_proof(
                credentials["xiao-001"],
                b"a" * 32,
                b"b" * 32,
                "confirm",
                "{}",
                "confirmed",
                command_id="invalid:command",
            )


class ConcurrentEquipmentEnrollmentTests(unittest.IsolatedAsyncioTestCase):
    async def test_ble_runtime_accepts_exact_v4_wire_response(self) -> None:
        credential = ModuleCredential("xiao-001", SECRET)
        identity_payload = (
            b'{"version":4,"module_id":"xiao-001","equipment_id":"eq-001",'
            b'"site_id":"campo-prueba","device_name":"Tractor Azul",'
            b'"firmware":"0.6.0","claimed":true}'
        )
        identity = parse_identity(identity_payload)
        module_nonce = bytes(range(64, 96))

        class Web:
            def __init__(self):
                self.seen = None

            async def sighting(self, seen_identity, site_id, rssi):
                self.seen = (seen_identity, site_id, rssi)

            async def next_command(self, module_id):
                return None

        class Client:
            latest = None

            def __init__(self, device, timeout):
                self.device = device
                self.timeout = timeout
                self.challenge = b""
                Client.latest = self

            async def __aenter__(self):
                return self

            async def __aexit__(self, exc_type, exc, traceback):
                return False

            async def write_gatt_char(self, uuid, value, *, response):
                self.assert_write(uuid, value, response)

            def assert_write(self, uuid, value, response):
                if uuid != CHALLENGE_UUID or response is not True:
                    raise AssertionError("escritura GATT inesperada")
                self.challenge = bytes(value)

            async def read_gatt_char(self, uuid):
                if uuid == IDENTITY_UUID:
                    return identity_payload
                if uuid == RESPONSE_UUID:
                    return expected_auth_response(
                        credential, identity, self.challenge, module_nonce
                    )
                raise AssertionError("lectura GATT inesperada")

        web = Web()
        runtime = BleEnrollmentRuntime(
            "campo-prueba", {credential.module_id: credential}, web
        )
        device = types.SimpleNamespace(address="AA:00:00:00:00:01")
        with patch.dict(
            sys.modules, {"bleak": types.SimpleNamespace(BleakClient=Client)}
        ):
            verified = await runtime._inspect(device, -47)
        self.assertEqual(verified, credential.module_id)
        self.assertEqual(len(Client.latest.challenge), 32)
        self.assertEqual(web.seen, (identity, "campo-prueba", -47))

    async def test_ble_runtime_rejects_legacy_or_misbound_responses(self) -> None:
        credential = ModuleCredential("xiao-001", SECRET)
        identity_payload = (
            b'{"version":4,"module_id":"xiao-001","equipment_id":"eq-001",'
            b'"site_id":"campo-prueba","device_name":"Tractor Azul",'
            b'"firmware":"0.6.0","claimed":true}'
        )
        identity = parse_identity(identity_payload)
        module_nonce = bytes(range(64, 96))
        other_nonce = bytes(reversed(module_nonce))

        def legacy_response(challenge: bytes) -> bytes:
            return expected_auth_response(
                credential, identity, challenge, module_nonce
            )[32:]

        def misbound_response(challenge: bytes) -> bytes:
            other = expected_auth_response(
                credential, identity, challenge, other_nonce
            )
            return module_nonce + other[32:]

        def tampered_response(challenge: bytes) -> bytes:
            valid = expected_auth_response(
                credential, identity, challenge, module_nonce
            )
            return valid[:-1] + bytes([valid[-1] ^ 1])

        class Web:
            def __init__(self):
                self.sightings = 0

            async def sighting(self, seen_identity, site_id, rssi):
                self.sightings += 1

            async def next_command(self, module_id):
                return None

        def client_type(response_builder):
            class Client:
                def __init__(self, device, timeout):
                    self.challenge = b""

                async def __aenter__(self):
                    return self

                async def __aexit__(self, exc_type, exc, traceback):
                    return False

                async def write_gatt_char(self, uuid, value, *, response):
                    if uuid != CHALLENGE_UUID or response is not True:
                        raise AssertionError("escritura GATT inesperada")
                    self.challenge = bytes(value)

                async def read_gatt_char(self, uuid):
                    if uuid == IDENTITY_UUID:
                        return identity_payload
                    if uuid == RESPONSE_UUID:
                        return response_builder(self.challenge)
                    raise AssertionError("lectura GATT inesperada")

            return Client

        device = types.SimpleNamespace(address="AA:00:00:00:00:01")
        for name, response_builder in {
            "legacy_v2": legacy_response,
            "otro_module_nonce": misbound_response,
            "tag_alterado": tampered_response,
        }.items():
            with self.subTest(response=name):
                web = Web()
                runtime = BleEnrollmentRuntime(
                    "campo-prueba", {credential.module_id: credential}, web
                )
                client = client_type(response_builder)
                with patch.dict(
                    sys.modules,
                    {"bleak": types.SimpleNamespace(BleakClient=client)},
                ):
                    with self.assertRaises(ValueError):
                        await runtime._inspect(device, -47)
                self.assertEqual(web.sightings, 0)

    async def test_connects_multiple_xiao_from_the_same_scan_window_concurrently(self) -> None:
        devices = [types.SimpleNamespace(address="AA:00:00:00:00:01"), types.SimpleNamespace(address="AA:00:00:00:00:02")]
        advertisement = types.SimpleNamespace(
            manufacturer_data={ADVERTISEMENT_COMPANY_ID: bytes([PROTOCOL_VERSION, 0])},
            rssi=-45,
        )

        class Scanner:
            def __init__(self, callback):
                self.callback = callback

            async def start(self):
                for device in devices:
                    self.callback(device, advertisement)

            async def stop(self):
                return None

        class Runtime(BleEnrollmentRuntime):
            active = 0
            peak = 0

            async def _inspect(self, device, rssi):
                self.active += 1
                self.peak = max(self.peak, self.active)
                await asyncio.sleep(0.05)
                self.active -= 1
                return device.address

        runtime = Runtime("campo-prueba", {}, object(), scan_seconds=1, max_connections=4)
        with patch.dict(sys.modules, {"bleak": types.SimpleNamespace(BleakScanner=Scanner)}):
            discovered, verified = await runtime.scan_once(1)
        self.assertEqual((discovered, verified), (2, 2))
        self.assertEqual(runtime.peak, 2)

    async def test_prioritizes_new_mim_before_already_configured_tractors(self) -> None:
        configured = types.SimpleNamespace(address="AA:00:00:00:00:01")
        factory = types.SimpleNamespace(address="AA:00:00:00:00:02")

        class Scanner:
            def __init__(self, callback):
                self.callback = callback

            async def start(self):
                self.callback(configured, types.SimpleNamespace(
                    manufacturer_data={ADVERTISEMENT_COMPANY_ID: bytes([
                        PROTOCOL_VERSION, ADVERTISEMENT_FLAG_CONFIGURED,
                    ])},
                    rssi=-35,
                ))
                self.callback(factory, types.SimpleNamespace(
                    manufacturer_data={ADVERTISEMENT_COMPANY_ID: bytes([
                        PROTOCOL_VERSION, ADVERTISEMENT_FLAG_ENROLLMENT_READY,
                    ])},
                    rssi=-60,
                ))

            async def stop(self):
                return None

        class Runtime(BleEnrollmentRuntime):
            order: list[str] = []

            async def _inspect(self, device, rssi):
                self.order.append(device.address)
                await asyncio.sleep(0)
                return device.address

        runtime = Runtime(
            "campo-prueba", {}, object(), scan_seconds=1, max_connections=1
        )
        with patch.dict(sys.modules, {"bleak": types.SimpleNamespace(BleakScanner=Scanner)}):
            await runtime.scan_once(1)
        self.assertEqual(runtime.order[0], factory.address)


if __name__ == "__main__":
    unittest.main()
