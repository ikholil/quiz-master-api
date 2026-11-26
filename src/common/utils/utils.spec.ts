import { parseCsv } from './csv.util';
import { generateOtp, hashPassword, hmacSha256, safeEqualHex, verifyPassword } from './crypto.util';
import { centiToDecimal, toCenti } from './marks.util';
import { normalizeBdPhone } from './phone.util';
import { seededRandom, shuffle } from './random.util';
import { dhakaDate, toIsoDate } from './date.util';

describe('normalizeBdPhone', () => {
  it.each([
    ['01712345678', '+8801712345678'],
    ['+8801712345678', '+8801712345678'],
    ['8801912-345678', '+8801912345678'],
    ['০১৭১২৩৪৫৬৭৮', '+8801712345678'],
  ])('%s → %s', (input, out) => expect(normalizeBdPhone(input)).toBe(out));
  it.each(['01212345678', '1712345678', '0171234567', 'abc'])('rejects %s', (input) => expect(normalizeBdPhone(input)).toBeNull());
});

describe('crypto', () => {
  it('hashes and verifies passwords (salted)', async () => {
    const h1 = await hashPassword('Secret123');
    const h2 = await hashPassword('Secret123');
    expect(h1).not.toEqual(h2);
    expect(await verifyPassword('Secret123', h1)).toBe(true);
    expect(await verifyPassword('secret123', h1)).toBe(false);
    expect(await verifyPassword('x', 'garbage')).toBe(false);
  });
  it('generates 6-digit OTPs', () => {
    for (let i = 0; i < 50; i++) expect(generateOtp()).toMatch(/^\d{6}$/);
  });
  it('compares HMACs in constant time and rejects malformed input', () => {
    const a = hmacSha256('k', 'msg');
    expect(safeEqualHex(a, hmacSha256('k', 'msg'))).toBe(true);
    expect(safeEqualHex(a, hmacSha256('k', 'other'))).toBe(false);
    expect(safeEqualHex(a, 'not-hex')).toBe(false);
  });
});

describe('marks', () => {
  it('converts to integer centimarks exactly', () => {
    expect(toCenti(0.25) * 37).toBe(925);
    expect(centiToDecimal(5375).toString()).toBe('53.75');
  });
});

describe('seeded shuffle', () => {
  it('is reproducible from the seed and a permutation', () => {
    const items = Array.from({ length: 20 }, (_, i) => i);
    const a = shuffle(items, seededRandom('seed'));
    expect(shuffle(items, seededRandom('seed'))).toEqual(a);
    expect([...a].sort((x, y) => x - y)).toEqual(items);
    expect(shuffle(items, seededRandom('other'))).not.toEqual(a);
  });
});

describe('csv', () => {
  it('handles quotes, escaped quotes and embedded newlines', () => {
    expect(parseCsv('a,b\n"x, y","he said ""hi""\nthere"\n')).toEqual([
      ['a', 'b'],
      ['x, y', 'he said "hi"\nthere'],
    ]);
  });
});

describe('dhakaDate', () => {
  it('rolls over at Dhaka midnight (UTC+6)', () => {
    expect(toIsoDate(dhakaDate(new Date('2026-03-01T17:59:00Z')))).toBe('2026-03-01');
    expect(toIsoDate(dhakaDate(new Date('2026-03-01T18:01:00Z')))).toBe('2026-03-02');
  });
});
