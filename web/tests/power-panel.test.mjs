import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import ts from "typescript";

// Exercise the component's real handlers/effects with deterministic hook state and
// deferred HTTP responses. No browser, live database or production records involved.
const asModule = source => `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;
const compile = source => ts.transpileModule(source, {compilerOptions:{module:ts.ModuleKind.ESNext,jsx:ts.JsxEmit.ReactJSX,target:ts.ScriptTarget.ES2022}}).outputText;
const hooksUrl = asModule(`
export const state = {slots:[],effects:[],cursor:0,pending:[]};
export function useState(initial) {
  const index=state.cursor++;
  if (!(index in state.slots)) state.slots[index]=typeof initial==='function'?initial():initial;
  return [state.slots[index],value=>{state.slots[index]=typeof value==='function'?value(state.slots[index]):value;}];
}
export function useEffect(callback,deps) {
  const index=state.cursor++,old=state.effects[index];
  if (!old || deps.some((value,i)=>value!==old.deps[i])) {
    state.pending.push(()=>{old?.cleanup?.();state.effects[index]={deps,cleanup:callback()};});
  }
}
`);
const hooks = await import(hooksUrl);
let source = compile(await readFile(new URL("../app/power-supply-panel.tsx",import.meta.url),"utf8"));
source = source.replace('from "react"',`from ${JSON.stringify(hooksUrl)}`)
  .replace('from "react/jsx-runtime"',`from ${JSON.stringify(import.meta.resolve("react/jsx-runtime"))}`);
for (const [specifier,path] of [["./site-time","../app/site-time.ts"],["../shared/power-supply","../shared/power-supply.ts"]]) {
  const url = asModule(compile(await readFile(new URL(path,import.meta.url),"utf8")));
  source = source.replace(`from "${specifier}"`,`from ${JSON.stringify(url)}`);
}
const {default:Panel} = await import(asModule(source));
const tick = () => new Promise(resolve=>setImmediate(resolve));
const end = new Date().toISOString();
const payload = days => ({rangeDays:days,rangeStart:new Date(Date.parse(end)-days*86400000).toISOString(),generatedAt:end,
  events:[{id:"power-test",lostAt:new Date(Date.parse(end)-600000).toISOString(),restoredAt:end,durationSeconds:600,source:"ups_gpio24",incidentType:"scheduled",alertId:"edge-alert-power-test"}],
  summary:{outageCount:1,totalDowntimeSeconds:600,longestOutageSeconds:600,lastOutage:null}});
const nodes = tree => [tree,...(Array.isArray(tree?.props?.children)?tree.props.children:[tree?.props?.children]).flat(Infinity).filter(x=>x&&typeof x==='object').flatMap(nodes)];
const find = (tree,predicate) => nodes(tree).find(predicate);
const text = tree => typeof tree === "string" ? tree : typeof tree === "number" ? String(tree) : (Array.isArray(tree)?tree:[tree?.props?.children]).flat(Infinity).filter(x=>x!==undefined&&x!==null&&x!==false).map(text).join(" ");

test("period/reset actions refresh, cancel stale responses, and expose errors and tooltips",async () => {
  const originalFetch=globalThis.fetch,requests=[];
  globalThis.fetch=(url,options)=>new Promise((resolve,reject)=>requests.push({url,...options,resolve,reject}));
  const render=()=>{
    hooks.state.cursor=0;
    const tree=Panel({online:true,onOpenAlert:()=>{}});
    hooks.state.pending.splice(0).forEach(effect=>effect());
    return tree;
  };
  const answer=async(index,days)=>{requests[index].resolve({ok:true,json:async()=>payload(days)});await tick();};
  try {
    let tree=render();
    assert.equal(requests.length,1);
    await answer(0,30); tree=render();
    const reset=t=>find(t,n=>n.props?.['aria-label']==="Restablecer a 30 días y actualizar historial");
    assert.equal(reset(tree).props.disabled,false);
    reset(tree).props.onClick(); tree=render();
    assert.equal(requests.length,2); assert.equal(requests[1].url,"/api/system-settings/power-events?days=30");
    assert.equal(reset(tree).props.disabled,true);
    await answer(1,30);tree=render();
    const range=(t,label)=>find(t,n=>n.type==='button'&&n.props.children===label);
    range(tree,"7 d").props.onClick(); tree=render();
    range(tree,"24 h").props.onClick();tree=render();
    assert.equal(requests[2].signal.aborted,true);
    await answer(3,1);tree=render();
    await answer(2,7);tree=render();
    assert.match(text(tree),/Historial actualizado/);
    assert.equal(range(tree,"24 h").props['aria-pressed'],true);
    assert.equal(find(tree,n=>n.props?.className==='power-history-count').props.children,"1 evento");
    // Clicking the already-selected range must not leave loading stuck forever.
    range(tree,"24 h").props.onClick();tree=render();
    assert.equal(requests.length,5);
    requests[4].reject(new Error("Sin conexión"));await tick();tree=render();
    assert.match(text(find(tree,n=>n.props?.role==='alert')),/Sin conexión/);
    assert.equal(reset(tree).props.disabled,false);
    reset(tree).props.onClick();tree=render();await answer(5,30);tree=render();
    assert.equal(range(tree,"30 d").props['aria-pressed'],true);
    let target=find(tree,n=>n.props?.className?.startsWith('power-outage-target'));
    assert.equal(target.props.title,undefined);
    target.props.onMouseEnter();tree=render();
    assert.match(text(find(tree,n=>n.props?.role==='tooltip')),/10 min 00 s\s+de interrupción.*Inicio.*Recuperación.*Corte programado/);
    target=find(tree,n=>n.props?.className?.startsWith('power-outage-target'));
    assert.equal(target.props['aria-describedby'],'power-event-tooltip');
    target.props.onKeyDown({key:'Escape'});tree=render();
    assert.equal(find(tree,n=>n.props?.role==='tooltip'),undefined);
    target.props.onFocus();tree=render();assert.ok(find(tree,n=>n.props?.role==='tooltip'));
    target.props.onBlur();tree=render();assert.equal(find(tree,n=>n.props?.role==='tooltip'),undefined);
    target.props.onClick();tree=render();assert.ok(find(tree,n=>n.props?.role==='tooltip'));
  } finally {
    hooks.state.effects.forEach(effect=>effect.cleanup?.());
    globalThis.fetch=originalFetch;
  }
});

test("the demo uses the same period controls without accessing the real API", async () => {
  hooks.state.effects.forEach(effect=>effect.cleanup?.());
  hooks.state.slots=[]; hooks.state.effects=[]; hooks.state.pending=[];
  const originalFetch=globalThis.fetch,calls=[],opened=[];
  globalThis.fetch=()=>{throw new Error("Demo must never access the network");};
  const loadHistory=async(days,signal)=>{calls.push({days,signal});return payload(days);};
  const render=()=>{
    hooks.state.cursor=0;
    const tree=Panel({online:true,onOpenAlert:id=>opened.push(id),loadHistory});
    hooks.state.pending.splice(0).forEach(effect=>effect());
    return tree;
  };
  try {
    render(); await tick(); let tree=render();
    assert.equal(calls[0].days,30);
    find(tree,n=>n.type==='button'&&n.props.children==='24 h').props.onClick();
    render(); await tick(); tree=render();
    assert.equal(calls[1].days,1);
    find(tree,n=>n.type==='button'&&n.props.children==='7 d').props.onClick();
    render(); await tick(); tree=render();
    assert.equal(calls[2].days,7);
    find(tree,n=>n.props?.className?.startsWith('power-classification ')).props.onClick();
    assert.deepEqual(opened,['edge-alert-power-test']);
    find(tree,n=>n.props?.['aria-label']==='Restablecer a 30 días y actualizar historial').props.onClick();
    render(); await tick(); tree=render();
    assert.equal(calls[3].days,30);
    assert.match(text(tree),/Historial actualizado/);
  } finally {
    hooks.state.effects.forEach(effect=>effect.cleanup?.()); globalThis.fetch=originalFetch;
  }
});
