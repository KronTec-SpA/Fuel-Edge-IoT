"""Agente edge de telemetría de combustible."""

from .access import AccessContext, AccessPolicy
from .domain import ControlConfig, EdgeEvent, EdgeState, FuelEdgeMachine
from .relay import MemoryPumpRelay, PumpRelay
from .rfid import (
    EquipmentEvidence,
    MemoryCredentialRepository,
    RfidAuthorizationService,
    RfidCredential,
    RfidValidator,
)

__all__ = [
    "AccessContext",
    "AccessPolicy",
    "ControlConfig",
    "EdgeEvent",
    "EdgeState",
    "FuelEdgeMachine",
    "MemoryPumpRelay",
    "EquipmentEvidence",
    "MemoryCredentialRepository",
    "PumpRelay",
    "RfidAuthorizationService",
    "RfidCredential",
    "RfidValidator",
]
