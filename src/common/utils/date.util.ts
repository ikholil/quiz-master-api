/** Date helpers. All persisted timestamps are UTC; "calendar days" for students are in Asia/Dhaka (UTC+6, no DST). */
export const DHAKA_OFFSET_MS = 6 * 60 * 60 * 1000;
export const DAY_MS = 24 * 60 * 60 * 1000;

/** Returns the Dhaka calendar date (as a UTC-midnight Date suitable for @db.Date columns). */
export function dhakaDate(at: Date = new Date()): Date {
  const shifted = new Date(at.getTime() + DHAKA_OFFSET_MS);
  return new Date(Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate()));
}

/** Start of the given Dhaka calendar day as a UTC instant. */
export function dhakaDayStartUtc(date: Date): Date {
  return new Date(date.getTime() - DHAKA_OFFSET_MS);
}

export function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * DAY_MS);
}

export function daysBetween(a: Date, b: Date): number {
  return Math.round((b.getTime() - a.getTime()) / DAY_MS);
}

export function toIsoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function parseIsoDate(value: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error(`Invalid date: ${value}`);
  const d = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(d.getTime())) throw new Error(`Invalid date: ${value}`);
  return d;
}
