"use client";

import { useEffect, useState, type CSSProperties } from "react";
import { formatSiteDate } from "./site-time";
import { powerIncidentLabels, type PowerSupplyEvent, type PowerSupplyResponse } from "../shared/power-supply";

type RangeDays = 1 | 7 | 30;

export default function PowerSupplyView({ online, reportedAt, onOpenAlert, alertRevision, loadHistory = requestPowerSupply }: {
  online: boolean;
  reportedAt?: string;
  onOpenAlert: (id: string) => void;
  alertRevision?: string;
  loadHistory?: (days: RangeDays, signal: AbortSignal) => Promise<PowerSupplyResponse>;
}) {
  const [query, setQuery] = useState<{ days: RangeDays; revision: number }>({ days: 30, revision: 0 });
  const [data, setData] = useState<PowerSupplyResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [activeId, setActiveId] = useState<string | null>(null);
  const [initialClock] = useState(() => Date.now());

  useEffect(() => {
    const controller = new AbortController();
    void loadHistory(query.days, controller.signal)
      .then(body => {
        if (controller.signal.aborted) return;
        setData(body); setError(""); setLoading(false);
      })
      .catch(caught => {
        if (controller.signal.aborted) return;
        setError(caught instanceof Error ? caught.message : "No fue posible consultar el historial eléctrico.");
        setLoading(false);
      });
    return () => controller.abort();
  }, [query, alertRevision, loadHistory]);

  function changeRange(days: RangeDays) {
    setLoading(true); setError(""); setActiveId(null);
    // Always request, including the active range and a reset already at 30 days.
    setQuery(current => ({ days, revision: current.revision + 1 }));
  }

  const rangeDays = query.days;
  const current = data?.rangeDays === rangeDays ? data : null;
  const chartEnd = Date.parse(current?.generatedAt ?? new Date(initialClock).toISOString());
  const chartStart = current ? Date.parse(current.rangeStart) : chartEnd - rangeDays * 86_400_000;
  const chartSpan = Math.max(1, chartEnd - chartStart);
  const ticks = Array.from({ length: 5 }, (_, index) => chartStart + chartSpan * index / 4);
  const events = current?.events ?? [];
  const lastOutage = current?.summary.lastOutage;
  const activeEvent = events.find(event => event.id === activeId);
  const position = (value: string) => Math.max(0, Math.min(100, (Date.parse(value) - chartStart) / chartSpan * 100));
  const period = rangeDays === 1 ? "las últimas 24 horas" : `los últimos ${rangeDays} días`;

  return <div className="power-supply-page">
    <section className={`panel power-supply-hero ${online ? "available" : "unconfirmed"}`}>
      <div><span className="eyebrow">Continuidad eléctrica</span><h2>Registro de interrupciones</h2>
        <p>El reporte del PLC indica conectividad; no confirma por sí solo la continuidad eléctrica.</p></div>
      <strong><i />{online ? "PLC en línea" : "Sin reporte reciente"}
        <small>{reportedAt ? `Último reporte: ${formatPowerDate(reportedAt)}` : "Estado de comunicación del controlador"}</small></strong>
    </section>

    <section className="power-metrics" aria-label="Resumen de continuidad eléctrica" aria-busy={loading}>
      <article className="panel"><small>Cortes registrados</small><strong>{current?.summary.outageCount ?? "—"}</strong><span>{period}</span></article>
      <article className="panel"><small>Tiempo de corte</small><strong>{current ? formatPowerDuration(current.summary.totalDowntimeSeconds) : "—"}</strong><span>dentro del período, sin duplicar solapamientos</span></article>
      <article className="panel"><small>Corte más largo</small><strong>{current?.summary.outageCount ? formatPowerDuration(current.summary.longestOutageSeconds) : "—"}</strong></article>
      <article className="panel"><small>Última recuperación</small><strong>{lastOutage ? formatSiteDate(lastOutage.restoredAt, { hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "—"}</strong><span>{lastOutage ? formatSiteDate(lastOutage.restoredAt, { day: "2-digit", month: "long", year: "numeric" }) : "Sin recuperación en este período"}</span></article>
    </section>

    <section className="panel power-timeline-card" aria-busy={loading}>
      <div className="power-card-heading"><div><span className="eyebrow">Continuidad</span><h2>Historial de suministro</h2></div>
        <div className="power-range-controls" aria-label="Período del gráfico">
          {([1, 7, 30] as const).map(days => <button type="button" className={rangeDays === days ? "active" : ""} aria-pressed={rangeDays === days} onClick={() => changeRange(days)} key={days}>{days === 1 ? "24 h" : `${days} d`}</button>)}
          <button type="button" className="power-refresh" onClick={() => changeRange(30)} disabled={loading} aria-label="Restablecer a 30 días y actualizar historial"><span className={loading ? "is-refreshing" : ""} aria-hidden="true">↻</span></button>
        </div>
      </div>
      <div className="power-update-status" role="status" aria-live="polite">{loading ? "Actualizando historial…" : error ? `No se pudo actualizar el historial${current ? "; se conservan los últimos datos recibidos" : ""}` : current ? `Historial actualizado · ${formatPowerDate(current.generatedAt)}` : "Sin consulta disponible"}</div>
      {error && <div className="auth-error" role="alert"><span>!</span>{error}<button type="button" className="secondary-button small" onClick={() => changeRange(rangeDays)}>Reintentar</button></div>}
      {current && !error && <>
        <div className="power-timeline-wrap">
          <div className="power-timeline-legend"><span><i className="unrecorded" />Sin corte registrado</span><span><i className="outage" />Interrupción registrada</span></div>
          <div className="power-timeline-labels" aria-hidden="true"><span>Sin corte<br />registrado</span><span>Interrumpido</span></div>
          <div className="power-timeline" role="group" aria-label={`Historial de interrupciones de ${period}`}>
            <span className="power-unrecorded-line" />
            {events.map(event => {
              const left = position(event.lostAt);
              const width = Math.max(0, position(event.restoredAt) - left);
              return <button type="button" className={`power-outage-target ${activeId === event.id ? "selected" : ""}`} style={{ left: `clamp(0px, calc(${left}% - 7px), calc(100% - 14px))`, width: `max(14px, calc(${width}% + 14px))` }}
                key={event.id} aria-label={`Corte del ${formatPowerDate(event.lostAt)}, ${formatPowerDuration(event.durationSeconds)}`}
                aria-describedby={activeId === event.id ? "power-event-tooltip" : undefined}
                onMouseEnter={() => setActiveId(event.id)} onMouseLeave={() => setActiveId(null)} onFocus={() => setActiveId(event.id)} onBlur={() => setActiveId(null)} onClick={() => setActiveId(event.id)} onKeyDown={key => { if (key.key === "Escape") setActiveId(null); }}>
                <span className="power-outage-segment" />
              </button>;
            })}
            {activeEvent && <div id="power-event-tooltip" className="power-event-tooltip" role="tooltip" style={{ "--tooltip-x": `${position(activeEvent.lostAt)}%` } as CSSProperties}>
              <strong>{formatPowerDuration(activeEvent.durationSeconds)} de interrupción</strong>
              <dl><div><dt>Inicio</dt><dd>{formatPowerDate(activeEvent.lostAt)}</dd></div><div><dt>Recuperación</dt><dd>{formatPowerDate(activeEvent.restoredAt)}</dd></div></dl>
              <span>{activeEvent.incidentType ? powerIncidentLabels[activeEvent.incidentType] : "Pendiente de clasificación"} · {powerSourceLabel(activeEvent.source)}</span>
            </div>}
          </div>
          <div className="power-timeline-ticks" aria-hidden="true">{ticks.map(tick => <time key={tick}>{formatSiteDate(tick, rangeDays === 1 ? { hour: "2-digit", minute: "2-digit" } : { day: "2-digit", month: "short" })}</time>)}</div>
          {!loading && events.length === 0 && <div className="power-empty-chart">No hay cortes registrados en este período.</div>}
        </div>
        <p className="power-data-note">El tramo gris indica ausencia de cortes registrados, no una medición continua. La duración termina cuando el PLC registra la recuperación y puede incluir su tiempo de arranque.</p>
      </>}
    </section>

    <section className="panel power-history-card" aria-busy={loading}>
      <div className="power-card-heading"><div><span className="eyebrow">Detalle de eventos</span><h2>Cortes y recuperación</h2><p>Fechas en hora de Chile. La duración corresponde al evento completo.</p></div><span className="power-history-count">{current ? `${events.length} ${events.length === 1 ? "evento" : "eventos"}` : "—"}</span></div>
      {events.length > 0 ? <div className="power-history-table-wrap"><table className="power-history-table"><thead><tr><th>Inicio del corte</th><th>Recuperación</th><th>Duración</th><th>Origen</th><th>Clasificación</th></tr></thead><tbody>{events.map(event => <tr key={event.id}>
        <td><strong>{formatPowerDate(event.lostAt)}</strong></td><td>{formatPowerDate(event.restoredAt)}</td><td>{formatPowerDuration(event.durationSeconds)}</td>
        <td><span className={`power-source ${event.source}`}>{powerSourceLabel(event.source)}</span></td>
        <td>{event.alertId ? <button type="button" className={`power-classification ${event.incidentType ? "classified" : ""}`} onClick={() => onOpenAlert(event.alertId!)}>{event.incidentType ? powerIncidentLabels[event.incidentType] : "Clasificar en alerta"}<span aria-hidden="true"> ↗</span></button> : <span className="power-unclassified">Sin clasificación histórica</span>}</td>
      </tr>)}</tbody></table></div> : <div className="power-history-empty"><div><strong>{loading ? "Consultando registros…" : error ? "Historial no disponible" : "Sin cortes en el período seleccionado"}</strong><p>{error ? "Reintenta la consulta para ver los eventos." : "Los eventos aparecen cuando el PLC registra y sincroniza su recuperación."}</p></div></div>}
    </section>
  </div>;
}

async function requestPowerSupply(rangeDays: RangeDays, signal: AbortSignal) {
  const response = await fetch(`/api/system-settings/power-events?days=${rangeDays}`, { credentials: "same-origin", cache: "no-store", signal });
  const body = await response.json() as PowerSupplyResponse & { error?: string };
  if (!response.ok) throw new Error(body.error ?? "No fue posible consultar el historial eléctrico.");
  return body;
}

export function formatPowerDuration(totalSeconds: number) {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainder = seconds % 60;
  if (hours > 0) return `${hours} h ${String(minutes).padStart(2, "0")} min ${String(remainder).padStart(2, "0")} s`;
  if (minutes > 0) return `${minutes} min ${String(remainder).padStart(2, "0")} s`;
  return `${remainder} s`;
}

function formatPowerDate(value: string) { return formatSiteDate(value, { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", second: "2-digit" }); }
function powerSourceLabel(source: PowerSupplyEvent["source"]) { return source === "ups_gpio24" ? "UPS del PLC" : source === "operator_confirmed" ? "Confirmado por operador" : "Histórico reconstruido"; }
