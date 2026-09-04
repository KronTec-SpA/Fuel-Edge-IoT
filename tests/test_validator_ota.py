from __future__ import annotations

import json
from pathlib import Path
import sys
import tempfile
import types
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from fuel_edge.validator_ota import _validate_identifier, stage


class _FakePublication:
    def __init__(
        self,
        *,
        rc: int = 0,
        published: bool = True,
        wait_error: Exception | None = None,
    ) -> None:
        self.rc = rc
        self._published = published
        self._wait_error = wait_error
        self.wait_called = False

    def wait_for_publish(self, timeout: float) -> None:
        self.wait_called = True
        if self._wait_error is not None:
            raise self._wait_error

    def is_published(self) -> bool:
        return self._published


class _FakeMqttClient:
    def __init__(
        self,
        *,
        terminal_state: str | None,
        command_wait_error: Exception | None = None,
        cleanup_wait_error: Exception | None = None,
        cleanup_rc: int = 0,
        disconnect_error: Exception | None = None,
        loop_stop_error: Exception | None = None,
        status_scenario: str = "terminal",
        command_rcs: tuple[int, ...] = (),
    ) -> None:
        self.terminal_state = terminal_state
        self.command_wait_error = command_wait_error
        self.cleanup_wait_error = cleanup_wait_error
        self.cleanup_rc = cleanup_rc
        self.disconnect_error = disconnect_error
        self.loop_stop_error = loop_stop_error
        self.status_scenario = status_scenario
        self.command_rcs = command_rcs
        self.cleanup_publication: _FakePublication | None = None
        self.publications: list[tuple[str, bytes, int, bool]] = []
        self.command_count = 0
        self.on_connect = None
        self.on_message = None
        self.disconnected = False
        self.loop_stopped = False

    def tls_set(self, **kwargs: object) -> None:
        return None

    def connect(self, host: str, port: int, keepalive: int) -> None:
        assert self.on_connect is not None
        self.on_connect(self, None, None, 0, None)

    def loop_start(self) -> None:
        return None

    def subscribe(self, topic: str, qos: int) -> None:
        return None

    def publish(
        self, topic: str, payload: bytes, qos: int, retain: bool
    ) -> _FakePublication:
        self.publications.append((topic, payload, qos, retain))
        if payload == b"":
            self.cleanup_publication = _FakePublication(
                rc=self.cleanup_rc, wait_error=self.cleanup_wait_error
            )
            return self.cleanup_publication
        command_rc = (
            self.command_rcs[self.command_count]
            if self.command_count < len(self.command_rcs)
            else 0
        )
        publication = _FakePublication(
            rc=command_rc, wait_error=self.command_wait_error
        )
        if self.command_wait_error is not None:
            return publication
        self.command_count += 1
        if command_rc != 0:
            return publication
        manifest = json.loads(payload)

        def emit(state: str, *, nonce: str | None) -> None:
            status = {
                "version": 1,
                "type": "validator.ota.status",
                "validator_id": manifest["validator_id"],
                "state": state,
                "detail": "test",
                "current_firmware": manifest["firmware"],
                "target_firmware": manifest["firmware"],
                "rollback_pending": False,
            }
            if nonce is not None:
                status["nonce"] = nonce
            assert self.on_message is not None
            self.on_message(
                self,
                None,
                SimpleNamespace(payload=json.dumps(status).encode("utf-8")),
            )

        if self.status_scenario == "boot_without_nonce":
            emit("restarting", nonce=manifest["nonce"])
            emit("ready", nonce=None)
        elif self.status_scenario == "ready_then_replay":
            if self.command_count == 1:
                emit("ready", nonce=None)
            else:
                emit("current", nonce=manifest["nonce"])
        elif self.status_scenario == "uncorrelated_only":
            emit("restarting", nonce="0" * 32)
            emit("ready", nonce=None)
        elif self.status_scenario == "reject_then_ready":
            emit("rejected", nonce=manifest["nonce"])
            emit("ready", nonce=None)
        elif self.terminal_state is not None:
            emit(self.terminal_state, nonce=manifest["nonce"])
        return publication

    def disconnect(self) -> None:
        self.disconnected = True
        if self.disconnect_error is not None:
            raise self.disconnect_error

    def loop_stop(self) -> None:
        self.loop_stopped = True
        if self.loop_stop_error is not None:
            raise self.loop_stop_error


