import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import ts from "typescript";
const source = await readFile(new URL("../shared/power-supply.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, {compilerOptions:{module:ts.ModuleKind.ESNext}}).outputText;
const {summarizePowerEvents, isPowerAlert, isPowerIncidentType} = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`);
const end = Date.parse("2026-09-09T12:00:00Z"), start = end - 86_400_000;
const event = (id, from, to) => ({id, lostAt:new Date(from).toISOString(), restoredAt:new Date(to).toISOString(), durationSeconds:(to-from)/1000});

test("clips outages at both period boundaries and excludes outside/invalid events", () => {
  const events = [event("first",start-3600000,start+3600000), event("last",end-60000,end+60000),
    event("future",end,end+60000), event("old",start-60000,start), {id:"invalid",lostAt:"bad",restoredAt:"bad"}];
  const summary = summarizePowerEvents(events,start,end);
  assert.equal(summary.outageCount,2);
  assert.equal(summary.totalDowntimeSeconds,3660);
  assert.equal(summary.longestOutageSeconds,3600);
  assert.equal(summary.lastOutage.id,"last");
});
test("overlapping records do not inflate downtime or exceed the selected window", () => {
  const events = [event("whole",start-5000,end+5000),event("inside",start+1000,end-1000)];
  assert.equal(summarizePowerEvents(events,start,end).totalDowntimeSeconds,86400);
  assert.deepEqual(summarizePowerEvents([],start,end),{outageCount:0,totalDowntimeSeconds:0,longestOutageSeconds:0,lastOutage:null});
});
test("classifies electrical alerts and reopened cycles without matching unrelated text", () => {
  assert.ok(isPowerAlert({id:"edge-alert-power-123",title:"Evento UPS"}));
  assert.ok(isPowerAlert({id:"alr-123",rootAlertId:"edge-alert-power-123",title:"Evento UPS"}));
  assert.ok(isPowerAlert({id:"legacy",title:"Corte eléctrico"}));
  assert.ok(!isPowerAlert({id:"other",title:"Sensor sin reporte"}));
  for (const value of ["scheduled","unscheduled","internal_fault"]) assert.ok(isPowerIncidentType(value));
  for (const value of [null,"__proto__","other",123,{}]) assert.ok(!isPowerIncidentType(value));
});
