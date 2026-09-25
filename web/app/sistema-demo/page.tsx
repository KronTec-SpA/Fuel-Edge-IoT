"use client";

import { useState } from "react";
import { SystemHealthPanel, SystemWorkspace } from "../system-workspace";
import PowerSupplyDemo from "../power-supply-demo";
import type { SystemEdge } from "../../shared/system-health";
import type { DisplaySensor } from "../fuel-level-display";

const cases = ["Operación normal", "OCIO pendiente de calibración", "Validador sin conexión", "Sin reporte reciente", "Modo manual activo", "Falla del controlador", "Sin datos iniciales"];
const now = Date.parse("2026-09-09T12:30:00Z");
const at = new Date(now).toISOString();

function PreviewSection({ title, items }: { title: string; items: { title: string; detail: string; body: string }[] }) {
  return <section className="sys-proposals"><div className="sys-section-heading"><div><span className="sys-label">VISTA DE EJEMPLO</span><h2>{title}</h2><p>Los controles de terreno se agrupan aquí. Esta demostración sólo permite consultar ejemplos.</p></div></div><div className="sys-proposal-list">{items.map(item => <article className="panel sys-proposal" key={item.title}><h3>{item.title}</h3><p>{item.detail}</p><details><summary>Ver detalle</summary><p>{item.body}</p></details></article>)}</div></section>;
}

export default function SystemDemo() {
  const [selected, setSelected] = useState(1);
  const edge: SystemEdge | null = selected === 6 ? null : { moduleId: "rpiplc-demo-01", siteId: "Fundo Santa Isabel · ejemplo", state: selected === 4 ? "manual_mode" : selected === 5 ? "fault" : "locked", relayEnergized: selected === 4 || selected === 3, validatorOnline: selected !== 2, nfcReady: true, k24Enabled: true, k24Healthy: true, tankLevelEnabled: true, telemetrySessionId: "sesion-demostracion", occurredAt: new Date(now - (selected === 3 ? 600000 : 5000)).toISOString() };
  const sensor: DisplaySensor | null = selected === 6 ? null : { currentLevel: 895, capacityLiters: 2500, latestReadingAt: new Date(now - (selected === 3 ? 610000 : 15000)).toISOString(), telemetrySessionId: "sesion-demostracion", measurementQuality: { occurredAt: at, status: selected === 1 ? "calibration_pending" : "valid", telemetrySessionId: "sesion-demostracion" } };
  return <main className="sys-demo-shell">
    <div className="sys-demo-brand"><span className="auth-mark">CT</span><div><strong>Concha y Toro</strong><small>Monitoreo de combustible · Fundo Santa Isabel</small></div></div>
    <div className="sys-demo-heading"><div><h1>Sistema</h1><p>Propuesta de organización · datos de ejemplo</p></div><label className="sys-demo-scenarios">Escenario<select value={selected} onChange={event => setSelected(Number(event.target.value))}>{cases.map((item, index) => <option value={index} key={item}>{item}</option>)}</select></label></div>
    <SystemWorkspace sections={[
      { id: "health", label: "Estado del sistema", content: <SystemHealthPanel key={selected} edge={edge} sensor={sensor} online={selected !== 3 && selected !== 6} nowMs={now} onRefresh={async () => { /* Fixed example: refreshing never implies a new physical report. */ }} /> },
      { id: "power", label: "Suministro eléctrico", content: <PowerSupplyDemo online={selected !== 3 && selected !== 6} /> },
      { id: "maintenance", label: "Calibración y mantenimiento", content: <PreviewSection title="Instrumentación y pruebas" items={[
        { title: "Sensor de nivel OCIO", detail: "Lectura, conversión de volumen y validación de calibración", body: "Concentrar aquí las lecturas eléctricas, la tabla del estanque y la confirmación del ajuste físico. La calibración pendiente aparece también en el diagnóstico general." },
        { title: "Proximidad BLE", detail: "Umbral solicitado y valor aplicado por el validador", body: "Se conserva el ajuste existente con observaciones de señal y confirmación de aplicación. Requiere administración del sistema." },
        { title: "Cuadratura de inventario", detail: "Medición del estanque frente a recepciones y despachos", body: "Disponible para mantenimiento maestro. Mantiene el volumen esperado y medido con los márgenes de variación observados." },
        { title: "Prueba de bomba y puesta en marcha", detail: "Acciones físicas y reinicio de registros, con sus permisos actuales", body: "La interfaz operacional conserva la confirmación de prueba y las restricciones del controlador. El reinicio de datos queda en mantenimiento; esta vista de ejemplo no ejecuta ninguna acción." },
      ]} /> },
      { id: "operation", label: "Operación y permisos", content: <PreviewSection title="Operación excepcional" items={[
        { title: "Modo manual", detail: "Período autorizado, inicio, término y responsable", body: "Se conserva su programación para los perfiles autorizados y la confirmación física por el PLC. El estado general destaca cuando este modo está activo." },
        { title: "Adopción tecnológica", detail: "Aprendizaje gradual y etapa de trazabilidad", body: "Se agrupa aquí el inicio, seguimiento y desactivación del programa existente. Sus acciones conservan los permisos actuales." },
      ]} /> },
    ]} />
    <footer className="sys-demo-note"><span>Demostración aislada · sin conexión con la Raspberry Pi</span><span>Escenarios con fecha fija: 9 de septiembre de 2026</span></footer>
  </main>;
}
