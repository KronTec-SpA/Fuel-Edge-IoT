"""Punto de entrada del agente edge."""

from __future__ import annotations

import argparse
import json
import signal
import sys
from dataclasses import asdict
from time import monotonic
from pathlib import Path
from threading import Event

from .config import (
    MAX_VALIDATOR_PROOF_TIMEOUT_SECONDS,
    MAX_WEB_REQUEST_TIMEOUT_SECONDS,
    AppConfig,
    load_config,
)
from .domain import EdgeEvent, FuelEdgeMachine
from .tank_table import HEIGHT_CONVERSIONS
from .hardware.industrial_shields import (
    AnalogInputError,
    IndustrialShieldsK24Reader,
    IndustrialShieldsRelay,
    IndustrialShieldsTankLevelReader,
    PulseInputError,
)
from .application import FuelEdgeApplication
from .mqtt_validator import (
    MAX_EQUIPMENT_REGISTRY_ENTRIES,
    MAX_MQTT_PUBLISH_TIMEOUT_SECONDS,
    EquipmentRegistryDistributor,
    MqttTlsConfig,
    MqttValidatorRuntime,
    MqttValidatorTransport,
)
from .equipment_enrollment import (
    EnrollmentWebClient,
    EquipmentRegistryRemovalCoordinator,
    load_equipment_registry,
)
from .relay import MemoryPumpRelay, PumpRelay
from .relay_test import RelayTestCoordinator, RelayTestWebClient
from .manual_mode import ManualModeCoordinator, ManualModeWebClient
from .technology_adoption import (
    TechnologyAdoptionCoordinator,
    TechnologyAdoptionWebClient,
)
from .rfid import RfidAuthorizationService, RfidValidator
from .service import FuelEdgeService
from .power_events import reconcile_power_restoration
from .storage import EventStore
from .tank_level import TankLevelFileReader
from .inventory_monitor import InventoryMonitor
from .ocio_calibration import OcioCalibrationCoordinator, restore_calibration
from .validator_registry import load_validator_registry
from .web_sync import WebSyncWorker, read_web_sensor_key
from .web_authorization import WebAuthorizationDirectory
from .nfc_enrollment import (
    EnrolledCredentialStore,
    NfcEnrollmentCoordinator,
    NfcEnrollmentWebClient,
)
from .validator_settings import (
    ValidatorSettingsCoordinator,
    ValidatorSettingsWebClient,
)
from .systemd_notify import SystemdNotifier
from .validator_link import ValidatorTransportError


DEFAULT_CONFIG = Path("/etc/fuel-edge/config.toml")
# Ruta bloqueante más larga admitida bajo el lock de la aplicación:
# observación web + tres pruebas NFC (publicación y espera) + resultado web +
# ventana y decisión MQTT.
# El WatchdogSec de la unidad debe ser mayor que el doble de este valor porque
# SystemdNotifier emite cada WatchdogSec/2 y una operación puede comenzar justo
# antes del siguiente latido programado.
MAX_BOUNDED_CONTROL_OPERATION_SECONDS = (
    2 * MAX_WEB_REQUEST_TIMEOUT_SECONDS
    + 3 * MAX_VALIDATOR_PROOF_TIMEOUT_SECONDS
    + 5 * MAX_MQTT_PUBLISH_TIMEOUT_SECONDS
)


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Agente edge de combustible")
    commands = parser.add_subparsers(dest="command", required=True)

    run = commands.add_parser("run", help="iniciar el controlador")
    run.add_argument("--config", type=Path, default=DEFAULT_CONFIG)
    run.add_argument(
        "--simulate",
        action="store_true",
        help="usar relé en memoria; nunca actúa una salida física",
    )
    run.add_argument("--tick-seconds", type=float, default=0.25)

    validate = commands.add_parser("validate-config", help="validar sin tocar hardware")
    validate.add_argument("--config", type=Path, default=DEFAULT_CONFIG)

    relay_off = commands.add_parser("relay-off", help="forzar el relé configurado a LOW")
    relay_off.add_argument("--config", type=Path, default=DEFAULT_CONFIG)
    return parser


