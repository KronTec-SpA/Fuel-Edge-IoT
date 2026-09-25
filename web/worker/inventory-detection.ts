import type { D1DatabaseLike } from "./user-store";
import { comparisonUncertainty } from "../shared/inventory-uncertainty";
import type { Sample, Receipt } from "./inventory-balance";

export const INVENTORY_POLICY = "inventory-evidence-v2";
const WINDOW_MS = 600_000;
type Bounds = { minLiters: number; maxLiters: number };
type Window = { id: string; start: string; end: string; day: string; minute: number; sample: Sample; count: number };
type Difference = { channel: string; available: boolean; from?: string; to?: string;
  observed?: number; bounds?: Bounds; reason?: string };
type Candidate = { first: string; last: string; count: number };
type Incident = { id: string; at: string; priority: "high" | "urgent"; peak: number; channels: string[];
  condition: "active" | "recovered"; recoveredAt?: string; reviewedPeak?: number };
type State = { policyId: string; lastSeen: string; highestPulses: number; lastWindowAt?: string;
  stepReference?: Window; candidates: Record<string, Candidate>; fast?: Candidate;
  episode: number; incident?: Incident; recoverySince?: string; receiptsKey?: string;
  comparisons: Difference[]; latestWindow?: Window };

export async function ensureDetectionStore(db: D1DatabaseLike) {
  await db.batch([
    db.prepare(`CREATE TABLE IF NOT EXISTS inventory_detection_state (
      anchor_id TEXT PRIMARY KEY, payload TEXT NOT NULL)`),
    db.prepare(`CREATE TABLE IF NOT EXISTS inventory_reference_windows (
      id TEXT PRIMARY KEY,anchor_id TEXT NOT NULL,occurred_at TEXT NOT NULL,
      local_date TEXT NOT NULL,local_minute INTEGER NOT NULL,payload TEXT NOT NULL)`),
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_inventory_reference_day
      ON inventory_reference_windows(anchor_id,local_date,local_minute)`),
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_inventory_reference_time
      ON inventory_reference_windows(anchor_id,occurred_at)`),
    db.prepare(`CREATE TABLE IF NOT EXISTS inventory_measurement_health (
      site_id TEXT PRIMARY KEY,occurred_at TEXT NOT NULL,payload TEXT NOT NULL)`),
  ]);
}

