import { Inject, Injectable, Logger } from '@nestjs/common';
import { createSign } from 'node:crypto';
import nodemailer, { Transporter } from 'nodemailer';
import { APP_CONFIG, AppConfig } from '../../config/configuration';
import { maskIdentifier } from '../../common/utils/phone.util';

/**
 * Delivery provider abstractions. "console" providers log a masked line (development);
 * real providers are selected by configuration without code changes.
 */
export interface SmsSender {
  send(phoneE164: string, text: string): Promise<void>;
}
export interface EmailSender {
  send(to: string, subject: string, text: string, html?: string): Promise<void>;
}
export interface PushSender {
  /** Returns tokens the provider reported as invalid (to be deleted). */
  send(tokens: string[], title: string, body: string, data?: Record<string, string>): Promise<{ invalidTokens: string[] }>;
}

export const SMS_SENDER = 'SMS_SENDER';
export const EMAIL_SENDER = 'EMAIL_SENDER';
export const PUSH_SENDER = 'PUSH_SENDER';

@Injectable()
export class ConsoleSmsSender implements SmsSender {
  private readonly logger = new Logger('SMS');
  async send(phone: string, text: string): Promise<void> {
    // Never log the OTP itself outside development.
    const safe = process.env.NODE_ENV === 'development' ? text : text.replace(/\d{4,}/g, '******');
    this.logger.log(`→ ${maskIdentifier(phone)}: ${safe}`);
  }
}

/**
 * Generic HTTP SMS gateway (most Bangladeshi bulk SMS providers expose an HTTP API taking api_key,
 * sender id, recipient and message). Configure SMS_HTTP_URL / SMS_API_KEY / SMS_SENDER_ID.
 */
export class HttpSmsSender implements SmsSender {
  constructor(
    private readonly url: string,
    private readonly apiKey: string,
    private readonly senderId: string | undefined,
    private readonly timeoutMs = 10000,
  ) {}
  async send(phone: string, text: string): Promise<void> {
    const res = await fetch(this.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${this.apiKey}` },
      body: JSON.stringify({ api_key: this.apiKey, senderid: this.senderId, number: phone.replace('+', ''), message: text }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!res.ok) throw new Error(`SMS gateway responded ${res.status}`);
  }
}

@Injectable()
export class ConsoleEmailSender implements EmailSender {
  private readonly logger = new Logger('Email');
  async send(to: string, subject: string, text: string): Promise<void> {
    const safe = process.env.NODE_ENV === 'development' ? text : text.replace(/\d{4,}/g, '******');
    this.logger.log(`→ ${maskIdentifier(to)} [${subject}] ${safe.slice(0, 200)}`);
  }
}

export class SmtpEmailSender implements EmailSender {
  private readonly transport: Transporter;
  constructor(
    smtpUrl: string,
    private readonly from: string,
  ) {
    this.transport = nodemailer.createTransport(smtpUrl);
  }
  async send(to: string, subject: string, text: string, html?: string): Promise<void> {
    await this.transport.sendMail({ from: this.from, to, subject, text, html });
  }
}

@Injectable()
export class ConsolePushSender implements PushSender {
  private readonly logger = new Logger('Push');
  async send(tokens: string[], title: string): Promise<{ invalidTokens: string[] }> {
    this.logger.log(`→ ${tokens.length} device(s): ${title}`);
    return { invalidTokens: [] };
  }
}

/** Firebase Cloud Messaging HTTP v1 using a service account (OAuth2 JWT bearer flow, no SDK dependency). */
export class FcmPushSender implements PushSender {
  private accessToken?: { value: string; expiresAt: number };
  private readonly logger = new Logger('FCM');

  constructor(
    private readonly projectId: string,
    private readonly clientEmail: string,
    private readonly privateKey: string,
  ) {}

  private async token(): Promise<string> {
    if (this.accessToken && this.accessToken.expiresAt > Date.now() + 60_000) return this.accessToken.value;
    const now = Math.floor(Date.now() / 1000);
    const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
    const claims = Buffer.from(
      JSON.stringify({
        iss: this.clientEmail,
        scope: 'https://www.googleapis.com/auth/firebase.messaging',
        aud: 'https://oauth2.googleapis.com/token',
        iat: now,
        exp: now + 3600,
      }),
    ).toString('base64url');
    const signer = createSign('RSA-SHA256');
    signer.update(`${header}.${claims}`);
    const assertion = `${header}.${claims}.${signer.sign(this.privateKey).toString('base64url')}`;
    const res = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }),
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) throw new Error(`FCM auth failed: ${res.status}`);
    const json = (await res.json()) as { access_token: string; expires_in: number };
    this.accessToken = { value: json.access_token, expiresAt: Date.now() + json.expires_in * 1000 };
    return json.access_token;
  }

  async send(tokens: string[], title: string, body: string, data?: Record<string, string>): Promise<{ invalidTokens: string[] }> {
    const bearer = await this.token();
    const invalidTokens: string[] = [];
    await Promise.all(
      tokens.map(async (token) => {
        const res = await fetch(`https://fcm.googleapis.com/v1/projects/${this.projectId}/messages:send`, {
          method: 'POST',
          headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
          body: JSON.stringify({ message: { token, notification: { title, body }, data, android: { priority: 'high' } } }),
          signal: AbortSignal.timeout(10000),
        });
        if (res.status === 404 || res.status === 400) invalidTokens.push(token);
        else if (!res.ok) this.logger.warn(`FCM send failed: ${res.status}`);
      }),
    );
    return { invalidTokens };
  }
}

export const deliveryProviders = [
  {
    provide: SMS_SENDER,
    inject: [APP_CONFIG],
    useFactory: (cfg: AppConfig): SmsSender => {
      const n = cfg.notifications;
      if (n.smsProvider === 'http') {
        if (!n.smsHttpUrl || !n.smsApiKey) throw new Error('SMS_HTTP_URL and SMS_API_KEY are required for SMS_PROVIDER=http');
        return new HttpSmsSender(n.smsHttpUrl, n.smsApiKey, n.smsSenderId);
      }
      return new ConsoleSmsSender();
    },
  },
  {
    provide: EMAIL_SENDER,
    inject: [APP_CONFIG],
    useFactory: (cfg: AppConfig): EmailSender => {
      const n = cfg.notifications;
      if (n.emailProvider === 'smtp') {
        if (!n.smtpUrl) throw new Error('SMTP_URL is required for EMAIL_PROVIDER=smtp');
        return new SmtpEmailSender(n.smtpUrl, n.emailFrom);
      }
      return new ConsoleEmailSender();
    },
  },
  {
    provide: PUSH_SENDER,
    inject: [APP_CONFIG],
    useFactory: (cfg: AppConfig): PushSender => {
      const n = cfg.notifications;
      if (n.pushProvider === 'fcm') {
        if (!n.fcmProjectId || !n.fcmClientEmail || !n.fcmPrivateKey) throw new Error('FCM_PROJECT_ID, FCM_CLIENT_EMAIL, FCM_PRIVATE_KEY are required');
        return new FcmPushSender(n.fcmProjectId, n.fcmClientEmail, n.fcmPrivateKey);
      }
      return new ConsolePushSender();
    },
  },
];

export { Inject };
