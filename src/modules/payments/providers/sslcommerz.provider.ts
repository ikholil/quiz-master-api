import type { Payment } from '@prisma/client';
import { createHash } from 'node:crypto';
import {
  InitiateContext,
  InitiateResult,
  InvalidWebhookError,
  PaymentProvider,
  VerifyResult,
  WebhookEvent,
} from './payment-provider';

const md5 = (s: string) => createHash('md5').update(s).digest('hex');

/**
 * SSLCommerz (Bangladesh) — hosted checkout covering cards, bKash, Nagad, Rocket and internet banking.
 * Flow: session API → redirect to GatewayPageURL → IPN to our webhook (verify_sign checked) → server-side
 * transaction query by tran_id confirms status and amount before fulfilment.
 */
export class SslCommerzProvider implements PaymentProvider {
  readonly name = 'sslcommerz';
  private readonly base: string;

  constructor(
    private readonly storeId: string | undefined,
    private readonly storePassword: string | undefined,
    sandbox: boolean,
  ) {
    this.base = sandbox ? 'https://sandbox.sslcommerz.com' : 'https://securepay.sslcommerz.com';
  }

  isConfigured(): boolean {
    return !!this.storeId && !!this.storePassword;
  }

  async initiate(payment: Payment, ctx: InitiateContext): Promise<InitiateResult> {
    const form = new URLSearchParams({
      store_id: this.storeId!,
      store_passwd: this.storePassword!,
      total_amount: (payment.amountMinor / 100).toFixed(2),
      currency: payment.currency,
      tran_id: payment.merchantTxnId,
      success_url: ctx.successUrl,
      fail_url: ctx.failUrl,
      cancel_url: ctx.cancelUrl,
      ipn_url: ctx.ipnUrl,
      cus_name: ctx.customer.name || 'Student',
      cus_email: ctx.customer.email || 'noreply@example.com',
      cus_phone: ctx.customer.phone || '01700000000',
      cus_add1: 'Bangladesh',
      cus_city: 'Dhaka',
      cus_country: 'Bangladesh',
      shipping_method: 'NO',
      num_of_item: '1',
      product_name: ctx.productName.slice(0, 250),
      product_category: 'Education',
      product_profile: 'non-physical-goods',
      value_a: payment.id,
    });
    const res = await fetch(`${this.base}/gwprocess/v4/api.php`, {
      method: 'POST',
      body: form,
      signal: AbortSignal.timeout(20000),
    });
    const json = (await res.json()) as {
      status: string;
      GatewayPageURL?: string;
      sessionkey?: string;
      failedreason?: string;
    };
    if (json.status !== 'SUCCESS' || !json.GatewayPageURL)
      throw new Error(`SSLCommerz session failed: ${json.failedreason ?? json.status}`);
    return { redirectUrl: json.GatewayPageURL, providerRef: json.sessionkey, raw: { status: json.status } };
  }

  async verify(payment: Payment): Promise<VerifyResult> {
    const qs = new URLSearchParams({
      tran_id: payment.merchantTxnId,
      store_id: this.storeId!,
      store_passwd: this.storePassword!,
      format: 'json',
    });
    const res = await fetch(`${this.base}/validator/api/merchantTransIDvalidationAPI.php?${qs}`, {
      signal: AbortSignal.timeout(20000),
    });
    const json = (await res.json()) as {
      APIConnect: string;
      no_of_trans_found?: number;
      element?: Array<{
        status: string;
        amount: string;
        currency: string;
        val_id: string;
        bank_tran_id: string;
      }>;
    };
    if (json.APIConnect !== 'DONE') throw new Error(`SSLCommerz validation API: ${json.APIConnect}`);
    const el = json.element ?? [];
    const valid = el.find((e) => e.status === 'VALID' || e.status === 'VALIDATED');
    if (valid) {
      return {
        status: 'SUCCEEDED',
        amountMinor: Math.round(Number(valid.amount) * 100),
        currency: valid.currency,
        providerRef: valid.bank_tran_id,
        raw: { val_id: valid.val_id, bank_tran_id: valid.bank_tran_id, status: valid.status },
      };
    }
    if (el.length && el.every((e) => ['FAILED', 'CANCELLED', 'UNATTEMPTED', 'EXPIRED'].includes(e.status)))
      return { status: 'FAILED', raw: { statuses: el.map((e) => e.status) } };
    return { status: 'PENDING' };
  }

  async parseWebhook(
    _headers: Record<string, string | string[] | undefined>,
    _raw: Buffer,
    body: Record<string, unknown>,
  ): Promise<WebhookEvent> {
    const fields = Object.fromEntries(Object.entries(body).map(([k, v]) => [k, String(v ?? '')]));
    const { verify_sign: sign, verify_key: keyList, tran_id: tranId, val_id: valId } = fields;
    if (!sign || !keyList || !tranId) throw new InvalidWebhookError('Missing SSLCommerz signature fields');
    const keys = [...keyList.split(','), 'store_passwd'].sort();
    const data: Record<string, string> = { ...fields, store_passwd: md5(this.storePassword!) };
    const expected = md5(keys.map((k) => `${k}=${data[k] ?? ''}`).join('&'));
    if (expected !== sign) throw new InvalidWebhookError('Invalid SSLCommerz verify_sign');
    return {
      eventId: valId || `${tranId}:${fields.status}`,
      merchantTxnId: tranId,
      raw: { status: fields.status, val_id: valId, amount: fields.amount, card_type: fields.card_type },
    };
  }

  async refund(payment: Payment, amountMinor: number, reason: string) {
    const meta = (payment.metadata ?? {}) as { bank_tran_id?: string };
    if (!meta.bank_tran_id) throw new Error('Missing bank_tran_id for refund');
    const qs = new URLSearchParams({
      bank_tran_id: meta.bank_tran_id,
      refund_amount: (amountMinor / 100).toFixed(2),
      refund_remarks: reason.slice(0, 250),
      store_id: this.storeId!,
      store_passwd: this.storePassword!,
      format: 'json',
    });
    const res = await fetch(`${this.base}/validator/api/merchantTransIDvalidationAPI.php?${qs}`, {
      signal: AbortSignal.timeout(20000),
    });
    const json = (await res.json()) as {
      APIConnect: string;
      status?: string;
      refund_ref_id?: string;
      errorReason?: string;
    };
    if (json.APIConnect !== 'DONE' || !json.refund_ref_id)
      throw new Error(`SSLCommerz refund failed: ${json.errorReason ?? json.status ?? json.APIConnect}`);
    return {
      providerRef: json.refund_ref_id,
      status: json.status === 'success' ? ('COMPLETED' as const) : ('PROCESSING' as const),
    };
  }
}