function localParts(at: string) {
  const parts = new Intl.DateTimeFormat("en-CA", {timeZone:"America/Santiago",year:"numeric",month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit",hourCycle:"h23"}).formatToParts(new Date(at));
  const get = (name: string) => parts.find(p=>p.type===name)!.value;
  return {day:`${get("year")}-${get("month")}-${get("day")}`, minute:Number(get("hour"))*60+Number(get("minute"))};
}
function previousDay(day: string, days: number) {
  const value = new Date(day+"T12:00:00Z"); value.setUTCDate(value.getUTCDate()-days);
  return value.toISOString().slice(0,10);
}
const bounds = (s: Sample): Bounds => s.measuredRange ?? {minLiters:s.measuredLiters,maxLiters:s.measuredLiters};
const median = (values: number[]) => {const a=values.toSorted((x,y)=>x-y);const m=Math.floor(a.length/2);return a.length%2?a[m]:(a[m-1]+a[m])/2;};

// Independent ten-minute buckets; no pooling across flow, missing data,
// calibration changes or unhealthy counters. Keep the entire observed envelope.
export function stableWindow(samples: Sample[]): Window | null {
  const a=samples.toSorted((x,y)=>x.occurredAt.localeCompare(y.occurredAt));
  if(a.length<5)return null;
  const first=a[0],last=a.at(-1)!;
  if(Date.parse(last.occurredAt)-Date.parse(first.occurredAt)<240_000)return null;
  const bucket=Math.floor(Date.parse(first.occurredAt)/WINDOW_MS);
  if(a.some((s,i)=>Math.floor(Date.parse(s.occurredAt)/WINDOW_MS)!==bucket || !s.meterHealthy
    || s.pulsesTotal!==first.pulsesTotal || s.calibrationId!==first.calibrationId
    || s.anchor.id!==first.anchor.id || s.pulsesPerLiter!==first.pulsesPerLiter
    || (i>0 && Date.parse(s.occurredAt)-Date.parse(a[i-1].occurredAt)>180_000)))return null;
  const range={minLiters:Math.min(...a.map(s=>bounds(s).minLiters)),maxLiters:Math.max(...a.map(s=>bounds(s).maxLiters))};
  // A broad but valid interval remains evidence; its width reduces sensitivity,
  // rather than being silently converted into a precise median.
  return {id:`${first.anchor.id}-w${bucket}`,start:first.occurredAt,end:last.occurredAt,
    ...localParts(last.occurredAt),count:a.length,
    sample:{...last,measuredLiters:median(a.map(s=>s.measuredLiters)),measuredRange:range}};
}

function windowStatement(db: D1DatabaseLike, w: Window) {
  return db.prepare(`INSERT OR IGNORE INTO inventory_reference_windows
    (id,anchor_id,occurred_at,local_date,local_minute,payload) VALUES (?,?,?,?,?,?)`)
    .bind(w.id,w.sample.anchor.id,w.end,w.day,w.minute,JSON.stringify(w));
}

function receiptInWindow(w: Window, receipts: Receipt[]) {
  return receipts.some(r=>r.reviewStatus!=="rejected" && r.occurredAt>=w.start && r.occurredAt<=w.end);
}

function difference(channel: string, before: Sample, after: Sample, receipts: Receipt[]): Difference {
  const empty={channel,available:false};
  if(before.anchor.id!==after.anchor.id || before.calibrationId!==after.calibrationId
    || before.pulsesPerLiter!==after.pulsesPerLiter || after.pulsesTotal<before.pulsesTotal
    || !before.meterHealthy || !after.meterHealthy)return {...empty,reason:"Referencia no compatible"};
  const received=receipts.filter(r=>r.occurredAt>before.occurredAt && r.occurredAt<=after.occurredAt);
  const pending=received.some(r=>r.reviewStatus==="pending");
  const liters=received.filter(r=>["approved","corrected"].includes(r.reviewStatus)).reduce((sum,r)=>sum+r.liters,0);
  const k=(after.pulsesTotal-before.pulsesTotal)/before.pulsesPerLiter;
  const left=bounds(before),right=bounds(after);
  const expanded=comparisonUncertainty(after.calibrationId,left,right,k,liters);
  const differenceBounds=expanded?.differenceBounds ?? {minLiters:left.minLiters+liters-k-right.maxLiters,maxLiters:left.maxLiters+liters-k-right.minLiters};
  // An unapproved positive receipt cannot erase an already provable shortage.
  // It does prevent declaring recovery or a reconciled surplus.
  if(pending && differenceBounds.minLiters<20)return {...empty,reason:"Recepción pendiente de conciliación"};
  return {channel,available:true,from:before.occurredAt,to:after.occurredAt,
    observed:before.measuredLiters+liters-k-after.measuredLiters,
    bounds:differenceBounds};
}

function anchorDifference(s: Sample, receipts: Receipt[]): Difference {
  const a=s.anchor;
  return difference("anchor",{...s,occurredAt:a.occurredAt,measuredLiters:a.levelLiters,
    measuredRange:a.levelRange,pulsesTotal:a.pulses,calibrationId:a.calibrationId,
    pulsesPerLiter:a.pulsesPerLiter,meterHealthy:true},s,receipts);
}

function advance(previous: Candidate | undefined, at: string, maxGap: number): Candidate {
  if(!previous || Date.parse(at)-Date.parse(previous.last)>maxGap)return {first:at,last:at,count:1};
  return {first:previous.first,last:at,count:previous.count+1};
}

async function bootstrap(db: D1DatabaseLike, sample: Sample, receipts: Receipt[]): Promise<State> {
  const start=new Date(Date.parse(sample.occurredAt)-9*86400_000).toISOString();
  const rows=await db.prepare(`SELECT payload FROM inventory_balance_samples
    WHERE anchor_id=? AND occurred_at>=? AND occurred_at<=? ORDER BY occurred_at DESC,id DESC LIMIT 16000`)
    .bind(sample.anchor.id,start,sample.occurredAt).all<{payload:string}>();
  const groups=new Map<number,Sample[]>();
  const counter=await db.prepare(`SELECT MAX(CAST(json_extract(payload,'$.pulsesTotal') AS INTEGER)) highest
    FROM inventory_balance_samples WHERE anchor_id=? AND occurred_at<=?`).bind(sample.anchor.id,sample.occurredAt).first<{highest:number}>();
  let highest=Math.max(sample.anchor.pulses,counter?.highest??0);
  for(const row of rows.results.reverse()){const s=JSON.parse(row.payload) as Sample;
    highest=Math.max(highest,s.pulsesTotal);
    const bucket=Math.floor(Date.parse(s.occurredAt)/WINDOW_MS);
    if(bucket>=Math.floor(Date.parse(sample.occurredAt)/WINDOW_MS))continue;
    const group=groups.get(bucket)??[];group.push(s);groups.set(bucket,group);
  }
  const windows=[...groups.values()].map(stableWindow).filter((w):w is Window=>w!==null&&!receiptInWindow(w,receipts));
  for(let i=0;i<windows.length;i+=100)await db.batch(windows.slice(i,i+100).map(w=>windowStatement(db,w)));
  const latest=windows.at(-1);
  return {policyId:INVENTORY_POLICY,lastSeen:sample.occurredAt,highestPulses:highest,
    lastWindowAt:latest?.end,stepReference:latest,latestWindow:latest,
    candidates:{},episode:0,comparisons:[]};
}

export async function recordInventoryDetection(db: D1DatabaseLike, sample: Sample, receipts: Receipt[]) {
  const row=await db.prepare("SELECT payload FROM inventory_detection_state WHERE anchor_id=?")
    .bind(sample.anchor.id).first<{payload:string}>();
  if(!row){
    const state=await bootstrap(db,sample,receipts);
    await db.prepare("INSERT OR IGNORE INTO inventory_detection_state(anchor_id,payload) VALUES (?,?)")
      .bind(sample.anchor.id,JSON.stringify(state)).run();
    return; // Historical seed supplies references, never retrospective alarms.
  }
  const state=JSON.parse(row.payload) as State;
  if(state.lastSeen>=sample.occurredAt)return;
  const previousSeen=state.lastSeen;
  state.lastSeen=sample.occurredAt;
  const compatible=sample.meterHealthy && sample.pulsesTotal>=state.highestPulses
    && sample.calibrationId===sample.anchor.calibrationId && sample.pulsesPerLiter===sample.anchor.pulsesPerLiter;
  state.highestPulses=Math.max(state.highestPulses,sample.pulsesTotal);
  const receiptsKey=JSON.stringify(receipts.map(r=>[r.id,r.liters,r.reviewStatus]));
  if(state.receiptsKey!==receiptsKey){state.candidates={};delete state.fast;state.receiptsKey=receiptsKey;}
  let trigger: {channels:string[];residual:number;urgent:boolean} | undefined;
  const current=anchorDifference(sample,receipts);
  if(compatible && current.available && current.bounds!.minLiters>=100){
    state.fast=advance(state.fast,sample.occurredAt,180_000);
    if(state.fast.count>=3 && Date.parse(state.fast.last)-Date.parse(state.fast.first)>=120_000)
      trigger={channels:["rapid"],residual:current.bounds!.minLiters,urgent:true};
  }else delete state.fast;
  if(!compatible){state.candidates={};delete state.recoverySince;}
  const bucket=Math.floor(Date.parse(sample.occurredAt)/WINDOW_MS);
  const previousBucket=Math.floor(Date.parse(previousSeen)/WINDOW_MS);
  const toFinalize=[...new Set([previousBucket,bucket-1])].filter(b=>b<bucket).sort((a,b)=>a-b);
  for(const b of toFinalize){
    if(state.lastWindowAt && b<=Math.floor(Date.parse(state.lastWindowAt)/WINDOW_MS))continue;
    const rows=await db.prepare(`SELECT payload FROM inventory_balance_samples
      WHERE anchor_id=? AND occurred_at>=? AND occurred_at<? ORDER BY occurred_at,id LIMIT 120`)
      .bind(sample.anchor.id,new Date(b*WINDOW_MS).toISOString(),new Date((b+1)*WINDOW_MS).toISOString()).all<{payload:string}>();
    const w=stableWindow(rows.results.map(r=>JSON.parse(r.payload)));
    if(!w || receiptInWindow(w,receipts))continue;
    await windowStatement(db,w).run();
    const diffs:Difference[]=[anchorDifference(w.sample,receipts)];
    const references:Record<string,Sample>={};
    if(state.stepReference && !receiptInWindow(state.stepReference,receipts)){
      references.step=state.stepReference.sample;
      diffs.push(difference("step",state.stepReference.sample,w.sample,receipts));
    }
    else diffs.push({channel:"step",available:false,reason:"Esperando referencia estable"});
    for(const days of [1,3,7]){
      const ref=await db.prepare(`SELECT payload FROM inventory_reference_windows
        WHERE anchor_id=? AND local_date=? AND ABS(local_minute-?)<=180
        ORDER BY ABS(local_minute-?),occurred_at DESC LIMIT 1`)
        .bind(sample.anchor.id,previousDay(w.day,days),w.minute,w.minute).first<{payload:string}>();
      const reference=ref?JSON.parse(ref.payload) as Window:null;
      if(reference&&!receiptInWindow(reference,receipts))references[`${days}d`]=reference.sample;
      diffs.push(reference&&!receiptInWindow(reference,receipts)?difference(`${days}d`,reference.sample,w.sample,receipts)
        :{channel:`${days}d`,available:false,reason:"Sin ventana comparable de reposo"});
    }
    const fresh=Date.parse(sample.occurredAt)-Date.parse(w.end)<=180_000;
    const losses=diffs.filter(d=>d.available && d.bounds!.minLiters>=20);
    const next:Record<string,Candidate>={};
    if(compatible && fresh){
      for(const d of losses){
        const candidate=advance(state.candidates[d.channel],w.end,1_200_000);
        next[d.channel]=candidate;
        const latest=d.channel==="anchor"?current:difference(d.channel,references[d.channel],sample,receipts);
        if(candidate.count>=2 && Date.parse(candidate.last)-Date.parse(candidate.first)>=540_000
          && latest.available && latest.bounds!.minLiters>=20){
          if(!trigger)trigger={channels:[],residual:0,urgent:false};
          trigger.channels.push(d.channel);trigger.residual=Math.max(trigger.residual,d.bounds!.minLiters);
          trigger.urgent ||= d.bounds!.minLiters>=100;
        }
      }
      if(diffs.filter(d=>d.available).every(d=>d.bounds!.minLiters<=10) && current.available && current.bounds!.minLiters<=10){
        if(!state.recoverySince || Date.parse(w.end)-Date.parse(state.lastWindowAt??w.end)>1_200_000)state.recoverySince=w.end;
        if(state.incident?.condition==="active" && Date.parse(w.end)-Date.parse(state.recoverySince)>=3_600_000){
          state.incident.condition="recovered";state.incident.recoveredAt=w.end;
        }
      }else delete state.recoverySince;
    }
    state.candidates=next;
    // Freeze the pre-step window as soon as a material candidate appears.
    // Slow changes still remain against the durable anchor and day references.
    if(!losses.some(d=>d.channel==="step"))state.stepReference=w;
    state.latestWindow=w;state.lastWindowAt=w.end;state.comparisons=diffs;
  }
  let notification=false;
  if(trigger){
    const old=state.incident;
    let resolved=false;
    if(old){const alert=await db.prepare("SELECT status FROM system_alerts WHERE id=?").bind(old.id).first<{status:string}>();resolved=alert?.status==="resolved";
      if(resolved)old.reviewedPeak??=old.peak;
    }
    if(!old || old.condition==="recovered" || (resolved && trigger.residual>=(old.reviewedPeak??old.peak)+100)){
      state.episode++;
      state.incident={id:`${sample.anchor.id}-v2-e${state.episode}`,at:sample.occurredAt,
        priority:trigger.urgent?"urgent":"high",peak:trigger.residual,
        channels:[...new Set(trigger.channels)],condition:"active"};
      notification=true;
    }else{
      notification=!resolved && (trigger.urgent && old.priority!=="urgent" || trigger.residual>=old.peak+20);
      old.peak=Math.max(old.peak,trigger.residual);
      old.channels=[...new Set([...old.channels,...trigger.channels])];
      if(trigger.urgent)old.priority="urgent";
    }
    delete state.recoverySince;
  }
  const payload=JSON.stringify(state);
  const statements=[db.prepare("UPDATE inventory_detection_state SET payload=? WHERE anchor_id=? AND payload=?")
    .bind(payload,sample.anchor.id,row.payload)];
  if(notification){
    const incident=state.incident!;
    const detail=`Descenso no explicado por K24 y recepciones conciliadas. Faltante residual máximo confirmado: ${incident.peak.toFixed(1)} L, después de los márgenes OCIO/K24. Evidencia: ${incident.channels.join(", ")}. Política ${INVENTORY_POLICY}. Requiere revisión; no confirma robo. Última evidencia: ${sample.occurredAt}.`;
    statements.push(db.prepare(`INSERT INTO system_alerts(id,severity,priority,status,title,detail,occurred_at)
      SELECT ?,'warning',?,'pending','Descenso de inventario no explicado',?,?
      WHERE EXISTS(SELECT 1 FROM inventory_detection_state WHERE anchor_id=? AND payload=?)
      ON CONFLICT(id) DO UPDATE SET detail=excluded.detail,priority=excluded.priority
      WHERE system_alerts.status<>'resolved'`).bind(incident.id,incident.priority,detail,incident.at,sample.anchor.id,payload));
    statements.push(db.prepare(`INSERT OR IGNORE INTO system_alert_comments
      (id,alert_id,actor_user_id,actor_name,comment,status_after,priority_after,occurred_at)
      SELECT ?,?,'system:inventory-evidence-v2','Monitor de inventario',?,
        (SELECT status FROM system_alerts WHERE id=?),?,?
      WHERE EXISTS(SELECT 1 FROM inventory_detection_state WHERE anchor_id=? AND payload=?)`)
      .bind(`${incident.id}-${sample.id}`,incident.id,detail,incident.id,incident.priority,sample.occurredAt,sample.anchor.id,payload));
  }
  const result=await db.batch(statements) as Array<{meta?:{changes?:number}}>;
  if(Number(result[0].meta?.changes??0)!==1)throw new Error("La evidencia cambió durante la evaluación; reintentar.");
}

export async function inventoryDetectionSummary(db: D1DatabaseLike, anchorId: string, siteId: string) {
  const row=await db.prepare("SELECT payload FROM inventory_detection_state WHERE anchor_id=?").bind(anchorId).first<{payload:string}>();
  const health=await db.prepare("SELECT payload FROM inventory_measurement_health WHERE site_id=?").bind(siteId).first<{payload:string}>();
  const state=row?JSON.parse(row.payload) as State:null;
  return {policyId:INVENTORY_POLICY,comparisons:state?.comparisons??[],incident:state?.incident??null,
    latestWindow:state?.latestWindow?{start:state.latestWindow.start,end:state.latestWindow.end,count:state.latestWindow.count}:null,
    health:health?JSON.parse(health.payload):null};
}
