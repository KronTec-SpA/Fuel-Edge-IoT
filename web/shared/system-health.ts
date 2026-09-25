export type SystemEdge = {
  moduleId: string; siteId: string; state: string; relayEnergized: boolean;
  validatorOnline: boolean; nfcReady: boolean; k24Enabled: boolean; k24Healthy: boolean;
  tankLevelEnabled: boolean; occurredAt: string; telemetrySessionId?: string | null;
};
export type HealthTone = "ok" | "warning" | "unknown" | "danger";
const stateLabels: Record<string, string> = {
  unassigned: "Sin asignar", locked: "En espera", relay_testing: "Prueba de bomba",
  manual_mode: "Modo manual", validating: "Validando autorización", authorized: "Carga autorizada",
  dispensing: "Despachando", closing: "Cerrando carga", fault: "Falla del controlador",
};
export function systemHealth(edge: SystemEdge | null, online: boolean, nowMs: number, levelFresh: boolean) {
  const age = nowMs - Date.parse(edge?.occurredAt ?? "");
  const current = Boolean(edge && online && age >= 0 && age <= 30_000);
  const stateKnown = Boolean(edge && stateLabels[edge.state]);
  const issues = current && edge ? Number(!edge.validatorOnline) + Number(!edge.nfcReady)
    + Number(!edge.k24Enabled || !edge.k24Healthy) + Number(!levelFresh) : 0;
  const fault = current && edge?.state === "fault";
  const exceptional = current && (edge?.state === "manual_mode" || edge?.state === "relay_testing");
  const tone: HealthTone = !current ? "unknown" : fault ? "danger" : issues || exceptional || !stateKnown ? "warning" : "ok";
  const title = !current ? edge ? "Sin reporte reciente" : "Esperando primer reporte"
    : fault ? "El controlador informa una falla" : issues ? `${issues} ${issues === 1 ? "componente requiere" : "componentes requieren"} revisión`
      : exceptional ? stateLabels[edge!.state] : !stateKnown ? "Estado de control sin reconocer" : "Componentes operativos";
  return { current, tone, title, issues, state: edge ? stateLabels[edge.state] ?? "Estado sin reconocer" : "Sin información",
    pump: !current ? "Sin confirmar" : edge!.relayEnergized ? "Habilitada" : "Deshabilitada",
    pumpDetail: !current ? "El último reporte no confirma el estado actual." : edge!.relayEnergized ? "Relé de habilitación cerrado" : "Relé de habilitación abierto" };
}
