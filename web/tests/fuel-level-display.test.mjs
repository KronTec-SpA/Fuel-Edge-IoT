import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import ts from "typescript";

const volumeSource = await readFile(new URL("../shared/volume-format.ts", import.meta.url), "utf8");
const volumeUrl = `data:text/javascript;base64,${Buffer.from(ts.transpileModule(volumeSource, { compilerOptions: { module: ts.ModuleKind.ESNext } }).outputText).toString("base64")}`;
const source = (await readFile(new URL("../app/fuel-level-display.ts", import.meta.url), "utf8")).replace("../shared/volume-format", volumeUrl);
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext } }).outputText;
const { fuelLevelDisplay } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`);
const now = Date.parse("2026-09-08T02:00:00Z");
const sensor = { currentLevel: 460, capacityLiters: 2500, latestReadingAt: new Date(now).toISOString(), telemetrySessionId: "boot1" };
const edge = { occurredAt: new Date(now).toISOString(), tankLevelEnabled: true, telemetrySessionId: "boot1" };

test("overflow calibrado de 2662 L muestra exactamente 100 %",()=>{
  const full=fuelLevelDisplay({...sensor,currentLevel:2662,capacityLiters:2662},edge,now);
  assert.equal(full.volumeLabel,"2.662,0 L");assert.equal(full.percent,100);
  assert.equal(full.percentLabel,"100,0 %");assert.equal(full.fresh,true);
});

test("variación acotada muestra una referencia y reserva los límites para el detalle", () => {
  const input = {...sensor, currentLevel: 786, levelRange:{minLiters:773.77,maxLiters:798.36}};
  const state = fuelLevelDisplay(input, edge, now);
  assert.equal(state.fresh,true);
  assert.equal(state.isRange,true);
  assert.equal(state.volumeLabel,"786,0 L");
  assert.equal(state.rangeLabel,"Entre 773,7 y 798,4 L");
  assert.equal(state.variationLabel,"Variación observada: ±13,0 L");
  assert.equal(state.label,"Volumen de referencia");
  assert.equal(state.statusLabel,"Lectura vigente");
  assert.equal(state.percentLabel,"31,4 %");
  assert.equal(fuelLevelDisplay(input,edge,now+181000).volumeLabel,state.volumeLabel);
  assert.equal(fuelLevelDisplay(input,edge,now+181000).fresh,false);
  assert.equal(fuelLevelDisplay({...input,levelRange:{minLiters:800,maxLiters:770}},edge,now).hasReading,false);
});

test("empty database does not display a measured zero", () => {
  const state = fuelLevelDisplay({ ...sensor, currentLevel: 0, latestReadingAt: "1970-01-01T00:00:00.000Z" }, edge, now);
  assert.equal(state.hasReading, false);
  assert.equal(state.percent, null);
  assert.equal(state.label, "Sin lectura");
});
test("a real zero is valid and liters agree with the percentage", () => {
  assert.equal(fuelLevelDisplay({ ...sensor, currentLevel: 0 }, edge, now).fresh, true);
  assert.equal(fuelLevelDisplay(sensor, edge, now).percent, 18.4);
});
test("stale, disabled, offline, future and previous-boot readings are not live", () => {
  for (const [reading, controller] of [
    [{ ...sensor, latestReadingAt: new Date(now - 180001).toISOString() }, edge],
    [sensor, { ...edge, occurredAt: new Date(now - 30001).toISOString() }],
    [sensor, { ...edge, tankLevelEnabled: false }],
    [{ ...sensor, latestReadingAt: new Date(now + 1).toISOString() }, edge],
    [sensor, { ...edge, telemetrySessionId: "boot2" }],
  ]) {
    const state = fuelLevelDisplay(reading, controller, now);
    assert.equal(state.fresh, false);
    assert.equal(state.label, "Última lectura disponible");
    assert.equal(state.percent, 18.4);
  }
});

test("validación y falla conservan el dato y no renuevan su vigencia", () => {
  const withQuality = (status, occurredAt = edge.occurredAt, session = "boot1") => ({...sensor,
    measurementQuality: {status, occurredAt, telemetrySessionId: session}});
  const validating = fuelLevelDisplay(withQuality("settling"),edge,now);
  assert.equal(validating.volumeLabel,"460,0 L");
  assert.equal(validating.statusLabel,"Validando lectura");
  assert.equal(validating.fresh,true);
  const failed = fuelLevelDisplay(withQuality("unavailable"),edge,now);
  assert.equal(failed.volumeLabel,"460,0 L");
  assert.equal(failed.fresh,false);
  assert.equal(failed.statusLabel,"Revisar sensor");
  const pending = fuelLevelDisplay({...withQuality("ambiguous_levels"),latestReadingAt:new Date(now-181000).toISOString()},edge,now);
  assert.equal(pending.statusLabel,"Actualización pendiente");
  assert.equal(pending.fresh,false);
  assert.equal(fuelLevelDisplay(withQuality("unavailable",new Date(now-31000).toISOString()),edge,now).statusLabel,"Lectura vigente");
  assert.equal(fuelLevelDisplay(withQuality("unavailable",edge.occurredAt,"old-boot"),edge,now).fresh,true);
  const first = fuelLevelDisplay({...withQuality("warming_up"), latestReadingAt:"1970-01-01T00:00:00Z"},edge,now);
  assert.equal(first.volumeLabel,"Sin lectura");
  assert.equal(first.statusLabel,"Preparando primera lectura");
});
test("invalid levels are not clamped into plausible measurements", () => {
  for (const reading of [{ ...sensor, capacityLiters: 0 }, { ...sensor, currentLevel: -1 },
    { ...sensor, currentLevel: 2501 }, { ...sensor, currentLevel: Number.NaN }]) {
    assert.equal(fuelLevelDisplay(reading, edge, now).hasReading, false);
  }
});

test("calibración pendiente conserva el histórico sin presentarlo como lectura vigente", () => {
  const reading = {...sensor, measurementQuality:{status:'calibration_pending',occurredAt:edge.occurredAt,telemetrySessionId:'boot1'}};
  const state = fuelLevelDisplay(reading,edge,now);
  assert.equal(state.statusLabel,'Calibración pendiente');
  assert.equal(state.fresh,false);
  assert.equal(state.volumeLabel,'460,0 L');
  assert.equal(state.label,'Última lectura disponible');
});
