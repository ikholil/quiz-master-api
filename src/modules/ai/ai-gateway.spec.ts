import { AiGatewayService } from './ai-gateway.service';
import {
  AiProvider,
  ChatRequest,
  ProviderUnavailableError,
  estimateCostMicros,
} from './providers/ai-provider';
import { LocalProvider, hashEmbedding } from './providers/local.provider';
import { OFFICIAL_FACT_FALLBACK, isOfficialFactQuestion } from './prompts';

function makeGateway(providers: string[], enabled = true) {
  const usage: unknown[] = [];
  const prisma = {
    aiUsageRecord: { create: jest.fn(async (args: { data: unknown }) => usage.push(args.data)) },
  };
  const settings = { get: jest.fn(async () => enabled) };
  const cfg = {
    ai: {
      providers,
      chatModel: { anthropic: 'claude-opus-5-5', openai: 'gpt-4o-mini', local: 'local' },
      embeddingProvider: 'local',
      embeddingModel: 'x',
      requestTimeoutMs: 1000,
      openaiBaseUrl: 'http://x',
      anthropicBaseUrl: 'http://x',
    },
  };
  const gw = new AiGatewayService(cfg as never, prisma as never, settings as never);
  return { gw, usage };
}

class FakeProvider implements AiProvider {
  calls = 0;
  constructor(
    readonly name: string,
    private readonly behaviour: 'ok' | 'down' | 'error',
  ) {}
  isConfigured() {
    return true;
  }
  async chat(_req: ChatRequest) {
    this.calls++;
    if (this.behaviour === 'down') throw new ProviderUnavailableError('down');
    if (this.behaviour === 'error') throw new Error('bad request');
    return { text: `from ${this.name}`, model: 'claude-opus-5-5', inputTokens: 1000, outputTokens: 500 };
  }
}

describe('AiGatewayService', () => {
  it('falls back to the next provider when one is unavailable and records usage for both', async () => {
    const { gw, usage } = makeGateway(['anthropic', 'openai']);
    const a = new FakeProvider('anthropic', 'down');
    const b = new FakeProvider('openai', 'ok');
    gw.registerProvider(a);
    gw.registerProvider(b);
    const res = await gw.chat(
      { system: 's', messages: [{ role: 'user', content: 'hi' }] },
      { feature: 'test' },
    );
    expect(res.provider).toBe('openai');
    expect(res.fallbackUsed).toBe(true);
    expect(a.calls).toBe(1);
    expect(usage).toHaveLength(2);
    expect(usage[1]).toMatchObject({
      status: 'SUCCESS',
      inputTokens: 1000,
      outputTokens: 500,
      estimatedCostMicros: 14000,
    });
  });

  it('always ends with the local provider so the feature keeps working when every external AI is down', async () => {
    const { gw } = makeGateway(['anthropic', 'openai']);
    gw.registerProvider(new FakeProvider('anthropic', 'down'));
    gw.registerProvider(new FakeProvider('openai', 'error'));
    const res = await gw.chat(
      {
        system: 's',
        messages: [{ role: 'user', content: 'percentage formula' }],
        contextPassages: ['To find a percentage, multiply by the rate and divide by 100.'],
      },
      { feature: 'test' },
    );
    expect(res.provider).toBe('local');
    expect(res.text).toContain('percentage');
  });

  it('uses only the local provider when AI is disabled by configuration', async () => {
    const { gw } = makeGateway(['anthropic'], false);
    const a = new FakeProvider('anthropic', 'ok');
    gw.registerProvider(a);
    const res = await gw.chat(
      { system: 's', messages: [{ role: 'user', content: 'x' }] },
      { feature: 'test' },
    );
    expect(res.provider).toBe('local');
    expect(a.calls).toBe(0);
  });
});

describe('local provider', () => {
  it('produces normalised deterministic 1536-d embeddings with lexical similarity', async () => {
    const v1 = hashEmbedding('percentage of a number');
    const v2 = hashEmbedding('percentage of a number');
    const v3 = hashEmbedding('history of the language movement');
    const dot = (a: number[], b: number[]) => a.reduce((s, x, i) => s + x * b[i], 0);
    expect(v1).toHaveLength(1536);
    expect(v1).toEqual(v2);
    expect(dot(v1, v1)).toBeCloseTo(1, 3);
    expect(dot(v1, v2)).toBeGreaterThan(dot(v1, v3));
  });

  it('admits it does not know when nothing relevant is in the context', async () => {
    const res = await new LocalProvider().chat({
      system: '',
      messages: [{ role: 'user', content: 'quantum chromodynamics' }],
      contextPassages: ['Average is sum divided by count.'],
    });
    expect(res.text).toMatch(/could not find/);
  });
});

describe('guardrails', () => {
  it.each([
    'When is the 47th BCS exam date?',
    'বিসিএস এর আবেদনের শেষ তারিখ কবে?',
    'What is the age limit for NTRCA?',
    'Give me the official answer key',
  ])('flags official-fact question: %s', (q) => expect(isOfficialFactQuestion(q)).toBe(true));
  it('does not flag ordinary study questions', () =>
    expect(isOfficialFactQuestion('Explain how to compute an average')).toBe(false));
  it('fallback text refuses to guess', () => expect(OFFICIAL_FACT_FALLBACK).toContain('will not guess'));
  it('estimates cost from the price table', () =>
    expect(estimateCostMicros('claude-opus-5-5', 1_000_000, 0)).toBe(4_000_000));
});
