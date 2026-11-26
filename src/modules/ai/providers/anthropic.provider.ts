import Anthropic from '@anthropic-ai/sdk';
import type { AppConfig } from '../../../config/configuration';
import { AiProvider, ChatRequest, ChatResult, ProviderUnavailableError } from './ai-provider';

/**
 * Claude via the official Anthropic SDK. Uses server-side refusal fallback ("default" routing) so a
 * safety decline on the primary model is retried by the API itself; a final `refusal` is reported as such.
 */
export class AnthropicProvider implements AiProvider {
  readonly name = 'anthropic';
  private readonly client?: Anthropic;
  private readonly model: string;

  constructor(cfg: AppConfig['ai']) {
    this.model = cfg.chatModel.anthropic;
    if (cfg.anthropicApiKey) {
      this.client = new Anthropic({
        apiKey: cfg.anthropicApiKey,
        baseURL: cfg.anthropicBaseUrl,
        timeout: cfg.requestTimeoutMs,
        maxRetries: 1,
      });
    }
  }

  isConfigured(): boolean {
    return !!this.client;
  }

  async chat(req: ChatRequest): Promise<ChatResult> {
    if (!this.client) throw new ProviderUnavailableError('Anthropic API key not configured');
    try {
      const response = await this.client.beta.messages.create({
        model: this.model,
        max_tokens: req.maxTokens ?? 16000,
        system: [{ type: 'text', text: req.system, cache_control: { type: 'ephemeral' } }],
        messages: req.messages.map((m) => ({ role: m.role, content: m.content })),
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
      });
      const text = response.content
        .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === 'text')
        .map((b) => b.text)
        .join('\n')
        .trim();
      return {
        text,
        model: response.model,
        inputTokens:
          response.usage.input_tokens +
          (response.usage.cache_read_input_tokens ?? 0) +
          (response.usage.cache_creation_input_tokens ?? 0),
        outputTokens: response.usage.output_tokens,
        refused: response.stop_reason === 'refusal',
      };
    } catch (err) {
      // Connection problems, rate limits and server errors are retryable on another provider.
      if (
        err instanceof Anthropic.APIConnectionError ||
        err instanceof Anthropic.RateLimitError ||
        err instanceof Anthropic.InternalServerError
      ) {
        throw new ProviderUnavailableError(`Anthropic unavailable: ${err.message}`);
      }
      if (
        err instanceof Anthropic.APIError &&
        (err.status === undefined || err.status >= 500 || err.status === 529)
      ) {
        throw new ProviderUnavailableError(`Anthropic error ${err.status}: ${err.message}`);
      }
      throw err;
    }
  }
}
