import { createHash } from 'node:crypto';
import { estimateTokens } from '../../../common/utils/text.util';
import { AiProvider, ChatRequest, ChatResult, EMBEDDING_DIMENSIONS } from './ai-provider';

const TOKEN_RE = /[\p{L}\p{N}]+/gu;

function tokens(text: string): string[] {
  return (text.normalize('NFKC').toLowerCase().match(TOKEN_RE) ?? []).filter((t) => t.length > 1);
}

/**
 * Deterministic, dependency-free provider that keeps the platform functional when no external AI service
 * is configured or all of them are down:
 *  - embeddings: signed feature hashing of unigrams + bigrams (L2-normalised), good enough for lexical retrieval;
 *  - chat: extractive answer that quotes the most relevant approved passages; it never generates new facts.
 */
export class LocalProvider implements AiProvider {
  readonly name = 'local';

  isConfigured(): boolean {
    return true;
  }

  async embed(texts: string[]) {
    return {
      vectors: texts.map((t) => hashEmbedding(t)),
      model: 'local-hash-embedding-v1',
      inputTokens: texts.reduce((n, t) => n + estimateTokens(t), 0),
    };
  }

  async chat(req: ChatRequest): Promise<ChatResult> {
    const question = [...req.messages].reverse().find((m) => m.role === 'user')?.content ?? '';
    const q = new Set(tokens(question));
    const sentences = (req.contextPassages ?? [])
      .flatMap((p, pi) => p.split(/(?<=[.!?।])\s+/).map((s) => ({ s: s.trim(), pi })))
      .filter((x) => x.s.length > 20);
    const scored = sentences
      .map((x) => ({ ...x, score: tokens(x.s).filter((t) => q.has(t)).length }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score || a.pi - b.pi)
      .slice(0, 4);
    const text = scored.length
      ? `Based on the approved study material:\n\n${scored.map((x) => `• ${x.s} [${x.pi + 1}]`).join('\n')}\n\n(Offline assistant mode: this answer quotes the material directly.)`
      : 'আমি এই প্রশ্নের উত্তর অনুমোদিত পাঠ্য উপকরণে খুঁজে পাইনি। I could not find this in the approved study material. Please check the relevant lesson or ask your instructor.';
    return {
      text,
      model: 'local-extractive-v1',
      inputTokens:
        estimateTokens(req.system) + req.messages.reduce((n, m) => n + estimateTokens(m.content), 0),
      outputTokens: estimateTokens(text),
    };
  }
}

export function hashEmbedding(text: string, dims = EMBEDDING_DIMENSIONS): number[] {
  const vec = new Float64Array(dims);
  const toks = tokens(text);
  const features = [...toks, ...toks.slice(1).map((t, i) => `${toks[i]}_${t}`)];
  for (const f of features) {
    const h = createHash('md5').update(f).digest();
    const idx = h.readUInt32LE(0) % dims;
    vec[idx] += h[4] & 1 ? 1 : -1;
  }
  const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0)) || 1;
  return Array.from(vec, (v) => Math.round((v / norm) * 1e6) / 1e6);
}
