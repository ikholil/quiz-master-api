import { Prisma } from '@prisma/client';

/**
 * Marks arithmetic is performed in integer hundredths ("centimarks") to avoid floating point drift
 * (e.g. 0.25 negative marking × 37 wrong answers must be exactly 9.25).
 */
export type Centi = number;

export function toCenti(value: Prisma.Decimal | number | string | null | undefined): Centi {
  if (value === null || value === undefined) return 0;
  const n = typeof value === 'object' ? Number(value.toString()) : Number(value);
  if (!Number.isFinite(n)) throw new Error(`Invalid marks value: ${String(value)}`);
  return Math.round(n * 100);
}

export function fromCenti(c: Centi): number {
  return Math.round(c) / 100;
}

export function centiToDecimal(c: Centi): Prisma.Decimal {
  return new Prisma.Decimal(fromCenti(c).toFixed(2));
}

export function decToNumber(value: Prisma.Decimal | number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  return typeof value === 'number' ? value : Number(value.toString());
}
