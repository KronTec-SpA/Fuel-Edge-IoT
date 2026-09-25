"""Cuadratura durable al arrancar y después de perder la señal de nivel.

Una diferencia de 20 L es una sospecha operacional, no prueba metrológica de
robo. Las recepciones durante la interrupción requieren revisión humana.
"""

from __future__ import annotations

from datetime import datetime, timezone
from math import isfinite
from statistics import median
from uuid import uuid4

from .storage import EventStore
from .volume_format import format_liters_cl
from .inventory_uncertainty import comparison


def instant(value: str) -> datetime:
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        raise ValueError("la lectura de inventario debe incluir zona horaria")
    return parsed.astimezone(timezone.utc)


class InventoryMonitor:
    # Parámetros operacionales para el piloto de 2.500 L; no especificaciones
    # de exactitud en litros. La geometría y la calibración deben validarse.
    SUSPECT_LITERS = 20.0
    CLEAR_LITERS = 10.0
    STABLE_SPREAD_LITERS = 6.25
    SAMPLE_SECONDS = 60
    GAP_SECONDS = 180
    TIMEOUT_SECONDS = 300

    def __init__(
        self, store: EventStore, *, site_id: str, capacity_liters: float,
        pulses_per_liter: float, calibration_id: str, k24_enabled: bool,
        now: datetime | None = None,
        customer_policy: bool = False,
    ) -> None:
        if not all(isfinite(v) and v > 0 for v in (capacity_liters, pulses_per_liter)):
            raise ValueError("capacidad y factor K24 deben ser positivos")
        self.store = store
        self.site_id = site_id
        self.capacity = capacity_liters
        self.factor = pulses_per_liter
        self.calibration_id = calibration_id
        self.k24_enabled = k24_enabled
        self.customer_policy = customer_policy
        self.started_at = now or datetime.now(timezone.utc)
        self.state = store.inventory_state(site_id) or {}
        self.samples: list[tuple[datetime, float, int, float, float]] = []
        self.last_reading: datetime | None = None
        self._begin("startup", self.started_at)
        self._last_health_publish = None

    def publish_health(self, now: datetime | None = None, *, quality: dict | None = None) -> None:
        """Technical condition is separate from customer loss notifications."""
        if not self.customer_policy:
            return
        now = now or datetime.now(timezone.utc)
        if quality:
            self.state['lastAcquisition'] = quality
        if self._last_health_publish and (now-self._last_health_publish).total_seconds() < 60:
            return
        self._last_health_publish = now
        pending = self.state.get('pending')
        verified_at = (self.state.get('baseline') or {}).get('occurredAt')
        waiting_since = pending['startedAt'] if pending else (
            verified_at if verified_at and (now-instant(verified_at)).total_seconds() >= 180 else None)
        health = self.state.setdefault('measurementHealth', {'episodes': 0})
        overdue = waiting_since and (now-instant(waiting_since)).total_seconds() >= 900
        if overdue:
            if health.get('condition') != 'active':
                health.update(condition='active', id=f'level-health-{uuid4()}', startedAt=waiting_since,
                              episodes=health['episodes']+1)
            health['lastDegradedAt'] = now.isoformat()
            health.pop('recoveringSince', None)
        elif health.get('condition') == 'active':
            if waiting_since:
                health.pop('recoveringSince', None)
            else:
                health.setdefault('recoveringSince', now.isoformat())
                if (now-instant(health['recoveringSince'])).total_seconds() >= 3600:
                    health.update(condition='recovered', recoveredAt=now.isoformat())
        payload = {'siteId':self.site_id, 'occurredAt':now.isoformat(),
                   'lastAcceptedAt':self.last_reading.isoformat() if self.last_reading else None,
                   'lastVerifiedAt':verified_at, 'pendingSince':waiting_since,
                   'acquisition':self.state.get('lastAcquisition'), 'incident':health,
                   'policyId':'inventory-evidence-v2'}
        self.store.save_inventory_state(self.site_id, self.state)
        self.store.enqueue_latest('web/inventory-health', payload, 'web/inventory-health:'+self.site_id)

    def _begin(self, reason: str, now: datetime) -> None:
        if self.state.get("pending") is None:
            self.state["pending"] = {
                "id": f"inventory-{uuid4()}", "reason": reason,
                "startedAt": now.isoformat(),
                "baseline": self.state.get("baseline"),
            }
            self.store.save_inventory_state(self.site_id, self.state)
        self.samples.clear()

    def tick(self, now: datetime | None = None) -> None:
        now = now or datetime.now(timezone.utc)
        last = self.last_reading or self.started_at
        if (now - last).total_seconds() >= self.GAP_SECONDS:
            self._begin("level_gap", last)
        pending = self.state.get("pending")
        if pending and not pending.get("timeoutReported") and (
            now - instant(pending["startedAt"])
        ).total_seconds() >= self.TIMEOUT_SECONDS:
            pending["timeoutReported"] = True
            check = {**pending, "id": pending["id"] + "-timeout",
                     "status": "unverifiable", "occurredAt": now.isoformat()}
            self.store.save_inventory_state(
                self.site_id, self.state, check=check,
                alert=None if self.customer_policy else self._alert(check, "Verificación de inventario pendiente",
                                  "No se completó la cuadratura: faltan lecturas frescas "
                                  "y estables en reposo o la diferencia sigue entre 10 y 20 L. "
                                  "No se puede descartar una extracción durante la interrupción."),
            )

    def observe(
        self, level_liters: float, occurred_at: str, *, idle: bool,
        meter_healthy: bool = True,
        min_liters: float | None = None,
        max_liters: float | None = None,
        now: datetime | None = None,
    ) -> None:
        now = now or datetime.now(timezone.utc)
        at = instant(occurred_at)
        if not isfinite(level_liters) or not 0 <= level_liters <= self.capacity:
            raise ValueError("nivel fuera de rango")
        low = level_liters if min_liters is None else min_liters
        high = level_liters if max_liters is None else max_liters
        if not all(isfinite(v) for v in (low, high)) or not 0 <= low <= level_liters <= high <= self.capacity:
            raise ValueError("intervalo de nivel inválido")
        # Un archivo anterior al arranque, fechas futuras y duplicados no
        # constituyen evidencia de que el OCIO volvió a medir.
        if at < self.started_at or not 0 <= (now - at).total_seconds() <= 90:
            return
        if self.last_reading is not None and at <= self.last_reading:
            return
        if self.last_reading and (at - self.last_reading).total_seconds() >= self.GAP_SECONDS:
            self._begin("level_gap", self.last_reading)
        self.last_reading = at
        pulses = self.store.inventory_pulses()
        if not idle:
            self.samples.clear()
            return
        if self.samples and (pulses != self.samples[-1][2]
                             or (at - self.samples[-1][0]).total_seconds() > 90
                             or any(max([s[i] for s in self.samples] + [v])
                                    - min([s[i] for s in self.samples] + [v]) > self.STABLE_SPREAD_LITERS
                                    for i, v in ((3, low), (4, high)))):
            self.samples.clear()
        if self.samples and (at - self.samples[-1][0]).total_seconds() < self.SAMPLE_SECONDS:
            return
        self.samples.append((at, level_liters, pulses, low, high))
        self.samples = self.samples[-3:]
        if len(self.samples) < 3:
            return
        levels = [sample[1] for sample in self.samples]
        if max(levels) - min(levels) > self.STABLE_SPREAD_LITERS:
            return
        snapshot = {
            "levelLiters": float(median(levels)), "pulses": pulses,
            "occurredAt": at.isoformat(), "calibrationId": self.calibration_id,
            "capacityLiters": self.capacity, "pulsesPerLiter": self.factor,
        }
        if any(s[3] != s[4] for s in self.samples):
            snapshot["levelRange"] = {"minLiters": min(s[3] for s in self.samples),
                                      "maxLiters": max(s[4] for s in self.samples)}
        pending = self.state.get("pending")
        if pending:
            self._complete(pending, snapshot, meter_healthy=meter_healthy)
        else:
            self._check_unmetered_drop(snapshot, meter_healthy=meter_healthy)
            self.state["baseline"] = snapshot
            self.store.save_inventory_state(self.site_id, self.state)
        self._publish_balance(snapshot, meter_healthy=meter_healthy)

    def _publish_balance(self, snapshot: dict, *, meter_healthy: bool) -> None:
        # Ancla contable independiente: nunca sigue al OCIO, ni al cambiar de
        # día, reiniciar, cerrar una alarma o concluir una cuadratura de corte.
        if not self.state.get("balanceAnchor"):
            self.state["balanceAnchor"] = {**snapshot, "id": f"balance-{uuid4()}"}
        anchor = self.state["balanceAnchor"]
        sample = {
            "id": f"balance-sample-{uuid4()}", "siteId": self.site_id,
            "anchor": anchor, "occurredAt": snapshot["occurredAt"],
            "measuredLiters": snapshot["levelLiters"],
            "pulsesTotal": snapshot["pulses"],
            "calibrationId": snapshot["calibrationId"],
            "pulsesPerLiter": snapshot["pulsesPerLiter"],
            "meterHealthy": bool(self.k24_enabled and meter_healthy),
        }
        if "levelRange" in snapshot:
            sample["measuredRange"] = snapshot["levelRange"]
        self.store.save_inventory_state(self.site_id, self.state, balance_sample=sample)

    def _check_unmetered_drop(self, snapshot: dict, *, meter_healthy: bool) -> None:
        previous = self.state.get("baseline")
        if not previous or not self.k24_enabled or not meter_healthy:
            return
        if any(previous.get(key) != snapshot[key] for key in (
            "calibrationId", "capacityLiters", "pulsesPerLiter", "pulses",
        )):
            return
        prev_low, prev_high = self._bounds(previous)
        low, high = self._bounds(snapshot)
        missing = round(prev_low - high, 3)
        maximum = round(prev_high - low, 3)
        uncertainty = comparison(snapshot['calibrationId'],(prev_low,prev_high),(low,high),0)
        if uncertainty:
            missing=uncertainty['differenceBounds']['minLiters']
            maximum=uncertainty['differenceBounds']['maxLiters']
        if missing < self.SUSPECT_LITERS:
            return
        check = {"id": f"inventory-{uuid4()}", "reason": "unmetered_drop",
                 "status": "suspected_loss", "baseline": previous,
                 "observed": snapshot, "occurredAt": snapshot["occurredAt"],
                 "differenceLiters": missing, "differenceMaxLiters": maximum, "meteredLiters": 0}
        if uncertainty:check['uncertainty']=uncertainty
        # Persistir también el avance evita repetir la misma evidencia tras un
        # reinicio. El ancla acumulativa independiente permanece intacta.
        self.state["baseline"] = snapshot
        self.store.save_inventory_state(self.site_id, self.state, check=check,
            alert=None if self.customer_policy else self._alert(check, "Posible robo o fuga: descenso sin flujo K24",
                f"El faltante mínimo tras aplicar los márgenes considerados es {format_liters_cl(missing, bound='lower')} L sin pulsos K24. "
                "Verificar robo, fuga y medición. Umbral de sospecha de 20,0 L; "
                "no confirma la causa ni elimina la incertidumbre del OCIO."))

    def _complete(self, pending: dict, snapshot: dict, *, meter_healthy: bool) -> None:
        baseline = pending.get("baseline")
        check = {**pending, "observed": snapshot,
                 "occurredAt": snapshot["occurredAt"],
                 "sampleCount": 3, "spreadLimitLiters": self.STABLE_SPREAD_LITERS,
                 "suspectThresholdLiters": self.SUSPECT_LITERS,
                 "clearThresholdLiters": self.CLEAR_LITERS}
        alert = None
        compatible = baseline and all(baseline.get(key) == snapshot[key] for key in (
            "calibrationId", "capacityLiters", "pulsesPerLiter",
        )) and snapshot["pulses"] >= baseline["pulses"] and self.k24_enabled and meter_healthy
        if not compatible:
            check["status"] = "unverifiable"
            alert = self._alert(check, "Inventario sin referencia verificable",
                                "Falta una referencia previa compatible o el conteo K24. "
                                "No se puede descartar pérdida durante la interrupción. "
                                "Se guarda una nueva referencia para verificaciones futuras.")
        else:
            metered = (snapshot["pulses"] - baseline["pulses"]) / self.factor
            expected = baseline["levelLiters"] - metered
            missing = round(expected - snapshot["levelLiters"], 3)
            before_low, before_high = self._bounds(baseline)
            low, high = self._bounds(snapshot)
            lower = round(before_low - metered - high, 3)
            upper = round(before_high - metered - low, 3)
            uncertainty=comparison(snapshot['calibrationId'],(before_low,before_high),(low,high),metered)
            if uncertainty:
                lower=uncertainty['differenceBounds']['minLiters']
                upper=uncertainty['differenceBounds']['maxLiters']
                check['uncertainty']=uncertainty
            check.update(meteredLiters=metered, expectedLiters=expected,
                         differenceLiters=missing, differenceRange={"minLiters": lower, "maxLiters": upper})
            if lower >= self.SUSPECT_LITERS or upper <= -self.SUSPECT_LITERS:
                check["status"] = "suspected_loss" if lower > 0 else "unverified_increase"
                title = ("Posible extracción durante interrupción" if lower > 0
                         else "Aumento de inventario durante interrupción")
                detail = (
                    f"Esperado entre {format_liters_cl(before_low-metered, bound='lower')} y {format_liters_cl(before_high-metered, bound='upper')} L; "
                    f"observado entre {format_liters_cl(low, bound='lower')} y {format_liters_cl(high, bound='upper')} L; "
                    f"diferencia entre {format_liters_cl(lower, bound='lower')} y {format_liters_cl(upper, bound='upper')} L; paso por K24 {format_liters_cl(metered)} L. "
                    "Tres lecturas estables durante al menos 120 s. "
                    "El umbral de 20,0 L se aplica al menor faltante después de los márgenes considerados. "
                    "Esta alerta no confirma robo ni certifica la exactitud del conjunto instalado. "
                    "Revisar accesos, recepciones y calibración."
                )
                alert = self._alert(check, title, detail)
            elif uncertainty and lower <= self.CLEAR_LITERS and upper >= -self.CLEAR_LITERS:
                check['status']='within_uncertainty'
            elif (low != high or before_low != before_high) and (lower < -self.CLEAR_LITERS or upper > self.CLEAR_LITERS):
                check["status"] = "range_uncertainty"
            elif lower < -self.CLEAR_LITERS or upper > self.CLEAR_LITERS:
                # Banda gris: no aprobar ni mover la referencia. Al vencer el
                # plazo se avisa que la cuadratura sigue pendiente.
                return
            else:
                check["status"] = "within_operational_band"
        # La evidencia original queda inmutable en inventory_checks antes de
        # adoptar la referencia siguiente. Las alarmas nunca se auto-resuelven.
        self.state["baseline"] = snapshot
        self.state["pending"] = None
        # V2 retains the local evidence. The local web service correlates all
        # loss channels into a single incident with receipts and persistence.
        self.store.save_inventory_state(self.site_id, self.state, check=check,
                                        alert=None if self.customer_policy else alert)

    def _alert(self, check: dict, title: str, detail: str) -> dict:
        return {"id": check["id"], "severity": "warning", "priority": "high",
                "title": title, "detail": detail, "occurredAt": check["occurredAt"]}

    @staticmethod
    def _bounds(snapshot: dict) -> tuple[float, float]:
        bounds = snapshot.get("levelRange")
        return (bounds["minLiters"], bounds["maxLiters"]) if bounds else (snapshot["levelLiters"], snapshot["levelLiters"])
