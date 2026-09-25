import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import ts from "typescript";
import { renderToStaticMarkup } from "react-dom/server";

// Compile the actual page functions so regressions in labels and the system
// panel are exercised without mounting unrelated operational controls.
const source = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
const ast = ts.createSourceFile("page.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const functions = ["movementToTransaction", "TechnologyAdoptionSystemPanel", "ManualModePanel"];
const bodies = ast.statements.filter(node => ts.isFunctionDeclaration(node) && functions.includes(node.name?.text)).map(node => `export ${node.getText(ast)}`).join("\n");
let compiled = ts.transpileModule(`
let slots=[],cursor=0;
export const setSlots=value=>{slots=value;cursor=0;};
const useState=initial=>[cursor<slots.length?slots[cursor++]:typeof initial==='function'?initial():initial,()=>{}];
const useEffect=()=>{};
const useCallback=callback=>callback;
const formatHistoryDate=value=>value;
const formatAlertDate=value=>value;
const localDateTimeFromNow=()=>'';
const adoptionStageCopy={assisted:{title:'Aprendizaje asistido'},full:{title:'Trazabilidad completa'}};
${bodies}`, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText;
compiled = compiled.replace('from "react/jsx-runtime"', `from ${JSON.stringify(import.meta.resolve("react/jsx-runtime"))}`);
const {movementToTransaction,TechnologyAdoptionSystemPanel,ManualModePanel,setSlots} = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`);
const movement = {id:"new",detail:"",source:"edge",liters:5,classification:"standard",operatorId:null,equipmentId:null,isMaster:false,manualModeSessionId:"manual-new",authorizationEvidence:"assisted",adoptionStage:null,assistedMode:false};

test("new manual activity carries no adoption labels; historical assisted evidence is preserved", () => {
  for (const evidence of ["assisted","rfid_only"]) {
    const item = movementToTransaction({...movement, authorizationEvidence:evidence,operatorId:evidence==='rfid_only'?'op':null});
    assert.match(item.validation, /modo manual/i);
    assert.doesNotMatch(`${item.validation} ${item.equipment}`,/adopción|aprendizaje|asistid/i);
  }
  const normal = movementToTransaction({...movement,manualModeSessionId:null,authorizationEvidence:"full",adoptionStage:"full",operatorName:"Operador",equipmentName:"Tractor"});
  assert.equal(normal.validation,"RFID + MIM + asociación");
  assert.equal(normal.equipment,"Tractor");
  const historical = movementToTransaction({...movement,assistedMode:true,adoptionStage:"assisted"});
  assert.match(historical.validation,/Sesión asistida/);
});

test("a closed assisted window does not appear as the last manual period", () => {
  for (const status of ["cancelled","completed","active"]) {
    const now=Date.now();
    setSlots([{purpose:"adoption_assisted",status,startAt:new Date(now-10000).toISOString(),endAt:new Date(now+10000).toISOString()},false,"","",false,false,"",now]);
    const html=renderToStaticMarkup(ManualModePanel({variant:"manual",online:true,edge:{state:"manual_mode",relayEnergized:true}}));
    assert.doesNotMatch(html,/Modo manual activo: bomba habilitada|ACOMPAÑADO POR|Último período/);
    assert.match(html,status==='active'?/Existe otra ventana operacional/:/Sin períodos programados/);
  }
});

test("deactivation remains pending until the controller confirms the full policy", () => {
  for (const applied of [false,true]) {
    setSlots([]);
    const html=renderToStaticMarkup(TechnologyAdoptionSystemPanel({dashboard:{settings:{programStatus:"inactive",stage:"full",revision:3},edgeApplication:{applied}},canManage:true,loading:false}));
    if (applied) assert.doesNotMatch(html,/Desactivación guardada/);
    else {
      assert.match(html,/Desactivación guardada/);
      assert.match(html,/<button[^>]*disabled/);
    }
  }
});
