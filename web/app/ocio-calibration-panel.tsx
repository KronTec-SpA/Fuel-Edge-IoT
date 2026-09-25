"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { formatSiteDate } from "./site-time";
import "./ocio-calibration.css";
import { calibrationCountdown } from "../shared/calibration-schedule";

export type OcioCalibration = {
  intervalDays:number;revision:number;confirmationId:string|null;
  calibratedAt:string|null;calibratedBy:string|null;nextDueAt:string|null;
  appliedAt:string|null;controllerSeenAt:string|null;controllerAvailable:boolean;
  status:"uncalibrated"|"awaiting_plc"|"calibrated"|"configuration_changed";
  history:{id:string;kind:string;occurredAt:string;actorName:string;intervalDays:number;appliedAt:string|null}[];
};

export default function OcioCalibrationPanel({nowMs,canManage,onRefresh}:{nowMs:number;canManage:boolean;onRefresh:()=>Promise<void>}) {
  const [data,setData] = useState<OcioCalibration|null>(null);
  const [days,setDays] = useState("365"), [busy,setBusy] = useState(false), [error,setError] = useState("");
  const dirty = useRef(false), applied = useRef<string|null>(null), refresh = useRef(onRefresh);
  useEffect(() => { refresh.current=onRefresh; }, [onRefresh]);
  const accept = useCallback((value:OcioCalibration) => {
    setData(value);
    if (!dirty.current) setDays(String(value.intervalDays));
    if (value.appliedAt && value.appliedAt !== applied.current) void refresh.current();
    applied.current=value.appliedAt;
  },[]);
  useEffect(() => {
    const controller = new AbortController();
    const load = async () => {
      try {
        const response = await fetch("/api/system-settings/ocio-calibration",{credentials:"same-origin",cache:"no-store",signal:controller.signal});
        const body = await response.json();
        if (!response.ok) throw new Error(body.error || "No fue posible consultar la calibración.");
        accept(body.calibration);
      } catch (caught) {
        if (!controller.signal.aborted) setError(caught instanceof Error ? caught.message : "No fue posible consultar la calibración.");
      }
    };
    void load();
    const timer=setInterval(()=>void load(),5000);
    return ()=>{controller.abort();clearInterval(timer);};
  },[accept]);
  const save = async (confirm:boolean) => {
    if (!data || busy) return;
    setBusy(true);setError("");
    try {
      const response = await fetch(`/api/system-settings/ocio-calibration${confirm ? "/confirm" : ""}`,{
        method:confirm ? "POST" : "PUT",credentials:"same-origin",headers:{"content-type":"application/json"},
        body:JSON.stringify({intervalDays:Number(days),expectedRevision:data.revision}),
      });
      const body=await response.json();
      if (!response.ok) throw new Error(body.error || "No fue posible guardar la calibración.");
      dirty.current=false;accept(body.calibration);
    } catch(caught) {setError(caught instanceof Error ? caught.message : "No fue posible guardar la calibración.");}
    finally {setBusy(false);}
  };
  const countdown=calibrationCountdown(data?.nextDueAt ?? null,nowMs);
  const waiting=data?.status==="awaiting_plc";
  const validDays=Number.isInteger(Number(days)) && Number(days)>=1 && Number(days)<=730;
  const label=!data ? "Consultando…" : waiting ? "Esperando PLC" : data.status==="configuration_changed" ? "Requiere nueva calibración"
    : data.status==="uncalibrated" ? "Calibración pendiente" : countdown.overdue ? "Calibración vencida" : "Calibración vigente";
  const tone=data?.status==="calibrated" && !countdown.overdue ? "ok" : waiting ? "waiting" : "pending";
  return <section className="panel ocio-calibration-panel" aria-label="Calibración del OCIO">
    <div className="ocio-calibration-heading"><div><span className="eyebrow">Medición del estanque</span><h2>Calibración del OCIO</h2><p>Registra el trabajo realizado en terreno y programa la próxima visita.</p></div><span className={`ocio-calibration-status ${tone}`} role="status">{label}</span></div>
    <div className="ocio-calibration-values">
      <div><span>Último registro en terreno</span><strong>{data?.calibratedAt ? formatSiteDate(data.calibratedAt,{dateStyle:"medium"}) : "Sin calibración registrada"}</strong><small>{data?.calibratedBy || "Pendiente de confirmación"}</small></div>
      <div className={countdown.overdue ? "overdue" : ""}><span>Próxima calibración</span><strong>{data?.nextDueAt ? formatSiteDate(data.nextDueAt,{dateStyle:"medium"}) : "Por programar"}</strong><small aria-live="off">{countdown.text}</small></div>
    </div>
    {canManage && <div className="ocio-calibration-controls"><label htmlFor="ocio-calibration-days">Intervalo de mantenimiento<div><input id="ocio-calibration-days" type="number" min="1" max="730" step="1" value={days} disabled={busy || !data} onChange={event=>{setDays(event.target.value);dirty.current=true;}}/><span>días</span></div></label><div className="ocio-calibration-actions"><button type="button" className="secondary-button compact" disabled={busy || !data || !validDays || Number(days)===data.intervalDays} onClick={()=>void save(false)}>Guardar intervalo</button><button type="button" className="primary-button compact" disabled={busy || !data?.controllerAvailable || waiting || !validDays} onClick={()=>void save(true)}>{busy ? "Guardando…" : "Calibrado"}</button></div></div>}
    <p className="ocio-calibration-note">{waiting ? "Registro guardado. El PLC lo aplicará cuando la bomba esté en reposo." : canManage ? "Pulsa Calibrado después de ajustar y verificar el OCIO en terreno. El estado pendiente se quita cuando el PLC lo confirma." : `Mantenimiento programado cada ${data?.intervalDays ?? 365} días.`}</p>
    {error && <p className="auth-error" role="alert">{error}</p>}
    {!!data?.history.length && <details className="ocio-calibration-history"><summary>Historial de calibración y programación</summary><ul>{data.history.map(event=><li key={event.id}><span><strong>{event.kind==="calibration" ? "Calibración registrada" : "Intervalo actualizado"}</strong><small>{event.actorName} · {event.intervalDays} días</small></span><time dateTime={event.occurredAt}>{formatSiteDate(event.occurredAt,{dateStyle:"medium",timeStyle:"short"})}</time></li>)}</ul></details>}
  </section>;
}
