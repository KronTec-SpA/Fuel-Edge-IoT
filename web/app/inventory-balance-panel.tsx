"use client";

import { formatSiteDate } from "./site-time";
import { formatLiters as liters } from "../shared/volume-format";
import { useEffect, useState } from "react";
import { formatLevelRange, type LevelRange } from "./fuel-level-display";

export type Balance = { occurredAt: string; initialLiters: number; receivedLiters: number;
  meteredLiters: number | null; expectedLiters: number | null; measuredLiters: number;
  differenceLiters: number | null; pendingReceipts: number; status: string;
  observedDifferenceLiters?: number | null;
  uncertainty?: {policyId:string;densityKgL:number;densityVerified:boolean;ocioErrorMm:number;
    quantizationHalfStepMm:number;k24ErrorLiters:number;expectedBounds:LevelRange;measuredBounds:LevelRange;differenceBounds:LevelRange} | null;
  initialRange?: LevelRange; measuredRange?: LevelRange; expectedRange?: LevelRange | null; differenceRange?: LevelRange | null };
type ResponseBody = { anchor: { occurredAt: string } | null; latest: Balance | null;
  daily: Array<Balance & { day: string }>;
  detection?: {policyId:string;comparisons:Array<{channel:string;available:boolean;from?:string;to?:string;observed?:number;bounds?:LevelRange;reason?:string}>;
    incident:{id:string;priority:string;condition:string;peak:number}|null;
    latestWindow:{start:string;end:string;count:number}|null;
    health:{occurredAt:string;pendingSince:string|null;lastAcceptedAt:string|null;
      incident:{condition?:string;episodes?:number;startedAt?:string;recoveredAt?:string}}|null} };

export function InventoryBalanceValues({ latest }: { latest: Balance }) {
  const range = latest.differenceRange;
  const surplus = range ? range.maxLiters < 0 : (latest.differenceLiters ?? 0) < 0;
  const overlaps = range && range.minLiters <= 0 && range.maxLiters >= 0;
  const displayed = surplus && range ? {minLiters: -range.maxLiters, maxLiters: -range.minLiters} : range;
  function reference(r: LevelRange | null | undefined, value: number | null) {
    if (!r || r.minLiters === r.maxLiters) return <strong>{liters(value ?? r?.minLiters ?? null)}</strong>;
    const center = Math.round((r.minLiters+r.maxLiters)/2);
    const variation = Math.ceil(Math.max(center-r.minLiters,r.maxLiters-center));
    return <><strong>{liters(center)}</strong><small>Variación observada: ±{liters(variation)}</small></>;
  }
  return <div className="inventory-balance-values">
    <div><small>Inventario esperado</small>{reference(latest.expectedRange,latest.expectedLiters)}</div>
    <div><small>{latest.measuredRange && latest.measuredRange.minLiters !== latest.measuredRange.maxLiters ? "Volumen de referencia OCIO" : "Último nivel OCIO"}</small>{reference(latest.measuredRange,latest.measuredLiters)}</div>
    <div><small>{overlaps ? "Cuadratura" : latest.status === "within_band" ? "Diferencia de inventario" : surplus ? "Excedente sin conciliar" : "Faltante por verificar"}</small><strong>{latest.status === "within_uncertainty" ? "Compatible con el margen" : overlaps ? latest.status === "within_band" ? "Dentro de banda" : "En observación" : displayed && displayed.minLiters !== displayed.maxLiters ? `Al menos ${liters(Math.floor(displayed.minLiters*10)/10)}` : liters(latest.differenceLiters === null ? null : Math.abs(latest.differenceLiters))}</strong>
      {latest.uncertainty && <small>Diferencia observada: {liters(latest.observedDifferenceLiters ?? null)}</small>}
      {range && range.minLiters !== range.maxLiters && <details><summary>Ver límites del cálculo</summary><p>{formatLevelRange(range,null)}</p></details>}
    </div>
  </div>;
}

