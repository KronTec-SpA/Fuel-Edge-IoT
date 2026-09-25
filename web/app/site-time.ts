/** UTC in storage; the installation's civil time in every display. */
export const SITE_TIME_ZONE = "America/Santiago";

export function databaseInstant(value: string): Date {
  const normalized = value.trim().replace(" ", "T");
  // SQLite CURRENT_TIMESTAMP and legacy ISO timestamps omit the UTC suffix.
  const utcWithoutZone = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?$/u.test(normalized);
  return new Date(utcWithoutZone ? `${normalized}Z` : normalized);
}

export function formatSiteDate(value: string | number | Date, options: Intl.DateTimeFormatOptions = { dateStyle: "medium", timeStyle: "short" }): string {
  const date = typeof value === "string" ? databaseInstant(value) : new Date(value);
  if (!Number.isFinite(date.getTime())) return typeof value === "string" ? value : "—";
  return new Intl.DateTimeFormat("es-CL", { ...options, timeZone: SITE_TIME_ZONE }).format(date);
}

export function siteDateKey(value: string | number | Date): string {
  const date = typeof value === "string" ? databaseInstant(value) : new Date(value);
  if (!Number.isFinite(date.getTime())) return "";
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: SITE_TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(date);
  const part = (type: string) => parts.find((item) => item.type === type)!.value;
  return `${part("year")}-${part("month")}-${part("day")}`;
}
