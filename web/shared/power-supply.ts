export const powerIncidentLabels = {
  scheduled: "Corte programado",
  unscheduled: "Corte no programado",
  internal_fault: "Falla interna de instalación",
} as const;
export type PowerIncidentType = keyof typeof powerIncidentLabels;

export function isPowerIncidentType(value: unknown): value is PowerIncidentType {
  return typeof value === "string" && Object.hasOwn(powerIncidentLabels, value);
}

export function isPowerAlert(alert: { id: string; title: string; rootAlertId?: string | null }) {
  return (alert.rootAlertId || alert.id).startsWith("edge-alert-power-")
    || /^(corte eléctrico|falla eléctrica|interrupción de suministro eléctrico)$/iu.test(alert.title.trim());
}

export type PowerSupplyEvent = {
  id: string;
  siteId: string;
  lostAt: string;
  restoredAt: string;
  durationSeconds: number;
  source: "ups_gpio24" | "operator_confirmed" | "reconstructed";
  lossBootId: string | null;
  restoreBootId: string | null;
  incidentType?: PowerIncidentType | null;
  alertId?: string | null;
};

// Clip to the requested window and merge overlaps to avoid counting a second twice.
// Full event durations remain available for the detail table.
export function summarizePowerEvents(events: PowerSupplyEvent[], start: number, end: number) {
  const intervals = events.map(event => [Math.max(start, Date.parse(event.lostAt)), Math.min(end, Date.parse(event.restoredAt))])
    .filter(([from, to]) => Number.isFinite(from) && Number.isFinite(to) && to > from)
    .sort((a, b) => a[0] - b[0]);
  const merged: number[][] = [];
  for (const [from, to] of intervals) {
    const previous = merged.at(-1);
    if (previous && from <= previous[1]) previous[1] = Math.max(previous[1], to);
    else merged.push([from, to]);
  }
  return {
    outageCount: intervals.length,
    totalDowntimeSeconds: Math.floor(merged.reduce((total, [from, to]) => total + to - from, 0) / 1000),
    longestOutageSeconds: Math.floor(intervals.reduce((longest, [from, to]) => Math.max(longest, to - from), 0) / 1000),
    lastOutage: [...events].filter(event => Date.parse(event.lostAt) < end && Date.parse(event.restoredAt) > start)
      .sort((a, b) => Date.parse(b.lostAt) - Date.parse(a.lostAt))[0] ?? null,
  };
}

export type PowerSupplyResponse = {
  rangeDays: 1 | 7 | 30;
  rangeStart: string;
  generatedAt: string;
  events: PowerSupplyEvent[];
  summary: ReturnType<typeof summarizePowerEvents>;
};
