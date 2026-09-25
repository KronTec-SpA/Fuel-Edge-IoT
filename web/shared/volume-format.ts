/** Presentation only: nearest tenth, ties away from zero (Intl halfExpand).
 * Never feed formatted values back into telemetry, totals or persisted records.
 */
const display = new Intl.NumberFormat("es-CL", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const decimal = new Intl.NumberFormat("en-US", { useGrouping: false, minimumFractionDigits: 1, maximumFractionDigits: 1 });

export function formatVolume(value: number | null | undefined, machine = false): string {
  if (value == null || !Number.isFinite(value)) return machine ? "" : "—";
  const text = (machine ? decimal : display).format(value);
  return text === "-0,0" || text === "-0.0" ? text.slice(1) : text;
}
export function formatLiters(value: number | null | undefined): string {
  const text = formatVolume(value);
  return text === "—" ? text : `${text} L`;
}
export function formatVolumeCsv(value: number | null | undefined): string {
  return formatVolume(value, true);
}

/** A document-only review must not overwrite the original volume with its display rounding. */
export function receiptVolumeToSave(entered: number, original: number): number {
  return entered === Number(formatVolumeCsv(original)) ? original : entered;
}
