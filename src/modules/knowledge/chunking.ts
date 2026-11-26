import { estimateTokens } from '../../common/utils/text.util';

export interface Chunk {
  ordinal: number;
  content: string;
  tokenCount: number;
  heading?: string;
}

/** Extracts plain text from supported formats. Returns null for formats that need an external extractor. */
export function extractText(mime: string, body: string): string | null {
  switch (mime) {
    case 'text/plain':
    case 'text/markdown':
      return body;
    case 'text/html':
      return body
        .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
        .replace(/<\/(p|div|h[1-6]|li|tr|br)>/gi, '\n')
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/[ \t]+/g, ' ');
    case 'application/json': {
      const walk = (v: unknown): string[] =>
        typeof v === 'string'
          ? [v]
          : Array.isArray(v)
            ? v.flatMap(walk)
            : v && typeof v === 'object'
              ? Object.values(v).flatMap(walk)
              : [];
      return walk(JSON.parse(body)).join('\n\n');
    }
    default:
      return null;
  }
}

/**
 * Paragraph-aware chunking: packs paragraphs up to `maxTokens`, splitting oversized paragraphs on sentence
 * boundaries, with a small overlap carried between chunks to preserve context. Markdown headings are kept as metadata.
 */
export function chunkText(text: string, maxTokens = 400, overlapTokens = 60): Chunk[] {
  const paragraphs = text
    .replace(/\r\n/g, '\n')
    .split(/\n{2,}/)
    .map((p) => p.replace(/\s+/g, ' ').trim())
    .filter(Boolean);

  const units: Array<{ text: string; heading?: string }> = [];
  let heading: string | undefined;
  for (const p of paragraphs) {
    const h = /^#{1,6}\s+(.*)$/.exec(p);
    if (h) {
      heading = h[1].slice(0, 200);
      continue;
    }
    if (estimateTokens(p) <= maxTokens) units.push({ text: p, heading });
    else for (const s of p.split(/(?<=[.!?।])\s+/)) units.push({ text: s, heading });
  }

  const chunks: Chunk[] = [];
  let buf: string[] = [];
  let bufTokens = 0;
  let bufHeading: string | undefined;
  const flush = () => {
    if (!buf.length) return;
    const content = buf.join('\n\n');
    chunks.push({
      ordinal: chunks.length,
      content,
      tokenCount: estimateTokens(content),
      heading: bufHeading,
    });
    // Overlap: keep trailing units up to overlapTokens.
    const carry: string[] = [];
    let carryTokens = 0;
    for (let i = buf.length - 1; i >= 0 && carryTokens < overlapTokens; i--) {
      carry.unshift(buf[i]);
      carryTokens += estimateTokens(buf[i]);
    }
    buf = carryTokens < maxTokens / 2 ? carry : [];
    bufTokens = buf.reduce((n, u) => n + estimateTokens(u), 0);
  };
  for (const u of units) {
    const t = estimateTokens(u.text);
    if (bufTokens + t > maxTokens && bufTokens > 0) flush();
    if (!buf.length) bufHeading = u.heading;
    buf.push(u.text.length > maxTokens * 6 ? u.text.slice(0, maxTokens * 6) : u.text);
    bufTokens += t;
  }
  if (buf.length && (chunks.length === 0 || bufTokens > overlapTokens)) flush();
  return chunks;
}
