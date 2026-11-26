import type { Payment } from '@prisma/client';

export interface InitiateContext {
  customer: { name: string; email?: string | null; phone?: string | null };
  productName: string;
  successUrl: string;
  failUrl: string;
  cancelUrl: string;
  ipnUrl: string;
}

export interface InitiateResult {
  redirectUrl: string;
  providerRef?: string;
  raw?: Record<string, unknown>;
}

export type VerifiedStatus = 'SUCCEEDED' | 'FAILED' | 'PENDING';

export interface VerifyResult {
  status: VerifiedStatus;
  amountMinor?: number;
  currency?: string;
  providerRef?: string;
  raw?: Record<string, unknown>;
}

export interface WebhookEvent {
  /** Provider-unique delivery identifier used for idempotency. */
  eventId: string;
  merchantTxnId: string;
  raw: Record<string, unknown>;
}

/**
 * Payment provider abstraction. Bangladeshi gateways (SSLCommerz, bKash, Nagad, …) and international
 * providers implement the same contract. Webhooks are only *notifications*: the payment status is always
 * confirmed with a server-to-server `verify` call before access is granted.
 */
export interface PaymentProvider {
  readonly name: string;
  isConfigured(): boolean;
  initiate(payment: Payment, ctx: InitiateContext): Promise<InitiateResult>;
  verify(payment: Payment): Promise<VerifyResult>;
  /** Validates authenticity (signature) and extracts the event. Throws on invalid signatures. */
  parseWebhook(headers: Record<string, string | string[] | undefined>, rawBody: Buffer, body: Record<string, unknown>): Promise<WebhookEvent>;
  refund?(payment: Payment, amountMinor: number, reason: string): Promise<{ providerRef: string; status: 'COMPLETED' | 'PROCESSING' }>;
}

export class InvalidWebhookError extends Error {}

/** Strips anything secret-looking before payloads are stored. */
export function sanitizePayload(obj: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(obj).filter(([k]) => !/pass|secret|token|key|sign/i.test(k)));
}
