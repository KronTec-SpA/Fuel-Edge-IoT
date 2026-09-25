"use client";

import { useState } from "react";
import { fuelLevelDisplay, type DisplaySensor } from "../fuel-level-display";
import { InventoryBalanceValues, type Balance } from "../inventory-balance-panel";

const cases = ["Operación normal", "Variación acotada", "Ciclo de medición", "Actualización pendiente", "Sin conexión", "Faltante detectado", "Reinicio del sistema", "Falla del sensor"];

export default function LevelRangeDemo() {
  const [selected, setSelected] = useState(1);
  const now = Date.parse("2026-09-08T12:00:00Z"), at = new Date(now).toISOString();
  // Alturas 440–450 mm, interpoladas en la tabla del fabricante BFM02500DG.
  const range = {minLiters: 869, maxLiters: 895};
  const pointLiters = 895;
  const ranged = [1,5].includes(selected);
  const sensor: DisplaySensor = {currentLevel: ranged ? (range.minLiters+range.maxLiters)/2 : pointLiters,
    levelRange: ranged ? range : null, capacityLiters: 2500,
    latestReadingAt: new Date(now-(selected===3 ? 360000 : selected===4 || selected===6 ? 600000 : selected===2 ? 15000 : 0)).toISOString(),
    telemetrySessionId: selected===6 ? "anterior" : "demo", measurementQuality: {occurredAt:at,telemetrySessionId:"demo",
      status: selected===6 ? "warming_up" : selected===7 ? "unavailable" : selected===2 ? "settling" : selected===3 ? "ambiguous_levels" : ranged ? "range" : "valid"}};
  const display = fuelLevelDisplay(sensor,{occurredAt: new Date(now-(selected===4 ? 600000 : 0)).toISOString(),
    tankLevelEnabled:true,telemetrySessionId:"demo"},now);
  const expected = selected===5 ? 940 : ranged ? 882 : pointLiters;
  const measuredRange = ranged ? range : {minLiters:pointLiters,maxLiters:pointLiters};
  const difference = {minLiters: expected-measuredRange.maxLiters, maxLiters: expected-measuredRange.minLiters};
  const balance: Balance = {occurredAt: sensor.latestReadingAt, initialLiters: expected, receivedLiters:0,meteredLiters:0,
    expectedLiters:expected, measuredLiters:sensor.currentLevel, differenceLiters:ranged ? null : expected-pointLiters,
    measuredRange, expectedRange:{minLiters:expected,maxLiters:expected}, differenceRange:difference,
    pendingReceipts:0,status:selected===5 ? "suspected_loss" : ranged ? "range_uncertainty" : "within_band"};
  const notes = [
    "Lectura vigente. El inventario se contrasta con los despachos registrados por K24.",
    "Se mantiene un volumen de referencia. La cuadratura utiliza todos los límites observados.",
    "Se conserva la última lectura válida mientras se verifica la señal. El pulso de presión no se incorpora al inventario.",
    "Se muestra la última lectura disponible con su fecha. La verificación de inventario requiere atención.",
    "El dato mostrado corresponde al último reporte recibido. El controlador conserva el conteo K24 y la evidencia local.",
    "Posible robo o fuga: incluso el menor faltante supera 20,0 L. La alerta requiere revisión.",
    "Se conserva la lectura anterior al reinicio. Al recuperar la señal se verifica el inventario con el consumo K24 registrado.",
    "La señal del sensor requiere revisión. El último volumen permanece visible, pero no se presenta como una lectura vigente.",
  ];
  return <main className="level-range-demo">
    <p className="eyebrow">VISTA DE EJEMPLO · SIN DATOS DE TERRENO</p>
    <h1>Nivel de combustible</h1>
    <div className="range-example-actions" aria-label="Casos de medición">{cases.map((name,i)=><button key={name} aria-pressed={selected===i} onClick={()=>setSelected(i)}>{name}</button>)}</div>
    <section className="panel range-example-card">
      <div className="range-example-heading"><span className="eyebrow">{display.label}</span><span className={"reading-status "+(display.fresh ? "current" : "pending")}>{display.statusLabel}</span></div>
      <h2 className="reference-volume">{display.volumeLabel}</h2>
      <p>{display.percentLabel} de 2.500,0 L</p>
      {display.variationLabel && <p className="reading-variation">{display.variationLabel}</p>}
      <div className="range-example-track"><span style={{width:display.percent+"%"}}/>{ranged && <i style={{left:display.minPercent+"%",width:(display.maxPercent!-display.minPercent!)+"%"}}/>}</div>
      <p role="status">{notes[selected]}</p>
      <small>Última lectura: {new Date(sensor.latestReadingAt).toLocaleString("es-CL",{timeZone:"America/Santiago"})}</small>
    </section>
    <section className="panel range-example-card"><h2>Control de inventario</h2>
      <InventoryBalanceValues latest={balance}/>
      {!display.fresh && <p>Cuadratura correspondiente a la última lectura disponible.</p>}
    </section>
  </main>;
}
