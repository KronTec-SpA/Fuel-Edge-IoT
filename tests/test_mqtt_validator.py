from __future__ import annotations

import unittest
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from threading import Event, Thread
from time import monotonic
from types import SimpleNamespace

from fuel_edge.mqtt_validator import (
    MAX_EQUIPMENT_REGISTRY_ENTRIES,
    EquipmentRegistryDistributor,
    MqttTlsConfig,
    MqttValidatorRuntime,
    MqttValidatorTransport,
)
from fuel_edge.rfid import RfidProof, build_rfid_response
from fuel_edge.validator_link import (
    CredentialPresenceUpdate,
    EquipmentPresenceUpdate,
    ValidatorDecision,
    ValidatorMessageCodec,
    ValidatorPresentation,
    ValidatorTransportError,
)


SECRET = bytes(range(32))


class FakePublishInfo:
    rc = 0

    def wait_for_publish(self, timeout: float) -> None:
        return None

    def is_published(self) -> bool:
        return True


class LoopbackMqttClient:
    def __init__(self) -> None:
        self.transport: MqttValidatorTransport | None = None
        self.published: list[tuple[str, bytes, int, bool]] = []
        self.on_connect = None
        self.on_subscribe = None
        self.on_disconnect = None
        self.on_message = None

    def publish(
        self, topic: str, payload: bytes, qos: int, retain: bool
    ) -> FakePublishInfo:
        self.published.append((topic, payload, qos, retain))
        if topic.endswith("/challenge"):
            validator_id, session_id, challenge = (
                ValidatorMessageCodec.decode_challenge(payload)
            )
            proof = RfidProof(
                "card-01",
                challenge,
                build_rfid_response(SECRET, "card-01", challenge),
            )
            response = ValidatorMessageCodec.encode_proof(
                validator_id, session_id, proof
            )
            message = SimpleNamespace(
                topic=topic.removesuffix("/challenge") + "/proof",
                payload=response,
            )
            assert self.transport is not None
            self.transport._on_message(self, None, message)
        return FakePublishInfo()


class StartingMqttClient(LoopbackMqttClient):
    def __init__(self) -> None:
        super().__init__()
        self.subscribe_mid = 41
        self.disconnected = False

    def connect(self, host: str, port: int, keepalive: int) -> int:
        return 0

    def loop_start(self) -> None:
        self.on_connect(self, None, None, 0, None)
        self.on_subscribe(self, None, self.subscribe_mid, [1] * 5, None)

    def subscribe(self, subscriptions):
        return 0, self.subscribe_mid

    def disconnect(self) -> None:
        self.disconnected = True

    def loop_stop(self) -> None:
        return None


class AsyncRetryingMqttClient(StartingMqttClient):
    def __init__(self) -> None:
        super().__init__()
        self.async_target: tuple[str, int, int] | None = None
        self.reconnect_delays: tuple[int, int] | None = None

    def reconnect_delay_set(self, *, min_delay: int, max_delay: int) -> None:
        self.reconnect_delays = (min_delay, max_delay)

    def connect_async(self, host: str, port: int, keepalive: int) -> None:
        self.async_target = (host, port, keepalive)
        return None

    def loop_start(self) -> None:
        # Simula que el broker/validador todavía no está disponible. El inicio
        # debe volver inmediatamente y dejar el reintento en el hilo de red.
        return None


class LoopStartErrorMqttClient(AsyncRetryingMqttClient):
    def loop_start(self) -> int:
        return 3


