"""Configuración validada del agente edge."""

from __future__ import annotations

from dataclasses import dataclass
from math import isfinite
from pathlib import Path
import re
import tomllib
from urllib.parse import urlsplit

from .domain import ControlConfig
from .ocio_filter import OcioFilterConfig
from .tank_table import OcioHeightSignal, FIELD_CONVERSION, FIELD_CAPACITY_LITERS, HEIGHT_CONVERSIONS


_RELAY_NAME = re.compile(r"^R\d+\.\d+$")
_INPUT_NAME = re.compile(r"^I\d+\.\d+$")
_MQTT_SEGMENT = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$")
DEFAULT_PLC_VERSION = "RPIPLC_V6"
DEFAULT_PLC_MODEL = "RPIPLC_19R"
DEFAULT_PUMP_RELAY = "R0.1"
DEFAULT_PULSES_PER_LITER = 100.0
DEFAULT_DATABASE_PATH = Path("/var/lib/fuel-edge/edge.db")
DEFAULT_VALIDATOR_REGISTRY_PATH = Path("/etc/fuel-edge/validator-registry.toml")
DEFAULT_EQUIPMENT_REGISTRY_PATH = Path("/etc/fuel-edge/equipment-registry.toml")
DEFAULT_WEB_SENSOR_KEY_PATH = Path("/etc/fuel-edge/web-sensor.key")
DEFAULT_TANK_LEVEL_PATH = Path("/run/fuel-edge/tank-level-liters")
MAX_VALIDATOR_PROOF_TIMEOUT_SECONDS = 5.0
MAX_WEB_REQUEST_TIMEOUT_SECONDS = 5.0


@dataclass(frozen=True, slots=True)
class IdentityConfig:
    module_id: str
    site_id: str


@dataclass(frozen=True, slots=True)
class PlcConfig:
    version: str = DEFAULT_PLC_VERSION
    model: str = DEFAULT_PLC_MODEL
    pump_relay: str = DEFAULT_PUMP_RELAY


@dataclass(frozen=True, slots=True)
class K24Config:
    enabled: bool = False
    input_pin: str = "I0.0"
    active_low: bool = False
    poll_interval_milliseconds: float = 1.0
    debounce_milliseconds: float = 1.5
    pulses_per_liter: float = DEFAULT_PULSES_PER_LITER


@dataclass(frozen=True, slots=True)
class DatabaseConfig:
    path: Path = DEFAULT_DATABASE_PATH


@dataclass(frozen=True, slots=True)
class MqttConfig:
    host: str
    ca_certificate: Path
    client_certificate: Path
    client_key: Path
    port: int = 8883


@dataclass(frozen=True, slots=True)
class ValidatorConfig:
    enabled: bool = False
    validator_id: str | None = None
    registry_path: Path = DEFAULT_VALIDATOR_REGISTRY_PATH
    equipment_registry_path: Path = DEFAULT_EQUIPMENT_REGISTRY_PATH
    proof_timeout_seconds: float = 5.0
    mqtt: MqttConfig | None = None


@dataclass(frozen=True, slots=True)
class WebSyncConfig:
    enabled: bool = False
    base_url: str = "http://127.0.0.1:8080"
    sensor_key_path: Path = DEFAULT_WEB_SENSOR_KEY_PATH
    request_timeout_seconds: float = 3.0
    retry_seconds: float = 5.0


@dataclass(frozen=True, slots=True)
class TankLevelConfig:
    enabled: bool = False
    source: str = "file"
    telemetry_source: str = "OCIO"
    reading_path: Path = DEFAULT_TANK_LEVEL_PATH
    capacity_liters: float = 2500.0
    volume_conversion: str = "linear"
    ocio_height_signal: OcioHeightSignal = OcioHeightSignal()
    ocio_calibration_pending: bool = False
    input_pin: str = "I0.2"
    signal_mode: str = "4-20ma"
    input_empty_volts: float = 2.0
    input_full_volts: float = 10.0
    adc_full_scale: int = 4095
    sample_count: int = 5
    deadband_percent: float = 0.1
    publish_interval_seconds: float = 60.0
    stability_seconds: float = 15.0
    stability_band_percent: float = 0.25
    cycle_filter: OcioFilterConfig = OcioFilterConfig()


