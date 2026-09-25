"use client";

import { useState, type ReactNode } from "react";
import { fuelLevelDisplay, type DisplaySensor } from "./fuel-level-display";
import { databaseInstant, SITE_TIME_ZONE } from "./site-time";
import { systemHealth, type SystemEdge, type HealthTone } from "../shared/system-health";
import "./system-workspace.css";

type Section = { id: string; label: string; content: ReactNode };
export function SystemWorkspace({ sections }: { sections: Section[] }) {
  const [selected, setSelected] = useState("health");
  const active = sections.find(item => item.id === selected) ?? sections[0];
  return <div className="system-workspace system-redesign">
    <div className="sys-tabs" role="tablist" aria-label="Secciones de Sistema">
      {sections.map((item, index) => <button key={item.id} id={`system-${item.id}-tab`} role="tab" type="button"
        aria-selected={active.id === item.id} aria-controls={`system-${item.id}-panel`} tabIndex={active.id === item.id ? 0 : -1}
        onClick={() => setSelected(item.id)} onKeyDown={event => {
          const next = event.key === "ArrowRight" ? (index + 1) % sections.length : event.key === "ArrowLeft" ? (index - 1 + sections.length) % sections.length : event.key === "Home" ? 0 : event.key === "End" ? sections.length - 1 : -1;
          if (next < 0) return;
          event.preventDefault(); setSelected(sections[next].id); document.getElementById(`system-${sections[next].id}-tab`)?.focus();
        }}>{item.label}</button>)}
    </div>
    <div id={`system-${active.id}-panel`} role="tabpanel" aria-labelledby={`system-${active.id}-tab`} tabIndex={0}>{active.content}</div>
  </div>;
}
function Badge({ tone, children }: { tone: HealthTone; children: ReactNode }) {
  return <span className={`sys-badge ${tone}`}><i aria-hidden="true" />{children}</span>;
}
function timestamp(at?: string) {
  if (!at || !(databaseInstant(at).getTime() > 0)) return "Sin reporte";
  // Explicit numeric parts avoid ICU month abbreviations and punctuation varying
  // between the Worker and browser during hydration.
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: SITE_TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).formatToParts(databaseInstant(at));
  const part = (type: string) => parts.find(item => item.type === type)?.value ?? "";
  return `${part("day")}/${part("month")}/${part("year")} · ${part("hour")}:${part("minute")}:${part("second")}`;
}
export function SystemHealthPanel({ edge, sensor, online, nowMs, onRefresh }: {
  edge: SystemEdge | null; sensor: DisplaySensor | null; online: boolean; nowMs: number; onRefresh: () => Promise<void>;
}) {
  const [refreshing, setRefreshing] = useState(false);
  const [message, setMessage] = useState("");
  const level = fuelLevelDisplay(sensor, edge, nowMs);
  const health = systemHealth(edge, online, nowMs, level.fresh);
  const current = health.current;
  const components: { code: string; name: string; purpose: string; detail: string; tone: HealthTone; status: string; at?: string; action: string }[] = [
    { code: "PLC", name: "Controlador", purpose: "Control local", detail: health.state, tone: !current ? "unknown" : edge?.state === "fault" ? "danger" : "ok", status: !current ? "Sin confirmar" : edge?.state === "fault" ? "Falla" : "Reportando", at: edge?.occurredAt, action: "Verificar alimentación y comunicación del controlador." },
    { code: "BLE", name: "Validador RFID / BLE", purpose: "Identificación de equipos", detail: "Enlace con el controlador", tone: !current ? "unknown" : edge?.validatorOnline ? "ok" : "warning", status: !current ? "Sin confirmar" : edge?.validatorOnline ? "Conectado" : "Sin conexión", at: edge?.occurredAt, action: "Revisar alimentación y enlace del validador." },
    { code: "RFID", name: "Lector de credenciales", purpose: "Identificación de operadores", detail: "Lector RC522", tone: !current ? "unknown" : edge?.nfcReady ? "ok" : "warning", status: !current ? "Sin confirmar" : edge?.nfcReady ? "Disponible" : "No disponible", at: edge?.occurredAt, action: "Revisar el lector RFID y su conexión al validador." },
    { code: "K24", name: "Medidor de despacho", purpose: "Conteo de combustible", detail: "PIUSI K24 Pulser", tone: !current ? "unknown" : edge?.k24Enabled && edge.k24Healthy ? "ok" : "warning", status: !current ? "Sin confirmar" : !edge?.k24Enabled ? "No habilitado" : edge.k24Healthy ? "Disponible" : "Revisar", at: edge?.occurredAt, action: "Verificar el medidor K24 antes de realizar pruebas de despacho." },
    { code: "OCIO", name: "Nivel del estanque", purpose: "Medición de inventario", detail: [level.volumeLabel, level.variationLabel].filter(Boolean).join(" · "), tone: !current ? "unknown" : level.fresh ? "ok" : "warning", status: !current ? "Sin confirmar" : level.statusLabel, at: sensor?.latestReadingAt, action: level.statusLabel === "Calibración pendiente" ? "Completar la validación del OCIO en Calibración y mantenimiento." : "Revisar la lectura y la calibración del sensor OCIO." },
  ];
  const pending = components.filter(item => item.tone === "warning" || item.tone === "danger");
  const refresh = async () => { setRefreshing(true); setMessage(""); try { await onRefresh(); setMessage("Consulta completada. La vigencia depende de la fecha del reporte."); } catch { setMessage("No se pudo actualizar. Se conserva el último reporte disponible."); } finally { setRefreshing(false); } };
  return <div className="sys-health">
    <section className={`panel sys-overview ${health.tone}`}>
      <div className="sys-overview-main"><span className={`sys-health-icon ${health.tone}`} aria-hidden="true">{health.tone === "ok" ? "✓" : "!"}</span><div><span className="sys-label">ESTADO DEL SISTEMA</span><h2>{health.title}</h2><p>{current ? "Diagnóstico basado en el último reporte del controlador." : "La conexión y los estados físicos necesitan un nuevo reporte."}</p></div></div>
      <button type="button" className="secondary-button" disabled={refreshing} onClick={() => void refresh()}>{refreshing ? "Consultando…" : "Actualizar estado"}</button>
    </section>
    {message && <p className="sys-feedback" role="status">{message}</p>}
    <section className="sys-metrics" aria-label="Resumen operativo">
      <article className="panel"><span className="sys-label">CONTROLADOR</span><strong>{current ? "Conectado" : "Sin confirmar"}</strong><span className="sys-metric-note">{current ? health.state : "Esperando telemetría vigente"}</span></article>
      <article className="panel"><span className="sys-label">HABILITACIÓN DE BOMBA</span><strong>{health.pump}</strong><span className="sys-metric-note">{health.pumpDetail}</span></article>
      <article className="panel"><span className="sys-label">COMPONENTES</span><strong>{current ? `${components.filter(item => item.tone === "ok").length} de 5` : "—"}</strong><span className="sys-metric-note">{current ? "con estado confirmado" : "Sin diagnóstico vigente"}</span></article>
      <article className="panel"><span className="sys-label">ÚLTIMO REPORTE</span><strong className="sys-report-date">{timestamp(edge?.occurredAt)}</strong><span className="sys-metric-note">Hora de Chile · America/Santiago</span></article>
    </section>
    <div className="sys-diagnostics">
      <section className="panel sys-components"><header><h2>Componentes</h2><span>Estado y última lectura</span></header><div className="sys-component-list">{components.map(item => <article className="sys-component" key={item.code}>
        <span className="sys-component-code" aria-hidden="true">{item.code}</span><div className="sys-component-name"><h3>{item.name}</h3><p>{item.purpose}</p><small>{item.detail}</small></div>
        <div className="sys-component-state"><Badge tone={item.tone}>{item.status}</Badge><time>{timestamp(item.at)}</time></div>
      </article>)}</div></section>
      <aside className="sys-aside"><section className="panel sys-attention"><header><h2>Requiere atención</h2><span className="sys-count">{current ? pending.length : "—"}</span></header>
        {!current ? <div className="sys-attention-item"><Badge tone="unknown">Comunicación pendiente</Badge><p>Verificar la conexión del controlador. Los datos conservados no confirman el estado actual de los componentes.</p></div>
          : pending.length ? pending.map(item => <div className="sys-attention-item" key={item.code}><strong>{item.name}</strong><p>{item.action}</p></div>)
            : <div className="sys-attention-item"><Badge tone="ok">Sin incidencias de componentes</Badge><p>{edge?.state === "manual_mode" || edge?.state === "relay_testing" ? "Hay una operación excepcional activa. Revisa su término en Operación y permisos." : "Los cinco componentes tienen estado confirmado en el último reporte."}</p></div>}
      </section><section className="panel sys-installation"><h2>Instalación</h2><dl><div><dt>Controlador</dt><dd>{edge?.moduleId ?? "Sin identificar"}</dd></div><div><dt>Fundo</dt><dd>{edge?.siteId ?? "Sin identificar"}</dd></div><div><dt>Salida de bomba</dt><dd>R0.1 · autoridad del PLC</dd></div></dl><p>La habilitación del relé no confirma por sí sola que exista flujo de combustible.</p></section></aside>
    </div>
    <details className="panel sys-technical"><summary>Detalle técnico del último reporte</summary><dl><div><dt>Estado de control</dt><dd>{edge?.state ?? "Sin reporte"}{!current && edge ? " · histórico" : ""}</dd></div><div><dt>Relé informado</dt><dd>{edge ? edge.relayEnergized ? "Cerrado" : "Abierto" : "Sin reporte"}{!current && edge ? " · histórico" : ""}</dd></div><div><dt>Sesión de telemetría</dt><dd>{edge?.telemetrySessionId ?? "No informada"}</dd></div></dl></details>
  </div>;
}
