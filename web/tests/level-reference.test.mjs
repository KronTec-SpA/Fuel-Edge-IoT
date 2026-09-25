import assert from "node:assert/strict";
import test from "node:test";
import {readFile} from "node:fs/promises";
import ts from "typescript";

async function moduleFrom(path) {
  let source=await readFile(new URL(path,import.meta.url),"utf8");
  if (source.includes("../shared/tank-capacity")) {
    const dependency = await readFile(new URL("../shared/tank-capacity.ts",import.meta.url),"utf8");
    const code = ts.transpileModule(dependency,{compilerOptions:{module:ts.ModuleKind.ESNext}}).outputText;
    source=source.replace("../shared/tank-capacity",`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`);
  }
  if (source.includes("../shared/volume-format")) {
    const volumeSource = await readFile(new URL("../shared/volume-format.ts", import.meta.url), "utf8");
    const volumeCode = ts.transpileModule(volumeSource, {compilerOptions: {module: ts.ModuleKind.ESNext}}).outputText;
    source = source.replace("../shared/volume-format", `data:text/javascript;base64,${Buffer.from(volumeCode).toString("base64")}`);
  }
  const output=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.ESNext}}).outputText;
  return import(`data:text/javascript;base64,${Buffer.from(output).toString("base64")}`);
}
const {nextLevelDisplayReference}=await moduleFrom("../worker/fuel-history-store.ts");
const {fuelLevelDisplay}=await moduleFrom("../app/fuel-level-display.ts");
const fixture=JSON.parse(await readFile(new URL("./fixtures/ocio-quiet-field.json",import.meta.url),"utf8"));

test("dos horas reales de ruido leve mantienen litros y porcentaje sin ocultar la muestra original",()=>{
  let reference=null;
  const labels=new Set(),percentages=new Set(),originals=new Set();
  for(const sample of fixture.readings){
    const reading={currentLevel:Math.round(sample.levelLiters*10)/10,latestReadingAt:sample.occurredAt,telemetrySessionId:"field",levelRange:null};
    reference=nextLevelDisplayReference(reference,reading);
    const before=reading.currentLevel;
    const display=fuelLevelDisplay({...reading,capacityLiters:2500,displayReference:reference},
      {occurredAt:reading.latestReadingAt,telemetrySessionId:"field",tankLevelEnabled:true},Date.parse(reading.latestReadingAt));
    labels.add(display.volumeLabel);percentages.add(display.percentLabel);originals.add(before);
    assert.equal(reading.currentLevel,before);
    assert.ok(Math.abs(display.reference-before)<=2.5);
    assert.equal(display.fresh,true);
  }
  assert.equal(fixture.readings.length,120);
  assert.ok(originals.size>=5);
  assert.deepEqual([...labels],["1.027,0 L"]);
  assert.deepEqual([...percentages],["41,1 %"]);
});

test("la histéresis visual no oculta una caída sostenida de 20 L ni acumula deriva",()=>{
  let reference=null;
  const make=(level,minute,session="boot")=>({currentLevel:level,latestReadingAt:new Date(Date.parse("2026-09-01T00:00:00Z")+minute*60000).toISOString(),telemetrySessionId:session,levelRange:null});
  for(let i=0;i<=50;i++){
    const reading=make(1000-i*.4,i);
    reference=nextLevelDisplayReference(reference,reading);
    assert.ok(Math.abs(reference.liters-reading.currentLevel)<=2.5);
  }
  assert.ok(reference.liters<=982);
  reference=nextLevelDisplayReference(reference,make(960,51));
  assert.equal(reference.liters,960);
  assert.equal(nextLevelDisplayReference(reference,make(961,52,"new-boot")).liters,961);
  assert.equal(nextLevelDisplayReference(reference,make(961,60)).liters,961);
  assert.equal(nextLevelDisplayReference(reference,make(0,52)).liters,0);
});

test("el dashboard rechaza una referencia visual de otra muestra o fuera de la banda",()=>{
  const at="2026-09-01T00:00:00Z",edge={occurredAt:at,tankLevelEnabled:true,telemetrySessionId:"boot"};
  const sensor={currentLevel:1000,latestReadingAt:at,capacityLiters:2500,telemetrySessionId:"boot"};
  for(const patch of [{sourceAt:"2026-08-31T00:00:00Z"},{telemetrySessionId:"old"},{liters:1003},{ranged:true}]){
    const display=fuelLevelDisplay({...sensor,displayReference:{liters:1001,sourceAt:at,telemetrySessionId:"boot",ranged:false,...patch}},edge,Date.parse(at));
    assert.equal(display.reference,1000);
    assert.equal(display.stabilized,false);
  }
});
