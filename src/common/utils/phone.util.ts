/**
 * Normalises Bangladeshi mobile numbers to E.164 (+8801XXXXXXXXX).
 * Accepts 01XXXXXXXXX, 8801XXXXXXXXX, +8801XXXXXXXXX (with spaces/dashes) and Bangla digits.
 * Valid operator prefixes: 013–019.
 */
const BN_DIGITS = '০১২৩৪৫৬৭৮৯';

export function foldBanglaDigits(input: string): string {
  return input.replace(/[০-৯]/g, (d) => String(BN_DIGITS.indexOf(d)));
}

export function normalizeBdPhone(input: string): string | null {
  if (!input) return null;
  let s = foldBanglaDigits(input).replace(/[\s\-()]/g, '');
  if (s.startsWith('+')) s = s.slice(1);
  if (s.startsWith('880')) s = s.slice(2);
  if (!/^01[3-9]\d{8}$/.test(s)) return null;
  return `+88${s}`;
}

export function normalizeEmail(input: string): string {
  return input.trim().toLowerCase();
}

export function maskIdentifier(identifier: string): string {
  if (identifier.includes('@')) {
    const [user, domain] = identifier.split('@');
    return `${user.slice(0, 2)}***@${domain}`;
  }
  return `${identifier.slice(0, 6)}****${identifier.slice(-2)}`;
}