@dataclass(frozen=True, slots=True)
class AppConfig:
    identity: IdentityConfig
    plc: PlcConfig
    control: ControlConfig
    k24: K24Config
    database: DatabaseConfig
    validator: ValidatorConfig
    web_sync: WebSyncConfig
    tank_level: TankLevelConfig


def load_config(path: str | Path) -> AppConfig:
    """Carga TOML y falla antes de tocar hardware si un valor es inválido."""
    config_path = Path(path)
    with config_path.open("rb") as config_file:
        raw = tomllib.load(config_file)

    identity_raw = _table(raw, "identity")
    plc_raw = _table(raw, "plc")
    control_raw = _table(raw, "control")
    k24_raw = _table(raw, "k24")
    database_raw = _table(raw, "database")
    validator_raw = _table(raw, "validator")
    web_sync_raw = _table(raw, "web_sync")
    tank_level_raw = _table(raw, "tank_level")

    identity = IdentityConfig(
        module_id=_required_text(identity_raw, "module_id"),
        site_id=_required_text(identity_raw, "site_id"),
    )
    plc = PlcConfig(
        version=str(plc_raw.get("version", DEFAULT_PLC_VERSION)),
        model=str(plc_raw.get("model", DEFAULT_PLC_MODEL)),
        pump_relay=str(plc_raw.get("pump_relay", DEFAULT_PUMP_RELAY)),
    )
    control = ControlConfig(
        start_timeout_seconds=_positive_int(
            control_raw, "start_timeout_seconds", ControlConfig().start_timeout_seconds
        ),
        k24_inactivity_seconds=_positive_int(
            control_raw, "k24_inactivity_seconds", ControlConfig().k24_inactivity_seconds
        ),
        ble_loss_seconds=_positive_int(
            control_raw, "ble_loss_seconds", ControlConfig().ble_loss_seconds
        ),
        nfc_debounce_milliseconds=_positive_int(
            control_raw,
            "nfc_debounce_milliseconds",
            ControlConfig().nfc_debounce_milliseconds,
        ),
        nfc_presence_timeout_milliseconds=_positive_int(
            control_raw,
            "nfc_presence_timeout_milliseconds",
            ControlConfig().nfc_presence_timeout_milliseconds,
        ),
    )
    k24_enabled = k24_raw.get("enabled", False)
    k24_active_low = k24_raw.get("active_low", False)
    if not isinstance(k24_enabled, bool) or not isinstance(k24_active_low, bool):
        raise ValueError("k24.enabled y k24.active_low deben ser boolean")
    k24_input_pin = str(k24_raw.get("input_pin", "I0.0")).strip()
    k24_poll_ms = float(k24_raw.get("poll_interval_milliseconds", 1.0))
    k24_debounce_ms = float(k24_raw.get("debounce_milliseconds", 1.5))
    pulses_per_liter = float(k24_raw.get("pulses_per_liter", DEFAULT_PULSES_PER_LITER))
    database = DatabaseConfig(path=Path(database_raw.get("path", DEFAULT_DATABASE_PATH)))
    validator = _validator_config(validator_raw)
    web_sync = _web_sync_config(web_sync_raw)
    tank_level = _tank_level_config(tank_level_raw)

    if not _RELAY_NAME.fullmatch(plc.pump_relay):
        raise ValueError("plc.pump_relay debe tener formato R0.1")
    if not plc.version.startswith("RPIPLC_V"):
        raise ValueError("plc.version no es una versión RPIPLC válida")
    if not plc.model.startswith("RPIPLC_"):
        raise ValueError("plc.model no es un modelo RPIPLC válido")
    if (
        tank_level.enabled
        and tank_level.source == "plc_analog"
        and plc.model == "RPIPLC_19R"
        and tank_level.input_pin not in {"I0.2", "I0.3", "I0.4", "I0.5"}
    ):
        raise ValueError(
            "tank_level.input_pin debe ser I0.2, I0.3, I0.4 o I0.5 en el 19R"
        )
    if not isfinite(pulses_per_liter) or pulses_per_liter <= 0:
        raise ValueError("k24.pulses_per_liter debe ser positivo")
    if not _INPUT_NAME.fullmatch(k24_input_pin):
        raise ValueError("k24.input_pin debe tener formato I0.0")
    if k24_enabled and plc.model == "RPIPLC_19R" and k24_input_pin not in {"I0.0", "I0.1"}:
        raise ValueError("k24.input_pin debe usar I0.0 o I0.1 aislada en el 19R")
    if not isfinite(k24_poll_ms) or not 0.5 <= k24_poll_ms <= 5:
        raise ValueError("k24.poll_interval_milliseconds debe estar entre 0.5 y 5")
    if not isfinite(k24_debounce_ms) or not 0 <= k24_debounce_ms <= 10:
        raise ValueError("k24.debounce_milliseconds debe estar entre 0 y 10")
    if validator.enabled:
        for value, name in (
            (identity.module_id, "identity.module_id"),
            (identity.site_id, "identity.site_id"),
            (validator.validator_id, "validator.validator_id"),
        ):
            if not isinstance(value, str) or not _MQTT_SEGMENT.fullmatch(value):
                raise ValueError(f"{name} no es válido para MQTT")

    return AppConfig(
        identity=identity,
        plc=plc,
        control=control,
        k24=K24Config(
            enabled=k24_enabled,
            input_pin=k24_input_pin,
            active_low=k24_active_low,
            poll_interval_milliseconds=k24_poll_ms,
            debounce_milliseconds=k24_debounce_ms,
            pulses_per_liter=pulses_per_liter,
        ),
        database=database,
        validator=validator,
        web_sync=web_sync,
        tank_level=tank_level,
    )


