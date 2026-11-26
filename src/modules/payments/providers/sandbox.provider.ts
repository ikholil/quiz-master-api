import type { Payment } from '@prisma/client';
import type Redis from 'ioredis';
import { hmacSha256, safeEqualHex } from '../../../common/utils/crypto.util';
import { InitiateContext, InitiateResult, InvalidWebhookError, PaymentProvider, VerifyResult, WebhookEvent } from './payment-provider';

/**
 * Development/test provider. Checkout is simulated; completion arrives as an HMAC-SHA256 signed webhook:
 *   header `x-sandbox-signature: hex(hmac_sha256(WEBHOOK_SANDBOX_SECRET, rawBody))`
 *   body   `{ "eventId": "...", "merchantTxnId": "...", "status": "SUCCEEDED"|"FAILED", "amountMinor": 49900 }`
 * The signed status is stored in a short-lived ledger that `verify` reads (standing in for the provider's API).
 */
export class SandboxPaymentProvider implements PaymentProvider {
  readonly name = 'sandbox';

  constructor(
    private readonly secret: string,
    private readonly redis: Redis,
    private readonly publicBaseUrl: string,
  ) {}

  isConfigured(): boolean {
    return !!this.secret;
  }

  async initiate(payment: Payment, _ctx: InitiateContext): Promise<InitiateResult> {
    return { redirectUrl: `${this.publicBaseUrl}/sandbox-checkout/${payment.merchantTxnId}`, providerRef: `SBX-${payment.merchantTxnId}` };
  }

  async verify(payment: Payment): Promise<VerifyResult> {
    const raw = await this.redis.get(`sandbox:payment:${payment.merchantTxnId}`);
    if (!raw) return { status: 'PENDING' };
    const data = JSON.parse(raw) as { status: 'SUCCEEDED' | 'FAILED'; amountMinor: number };
    return { status: data.status, amountMinor: data.amountMinor, currency: 'BDT', providerRef: `SBX-${payment.merchantTxnId}`, raw: data };
  }

  async parseWebhook(headers: Record<string, string | string[] | undefined>, rawBody: Buffer, body: Record<string, unknown>): Promise<WebhookEvent> {
    const sig = headers['x-sandbox-signature'];
    if (typeof sig !== 'string' || !safeEqualHex(hmacSha256(this.secret, rawBody), sig)) throw new InvalidWebhookError('Invalid sandbox signature');
    const { eventId, merchantTxnId, status, amountMinor } = body as { eventId?: string; merchantTxnId?: string; status?: string; amountMinor?: number };
    if (!eventId || !merchantTxnId || !['SUCCEEDED', 'FAILED'].includes(status ?? '') || typeof amountMinor !== 'number') {
      throw new InvalidWebhookError('Malformed sandbox event');
    }
    await this.redis.set(`sandbox:payment:${merchantTxnId}`, JSON.stringify({ status, amountMinor }), 'EX', 7 * 86400);
    return { eventId, merchantTxnId, raw: body };
  }

  async refund(payment: Payment, amountMinor: number) {
    return { providerRef: `SBX-RF-${payment.merchantTxnId}-${amountMinor}`, status: 'COMPLETED' as const };
  }
}
