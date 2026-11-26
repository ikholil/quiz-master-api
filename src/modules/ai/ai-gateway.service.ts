import { Global, Inject, Injectable, Logger, Module } from '@nestjs/common';
import { AiUsageStatus } from '@prisma/client';
import { APP_CONFIG, AppConfig } from '../../config/configuration';
import { PrismaService } from '../../prisma/prisma.service';
import { SETTINGS, SystemConfigService } from '../system-config/system-config.module';
import {
  AiProvider,
  ChatRequest,
  ChatResult,
  EMBEDDING_DIMENSIONS,
  ProviderUnavailableError,
  estimateCostMicros,
} from './providers/ai-provider';
import { AnthropicProvider } from './providers/anthropic.provider';
import { LocalProvider } from './providers/local.provider';
import { OpenAiCompatibleProvider } from './providers/openai-compatible.provider';

export interface GatewayChatResult extends ChatResult {
  provider: string;
  fallbackUsed: boolean;
}

/**
 * Routes AI calls through the configured provider chain (AI_PROVIDERS, e.g. "anthropic,openai,local"),
 * falling back on availability errors, and records token usage + estimated cost for every call.
 * The deterministic local provider is always appended last so the feature degrades instead of failing.
 */
@Injectable()
export class AiGatewayService {
  private readonly logger = new Logger(AiGatewayService.name);
  private readonly providers: Map<string, AiProvider>;

  constructor(
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
    private readonly prisma: PrismaService,
    private readonly settings: SystemConfigService,
  ) {
    this.providers = new Map<string, AiProvider>([
      ['anthropic', new AnthropicProvider(cfg.ai)],
      ['openai', new OpenAiCompatibleProvider(cfg.ai)],
      ['local', new LocalProvider()],
    ]);
  }

  /** For tests: replace or add providers. */
  registerProvider(provider: AiProvider): void {
    this.providers.set(provider.name, provider);
  }

  chain(): AiProvider[] {
    const names = [...new Set([...this.cfg.ai.providers, 'local'])];
    return names.map((n) => this.providers.get(n)).filter((p): p is AiProvider => !!p && p.isConfigured());
  }

  async chat(
    req: ChatRequest,
    ctx: { userId?: string | null; feature: string },
    chain?: AiProvider[],
  ): Promise<GatewayChatResult> {
    const enabled = await this.settings.get<boolean>(SETTINGS.AI_ENABLED, true);
    const providers = enabled ? (chain ?? this.chain()) : [this.providers.get('local')!];
    let lastError: Error | undefined;
    for (const [i, provider] of providers.entries()) {
      const started = Date.now();
      try {
        const result = await provider.chat(req);
        await this.recordUsage(
          ctx,
          provider.name,
          result.model,
          result.inputTokens,
          result.outputTokens,
          Date.now() - started,
          AiUsageStatus.SUCCESS,
        );
        return { ...result, provider: provider.name, fallbackUsed: i > 0 };
      } catch (err) {
        lastError = err as Error;
        await this.recordUsage(
          ctx,
          provider.name,
          'unknown',
          0,
          0,
          Date.now() - started,
          AiUsageStatus.FAILED,
          lastError.message,
        );
        if (!(err instanceof ProviderUnavailableError)) {
          // Non-availability errors (bad request etc.) are logged and still fall through to the next provider,
          // but never with secrets in the message.
          this.logger.error(`Provider ${provider.name} failed: ${lastError.message.slice(0, 300)}`);
        } else {
          this.logger.warn(
            `Provider ${provider.name} unavailable, falling back: ${lastError.message.slice(0, 200)}`,
          );
        }
      }
    }
    throw lastError ?? new Error('No AI provider available');
  }

  async embed(texts: string[], ctx: { userId?: string | null; feature: string }) {
    const preferred = this.providers.get(this.cfg.ai.embeddingProvider);
    const order = [preferred, this.providers.get('local')].filter(
      (p, i, a): p is AiProvider => !!p && !!p.embed && p.isConfigured() && a.indexOf(p) === i,
    );
    let lastError: Error | undefined;
    for (const provider of order) {
      const started = Date.now();
      try {
        const res = await provider.embed!(texts);
        if (res.vectors.some((v) => v.length !== EMBEDDING_DIMENSIONS))
          throw new Error('Embedding dimension mismatch');
        await this.recordUsage(
          ctx,
          provider.name,
          res.model,
          res.inputTokens,
          0,
          Date.now() - started,
          AiUsageStatus.SUCCESS,
        );
        return { ...res, provider: provider.name };
      } catch (err) {
        lastError = err as Error;
        await this.recordUsage(
          ctx,
          provider.name,
          'embedding',
          0,
          0,
          Date.now() - started,
          AiUsageStatus.FAILED,
          lastError.message,
        );
      }
    }
    throw lastError ?? new Error('No embedding provider available');
  }

  /** Embedding model identifier used for indexing; retrieval must use the same one. */
  embeddingModelKey(): string {
    const p = this.providers.get(this.cfg.ai.embeddingProvider);
    return p?.isConfigured() && p.name !== 'local' ? this.cfg.ai.embeddingModel : 'local-hash-embedding-v1';
  }

  private async recordUsage(
    ctx: { userId?: string | null; feature: string },
    provider: string,
    model: string,
    inputTokens: number,
    outputTokens: number,
    latencyMs: number,
    status: AiUsageStatus,
    error?: string,
  ) {
    await this.prisma.aiUsageRecord
      .create({
        data: {
          userId: ctx.userId ?? null,
          feature: ctx.feature,
          provider,
          model,
          inputTokens,
          outputTokens,
          estimatedCostMicros: estimateCostMicros(model, inputTokens, outputTokens),
          latencyMs,
          status,
          error: error?.slice(0, 500),
        },
      })
      .catch((e: Error) => this.logger.warn(`Usage record failed: ${e.message}`));
  }
}

@Global()
@Module({ providers: [AiGatewayService], exports: [AiGatewayService] })
export class AiGatewayModule {}
