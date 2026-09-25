import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import ts from "typescript";

const source = await readFile(new URL("../shared/system-health.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext } }).outputText;
const { systemHealth } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`);
const now = Date.parse("2026-09-09T12:00:00Z");
const edge = { occurredAt: new Date(now).toISOString(), state: "locked", relayEnergized: true, validatorOnline: true, nfcReady: true, k24Enabled: true, k24Healthy: true };

test("expired, missing, future or offline reports never confirm the pump", () => {
  for (const [data, online, time] of [[edge,true,now+30001],[null,true,now],[edge,false,now],[edge,true,now-1]]) {
    const health = systemHealth(data, online, time, true);
    assert.equal(health.current, false);
    assert.equal(health.pump, "Sin confirmar");
    assert.equal(health.tone, "unknown");
  }
  assert.equal(systemHealth(edge,true,now+30000,true).pump,"Habilitada");
});
test("component issues and controller fault override a healthy connection", () => {
  assert.equal(systemHealth(edge,true,now,true).tone,"ok");
  assert.equal(systemHealth({...edge,validatorOnline:false,k24Healthy:false},true,now,false).issues,3);
  assert.equal(systemHealth({...edge,state:"fault"},true,now,true).tone,"danger");
  assert.equal(systemHealth({...edge,state:"manual_mode"},true,now,true).tone,"warning");
  assert.equal(systemHealth({...edge,state:"relay_testing"},true,now,true).tone,"warning");
  assert.equal(systemHealth({...edge,state:"unknown_state"},true,now,true).tone,"warning");
});
test("relay authorization is not represented as measured flow", () => {
  const health = systemHealth({...edge,state:"dispensing",relayEnergized:false},true,now,true);
  assert.equal(health.pump,"Deshabilitada");
  assert.equal(health.state,"Despachando");
});
