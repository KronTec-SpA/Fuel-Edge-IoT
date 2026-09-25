import { formatVolume } from "../shared/volume-format";

export type DisplaySensor = {
  currentLevel: number;
  capacityLiters: number;
  latestReadingAt: string;
  telemetrySessionId?: string | null;
  displayReference?: {liters: number; sourceAt: string; telemetrySessionId: string | null; ranged: boolean} | null;
  levelRange?: {minLiters: number; maxLiters: number} | null;
  measurementQuality?: {occurredAt: string; status: string; telemetrySessionId?: string | null} | null;
};

export type LevelRange = {minLiters: number; maxLiters: number};
const number = formatVolume;
export function formatLevelRange(range: LevelRange | null | undefined, fallback: number | null, unit = "L") {
  if (range && range.minLiters !== range.maxLiters) return `Entre ${number(Math.floor(range.minLiters*10)/10)} y ${number(Math.ceil(range.maxLiters*10)/10)} ${unit}`;
  const value = range?.minLiters ?? fallback;
  return value == null ? "—" : `${number(value)} ${unit}`;
}

type DisplayEdge = {
  occurredAt: string;
  tankLevelEnabled: boolean;
  telemetrySessionId?: string | null;
};

/** El volumen es el último dato OCIO; la antigüedad nunca lo convierte en cero. */
export function fuelLevelDisplay(sensor: DisplaySensor | null | undefined,
  edge: DisplayEdge | null | undefined, nowMs: number) {
  const measuredAt = Date.parse(sensor?.latestReadingAt ?? "");
  const range = sensor?.levelRange;
  const validRange = !range || (Number.isFinite(range.minLiters) && Number.isFinite(range.maxLiters)
    && range.minLiters >= 0 && range.minLiters <= sensor!.currentLevel
    && range.maxLiters >= sensor!.currentLevel && range.maxLiters <= sensor!.capacityLiters);
  const hasReading = Boolean(validRange && sensor && measuredAt > 0
    && Number.isFinite(sensor.currentLevel) && Number.isFinite(sensor.capacityLiters)
    && sensor.capacityLiters > 0 && sensor.currentLevel >= 0
    && sensor.currentLevel <= sensor.capacityLiters);
  const age = nowMs - measuredAt;
  const edgeAge = nowMs - Date.parse(edge?.occurredAt ?? "");
  const sessionMatches = !edge?.telemetrySessionId
    || sensor?.telemetrySessionId === edge.telemetrySessionId;
  const recent = Boolean(hasReading && nowMs > 0 && age >= 0 && age <= 180_000
    && edge?.tankLevelEnabled && edgeAge >= 0 && edgeAge <= 30_000 && sessionMatches);
  const isRange = Boolean(hasReading && range && range.minLiters !== range.maxLiters);
  const center = isRange ? (range!.minLiters+range!.maxLiters)/2 : sensor?.currentLevel;
  const saved = sensor?.displayReference;
  const savedMatches = Boolean(hasReading && saved && saved.sourceAt === sensor!.latestReadingAt
    && saved.telemetrySessionId === (sensor!.telemetrySessionId ?? null) && saved.ranged === isRange
    && Number.isFinite(saved.liters) && saved.liters >= 0 && saved.liters <= sensor!.capacityLiters
    && Math.abs(saved.liters-center!) <= 2.5
    && (!isRange || saved.liters >= range!.minLiters && saved.liters <= range!.maxLiters));
  const reference = hasReading ? savedMatches ? saved!.liters : isRange ? Math.round(center!) : sensor!.currentLevel : null;
  const variation = isRange ? Math.ceil(Math.max(reference!-range!.minLiters, range!.maxLiters-reference!)) : null;
  const q = sensor?.measurementQuality;
  const qAge = nowMs-Date.parse(q?.occurredAt ?? "");
  const qFresh = Boolean(q && qAge >= 0 && qAge <= 30000 && edgeAge >= 0 && edgeAge <= 30000
    && (!edge?.telemetrySessionId || q.telemetrySessionId === edge.telemetrySessionId));
  const unavailable = qFresh && q!.status === "unavailable";
  const calibrationPending = qFresh && q!.status === "calibration_pending";
  const fresh = recent && !unavailable && !calibrationPending;
  const validating = qFresh && !["valid","range","unavailable"].includes(q!.status);
  const statusLabel = calibrationPending ? "Calibración pendiente" : unavailable ? "Revisar sensor" : !hasReading ? validating ? "Preparando primera lectura" : "Esperando lectura"
    : !fresh ? "Actualización pendiente"
      : validating ? "Validando lectura" : "Lectura vigente";
  return {
    hasReading, fresh,
    isRange, reference, variation, statusLabel, validating,
    stabilized: savedMatches,
    minPercent: hasReading ? (range?.minLiters ?? sensor!.currentLevel) / sensor!.capacityLiters * 100 : null,
    percent: hasReading ? reference! / sensor!.capacityLiters * 100 : null,
    maxPercent: hasReading ? (range?.maxLiters ?? sensor!.currentLevel) / sensor!.capacityLiters * 100 : null,
    volumeLabel: hasReading ? `${number(reference!)} L` : "Sin lectura",
    variationLabel: variation === null ? null : `Variación observada: ±${number(variation)} L`,
    rangeLabel: hasReading ? formatLevelRange(range, sensor!.currentLevel) : "—",
    percentLabel: hasReading ? `${number(reference!/sensor!.capacityLiters*100)} %` : "—",
    label: !hasReading ? "Sin lectura" : !fresh ? "Última lectura disponible" : isRange ? "Volumen de referencia" : "Nivel de combustible",
  };
}