def _web_sync_config(section: dict[str, object]) -> WebSyncConfig:
    enabled = section.get("enabled", False)
    if not isinstance(enabled, bool):
        raise ValueError("web_sync.enabled debe ser boolean")
    base_url = str(section.get("base_url", "http://127.0.0.1:8080")).strip().rstrip("/")
    parsed = urlsplit(base_url)
    if parsed.scheme not in {"http", "https"} or parsed.hostname not in {"127.0.0.1", "localhost", "::1"}:
        raise ValueError("web_sync.base_url debe apuntar al servicio local de la Raspberry")
    if parsed.username or parsed.password or parsed.query or parsed.fragment or parsed.path not in {"", "/"}:
        raise ValueError("web_sync.base_url no debe incluir credenciales, ruta ni parámetros")
    timeout = float(section.get("request_timeout_seconds", 3.0))
    retry = float(section.get("retry_seconds", 5.0))
    if (
        not isfinite(timeout)
        or not 0.2 <= timeout <= MAX_WEB_REQUEST_TIMEOUT_SECONDS
    ):
        raise ValueError(
            "web_sync.request_timeout_seconds debe estar entre 0.2 y "
            f"{MAX_WEB_REQUEST_TIMEOUT_SECONDS:g}"
        )
    if not isfinite(retry) or not 1 <= retry <= 300:
        raise ValueError("web_sync.retry_seconds debe estar entre 1 y 300")
    return WebSyncConfig(
        enabled=enabled,
        base_url=base_url,
        sensor_key_path=Path(section.get("sensor_key_path", DEFAULT_WEB_SENSOR_KEY_PATH)),
        request_timeout_seconds=timeout,
        retry_seconds=retry,
    )