class CallbackRecoveringMqttClient(AsyncRetryingMqttClient):
    def __init__(self) -> None:
        super().__init__()
        self.transport: MqttValidatorTransport | None = None
        self.fail_publish = True
        self.reconnect_started = Event()
        self.allow_reconnect = Event()
        self.reconnect_calls = 0

    def publish(
        self, topic: str, payload: bytes, qos: int, retain: bool
    ) -> FakePublishInfo:
        if self.fail_publish:
            raise OSError("socket MQTT transitoriamente rota")
        return super().publish(topic, payload, qos, retain)

    def reconnect(self) -> int:
        self.reconnect_calls += 1
        self.reconnect_started.set()
        if not self.allow_reconnect.wait(1.0):
            raise TimeoutError("el test no liberó la reconexión")
        self.fail_publish = False
        assert self.transport is not None
        self.transport._on_connect(self, None, None, 0, None)
        self.transport._on_subscribe(
            self, None, self.subscribe_mid, [1] * 6, None
        )
        return 0


class RetryableConnectMqttClient(StartingMqttClient):
    def __init__(self) -> None:
        super().__init__()
        self.connect_attempts = 0

    def connect(self, host: str, port: int, keepalive: int) -> int:
        self.connect_attempts += 1
        if self.connect_attempts == 1:
            raise OSError("connect interrumpido")
        return super().connect(host, port, keepalive)


class RetryableLoopMqttClient(StartingMqttClient):
    def __init__(self) -> None:
        super().__init__()
        self.loop_attempts = 0

    def loop_start(self) -> None:
        self.loop_attempts += 1
        if self.loop_attempts == 1:
            raise OSError("no se pudo crear hilo MQTT")
        super().loop_start()


class RetryableAsyncMqttClient(AsyncRetryingMqttClient):
    def __init__(self) -> None:
        super().__init__()
        self.connect_attempts = 0

    def connect_async(self, host: str, port: int, keepalive: int) -> None:
        self.connect_attempts += 1
        if self.connect_attempts == 1:
            raise OSError("resolución MQTT interrumpida")
        return super().connect_async(host, port, keepalive)


class PassiveMqttClient(LoopbackMqttClient):
    """Publica sin fabricar una prueba; permite simular una caída durante RPC."""

    def __init__(self) -> None:
        super().__init__()
        self.published_event = Event()

    def publish(
        self, topic: str, payload: bytes, qos: int, retain: bool
    ) -> FakePublishInfo:
        self.published.append((topic, payload, qos, retain))
        self.published_event.set()
        return FakePublishInfo()

def config() -> MqttTlsConfig:
    return MqttTlsConfig(
        host="mqtt.internal",
        site_id="site-01",
        module_id="module-01",
        ca_certificate=Path("/etc/fuel-edge/ca.crt"),
        client_certificate=Path("/etc/fuel-edge/rpi.crt"),
        client_key=Path("/etc/fuel-edge/rpi.key"),
    )