def main() -> None:
    args = _parser().parse_args()
    config = load_config(args.config)

    if args.command == "validate-config":
        _validate_validator_files(config)
        _validate_web_sync_files(config)
        print(json.dumps(_summary(config), sort_keys=True))
        return
    if args.command == "relay-off":
        relay = _physical_relay(config)
        relay.close()
        print(json.dumps({"relay": config.plc.pump_relay, "energized": False}))
        return
    if args.tick_seconds <= 0:
        raise ValueError("--tick-seconds debe ser positivo")
    _validate_validator_files(config)
    _validate_web_sync_files(config)
    _run(config, simulate=args.simulate, tick_seconds=args.tick_seconds)


def _run(config: AppConfig, *, simulate: bool, tick_seconds: float) -> None:
    systemd = SystemdNotifier()
    relay: PumpRelay = MemoryPumpRelay() if simulate else _physical_relay(config)
    store: EventStore | None = None
    validator_runtime: MqttValidatorRuntime | None = None
    validator_application: FuelEdgeApplication | None = None
    web_sync_worker: WebSyncWorker | None = None
    relay_test: RelayTestCoordinator | None = None
    manual_mode: ManualModeCoordinator | None = None
    technology_adoption: TechnologyAdoptionCoordinator | None = None
    nfc_enrollment: NfcEnrollmentCoordinator | None = None
    validator_settings: ValidatorSettingsCoordinator | None = None
    ocio_calibration: OcioCalibrationCoordinator | None = None
    equipment_registry_distributor: EquipmentRegistryDistributor | None = None
    equipment_registry_removals: EquipmentRegistryRemovalCoordinator | None = None
    k24_reader: IndustrialShieldsK24Reader | None = None
    tank_level_reader: (
        TankLevelFileReader | IndustrialShieldsTankLevelReader | None
    ) = None
    stop_requested = Event()

    def request_stop(_signum: int, _frame: object) -> None:
        stop_requested.set()

    signal.signal(signal.SIGTERM, request_stop)
    signal.signal(signal.SIGINT, request_stop)
    try:
        store = EventStore(config.database.path)
        restored_power = reconcile_power_restoration(store, config.identity.site_id)
        if restored_power is not None:
            print(
                json.dumps(
                    {
                        "component": "power_supply",
                        "status": "restored",
                        "lost_at": restored_power["lostAt"],
                        "restored_at": restored_power["restoredAt"],
                        "duration_seconds": restored_power["durationSeconds"],
                    },
                    sort_keys=True,
                ),
                flush=True,
            )
        machine = FuelEdgeMachine(relay=relay, config=config.control)
        service = FuelEdgeService(
            machine,
            store,
            pulses_per_liter=config.k24.pulses_per_liter,
            k24_enabled=config.k24.enabled,
            tank_level_enabled=config.tank_level.enabled,
            validator_enabled=config.validator.enabled,
        )
        service.assign(config.identity.module_id, config.identity.site_id)
        inventory_monitor = None
        if config.k24.enabled and not simulate:
            k24_reader = IndustrialShieldsK24Reader(
                pin=config.k24.input_pin,
                version=config.plc.version,
                model=config.plc.model,
                active_low=config.k24.active_low,
                poll_interval_milliseconds=config.k24.poll_interval_milliseconds,
                debounce_milliseconds=config.k24.debounce_milliseconds,
            )
        if config.tank_level.enabled:
            if config.tank_level.source == "plc_analog" and not simulate:
                tank_level_reader = IndustrialShieldsTankLevelReader(
                    pin=config.tank_level.input_pin,
                    version=config.plc.version,
                    model=config.plc.model,
                    capacity_liters=config.tank_level.capacity_liters,
                    signal_mode=config.tank_level.signal_mode,
                    source_label=config.tank_level.telemetry_source,
                    input_empty_volts=config.tank_level.input_empty_volts,
                    input_full_volts=config.tank_level.input_full_volts,
                    adc_full_scale=config.tank_level.adc_full_scale,
                    sample_count=config.tank_level.sample_count,
                    deadband_percent=config.tank_level.deadband_percent,
                    publish_interval_seconds=config.tank_level.publish_interval_seconds,
                    stability_seconds=config.tank_level.stability_seconds,
                    stability_band_percent=config.tank_level.stability_band_percent,
                    volume_conversion=config.tank_level.volume_conversion,
                    ocio_height_signal=config.tank_level.ocio_height_signal,
                    ocio_calibration_pending=config.tank_level.ocio_calibration_pending,
                    cycle_filter=config.tank_level.cycle_filter,
                )
            else:
                tank_level_reader = TankLevelFileReader(
                    config.tank_level.reading_path,
                    config.tank_level.capacity_liters,
                )
        if isinstance(tank_level_reader, IndustrialShieldsTankLevelReader):
            restore_calibration(store, config.identity.site_id, tank_level_reader)
        inventory_monitor = _inventory_for_reader(store, config, tank_level_reader)
        if config.web_sync.enabled:
            web_sensor_key = read_web_sensor_key(config.web_sync.sensor_key_path)
            web_sync_worker = WebSyncWorker(
                store,
                config.web_sync,
                web_sensor_key,
                on_error=lambda error: print(
                    json.dumps(
                        {
                            "component": "web_sync",
                            "error": type(error).__name__,
                        }
                    ),
                    file=sys.stderr,
                    flush=True,
                ),
            )
            web_sync_worker.start()
            if isinstance(tank_level_reader, IndustrialShieldsTankLevelReader):
                ocio_calibration = OcioCalibrationCoordinator(
                    config.web_sync, web_sensor_key, site_id=config.identity.site_id,
                    session_id=service.telemetry_session_id, reader=tank_level_reader,
                    on_error=lambda error: print(json.dumps({"component":"ocio_calibration","error":type(error).__name__}),file=sys.stderr,flush=True),
                )
                ocio_calibration.start()
            relay_test = RelayTestCoordinator(
                RelayTestWebClient(config.web_sync, web_sensor_key),
                service,
                on_error=lambda error: print(
                    json.dumps(
                        {
                            "component": "relay_test",
                            "error": type(error).__name__,
                        }
                    ),
                    file=sys.stderr,
                    flush=True,
                ),
            )
            relay_test.start()
            technology_adoption = TechnologyAdoptionCoordinator(
                TechnologyAdoptionWebClient(config.web_sync, web_sensor_key),
                service,
                on_error=lambda error: print(
                    json.dumps(
                        {
                            "component": "technology_adoption",
                            "error": type(error).__name__,
                        }
                    ),
                    file=sys.stderr,
                    flush=True,
                ),
            )
            technology_adoption.start()
            manual_mode = ManualModeCoordinator(
                ManualModeWebClient(config.web_sync, web_sensor_key),
                service,
                on_error=lambda error: print(
                    json.dumps(
                        {
                            "component": "manual_mode",
                            "error": type(error).__name__,
                        }
                    ),
                    file=sys.stderr,
                    flush=True,
                ),
            )
            manual_mode.start()
        if config.validator.enabled:
            if config.validator.mqtt is None or config.validator.validator_id is None:
                raise RuntimeError("configuración activa del validador incompleta")
            registry = load_validator_registry(config.validator.registry_path)
            credential_store = EnrolledCredentialStore(
                config.database.path.with_suffix(".credentials.json")
            )
            credential_store.load_into(registry.credentials)
            mqtt = config.validator.mqtt
            validator_transport = MqttValidatorTransport(
                MqttTlsConfig(
                    host=mqtt.host,
                    port=mqtt.port,
                    site_id=config.identity.site_id,
                    module_id=config.identity.module_id,
                    ca_certificate=mqtt.ca_certificate,
                    client_certificate=mqtt.client_certificate,
                    client_key=mqtt.client_key,
                )
            )
            validator_transport.set_hardware_status_handler(
                lambda _validator_id, nfc_ready, _rfid_version: (
                    service.report_validator_hardware(nfc_ready)
                )
            )
            equipment_registry_distributor = EquipmentRegistryDistributor(
                registry_path=config.validator.equipment_registry_path,
                transport=validator_transport,
                validator_id=config.validator.validator_id,
                on_status=lambda generation, count, capacity: print(
                    json.dumps(
                        {
                            "component": "equipment_registry",
                            "status": "synchronized",
                            "generation": generation,
                            "modules": count,
                            "capacity": capacity,
                        }
                    ),
                    flush=True,
                ),
            )
            validator_transport.set_equipment_registry_status_handler(
                equipment_registry_distributor.handle_status
            )
            # Se encola antes de conectar. El transporte lo publica retenido en
            # cuanto MQTT queda listo, sin exigir ninguna acción en terreno.
            equipment_registry_distributor.sync_if_changed(force=True)
            if config.web_sync.enabled:
                equipment_registry_removals = EquipmentRegistryRemovalCoordinator(
                    EnrollmentWebClient(
                        config.web_sync.base_url,
                        web_sensor_key,
                        config.web_sync.request_timeout_seconds,
                    ),
                    config.validator.equipment_registry_path,
                    on_change=lambda: equipment_registry_distributor.sync_if_changed(
                        force=True
                    ),
                    on_error=lambda error: print(
                        json.dumps(
                            {
                                "component": "equipment_registry_removal",
                                "error": type(error).__name__,
                            }
                        ),
                        file=sys.stderr,
                        flush=True,
                    ),
                )
                bootstrap = registry.credentials.get("card-01")
                if bootstrap is None:
                    raise RuntimeError(
                        "el modo piloto de enrolamiento requiere la credencial card-01"
                    )
                nfc_enrollment = NfcEnrollmentCoordinator(
                    NfcEnrollmentWebClient(config.web_sync, web_sensor_key),
                    registry.credentials,
                    credential_store,
                    bootstrap.secret,
                    on_window_change=lambda active: (
                        validator_transport.publish_enrollment_window(
                            config.validator.validator_id, active
                        )
                    ),
                    on_error=lambda error: print(
                        json.dumps(
                            {
                                "component": "nfc_enrollment",
                                "error": type(error).__name__,
                            }
                        ),
                        file=sys.stderr,
                        flush=True,
                    ),
                )
                validator_settings = ValidatorSettingsCoordinator(
                    ValidatorSettingsWebClient(config.web_sync, web_sensor_key),
                    validator_transport,
                    config.validator.validator_id,
                    on_error=lambda error: print(
                        json.dumps(
                            {
                                "component": "validator_settings",
                                "error": type(error).__name__,
                            }
                        ),
                        file=sys.stderr,
                        flush=True,
                    ),
                )
            validator_application = FuelEdgeApplication(
                control=service,
                rfid=RfidAuthorizationService(
                    RfidValidator(registry.credentials)
                ),
                transport=validator_transport,
                directory=(
                    WebAuthorizationDirectory(
                        config.web_sync,
                        web_sensor_key,
                        config.identity.site_id,
                    )
                    if config.web_sync.enabled
                    else registry.directory
                ),
                validator_id=config.validator.validator_id,
                proof_timeout_seconds=config.validator.proof_timeout_seconds,
                nfc_enrollment=nfc_enrollment,
                on_equipment_observation=(
                    validator_settings.record_observation
                    if validator_settings is not None
                    else None
                ),
            )
            def handle_validator_disconnect() -> None:
                service.report_validator_offline()
                validator_application.process_validator_disconnect()

            validator_transport.set_disconnect_handler(
                handle_validator_disconnect
            )
            validator_runtime = MqttValidatorRuntime(
                application=validator_application,
                transport=validator_transport,
                on_error=lambda error: print(
                    json.dumps(
                        {
                            "component": "validator",
                            "error": type(error).__name__,
                        }
                    ),
                    file=sys.stderr,
                    flush=True,
                ),
            )
            validator_runtime.start()
            if nfc_enrollment is not None:
                nfc_enrollment.start()
            if equipment_registry_removals is not None:
                equipment_registry_removals.start()
            if validator_settings is not None:
                validator_settings.start()
        print(
            json.dumps(
                {
                    **_summary(config),
                    "state": str(machine.state),
                    "simulate": simulate,
                    "relay_energized": relay.is_energized,
                },
                sort_keys=True,
            ),
            flush=True,
        )
        # Type=notify no considera operativo el servicio hasta que terminaron
        # hardware, persistencia, workers y transporte MQTT.
        systemd.ready()
        next_status_at = 0.0
        next_registry_sync_at = 0.0
        next_tank_error_at = 0.0
        k24_fault_reported = False
        while not stop_requested.wait(tick_seconds):
            if k24_reader is not None:
                try:
                    pulse_count = k24_reader.drain_pulses()
                    if pulse_count:
                        service.record_k24_pulse(pulse_count)
                    if k24_fault_reported:
                        service.apply(EdgeEvent.TELEMETRY_RESTORED, sensor="K24")
                        k24_fault_reported = False
                except PulseInputError as error:
                    if not k24_fault_reported:
                        service.apply(
                            EdgeEvent.TELEMETRY_FAULT,
                            sensor="K24",
                            reason="pulse_input_unavailable",
                            error=type(error).__name__,
                        )
                        k24_fault_reported = True
            if validator_application is not None:
                validator_application.check_credential_presence_timeout()
            service.tick()
            if ocio_calibration is not None:
                try:
                    if ocio_calibration.apply_if_idle(store, idle=not machine.relay.is_energized):
                        inventory_monitor = _inventory_for_reader(store, config, tank_level_reader)
                        if web_sync_worker is not None:
                            web_sync_worker.wake()
                except (OSError, ValueError) as error:
                    print(json.dumps({"component":"ocio_calibration","error":type(error).__name__}),file=sys.stderr,flush=True)
            if web_sync_worker is not None and monotonic() >= next_status_at:
                service.publish_status()
                web_sync_worker.wake()
                next_status_at = monotonic() + 5.0
            if (
                equipment_registry_distributor is not None
                and monotonic() >= next_registry_sync_at
            ):
                _sync_equipment_registry(equipment_registry_distributor)
                next_registry_sync_at = monotonic() + 5.0
            if tank_level_reader is not None:
                try:
                    reading = tank_level_reader.read_if_updated()
                    if reading is not None:
                        next_tank_error_at = 0.0
                        service.record_tank_level(
                            reading.level_liters,
                            reading.occurred_at,
                            source=reading.source,
                            min_liters=reading.min_liters, max_liters=reading.max_liters,
                            calibration_id=reading.calibration_id,
                        )
                        if inventory_monitor is not None:
                            inventory_monitor.observe(
                                reading.level_liters, reading.occurred_at,
                                idle=not machine.relay.is_energized,
                                meter_healthy=machine.k24_healthy,
                                min_liters=reading.min_liters, max_liters=reading.max_liters,
                            )
                        if web_sync_worker is not None:
                            web_sync_worker.wake()
                except (AnalogInputError, OSError, UnicodeError, ValueError) as error:
                    now = monotonic()
                    if now >= next_tank_error_at:
                        print(
                            json.dumps(
                                {
                                    "component": "tank_level",
                                    "error": type(error).__name__,
                                }
                            ),
                            file=sys.stderr,
                            flush=True,
                        )
                        next_tank_error_at = now + 60.0
                finally:
                    if isinstance(tank_level_reader, IndustrialShieldsTankLevelReader):
                        store.record_ocio_diagnostics(tank_level_reader.drain_diagnostics(), site_id=config.identity.site_id, telemetry_session_id=service.telemetry_session_id)
                        quality = tank_level_reader.quality_update()
                        if quality:
                            if inventory_monitor is not None:
                                inventory_monitor.publish_health(quality=quality)
                            store.enqueue_latest("web/level-reading", {
                                **quality, "telemetrySessionId": service.telemetry_session_id,
                            }, "web/level-quality:latest")
            if inventory_monitor is not None:
                # New evidence gets a chance to complete verification first.
                inventory_monitor.tick()
                inventory_monitor.publish_health()
            # El latido representa una vuelta completa y saludable del bucle,
            # no sólo la existencia del proceso Python.
            systemd.watchdog()
    finally:
        systemd.stopping()
        # La última orden del proceso siempre abre el circuito.
        try:
            if validator_runtime is not None:
                if equipment_registry_removals is not None:
                    equipment_registry_removals.close()
                    equipment_registry_removals = None
                if validator_settings is not None:
                    validator_settings.close()
                if nfc_enrollment is not None:
                    nfc_enrollment.close()
                    nfc_enrollment = None
                validator_runtime.close()
        finally:
            try:
                if equipment_registry_removals is not None:
                    equipment_registry_removals.close()
                    equipment_registry_removals = None
                if nfc_enrollment is not None:
                    nfc_enrollment.close()
            finally:
                try:
                    if manual_mode is not None:
                        manual_mode.close()
                        manual_mode = None
                    if technology_adoption is not None:
                        technology_adoption.close()
                        technology_adoption = None
                    if relay_test is not None:
                        relay_test.close()
                        relay_test = None
                    if ocio_calibration is not None:
                        ocio_calibration.close()
                        ocio_calibration = None
                    if web_sync_worker is not None:
                        web_sync_worker.close()
                finally:
                    try:
                        if k24_reader is not None:
                            k24_reader.close()
                    finally:
                        try:
                            relay.deenergize()
                        finally:
                            if store is not None:
                                if isinstance(tank_level_reader, IndustrialShieldsTankLevelReader):
                                    store.record_ocio_diagnostics(tank_level_reader.drain_diagnostics(force=True), site_id=config.identity.site_id, telemetry_session_id=service.telemetry_session_id)
                                store.close()


