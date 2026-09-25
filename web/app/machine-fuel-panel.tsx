"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { machineCategory, rankMachines, type MachineFuelHistory, type MachineFuelLoads, type MachineFuelTotal } from "../shared/machine-fuel-history";
import { formatLiters, formatVolume, formatVolumeCsv } from "../shared/volume-format";
import { formatSiteDate } from "./site-time";
import "./machine-fuel-panel.css";

function useHistoryRequest<T>(url: string, active: boolean) {
  const [result, setResult] = useState<{ url: string; data: T } | null>(null);
  const [failure, setFailure] = useState<{ url: string; message: string } | null>(null);
  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    let pending = false;
    const refresh = async () => {
      if (pending) return;
      pending = true;
      try {
        const response = await fetch(url, { credentials: "same-origin", cache: "no-store", signal: controller.signal });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error ?? "No se pudo consultar el histórico.");
        if (!controller.signal.aborted) { setResult({ url, data }); setFailure(null); }
      } catch (error) {
        if (!controller.signal.aborted) setFailure({ url, message: error instanceof Error ? error.message : "No se pudo consultar el histórico." });
      } finally { pending = false; }
    };
    void refresh();
    const timer = window.setInterval(refresh, 15000);
    return () => { controller.abort(); window.clearInterval(timer); };
  }, [url, active]);
  return { data: result?.url === url ? result.data : null, error: failure?.url === url ? failure.message : "" };
}

function MachineIcon({ kind }: { kind: string }) {
  const category = machineCategory(kind);
  const harvest = category === "Cosechadora / trilladora";
  const icon = category === "Tractor" || harvest ? "tractor" : category === "Camioneta" ? "car-suv" : category === "Camión" ? "truck" : "settings";
  return <span className="machine-pictogram" aria-hidden="true"><span className="machine-icon-shape" style={{ maskImage: `url(/icons/${icon}.svg)`, WebkitMaskImage: `url(/icons/${icon}.svg)` }} />{harvest && <span className="machine-harvest-mark" style={{ maskImage: "url(/icons/wheat.svg)", WebkitMaskImage: "url(/icons/wheat.svg)" }} />}</span>;
}

const percent = (value: number) => new Intl.NumberFormat("es-CL", { maximumFractionDigits: 1 }).format(value);
const dayLabel = (value: string) => formatSiteDate(`${value}T12:00:00Z`, { day: "numeric", month: "short", year: "numeric" });
// Protect exported user-entered names from spreadsheet formula interpretation.
const csvCell = (value: string | number) => `"${String(value).replace(/^[\s]*[=+@-]/, "'$&").replaceAll('"', '""')}"`;

