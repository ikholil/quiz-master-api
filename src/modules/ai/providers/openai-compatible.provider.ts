import type { AppConfig } from '../../../config/configuration';
import {
  AiProvider,
  ChatRequest,
  ChatResult,
  EMBEDDING_DIMENSIONS,
  ProviderUnavailableError,
} from './ai-provider';

/**
 * Any OpenAI-compatible endpoint (OpenAI, Azure-compatible gateways, self-hosted vLLM/Ollama gateways)
 * for chat completions and embeddings. Configure OPENAI_BASE_URL / OPENAI_API_KEY / OPENAI_CHAT_MODEL.
 */
export class OpenAiCompatibleProvider implements AiProvider {
  readonly name = 'openai';

  constructor(private readonly cfg: AppConfig['ai']) {}

  isConfigured(): boolean {
    return !!this.cfg.openaiApiKey;
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    if (!this.cfg.openaiApiKey)
      throw new ProviderUnavailableError('OpenAI-compatible API key not configured');
    let res: Response;
    try {
      res = await fetch(`${this.cfg.openaiBaseUrl}${path}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${this.cfg.openaiApiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.cfg.requestTimeoutMs),
      });
    } catch (err) {
      throw new ProviderUnavailableError(`OpenAI-compatible request failed: ${(err as Error).message}`);
    }
    if (res.status === 429 || res.status >= 500)
      throw new ProviderUnavailableError(`OpenAI-compatible error ${res.status}`);
    if (!res.ok)
      throw new Error(`OpenAI-compatible error ${res.status}: ${(await res.text()).slice(0, 300)}`);
    return (await res.json()) as T;
  }

  async chat(req: ChatRequest): Promise<ChatResult> {
    const model = this.cfg.chatModel.openai;
    const json = await this.post<{
      model: string;
      choices: Array<{ message: { content: string | null }; finish_reason: string }>;
      usage?: { prompt_tokens: number; completion_tokens: number };
    }>('/chat/completions', {
      model,
      max_tokens: req.maxTokens ?? 4000,
      messages: [{ role: 'system', content: req.system }, ...req.messages],
    });
    const choice = json.choices[0];
    return {
      text: (choice?.message.content ?? '').trim(),
      model: json.model ?? model,
      inputTokens: json.usage?.prompt_tokens ?? 0,
      outputTokens: json.usage?.completion_tokens ?? 0,
      refused: choice?.finish_reason === 'content_filter',
    };
  }

  async embed(texts: string[]) {
    const model = this.cfg.embeddingModel;
    const json = await this.post<{
      data: Array<{ embedding: number[]; index: number }>;
      usage?: { prompt_tokens: number };
    }>('/embeddings', {
      model,
      input: texts,
      dimensions: EMBEDDING_DIMENSIONS,
    });
    const vectors = json.data.sort((a, b) => a.index - b.index).map((d) => d.embedding);
    if (vectors.some((v) => v.length !== EMBEDDING_DIMENSIONS))
      throw new Error(`Embedding model must return ${EMBEDDING_DIMENSIONS} dimensions`);
    return { vectors, model, inputTokens: json.usage?.prompt_tokens ?? 0 };
  }
}