def _inventory_for_reader(store, config, reader):
    pending = reader.ocio_calibration_pending if isinstance(reader, IndustrialShieldsTankLevelReader) else config.tank_level.ocio_calibration_pending
    if not config.tank_level.enabled or pending:
        return None
    level = config.tank_level
    return InventoryMonitor(store,site_id=config.identity.site_id,
        capacity_liters=level.capacity_liters,pulses_per_liter=config.k24.pulses_per_liter,
        calibration_id=json.dumps({"source":level.source,"pin":level.input_pin,"label":level.telemetry_source,
            "signal":level.signal_mode,"empty":level.input_empty_volts,"full":level.input_full_volts,
            "adc":level.adc_full_scale,"volumeConversion":level.volume_conversion,
            **(level.ocio_height_signal.calibration_metadata(level.volume_conversion) if level.volume_conversion in HEIGHT_CONVERSIONS else {}),
            "ocioFilter":asdict(level.cycle_filter),"confirmationId":getattr(reader,'confirmation_id',None)},sort_keys=True),
        k24_enabled=config.k24.enabled, customer_policy=True)


def _sync_equipment_registry(
    distributor: EquipmentRegistryDistributor,
) -> None:
    """Reintenta una carrera de desconexión MQTT sin derribar el controlador."""

    try:
        distributor.sync_if_changed()
    except (
        OSError,
        PermissionError,
        TypeError,
        ValueError,
        ValidatorTransportError,
    ) as error:
        print(
            json.dumps(
                {
                    "component": "equipment_registry",
                    "status": "retrying",
                    "error": type(error).__name__,
                    "detail": str(error)[:160],
                }
            ),
            file=sys.stderr,
            flush=True,
        )


