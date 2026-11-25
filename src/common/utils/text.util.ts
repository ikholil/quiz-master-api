import { foldBanglaDigits } from './phone.util';

export function slugify(input: string): string {
  return input
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9ঀ-৿]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

/** Normalisation for short-answer comparison: case/whitespace/punctuation-insensitive, Bangla digits folded. */
export function normalizeAnswer(input: string): string {
  return foldBanglaDigits(input.normalize('NFKC'))
    .toLowerCase()
    .replace(/[.,;:!?'"“”‘’()[\]{}।]/g, '')
    .replace(/[\s ]+/g, ' ')
    .trim();
}

/** Rough token estimate (≈4 chars/token for Latin script, ≈2 for Bangla script). */
export function estimateTokens(text: string): number {
  const bangla = (text.match(/[ঀ-৿]/g) ?? []).length;
  return Math.ceil(bangla / 2 + (text.length - bangla) / 4);
}

export function escapeLike(input: string): string {
  return input.replace(/[\\%_]/g, (m) => `\\${m}`);
}
