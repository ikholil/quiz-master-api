export interface ChatTurn {
  role: 'user' | 'assistant';
  content: string;
}

export interface ChatRequest {
  system: string;
  messages: ChatTurn[];
  maxTokens?: number;
  /** Context passages (already included in the prompt) — used by the local extractive provider. */
  contextPassages?: string[];
}

export interface ChatResult {
  text: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  /** True when the provider declined for safety reasons (not retried on other providers). */
  refused?: boolean;
}

export interface AiProvider {
  readonly name: string;
  /** Whether the provider is configured (credentials present). */
  isConfigured(): boolean;
  chat(req: ChatRequest): Promise<ChatResult>;
  /** Optional embeddings support; vectors must have EMBEDDING_DIMENSIONS dimensions. */
  embed?(texts: string[]): Promise<{ vectors: number[][]; model: string; inputTokens: number }>;
}

/** Fixed by the `vector(1536)` column. */
export const EMBEDDING_DIMENSIONS = 1536;

export class ProviderUnavailableError extends Error {}

/** Estimated price per million tokens (USD) for cost tracking. Unknown models fall back to zero. */
export const MODEL_PRICES_PER_MTOK: Record<string, { input: number; output: number }> = {
  'claude-opus-5-5': { input: 4, output: 20 },
  'claude-sonnet-5-5': { input: 2, output: 10 },
  'claude-haiku-5-5': { input: 0.1, output: 0.5 },
  'gpt-4o-mini': { input: 0.15, output: 0.6 },
  'text-embedding-3-small': { input: 0.02, output: 0 },
  'local-extractive-v1': { input: 0, output: 0 },
  'local-hash-embedding-v1': { input: 0, output: 0 },
};

export function estimateCostMicros(model: string, inputTokens: number, outputTokens: number): number {
  const p = MODEL_PRICES_PER_MTOK[model];
  if (!p) return 0;
  // USD per MTok == micro-USD per token.
  return Math.round(inputTokens * p.input + outputTokens * p.output);
}