export function MachineFuelPanel({ from, to, active }: { from: string; to: string; active: boolean }) {
  const [kind, setKind] = useState("all");
  const [search, setSearch] = useState("");
  const [selection, setSelection] = useState<{ machine: MachineFuelTotal; key: string } | null>(null);
  const [page, setPage] = useState(1);
  const detailsRef = useRef<HTMLElement>(null);
  const validRange = /^\d{4}-\d{2}-\d{2}$/.test(from) && /^\d{4}-\d{2}-\d{2}$/.test(to) && from <= to;
  const range = `from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;
  const filterKey = `${range}|${kind}|${search}`;
  const { data, error } = useHistoryRequest<MachineFuelHistory>(`/api/fuel-history/machines?${range}`, active && validRange);
  const ranked = useMemo(() => rankMachines(data?.machines ?? [], kind, search), [data, kind, search]);
  const selected = selection?.key === filterKey ? selection.machine : null;
  const loadsUrl = `/api/fuel-history/machines/loads?${range}&equipmentId=${encodeURIComponent(selected?.equipmentId ?? "")}&page=${page}`;
  const { data: detail, error: detailError } = useHistoryRequest<MachineFuelLoads>(loadsUrl, active && validRange && selected !== null);
  const total = ranked.reduce((sum, machine) => sum + machine.liters, 0);
  const loads = ranked.reduce((sum, machine) => sum + machine.loads, 0);
  const allIdentified = (data?.machines ?? []).reduce((sum, machine) => sum + machine.liters, 0);
  const totalDispatched = allIdentified + (data?.unassigned?.liters ?? 0);
  const coverage = totalDispatched > 0 ? allIdentified / totalDispatched * 100 : 0;
  const filtered = kind !== "all" || search.trim() !== "";
  const topThreeShare = ranked.slice(0, 3).reduce((sum, machine) => sum + machine.share, 0);
  const openMachine = (machine: MachineFuelTotal) => {
    setSelection({ machine, key: filterKey }); setPage(1);
    window.requestAnimationFrame(() => { detailsRef.current?.focus({ preventScroll: true }); detailsRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }); });
  };
  const exportRanking = () => {
    const rows = ranked.map((machine) => [from, to, `${machine.rank}°`, machine.name, machine.equipmentId ?? "", machineCategory(machine.kind), formatVolumeCsv(machine.liters), machine.loads, formatVolumeCsv(machine.liters / machine.loads), percent(machine.share), formatSiteDate(machine.lastAt)]);
    const text = [["Desde", "Hasta", "Puesto", "Máquina", "ID equipo", "Tipo", "Litros surtidos", "Cargas", "Promedio L/carga", "Participación % (filtro)", "Última carga"], ...rows].map((row) => row.map(csvCell).join(",")).join("\n");
    const url = URL.createObjectURL(new Blob([`\uFEFF${text}`], { type: "text/csv;charset=utf-8" }));
    const link = document.createElement("a"); link.href = url; link.download = `ranking-maquinas-${from}-${to}.csv`; link.click(); URL.revokeObjectURL(url);
  };

  return <div className="machine-fuel-stack">
    <section className="panel machine-ranking-toolbar" aria-label="Filtrar máquinas">
      <label className="machine-search">Buscar máquina<input type="search" placeholder="Nombre o código, ej. T195" value={search} onChange={(event) => setSearch(event.target.value)} /></label>
      <label>Tipo de máquina<select value={kind} onChange={(event) => setKind(event.target.value)}><option value="all">Todos los tipos</option>{["Tractor", "Camioneta", "Cosechadora / trilladora", "Camión", "Otro"].map((value) => <option key={value}>{value}</option>)}</select></label>
      <button className="secondary-button" type="button" disabled={!validRange || !data || !!error || ranked.length === 0} onClick={exportRanking}>↓ Exportar ranking</button>
    </section>
    {!validRange ? <div className="machine-empty panel" role="status"><h2>Selecciona un período válido</h2><p>Completa ambas fechas. Desde debe ser anterior o igual a Hasta.</p></div> : error ? <div className="machine-error panel" role="alert"><strong>No se pudo actualizar el ranking</strong><p>{error}</p><span>Se volverá a intentar automáticamente.</span></div> : !data ? <div className="history-loading panel" role="status">Sumando los despachos por máquina…</div> : <>
      <section className="machine-summary" aria-label="Resumen de máquinas del período">
        <article className="panel machine-total"><small>Litros surtidos{filtered ? " · filtro actual" : " a máquinas"}</small><strong>{formatVolume(total)} <span>L</span></strong><p>{loads} {loads === 1 ? "carga" : "cargas"} en el período</p></article>
        <article className="panel"><small>Máquinas con cargas</small><strong>{ranked.length}</strong></article>
        <article className="panel"><small>Promedio por carga</small><strong>{loads ? formatVolume(total / loads) : "—"} <span>{loads ? "L" : ""}</span></strong></article>
      </section>
      {selected && <section className="panel machine-load-detail" ref={detailsRef} tabIndex={-1} aria-labelledby="machine-detail-title">
        <div className="machine-section-head"><div><span className="eyebrow">Histórico de cargas</span><h2 id="machine-detail-title">{selected.name}</h2><p>{dayLabel(from)} — {dayLabel(to)} · {detail?.total ?? selected.loads} cargas</p></div><button className="secondary-button" type="button" onClick={() => setSelection(null)}>Cerrar detalle</button></div>
        {detailError ? <p className="machine-error" role="alert">{detailError}</p> : !detail ? <p role="status">Consultando cargas…</p> : <><div className="machine-load-table-scroll"><table className="machine-load-table"><caption className="sr-only">Cargas de {selected.name} en el período seleccionado</caption><thead><tr><th scope="col">Fecha y hora</th><th scope="col">Litros surtidos</th><th scope="col">Operador</th><th scope="col">Referencia / origen</th></tr></thead><tbody>{detail.movements.map((movement) => <tr key={movement.id}><td><time dateTime={movement.occurredAt}>{formatSiteDate(movement.occurredAt)}</time></td><td><strong>{formatLiters(movement.liters)}</strong></td><td className="machine-operator">{movement.operator}</td><td>{movement.reference}<small>{movement.source}</small></td></tr>)}</tbody></table></div>{detail.movements.length === 0 && <p>No hay cargas en esta página.</p>}<div className="machine-pagination"><span>Página {page} de {Math.max(1, Math.ceil(detail.total / detail.pageSize))} · {detail.total} cargas</span><button className="secondary-button" type="button" disabled={page <= 1} onClick={() => setPage((value) => value - 1)}>Anterior</button><button className="secondary-button" type="button" disabled={page * detail.pageSize >= detail.total} onClick={() => setPage((value) => value + 1)}>Siguiente</button></div></>}
      </section>}
      <section className="machine-ranking" aria-labelledby="machine-ranking-title">
        <div className="machine-section-head"><div><span className="eyebrow">De mayor a menor</span><h2 id="machine-ranking-title">Ranking de máquinas</h2><p>{dayLabel(from)} — {dayLabel(to)}{filtered ? " · ranking del filtro actual" : ""}</p></div>{filtered && <button className="text-button" type="button" onClick={() => { setKind("all"); setSearch(""); }}>Limpiar filtros</button>}</div>
        {ranked.length > 0 ? <><ol className="machine-ranking-grid">{ranked.map((machine) => <li key={machine.equipmentId!} className={`panel machine-rank-card ${machine.rank === 1 ? "machine-leader" : ""}`}>
          <div className="machine-rank-top"><span className="machine-rank-position" aria-label={`Puesto ${machine.rank}`}>{machine.rank}°</span><span className="machine-kind">{machineCategory(machine.kind)}</span></div>
          <div className="machine-identity"><h3>{machine.name}</h3><MachineIcon kind={machine.kind} /></div>
          <div className="machine-volume"><strong>{formatVolume(machine.liters)} <span>L</span></strong></div>
          <div className="machine-share"><div><strong>{percent(machine.share)} %</strong><span>del total{filtered ? " filtrado" : " identificado"}</span></div><span className="machine-share-track" aria-hidden="true"><span style={{ width: `${machine.share}%` }} /></span></div>
          <dl className="machine-card-metrics"><div><dt>Cargas</dt><dd>{machine.loads}</dd></div><div><dt>Promedio / carga</dt><dd>{formatLiters(machine.liters / machine.loads)}</dd></div></dl>
          <div className="machine-last-load"><span>Última carga</span><time dateTime={machine.lastAt}>{formatSiteDate(machine.lastAt, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}</time></div>
          <button className="machine-detail-button" type="button" onClick={() => openMachine(machine)} aria-label={`Ver ${machine.loads} cargas de ${machine.name}`}>Ver cargas <span aria-hidden="true">↗</span></button>
        </li>)}</ol>{ranked.length >= 3 && <p className="machine-insight">Las 3 primeras máquinas reúnen el <strong>{percent(topThreeShare)} %</strong> de los litros {filtered ? "del filtro actual" : "identificados en este período"}.</p>}</> : <div className="panel machine-empty"><h3>{filtered ? "No encontramos máquinas con estos filtros" : "Sin cargas identificadas en este período"}</h3><p>{filtered ? "Prueba otro nombre o tipo de máquina, o limpia los filtros." : "Amplía el período para consultar despachos anteriores."}</p></div>}
      </section>
      {data.unassigned && <section className="panel machine-unassigned" aria-label="Despachos sin máquina identificada"><div><strong>{formatLiters(data.unassigned.liters)} sin máquina identificada</strong><p>{data.unassigned.loads} cargas quedan fuera del ranking. El {percent(coverage)} % del total despachado tiene máquina identificada.</p><small>Corresponde a todo el período, sin aplicar el filtro por máquina o tipo.</small></div><button className="secondary-button" type="button" onClick={() => openMachine(data.unassigned!)}>Revisar cargas</button></section>}
      <p className="machine-data-note">Fuente: despachos confirmados. Excluye recepciones y habilitaciones de bomba.</p>
    </>}
  </div>;
}