class ValidatorOtaTests(unittest.TestCase):
    def _run_stage(
        self, client: _FakeMqttClient, *, wait_seconds: float = 0.01
    ) -> dict[str, object]:
        paho = types.ModuleType("paho")
        mqtt_package = types.ModuleType("paho.mqtt")
        mqtt_module = types.ModuleType("paho.mqtt.client")
        paho.__path__ = []  # type: ignore[attr-defined]
        mqtt_package.__path__ = []  # type: ignore[attr-defined]
        paho.mqtt = mqtt_package  # type: ignore[attr-defined]
        mqtt_package.client = mqtt_module  # type: ignore[attr-defined]
        mqtt_module.CallbackAPIVersion = SimpleNamespace(VERSION2=2)
        mqtt_module.MQTTv311 = 4
        mqtt_module.MQTT_ERR_SUCCESS = 0
        mqtt_module.Client = lambda **kwargs: client

        mqtt_config = SimpleNamespace(
            host="127.0.0.1",
            port=8883,
            ca_certificate=Path("/tls/ca.crt"),
            client_certificate=Path("/tls/rpi.crt"),
            client_key=Path("/tls/rpi.key"),
        )
        config = SimpleNamespace(
            identity=SimpleNamespace(site_id="site", module_id="module"),
            validator=SimpleNamespace(
                enabled=True,
                validator_id="validator-01",
                mqtt=mqtt_config,
            ),
        )
        modules = {
            "paho": paho,
            "paho.mqtt": mqtt_package,
            "paho.mqtt.client": mqtt_module,
        }
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            firmware = root / "firmware.bin"
            firmware.write_bytes(b"\xe9" + b"firmware-0.3.9")
            with (
                patch.dict(sys.modules, modules),
                patch("fuel_edge.validator_ota.load_config", return_value=config),
            ):
                return stage(
                    firmware,
                    firmware_version="0.3.9",
                    config_path=root / "config.toml",
                    ota_root=root / "ota",
                    wait_seconds=wait_seconds,
                )

    def assert_retained_command_was_cleared(
        self, client: _FakeMqttClient
    ) -> None:
        self.assertGreaterEqual(len(client.publications), 2)
        command = client.publications[-2]
        deletion = client.publications[-1]
        self.assertEqual(deletion[0], command[0])
        self.assertEqual(deletion[1], b"")
        self.assertEqual(deletion[2:], (1, True))
        self.assertTrue(client.disconnected)
        self.assertTrue(client.loop_stopped)

    def test_validator_identifier_rejects_topic_injection(self) -> None:
        self.assertEqual(_validate_identifier("validator-01", "id"), "validator-01")
        with self.assertRaises(ValueError):
            _validate_identifier("validator/+", "id")

    def test_stage_rejects_non_esp32_image_before_touching_configuration(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            firmware = Path(directory) / "firmware.bin"
            firmware.write_bytes(b"not-an-esp32-image")
            with self.assertRaisesRegex(ValueError, "ESP32"):
                stage(
                    firmware,
                    firmware_version="0.3.8",
                    config_path=Path(directory) / "missing.toml",
                    ota_root=Path(directory) / "ota",
                    wait_seconds=1,
                )

    def test_stage_requires_semantic_version(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            firmware = Path(directory) / "firmware.bin"
            firmware.write_bytes(b"\xe9" + b"x" * 20)
            with self.assertRaisesRegex(ValueError, "major.minor.patch"):
                stage(
                    firmware,
                    firmware_version="latest",
                    config_path=Path(directory) / "missing.toml",
                    ota_root=Path(directory) / "ota",
                    wait_seconds=1,
                )

    def test_stage_clears_retained_command_after_success(self) -> None:
        client = _FakeMqttClient(terminal_state="healthy")

        result = self._run_stage(client)

        self.assertTrue(result["success"])
        self.assert_retained_command_was_cleared(client)

    def test_stage_correlates_boot_ready_with_prior_nonce_progress(self) -> None:
        client = _FakeMqttClient(
            terminal_state=None, status_scenario="boot_without_nonce"
        )

        result = self._run_stage(client)

        self.assertTrue(result["success"])
        self.assertEqual(
            result["correlation"], "nonce_progress_then_boot_status"
        )
        self.assertEqual(len(result["nonce"]), 32)
        self.assert_retained_command_was_cleared(client)

    def test_uncorrelated_ready_only_requests_same_nonce_replay(self) -> None:
        client = _FakeMqttClient(
            terminal_state=None, status_scenario="ready_then_replay"
        )

        result = self._run_stage(client)

        self.assertTrue(result["success"])
        commands = [payload for _, payload, _, _ in client.publications if payload]
        self.assertEqual(len(commands), 2)
        self.assertEqual(
            json.loads(commands[0])["nonce"], json.loads(commands[1])["nonce"]
        )
        self.assert_retained_command_was_cleared(client)

    def test_forged_progress_nonce_cannot_authorize_uncorrelated_ready(self) -> None:
        client = _FakeMqttClient(
            terminal_state=None, status_scenario="uncorrelated_only"
        )

        with self.assertRaisesRegex(TimeoutError, "no confirmó el firmware"):
            self._run_stage(client)

        self.assertEqual(client.command_count, 4)
        self.assert_retained_command_was_cleared(client)

    def test_failed_replay_still_clears_the_initial_retained_command(self) -> None:
        client = _FakeMqttClient(
            terminal_state=None,
            status_scenario="ready_then_replay",
            command_rcs=(0, 4),
        )

        with self.assertRaisesRegex(RuntimeError, "código 4"):
            self._run_stage(client)

        self.assert_retained_command_was_cleared(client)

    def test_stage_clears_retained_command_after_rejection(self) -> None:
        client = _FakeMqttClient(terminal_state="rejected")

        with self.assertRaisesRegex(RuntimeError, "OTA rechazada"):
            self._run_stage(client)

        self.assert_retained_command_was_cleared(client)

    def test_later_boot_status_cannot_overwrite_correlated_rejection(self) -> None:
        client = _FakeMqttClient(
            terminal_state=None, status_scenario="reject_then_ready"
        )

        with self.assertRaisesRegex(RuntimeError, "OTA rechazada: rejected"):
            self._run_stage(client)

        self.assert_retained_command_was_cleared(client)

    def test_stage_clears_retained_command_after_timeout(self) -> None:
        client = _FakeMqttClient(terminal_state=None)

        with self.assertRaisesRegex(TimeoutError, "no confirmó el firmware"):
            self._run_stage(client, wait_seconds=0)

        self.assert_retained_command_was_cleared(client)

    def test_stage_clears_retained_command_after_publish_exception(self) -> None:
        client = _FakeMqttClient(
            terminal_state=None,
            command_wait_error=RuntimeError("falló el PUBACK inicial"),
        )

        with self.assertRaisesRegex(RuntimeError, "PUBACK inicial"):
            self._run_stage(client)

        self.assert_retained_command_was_cleared(client)

    def test_cleanup_failure_does_not_hide_primary_ota_error(self) -> None:
        client = _FakeMqttClient(
            terminal_state="rejected",
            cleanup_wait_error=TimeoutError("sin PUBACK de limpieza"),
        )

        with self.assertRaisesRegex(RuntimeError, "OTA rechazada") as raised:
            self._run_stage(client)

        self.assertTrue(
            any(
                "sin PUBACK de limpieza" in note
                for note in getattr(raised.exception, "__notes__", [])
            )
        )
        self.assertTrue(client.disconnected)
        self.assertTrue(client.loop_stopped)

    def test_cleanup_publish_rc_is_checked_before_waiting_for_puback(self) -> None:
        client = _FakeMqttClient(terminal_state="healthy", cleanup_rc=4)

        with self.assertRaisesRegex(RuntimeError, "código 4"):
            self._run_stage(client)

        self.assertIsNotNone(client.cleanup_publication)
        assert client.cleanup_publication is not None
        self.assertFalse(client.cleanup_publication.wait_called)
        self.assertTrue(client.disconnected)
        self.assertTrue(client.loop_stopped)

    def test_transport_shutdown_errors_do_not_hide_primary_ota_error(self) -> None:
        client = _FakeMqttClient(
            terminal_state="rejected",
            disconnect_error=RuntimeError("disconnect falló"),
            loop_stop_error=RuntimeError("loop_stop falló"),
        )

        with self.assertRaisesRegex(RuntimeError, "OTA rechazada") as raised:
            self._run_stage(client)

        notes = getattr(raised.exception, "__notes__", [])
        self.assertTrue(any("disconnect falló" in note for note in notes))
        self.assertTrue(any("loop_stop falló" in note for note in notes))
        self.assertTrue(client.disconnected)
        self.assertTrue(client.loop_stopped)


if __name__ == "__main__":
    unittest.main()