export function InventoryBalancePanel({ nowMs }: { nowMs: number }) {
  const [data, setData] = useState<ResponseBody | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    let busy = false;
    async function refresh() {
      if (busy) return;
      busy = true;
      try {
        const response = await fetch("/api/inventory-balance", { credentials: "same-origin", cache: "no-store", signal: controller.signal });
        if (!response.ok) throw new Error("No se pudo actualizar la cuadratura.");
        setData(await response.json());
        setError("");
      } catch (caught) {
        if (!controller.signal.aborted) setError(caught instanceof Error ? caught.message : "Cuadratura no disponible.");
      } finally { busy = false; }
    }
    void refresh();
    const timer = window.setInterval(refresh, 5000);
    return () => { controller.abort(); window.clearInterval(timer); };
  }, []);
  const latest = data?.latest;
  const age = latest ? nowMs-Date.parse(latest.occurredAt) : Infinity;
  const stale = age < 0 || age > 180_000;
  const detection=data?.detection;
  const confirmed=detection?.incident?.condition==="active";
  const updating=stale || Boolean(detection?.health?.pendingSince) || latest?.status==="unverifiable";
  const labels:Record<string,string>={anchor:"Referencia conciliada",step:"Antes del escalón","1d":"Día anterior","3d":"Hace 3 días","7d":"Hace 7 días"};
  return <section className="panel inventory-balance-panel" aria-label="Cuadratura acumulada OCIO y K24">
    <div className="history-panel-head"><div><span className="eyebrow">CUADRATURA DE INVENTARIO</span><h2>Seguimiento de inventario · OCIO y K24</h2><p>Inventario inicial + recepciones conciliadas − consumo K24. La referencia se conserva entre días y reinicios.</p></div></div>
    {error && <p role="alert" className="auth-error">{error}</p>}
    {!latest ? <p>Esperando la primera referencia estable del estanque.</p> : <>
      <p><strong>{confirmed ? "Descenso de inventario no explicado" : updating ? "Cuadratura en actualización" : latest.pendingReceipts || latest.status==="unverified_increase" ? "Inventario pendiente de conciliación" : ["suspected_loss","watch","range_uncertainty"].includes(latest.status) ? "Diferencia en observación" : "Sin desviaciones significativas en la última comprobación"}</strong></p>
      <InventoryBalanceValues latest={latest} />
      {latest.uncertainty && <details><summary>Margen de medición aplicado</summary>
        <p>Se amplían las cotas de oscilación del OCIO con su error de medición y medio escalón de resolución; el saldo esperado considera también el error del K24. Un faltante residual de 20,0 L requiere confirmación en dos ventanas de reposo. Desde 100,0 L residuales se aplica confirmación rápida con tres muestras durante al menos dos minutos.</p>
        <p>Esperado con margen: {formatLevelRange(latest.uncertainty.expectedBounds,null)}. OCIO con margen: {formatLevelRange(latest.uncertainty.measuredBounds,null)}.</p>
        <p>Densidad medida en terreno: {latest.uncertainty.densityKgL.toLocaleString('es-CL',{minimumFractionDigits:4,maximumFractionDigits:4})} kg/L. El margen no certifica el error del aforo ni del convertidor.</p>
      </details>}
      <p>{updating ? "Esperando una comprobación reciente y utilizable. Se conserva el último inventario con su fecha. " : ""}{confirmed ? "Hay un descenso persistente fuera del margen considerado. Revisar el incidente y sus antecedentes." : latest.pendingReceipts ? `${latest.pendingReceipts} recepciones pendientes; el balance sigue provisional.` : latest.status === "unverified_increase" ? "Hay un incremento de nivel que requiere conciliación." : latest.status === "suspected_loss" ? "Se está comprobando la persistencia de la diferencia antes de emitir un aviso." : "Las diferencias se conservan para comparar su evolución; el inventario inicial no se reajusta automáticamente."}</p>
      <p className="inventory-balance-reference">Desde {formatSiteDate(data!.anchor!.occurredAt)} · {formatLevelRange(latest.initialRange, latest.initialLiters)} iniciales + {liters(latest.receivedLiters)} recibidos − {liters(latest.meteredLiters)} por K24. Última muestra: {formatSiteDate(latest.occurredAt)}.</p>
      {detection && <details><summary>Comparación con períodos anteriores</summary>
        <p>Ventanas independientes de diez minutos, con combustible en reposo y sin pulsos K24. Se busca un horario similar, con hasta tres horas de diferencia. Sin una referencia válida, la comparación queda pendiente.</p>
        {detection.latestWindow && <p>Ventana actual: {formatSiteDate(detection.latestWindow.start)} a {formatSiteDate(detection.latestWindow.end)}.</p>}
        <div className="table-scroll"><table><thead><tr><th>Referencia</th><th>Diferencia observada</th><th>Intervalo con margen</th></tr></thead><tbody>
          {detection.comparisons.map(c=><tr key={c.channel}><td>{labels[c.channel]??c.channel}{c.from&&<small> · {formatSiteDate(c.from)}</small>}</td><td>{c.available?liters(c.observed??null):"Pendiente"}</td><td>{c.available?formatLevelRange(c.bounds,null):c.reason}</td></tr>)}
        </tbody></table></div>
      </details>}
      {detection?.health && <details><summary>Estado técnico de la medición</summary>
        <p>{nowMs-Date.parse(detection.health.occurredAt)>120_000?"Estado técnico pendiente de actualización.":detection.health.incident.condition==="active"?"Seguimiento de estabilidad OCIO abierto. Las recurrencias se agrupan en un solo incidente técnico.":"Sin incidente técnico activo en el último reporte."} {detection.health.pendingSince?`Verificación pendiente desde ${formatSiteDate(detection.health.pendingSince)}.`:""}</p>
        <p>Reporte: {formatSiteDate(detection.health.occurredAt)}. La recuperación técnica requiere una hora de comprobaciones continuas.</p>
      </details>}
      <details><summary>Seguimiento diario · últimos 31 días con medición</summary>
        <div className="table-scroll"><table><thead><tr><th>Día</th><th>Esperado</th><th>OCIO</th><th>Diferencia acumulada</th></tr></thead><tbody>{data!.daily.map(day=><tr key={day.day}><td>{day.day}</td><td>{formatLevelRange(day.expectedRange, day.expectedLiters)}</td><td>{formatLevelRange(day.measuredRange, day.measuredLiters)}</td><td>{formatLevelRange(day.differenceRange, day.differenceLiters)}</td></tr>)}</tbody></table></div>
      </details>
    </>}
  </section>;
}