def _physical_relay(config: AppConfig) -> IndustrialShieldsRelay:
    return IndustrialShieldsRelay(
        pin=config.plc.pump_relay,
        version=config.plc.version,
        model=config.plc.model,
    )


def _validate_validator_files(config: AppConfig) -> None:
    if not config.validator.enabled:
        return
    load_validator_registry(config.validator.registry_path)
    equipment_registry = load_equipment_registry(
        config.validator.equipment_registry_path
    )
    active_modules = sum(
        1 for credential in equipment_registry.values() if credential.active
    )
    if active_modules > MAX_EQUIPMENT_REGISTRY_ENTRIES:
        raise ValueError(
            "validator.equipment_registry_path contiene más de "
            f"{MAX_EQUIPMENT_REGISTRY_ENTRIES} MIM activos"
        )
    if config.validator.mqtt is None:
        raise ValueError("configuración MQTT del validador incompleta")
    mqtt = config.validator.mqtt
    for path, name in (
        (mqtt.ca_certificate, "ca_certificate"),
        (mqtt.client_certificate, "client_certificate"),
        (mqtt.client_key, "client_key"),
    ):
        if not path.is_file():
            raise FileNotFoundError(f"validator.mqtt.{name} no existe: {path}")
    if mqtt.client_key.stat().st_mode & 0o077:
        raise PermissionError("validator.mqtt.client_key debe tener permisos 0600")


def _validate_web_sync_files(config: AppConfig) -> None:
    if config.web_sync.enabled:
        read_web_sensor_key(config.web_sync.sensor_key_path)


def _summary(config: AppConfig) -> dict[str, object]:
    return {
        "module_id": config.identity.module_id,
        "site_id": config.identity.site_id,
        "plc_version": config.plc.version,
        "plc_model": config.plc.model,
        "pump_relay": config.plc.pump_relay,
        "k24_enabled": config.k24.enabled,
        "k24_input": config.k24.input_pin,
        "database": str(config.database.path),
        "validator_enabled": config.validator.enabled,
        "web_sync_enabled": config.web_sync.enabled,
        "tank_level_enabled": config.tank_level.enabled,
        "tank_level_source": config.tank_level.source,
        "tank_level_signal": config.tank_level.signal_mode,
        "tank_level_cycle_filter": asdict(config.tank_level.cycle_filter),
    }


if __name__ == "__main__":
    main()
