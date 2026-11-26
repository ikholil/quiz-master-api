import { Inject, Injectable, Logger } from '@nestjs/common';
import { APP_CONFIG, AppConfig } from '../../config/configuration';

/**
 * Error monitoring hook. By default errors are emitted as structured logs (picked up by the log pipeline).
 * When ERROR_WEBHOOK_URL is set, a compact JSON event is POSTed (compatible with Slack/Teams incoming
 * webhooks or any alerting relay). Swap this provider for a Sentry/Datadog implementation if desired.
 */
@Injectable()
export class ErrorReporter {
  private readonly logger = new Logger('ErrorReporter');
  private lastSent = 0;

  constructor(@Inject(APP_CONFIG) private readonly cfg: AppConfig) {}

  report(error: unknown, context: Record<string, unknown> = {}): void {
    const err = error instanceof Error ? error : new Error(String(error));
    const url = this.cfg.monitoring.errorWebhookUrl;
    if (!url) return;
    // Basic throttling: at most one alert per 10 seconds per instance.
    const now = Date.now();
    if (now - this.lastSent < 10_000) return;
    this.lastSent = now;
    const body = {
      text: `[${this.cfg.appName}/${this.cfg.env}] ${err.name}: ${err.message}`,
      context,
      stack: err.stack?.split('\n').slice(0, 8).join('\n'),
      at: new Date().toISOString(),
    };
    fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }).catch((e: Error) => this.logger.warn(`Error webhook failed: ${e.message}`));
  }
}