def _tank_level_config(section: dict[str, object]) -> TankLevelConfig:
    enabled = section.get("enabled", False)
    if not isinstance(enabled, bool):
        raise ValueError("tank_level.enabled debe ser boolean")
    capacity = float(section.get("capacity_liters", 2500.0))
    if not isfinite(capacity) or capacity <= 0:
        raise ValueError("tank_level.capacity_liters debe ser positivo")
    volume_conversion = str(section.get("volume_conversion", "linear"))
    calibration_pending = section.get("ocio_calibration_pending", False)
    if not isinstance(calibration_pending, bool):
        raise ValueError("tank_level.ocio_calibration_pending debe ser boolean")
    if volume_conversion == "fm2500_horizontal":
        raise ValueError("fm2500_horizontal retirado; usar tabla fm2500_manufacturer con señal de altura confirmada")
    if volume_conversion not in {"linear", *HEIGHT_CONVERSIONS}:
        raise ValueError("tank_level.volume_conversion inválido")
    height_signal = OcioHeightSignal(
        output_mode=str(section.get("ocio_output_mode", "unconfirmed")),
        height_at_zero_percent_mm=(float(section["ocio_height_at_zero_percent_mm"]) if "ocio_height_at_zero_percent_mm" in section else None),
        height_at_full_percent_mm=(float(section["ocio_height_at_full_percent_mm"]) if "ocio_height_at_full_percent_mm" in section else None),
    )
    if volume_conversion in HEIGHT_CONVERSIONS:
        expected_capacity = FIELD_CAPACITY_LITERS if volume_conversion == FIELD_CONVERSION else 2500
        if capacity != expected_capacity:
            raise ValueError(f"{volume_conversion} requiere capacidad de {expected_capacity:g} L")
        height_signal.validate()
        if volume_conversion == FIELD_CONVERSION and height_signal.height_at_full_percent_mm < 1220:
            raise ValueError("la señal debe cubrir el overflow de 1220 mm")
    source = str(section.get("source", "file")).strip().lower()
    if source not in {"file", "plc_analog"}:
        raise ValueError("tank_level.source debe ser file o plc_analog")
    if volume_conversion in HEIGHT_CONVERSIONS and source != "plc_analog":
        raise ValueError(f"{volume_conversion} requiere plc_analog; el archivo de nivel ya contiene litros")
    telemetry_source = str(section.get("telemetry_source", "OCIO")).strip()
    if not telemetry_source or len(telemetry_source) > 80:
        raise ValueError("tank_level.telemetry_source debe tener entre 1 y 80 caracteres")
    input_pin = str(section.get("input_pin", "I0.2")).strip()
    if not _INPUT_NAME.fullmatch(input_pin):
        raise ValueError("tank_level.input_pin debe tener formato I0.2")
    signal_mode = str(section.get("signal_mode", "4-20ma")).strip().lower()
    if signal_mode not in {"4-20ma", "0-10v"}:
        raise ValueError("tank_level.signal_mode debe ser 4-20ma o 0-10v")
    default_empty_volts = 2.0 if signal_mode == "4-20ma" else 0.0
    empty_volts = float(section.get("input_empty_volts", default_empty_volts))
    full_volts = float(section.get("input_full_volts", 10.0))
    if (
        not isfinite(empty_volts)
        or not isfinite(full_volts)
        or not 0 <= empty_volts < full_volts <= 10
    ):
        raise ValueError(
            "tank_level.input_empty_volts/input_full_volts deben definir un rango dentro de 0-10 V"
        )
    if signal_mode == "4-20ma" and empty_volts < 1.8:
        raise ValueError(
            "tank_level 4-20ma debe entrar al PLC como 2-10 V para conservar el cero vivo"
        )
    adc_full_scale = int(section.get("adc_full_scale", 4095))
    if not 255 <= adc_full_scale <= 65535:
        raise ValueError("tank_level.adc_full_scale está fuera de rango")
    sample_count = int(section.get("sample_count", 5))
    if not 1 <= sample_count <= 31 or sample_count % 2 == 0:
        raise ValueError("tank_level.sample_count debe ser impar entre 1 y 31")
    deadband = float(section.get("deadband_percent", 0.1))
    if not isfinite(deadband) or not 0 <= deadband <= 10:
        raise ValueError("tank_level.deadband_percent debe estar entre 0 y 10")
    publish_interval = float(section.get("publish_interval_seconds", 60.0))
    if not isfinite(publish_interval) or not 1 <= publish_interval <= 3600:
        raise ValueError(
            "tank_level.publish_interval_seconds debe estar entre 1 y 3600"
        )
    stability_seconds = float(section.get("stability_seconds", 15.0))
    if not isfinite(stability_seconds) or not 0 <= stability_seconds <= 300:
        raise ValueError("tank_level.stability_seconds debe estar entre 0 y 300")
    stability_band = float(section.get("stability_band_percent", 0.25))
    if not isfinite(stability_band) or not 0 < stability_band <= 10:
        raise ValueError(
            "tank_level.stability_band_percent debe estar entre 0 (exclusivo) y 10"
        )
    return TankLevelConfig(
        enabled=enabled,
        source=source,
        telemetry_source=telemetry_source,
        reading_path=Path(section.get("reading_path", DEFAULT_TANK_LEVEL_PATH)),
        capacity_liters=capacity,
        volume_conversion=volume_conversion,
        ocio_height_signal=height_signal,
        ocio_calibration_pending=calibration_pending,
        input_pin=input_pin,
        signal_mode=signal_mode,
        input_empty_volts=empty_volts,
        input_full_volts=full_volts,
        adc_full_scale=adc_full_scale,
        sample_count=sample_count,
        deadband_percent=deadband,
        publish_interval_seconds=publish_interval,
        stability_seconds=stability_seconds,
        stability_band_percent=stability_band,
        cycle_filter=OcioFilterConfig(
            enabled=section.get("cycle_filter_enabled", True),
            window_seconds=float(section.get("cycle_window_seconds", 120)),
            quiet_seconds=float(section.get("cycle_quiet_seconds", 15)),
            band_percent=float(section.get("cycle_band_percent", 0.25)),
            support_fraction=float(section.get("cycle_support_fraction", 0.8)),
        ),
    )


