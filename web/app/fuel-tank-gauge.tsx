"use client";

import { useId } from "react";

/** A schematic level indicator, scaled by volume rather than physical tank geometry. */
export function FuelTankGauge({ percent, minPercent, maxPercent, compact = false }: {
  percent: number | null;
  minPercent?: number | null;
  maxPercent?: number | null;
  compact?: boolean;
}) {
  const id = useId().replace(/:/g, "");
  const clamp = (value: number) => Math.max(0, Math.min(100, value));
  const levelY = (value: number) => 162 - clamp(value) * 1.16;
  const top = levelY(percent ?? 0);
  const range = minPercent != null && maxPercent != null && maxPercent > minPercent;
  return <svg className={`tank-diagram${compact ? " tank-diagram-compact" : ""}`} viewBox={compact ? "16 12 142 182" : "0 0 224 200"} aria-hidden="true">
    <defs>
      <linearGradient id={`${id}-steel`} x1="0" x2="1">
        <stop offset="0" stopColor="#b9b2c2" /><stop offset=".18" stopColor="#e3dee8" />
        <stop offset=".48" stopColor="#faf9fc" /><stop offset=".8" stopColor="#d9d3e1" /><stop offset="1" stopColor="#b2a9bd" />
      </linearGradient>
      <linearGradient id={`${id}-fuel`} x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stopColor="#a98acb" /><stop offset="1" stopColor="#70549e" />
      </linearGradient>
      <clipPath id={`${id}-vessel`}><path d="M30 46h112v116c0 8-25 14-56 14s-56-6-56-14Z" /></clipPath>
    </defs>
    <ellipse cx="86" cy="188" rx="70" ry="5" fill="#41364e" opacity=".07" />
    <g fill="#8d8299" stroke="#74687f" strokeWidth="1.5">
      <path d="M43 168v16h14v-12M115 172v12h14v-16" />
      <rect x="72" y="23" width="28" height="16" rx="3" />
      <rect x="68" y="21" width="36" height="5" rx="2" fill="#d9d3e1" />
      <path d="M119 35V19h10" fill="none" strokeWidth="4" />
    </g>
    <path d="M30 46h112v116c0 8-25 14-56 14s-56-6-56-14Z" fill={`url(#${id}-steel)`} stroke="#92859f" strokeWidth="1.5" />
    <g clipPath={`url(#${id}-vessel)`}>
      {percent != null && percent > 0 && <>
        <rect x="30" y={top} width="112" height={176 - top} fill={`url(#${id}-fuel)`} />
        <ellipse cx="86" cy={top} rx="56" ry="9" fill="#c2aad9" stroke="#9575b5" />
      </>}
      {range && <rect x="30" y={levelY(maxPercent)} width="112" height={levelY(minPercent) - levelY(maxPercent)} fill="#e4b764" opacity=".65" />}
      <path d="M41 50v111" stroke="white" strokeWidth="4" opacity=".38" />
      <path d="M30 82c18 10 94 10 112 0M30 139c18 10 94 10 112 0" fill="none" stroke="#796c89" opacity=".3" />
    </g>
    <ellipse cx="86" cy="46" rx="56" ry="13" fill={`url(#${id}-steel)`} stroke="#92859f" strokeWidth="1.5" />
    <ellipse cx="86" cy="44" rx="45" ry="8" fill="none" stroke="white" opacity=".6" />
    <path d="M30 162c0 8 25 14 56 14s56-6 56-14" fill="none" stroke="#857591" strokeWidth="2" />
    <rect x="73" y="63" width="26" height="12" rx="2" fill="#faf9fc" stroke="#b3a8be" />
    <path d="M79 69h14" stroke="#8b7b9b" strokeWidth="2" />
    {!compact && <>
      <rect x="160" y="46" width="8" height="116" rx="4" fill="#e6e0ed" />
      {percent != null && percent > 0 && <rect x="160" y={top} width="8" height={162 - top} rx="4" fill={`url(#${id}-fuel)`} />}
      {[100, 75, 50, 25, 0].map(value => <g key={value}>
        <path d={`M174 ${levelY(value)}h5`} stroke="#b6acbf" />
        <text x="185" y={levelY(value)} dominantBaseline="central" className="tank-scale-label">{value}%</text>
      </g>)}
      {percent != null && <path d={`M151 ${top - 4}l6 4-6 4Z`} fill="#70549e" />}
    </>}
  </svg>;
}