class MqttValidatorTransportTests(unittest.TestCase):
    def test_mqtt_qos1_exchange_correlates_proof_and_decision(self) -> None:
        client = LoopbackMqttClient()
        transport = MqttValidatorTransport(config(), client=client)
        client.transport = transport
        transport._ready.set()

        proof = transport.exchange_proof(
            "validator-01", "session-01", b"c" * 32, 1.0
        )
        decision = ValidatorDecision(
            validator_id="validator-01",
            session_id="session-01",
            allowed=True,
            state="authorized",
            transaction_id="transaction-01",
        )
        transport.publish_decision(decision)

        self.assertIsNotNone(proof)
        self.assertEqual(proof.credential_id, "card-01")
        self.assertEqual(
            [entry[0].rsplit("/", 1)[-1] for entry in client.published],
            ["challenge", "decision"],
        )
        self.assertTrue(all(entry[2] == 1 for entry in client.published))

    def test_topic_wildcard_in_configuration_is_rejected(self) -> None:
        with self.assertRaises(ValueError):
            MqttTlsConfig(
                host="mqtt.internal",
                site_id="site/+",
                module_id="module-01",
                ca_certificate=Path("ca.crt"),
                client_certificate=Path("rpi.crt"),
                client_key=Path("rpi.key"),
            )

    def test_equipment_presence_topic_is_decoded_and_dispatched(self) -> None:
        client = LoopbackMqttClient()
        transport = MqttValidatorTransport(config(), client=client)
        received: list[EquipmentPresenceUpdate] = []
        transport.set_equipment_handler(received.append)
        update = EquipmentPresenceUpdate(
            validator_id="validator-01",
            session_id="session-01",
            module_id="equipment-module-0001",
            equipment_id="tractor-01",
            present=False,
            authenticated=False,
            lost_for_seconds=20,
        )
        message = SimpleNamespace(
            topic=(
                "fuel-edge/v1/site-01/module-01/validators/"
                "validator-01/equipment"
            ),
            payload=ValidatorMessageCodec.encode_equipment_presence(update),
        )

        transport._on_message(client, None, message)

        self.assertEqual(received, [update])

    def test_credential_presence_topic_is_decoded_and_dispatched(self) -> None:
        client = LoopbackMqttClient()
        transport = MqttValidatorTransport(config(), client=client)
        received: list[CredentialPresenceUpdate] = []
        transport.set_credential_handler(received.append)
        update = CredentialPresenceUpdate(
            validator_id="validator-01",
            session_id="session-01",
            credential_id="card-01",
            present=False,
            authenticated=False,
            absent_for_milliseconds=300,
        )
        message = SimpleNamespace(
            topic=(
                "fuel-edge/v1/site-01/module-01/validators/"
                "validator-01/credential"
            ),
            payload=ValidatorMessageCodec.encode_credential_presence(update),
        )

        transport._on_message(client, None, message)

        self.assertEqual(received, [update])

    def test_runtime_bluetooth_configuration_is_retained_and_acknowledged(self) -> None:
        client = LoopbackMqttClient()
        transport = MqttValidatorTransport(config(), client=client)
        transport._ready.set()
        confirmations: list[tuple[str, int, int]] = []
        hardware: list[tuple[str, bool, int]] = []
        transport.set_config_status_handler(
            lambda validator_id, threshold, revision: confirmations.append(
                (validator_id, threshold, revision)
            )
        )
        transport.set_hardware_status_handler(
            lambda validator_id, ready, version: hardware.append(
                (validator_id, ready, version)
            )
        )

        transport.publish_runtime_config("validator-01", -63, 4)
        published = client.published[-1]
        self.assertTrue(published[0].endswith("/validator-01/config"))
        self.assertTrue(published[3])
        self.assertEqual(__import__("json").loads(published[1])["ble_rssi_threshold"], -63)

        transport._on_message(client, None, SimpleNamespace(
            topic=published[0] + "/status",
            payload=b'{"version":1,"type":"validator.config.status","validator_id":"validator-01","ble_rssi_threshold":-63,"revision":4,"rfid_ready":false,"rfid_version":0}',
        ))
        self.assertEqual(confirmations, [("validator-01", -63, 4)])
        self.assertEqual(hardware, [("validator-01", False, 0)])

    def test_enrollment_purpose_is_sent_to_validator(self) -> None:
        client = LoopbackMqttClient()
        transport = MqttValidatorTransport(config(), client=client)
        client.transport = transport
        transport._ready.set()

        transport.exchange_proof(
            "validator-01", "session-enroll", b"e" * 32, 1.0,
            purpose="enrollment",
        )

        payload = __import__("json").loads(client.published[0][1])
        self.assertEqual(payload["purpose"], "enrollment")

    def test_enrollment_window_is_retained_for_the_validator(self) -> None:
        client = LoopbackMqttClient()
        transport = MqttValidatorTransport(config(), client=client)
        transport._ready.set()

        transport.publish_enrollment_window("validator-01", True)

        topic, encoded, qos, retained = client.published[-1]
        payload = __import__("json").loads(encoded)
        self.assertTrue(topic.endswith("/validator-01/enrollment"))
        self.assertEqual(payload["active"], True)
        self.assertEqual((qos, retained), (1, True))

    def test_closed_enrollment_clears_retained_state_then_notifies_live(self) -> None:
        client = LoopbackMqttClient()
        transport = MqttValidatorTransport(config(), client=client)
        transport._ready.set()

        transport.publish_enrollment_window("validator-01", False)

        cleared, closed = client.published[-2:]
        self.assertTrue(cleared[0].endswith("/validator-01/enrollment"))
        self.assertEqual(cleared[1:], (b"", 1, True))
        self.assertEqual(closed[0], cleared[0])
        self.assertFalse(__import__("json").loads(closed[1])["active"])
        self.assertEqual(closed[2:], (1, False))

    def test_equipment_registry_is_retained_and_scales_past_ten_tractors(self) -> None:
        client = LoopbackMqttClient()
        transport = MqttValidatorTransport(config(), client=client)
        transport._ready.set()
        entries = {
            f"mim-{index:02d}": bytes([index + 1]) * 32
            for index in range(12)
        }

        generation = transport.publish_equipment_registry(
            "validator-01", entries
        )

        topic, encoded, qos, retained = client.published[-1]
        payload = __import__("json").loads(encoded)
        self.assertTrue(topic.endswith("/validator-01/registry"))
        self.assertEqual((qos, retained), (1, True))
        self.assertEqual(payload["generation"], generation)
        self.assertEqual(len(payload["modules"]), 12)
        self.assertEqual(
            [row["module_id"] for row in payload["modules"]], sorted(entries)
        )

    def test_registry_acknowledgement_is_dispatched(self) -> None:
        client = LoopbackMqttClient()
        transport = MqttValidatorTransport(config(), client=client)
        received: list[tuple[str, str, int, int, bool]] = []
        transport.set_equipment_registry_status_handler(
            lambda *values: received.append(values)
        )
        generation = "a" * 64
        transport._on_message(client, None, SimpleNamespace(
            topic=(
                "fuel-edge/v1/site-01/module-01/validators/"
                "validator-01/registry/status"
            ),
            payload=__import__("json").dumps({
                "version": 1,
                "type": "validator.equipment.registry.status",
                "validator_id": "validator-01",
                "generation": generation,
                "module_count": 12,
                "capacity": MAX_EQUIPMENT_REGISTRY_ENTRIES,
                "persisted": True,
            }).encode(),
        ))
        self.assertEqual(received, [(
            "validator-01", generation, 12,
            MAX_EQUIPMENT_REGISTRY_ENTRIES, True,
        )])

    def test_distributor_reads_private_registry_without_field_intervention(self) -> None:
        client = LoopbackMqttClient()
        transport = MqttValidatorTransport(config(), client=client)
        transport._ready.set()
        with tempfile.TemporaryDirectory() as directory:
            registry = Path(directory) / "equipment-registry.toml"
            registry.write_text("\n".join(
                f'[[modules]]\nmodule_id="mim-{index:02d}"\n'
                f'secret_hex="{(bytes([index + 1]) * 32).hex()}"\nactive=true'
                for index in range(11)
            ) + "\n", encoding="utf-8")
            registry.chmod(0o600)
            distributor = EquipmentRegistryDistributor(
                registry, transport, "validator-01", republish_seconds=60
            )

            generation = distributor.sync_if_changed(force=True)
            self.assertIsNotNone(generation)
            self.assertIsNone(distributor.sync_if_changed())

            # Un acuse con cantidad incoherente no confirma una copia parcial.
            distributor.handle_status(
                "validator-01", generation, 10,
                MAX_EQUIPMENT_REGISTRY_ENTRIES, True,
            )
            self.assertIsNone(distributor.confirmed_generation)

            distributor.handle_status(
                "validator-01", generation, 11,
                MAX_EQUIPMENT_REGISTRY_ENTRIES, True,
            )
            self.assertEqual(distributor.confirmed_generation, generation)
            self.assertEqual(distributor.confirmed_module_count, 11)

            # La próxima revisión detecta una incorporación sin reiniciar nada.
            with registry.open("a", encoding="utf-8") as destination:
                destination.write(
                    '[[modules]]\nmodule_id="mim-11"\n'
                    f'secret_hex="{(bytes([12]) * 32).hex()}"\nactive=true\n'
                )
            next_generation = distributor.sync_if_changed()
            self.assertIsNotNone(next_generation)
            self.assertNotEqual(next_generation, generation)
            payload = __import__("json").loads(client.published[-1][1])
            self.assertEqual(len(payload["modules"]), 12)

    def test_retained_settings_wait_for_mqtt_and_flush_after_subscribe(self) -> None:
        client = StartingMqttClient()
        transport = MqttValidatorTransport(config(), client=client)

        transport.publish_enrollment_window("validator-01", False)
        transport.publish_enrollment_window("validator-01", True)
        transport.publish_runtime_config("validator-01", -64, 7)

        self.assertEqual(client.published, [])
        transport.start()
        published = {
            topic.rsplit("/", 1)[-1]: __import__("json").loads(payload)
            for topic, payload, _qos, retained in client.published
            if retained and not topic.endswith("/rpi/status")
        }
        self.assertEqual(published["enrollment"]["active"], True)
        self.assertEqual(published["config"]["revision"], 7)
        transport.close()

    def test_start_waits_for_subscriptions_without_blocking_callback(self) -> None:
        client = StartingMqttClient()
        transport = MqttValidatorTransport(config(), client=client)

        transport.start()

        self.assertTrue(transport._ready.is_set())
        status = client.published[-1]
        self.assertTrue(status[0].endswith("/rpi/status"))
        self.assertEqual(status[2:], (1, True))
        transport.close()
        self.assertTrue(client.disconnected)

    def test_start_keeps_searching_asynchronously_until_broker_is_available(self) -> None:
        client = AsyncRetryingMqttClient()
        transport = MqttValidatorTransport(config(), client=client)

        transport.start()

        self.assertEqual(client.async_target, ("mqtt.internal", 8883, 30))
        self.assertEqual(client.reconnect_delays, (1, 10))
        self.assertFalse(transport._ready.is_set())
        transport.close()

    def test_nonzero_loop_start_result_aborts_instead_of_sticking_started(self) -> None:
        client = LoopStartErrorMqttClient()
        transport = MqttValidatorTransport(config(), client=client)

        with self.assertRaisesRegex(ValidatorTransportError, "loop_start"):
            transport.start()

        self.assertFalse(transport._started)
        self.assertFalse(transport._ready.is_set())

    def test_callback_failure_recovers_off_paho_thread_until_ready(self) -> None:
        client = CallbackRecoveringMqttClient()
        transport = MqttValidatorTransport(config(), client=client)
        client.transport = transport
        reported: list[Exception] = []
        transport.set_error_handler(reported.append)
        transport.start()
        transport._subscribe_mid = client.subscribe_mid

        started_at = monotonic()
        transport._on_subscribe(
            client, None, client.subscribe_mid, [1] * 6, None
        )
        callback_elapsed = monotonic() - started_at

        self.assertLess(callback_elapsed, 0.1)
        self.assertTrue(client.reconnect_started.wait(1.0))
        self.assertFalse(transport._ready.is_set())
        client.allow_reconnect.set()
        self.assertTrue(transport._ready.wait(1.0))
        self.assertEqual(client.reconnect_calls, 1)
        self.assertTrue(reported)
        transport.close()

    def test_start_failure_is_reversible_and_normalized_for_every_client_stage(self) -> None:
        cases = (
            (RetryableConnectMqttClient(), True),
            (RetryableLoopMqttClient(), True),
            (RetryableAsyncMqttClient(), False),
        )
        for client, ready_after_retry in cases:
            with self.subTest(client=type(client).__name__):
                transport = MqttValidatorTransport(config(), client=client)
                pending = SimpleNamespace(event=Event(), error=None)
                transport._pending[("validator-01", "session-pending")] = pending

                with self.assertRaises(ValidatorTransportError) as raised:
                    transport.start()

                self.assertIsInstance(raised.exception.__cause__, OSError)
                self.assertFalse(transport._started)
                self.assertFalse(transport._ready.is_set())
                self.assertTrue(pending.event.is_set())
                self.assertIs(pending.error, raised.exception)

                transport._pending.clear()
                transport.start()
                self.assertTrue(transport._started)
                self.assertEqual(transport._ready.is_set(), ready_after_retry)
                transport.close()

    def test_disconnect_releases_pending_rpc_before_calling_application(self) -> None:
        client = PassiveMqttClient()
        transport = MqttValidatorTransport(config(), client=client)
        transport._ready.set()
        exchange_finished = Event()
        exchange_errors: list[Exception] = []

        def exchange() -> None:
            try:
                transport.exchange_proof(
                    "validator-01", "session-01", b"c" * 32, 5.0
                )
            except Exception as exc:
                exchange_errors.append(exc)
            finally:
                exchange_finished.set()

        worker = Thread(target=exchange)
        worker.start()
        self.assertTrue(client.published_event.wait(1.0))
        handler_observations: list[bool] = []
        reported: list[Exception] = []
        transport.set_error_handler(reported.append)

        def failing_handler() -> None:
            handler_observations.append(exchange_finished.wait(1.0))
            raise RuntimeError("falló persistencia al marcar offline")

        transport.set_disconnect_handler(failing_handler)

        transport._on_disconnect(client, None, None, 7, None)
        worker.join(1.0)

        self.assertFalse(worker.is_alive())
        self.assertEqual(handler_observations, [True])
        self.assertEqual(len(exchange_errors), 1)
        self.assertIsInstance(exchange_errors[0], ValidatorTransportError)
        self.assertEqual(len(reported), 1)
        self.assertIsInstance(reported[0].__cause__, RuntimeError)

    def test_paho_callbacks_contain_client_and_handler_exceptions(self) -> None:
        client = LoopbackMqttClient()
        transport = MqttValidatorTransport(config(), client=client)
        reported: list[Exception] = []
        transport.set_error_handler(reported.append)

        def fail_subscribe(_subscriptions):
            raise OSError("socket cerrada")

        client.subscribe = fail_subscribe
        transport._on_connect(client, None, None, 0, None)
        self.assertFalse(transport._ready.is_set())

        def fail_publish(_topic, _payload, *, qos, retain):
            raise OSError("socket cerrada")

        client.publish = fail_publish
        transport._subscribe_mid = 9
        transport._on_subscribe(client, None, 9, [1], None)
        self.assertFalse(transport._ready.is_set())

        disconnect_calls: list[bool] = []

        def fail_disconnect_handler() -> None:
            disconnect_calls.append(True)
            raise RuntimeError("persistencia temporalmente ocupada")

        transport.set_disconnect_handler(fail_disconnect_handler)
        transport._on_disconnect(client, None, None, 7, None)

        self.assertEqual(disconnect_calls, [True])
        self.assertEqual(len(reported), 3)
        self.assertTrue(all(isinstance(error, ValidatorTransportError) for error in reported))

    def test_message_handler_failure_does_not_poison_following_messages(self) -> None:
        client = LoopbackMqttClient()
        transport = MqttValidatorTransport(config(), client=client)
        reported: list[Exception] = []
        transport.set_error_handler(reported.append)
        occurred_at = datetime(2026, 8, 13, 12, tzinfo=timezone.utc)

        def message(session_id: str) -> SimpleNamespace:
            presentation = ValidatorPresentation(
                validator_id="validator-01",
                session_id=session_id,
                occurred_at=occurred_at,
            )
            return SimpleNamespace(
                topic=(
                    "fuel-edge/v1/site-01/module-01/validators/"
                    "validator-01/presentation"
                ),
                payload=ValidatorMessageCodec.encode_presentation(presentation),
            )

        def fail_handler(_presentation: ValidatorPresentation) -> None:
            raise RuntimeError("falló dependencia local")

        transport.set_presentation_handler(fail_handler)
        transport._on_message(client, None, message("session-01"))
        received: list[ValidatorPresentation] = []
        transport.set_presentation_handler(received.append)
        transport._on_message(client, None, message("session-02"))

        self.assertEqual(len(reported), 1)
        self.assertEqual([item.session_id for item in received], ["session-02"])

    def test_raw_publish_failures_are_transport_errors(self) -> None:
        client = LoopbackMqttClient()
        transport = MqttValidatorTransport(config(), client=client)
        transport._ready.set()
        decision = ValidatorDecision(
            validator_id="validator-01",
            session_id="session-01",
            allowed=False,
            state="locked",
            reason="denied",
        )

        def fail_publish(_topic, _payload, *, qos, retain):
            raise OSError("socket cerrada")

        client.publish = fail_publish
        with self.assertRaises(ValidatorTransportError) as raised:
            transport.publish_decision(decision)
        self.assertIsInstance(raised.exception.__cause__, OSError)

    def test_runtime_survives_broken_error_observer_and_ignores_late_submit(self) -> None:
        client = LoopbackMqttClient()
        transport = MqttValidatorTransport(config(), client=client)
        processed_second = Event()

        class SometimesFailingApplication:
            calls = 0

            def process_presentation(self, _presentation) -> None:
                self.calls += 1
                if self.calls == 1:
                    raise RuntimeError("falla focalizada")
                processed_second.set()

            def process_equipment_presence(self, _update) -> None:
                return None

            def process_credential_presence(self, _update) -> None:
                return None

        reported: list[Exception] = []

        def broken_error_observer(error: Exception) -> None:
            reported.append(error)
            raise RuntimeError("logger roto")

        runtime = MqttValidatorRuntime(
            application=SometimesFailingApplication(),
            transport=transport,
            on_error=broken_error_observer,
        )
        first = ValidatorPresentation("validator-01", "session-01")
        second = ValidatorPresentation("validator-01", "session-02")
        runtime._enqueue(first)
        runtime._enqueue(second)
        self.assertTrue(processed_second.wait(1.0))

        runtime.close()
        # Una entrega tardía desde Paho durante shutdown se descarta sin lanzar
        # RuntimeError("cannot schedule new futures after shutdown").
        runtime._enqueue(ValidatorPresentation("validator-01", "session-late"))

        self.assertEqual(len(reported), 1)

    def test_runtime_bounds_backlog_and_fails_safe_when_cut_event_is_rejected(self) -> None:
        client = LoopbackMqttClient()
        transport = MqttValidatorTransport(config(), client=client)
        first_started = Event()
        release_first = Event()
        fail_safe_called = Event()

        class BlockingApplication:
            def process_presentation(self, _presentation) -> None:
                first_started.set()
                release_first.wait(1.0)

            def process_equipment_presence(self, _update) -> None:
                return None

            def process_credential_presence(self, _update) -> None:
                return None

            def process_validator_disconnect(self) -> None:
                fail_safe_called.set()

        reported: list[Exception] = []
        runtime = MqttValidatorRuntime(
            application=BlockingApplication(),
            transport=transport,
            on_error=reported.append,
            max_pending_tasks=2,
        )
        try:
            runtime._enqueue(ValidatorPresentation("validator-01", "session-01"))
            self.assertTrue(first_started.wait(1.0))
            runtime._enqueue(ValidatorPresentation("validator-01", "session-02"))
            runtime._enqueue_credential(CredentialPresenceUpdate(
                validator_id="validator-01",
                session_id="session-active",
                credential_id="card-01",
                present=False,
                authenticated=False,
                absent_for_milliseconds=300,
            ))

            self.assertTrue(fail_safe_called.wait(1.0))
            self.assertTrue(
                any("cola del validador saturada" in str(error) for error in reported)
            )
        finally:
            release_first.set()
            runtime.close()


if __name__ == "__main__":
    unittest.main()