def _validator_config(section: dict[str, object]) -> ValidatorConfig:
    enabled = section.get("enabled", False)
    if not isinstance(enabled, bool):
        raise ValueError("validator.enabled debe ser boolean")
    registry_path = Path(
        section.get("registry_path", DEFAULT_VALIDATOR_REGISTRY_PATH)
    )
    equipment_registry_path = Path(
        section.get("equipment_registry_path", DEFAULT_EQUIPMENT_REGISTRY_PATH)
    )
    timeout = float(section.get("proof_timeout_seconds", 5.0))
    if (
        not isfinite(timeout)
        or not 0 < timeout <= MAX_VALIDATOR_PROOF_TIMEOUT_SECONDS
    ):
        raise ValueError(
            "validator.proof_timeout_seconds debe ser mayor que 0 y menor o igual a "
            f"{MAX_VALIDATOR_PROOF_TIMEOUT_SECONDS:g}"
        )
    if not enabled:
        return ValidatorConfig(
            enabled=False,
            registry_path=registry_path,
            equipment_registry_path=equipment_registry_path,
            proof_timeout_seconds=timeout,
        )

    validator_id = _section_text(section, "validator_id", "validator")
    mqtt_raw = section.get("mqtt")
    if not isinstance(mqtt_raw, dict):
        raise ValueError("validator.mqtt es obligatorio cuando el validador está activo")
    port = int(mqtt_raw.get("port", 8883))
    if not 1 <= port <= 65535:
        raise ValueError("validator.mqtt.port inválido")
    mqtt = MqttConfig(
        host=_section_text(mqtt_raw, "host", "validator.mqtt"),
        port=port,
        ca_certificate=Path(
            _section_text(mqtt_raw, "ca_certificate", "validator.mqtt")
        ),
        client_certificate=Path(
            _section_text(mqtt_raw, "client_certificate", "validator.mqtt")
        ),
        client_key=Path(
            _section_text(mqtt_raw, "client_key", "validator.mqtt")
        ),
    )
    return ValidatorConfig(
        enabled=True,
        validator_id=validator_id,
        registry_path=registry_path,
        equipment_registry_path=equipment_registry_path,
        proof_timeout_seconds=timeout,
        mqtt=mqtt,
    )


def _required_text(section: dict[str, object], key: str) -> str:
    return _section_text(section, key, "identity")


def _table(raw: dict[str, object], name: str) -> dict[str, object]:
    value = raw.get(name, {})
    if not isinstance(value, dict):
        raise ValueError(f"{name} debe ser una tabla TOML")
    return value


def _section_text(section: dict[str, object], key: str, name: str) -> str:
    value = str(section.get(key, "")).strip()
    if not value:
        raise ValueError(f"{name}.{key} es obligatorio")
    return value


def _positive_int(section: dict[str, object], key: str, default: int) -> int:
    value = int(section.get(key, default))
    if value <= 0:
        raise ValueError(f"control.{key} debe ser positivo")
    return value
