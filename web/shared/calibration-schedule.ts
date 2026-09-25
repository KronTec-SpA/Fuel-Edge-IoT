export function calibrationCountdown(nextDueAt:string|null, nowMs:number) {
  if (!nextDueAt || !Number.isFinite(Date.parse(nextDueAt)) || !Number.isFinite(nowMs) || !nowMs) return {text:"Se inicia al calibrar",overdue:false};
  const remaining = Date.parse(nextDueAt)-nowMs;
  if (remaining <= 0) {
    const days = Math.floor(-remaining/86400000);
    return {text:days ? `${days} ${days===1 ? "día" : "días"} de atraso` : "Corresponde calibrar hoy",overdue:true};
  }
  const days = Math.floor(remaining/86400000), hours=Math.floor(remaining%86400000/3600000);
  return {text:days ? `${days} ${days===1 ? "día" : "días"} · ${hours} h` : `${hours} h · ${Math.floor(remaining%3600000/60000)} min`,overdue:false};
}
