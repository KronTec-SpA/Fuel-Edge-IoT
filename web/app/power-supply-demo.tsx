"use client";

import { useCallback, useState } from "react";
import "./power-supply-demo.css";
import PowerSupplyView from "./power-supply-panel";
import { powerIncidentLabels, summarizePowerEvents, type PowerIncidentType, type PowerSupplyEvent } from "../shared/power-supply";

export const POWER_DEMO_END = Date.parse("2026-09-09T12:30:00Z");
export const POWER_DEMO_EVENTS: PowerSupplyEvent[] = [
  ["01", 1, 240, "ups_gpio24", "unscheduled"],
  ["02", 15, 1500, "operator_confirmed", "scheduled"],
  ["03", 48, 510, "ups_gpio24", null],
  ["04", 120, 3600, "reconstructed", "internal_fault"],
  ["05", 240, 720, "ups_gpio24", "unscheduled"],
  ["06", 600, 1200, "operator_confirmed", "scheduled"],
].map(([id, hours, duration, source, incidentType]) => ({
  id: `power-demo-${id}`, siteId: "demostracion", alertId: `alert-demo-${id}`,
  restoredAt: new Date(POWER_DEMO_END - Number(hours) * 3600000).toISOString(),
  lostAt: new Date(POWER_DEMO_END - Number(hours) * 3600000 - Number(duration) * 1000).toISOString(),
  durationSeconds: Number(duration), source: source as PowerSupplyEvent["source"],
  incidentType: incidentType as PowerIncidentType | null, lossBootId: null, restoreBootId: null,
}));

export function demoPowerHistory(days: 1 | 7 | 30, classifications: Record<string, PowerIncidentType> = {}) {
  const start = POWER_DEMO_END - days * 86400000;
  const events = POWER_DEMO_EVENTS.filter(event => Date.parse(event.restoredAt) > start)
    .map(event => ({ ...event, incidentType: classifications[event.alertId!] ?? event.incidentType }));
  return { rangeDays: days, rangeStart: new Date(start).toISOString(), generatedAt: new Date(POWER_DEMO_END).toISOString(), events, summary: summarizePowerEvents(events, start, POWER_DEMO_END) };
}

export default function PowerSupplyDemo({ online }: { online: boolean }) {
  const [classifications, setClassifications] = useState<Record<string, PowerIncidentType>>({});
  const [editing, setEditing] = useState<string | null>(null);
  const [selected, setSelected] = useState<PowerIncidentType>("unscheduled");
  const [saved, setSaved] = useState("");
  const loadHistory = useCallback(async (days: 1 | 7 | 30, signal: AbortSignal) => {
    if (signal.aborted) throw new DOMException("Consulta cancelada", "AbortError");
    return demoPowerHistory(days, classifications);
  }, [classifications]);
  return <div className="sys-power-demo">
    <p className="sys-power-demo-notice">Datos de ejemplo · prueba los períodos, el detalle de cada corte y su clasificación.</p>
    <PowerSupplyView online={online} reportedAt={new Date(POWER_DEMO_END - (online ? 5000 : 600000)).toISOString()} loadHistory={loadHistory} onOpenAlert={id => {
      setEditing(id); setSaved(""); setSelected(classifications[id] ?? POWER_DEMO_EVENTS.find(item => item.alertId === id)?.incidentType ?? "unscheduled");
      requestAnimationFrame(() => document.getElementById("demo-power-classification")?.focus());
    }} />
    {editing && <section className="panel sys-power-classification" aria-labelledby="demo-classification-title">
      <div><span className="sys-label">ALERTA DE EJEMPLO</span><h2 id="demo-classification-title">Clasificar interrupción</h2><p>El cambio se refleja en la tabla y el gráfico de esta demostración. Se descarta al salir de la sección.</p></div>
      <label>Tipo de incidente<select id="demo-power-classification" value={selected} onChange={event => setSelected(event.target.value as PowerIncidentType)}>{Object.entries(powerIncidentLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
      <div className="sys-power-classification-actions"><button type="button" className="secondary-button" onClick={() => setEditing(null)}>Cancelar</button><button type="button" className="primary-button" onClick={() => { setClassifications(current => ({ ...current, [editing]: selected })); setEditing(null); setSaved("Clasificación actualizada sólo en esta demostración."); }}>Guardar en demostración</button></div>
    </section>}
    {saved && <p className="sys-feedback" role="status">{saved}</p>}
  </div>;
}
