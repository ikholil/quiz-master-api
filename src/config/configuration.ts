/**
 * Typed, validated application configuration loaded from environment variables.
 * The app refuses to boot in production with missing or insecure secrets.
 */
export interface AppConfig {
  env: 'development' | 'test' | 'production';
  port: number;
  appName: string;
  publicBaseUrl: string;
  corsOrigins: string[];
  trustProxy: boolean;
  logLevel: string;
  workersEnabled: boolean;
  schedulersEnabled: boolean;
  databaseUrl: string;
  redisUrl: string;
  auth: {
    accessSecret: string;
    accessTtlSeconds: number;
    refreshTtlDays: number;
    adminRefreshTtlDays: number;
    otpHmacSecret: string;
    otpTtlSeconds: number;
    otpMaxAttempts: number;
    otpResendCooldownSeconds: number;
    loginMaxFailures: number;
    loginLockMinutes: number;
    passwordLoginEnabled: boolean;
    exposeDevOtp: boolean;
  };
  rateLimit: { ttlSeconds: number; limit: number; authLimit: number };
  storage: {
    driver: 'local' | 's3';
    localPath: string;
    signingSecret: string;
    maxUploadBytes: number;
    s3: { bucket: string; region: string; endpoint?: string; accessKeyId?: string; secretAccessKey?: string; forcePathStyle: boolean };
  };
  ai: {
    providers: string[];
    chatModel: Record<string, string>;
    embeddingProvider: string;
    embeddingModel: string;
    openaiApiKey?: string;
    openaiBaseUrl: string;
    anthropicApiKey?: string;
    anthropicBaseUrl: string;
    requestTimeoutMs: number;
    freeDailyMessages: number;
  };
  payments: {
    defaultProvider: string;
    sandboxWebhookSecret: string;
    sslcommerz: { storeId?: string; storePassword?: string; sandbox: boolean };
    successRedirectUrl: string;
    failRedirectUrl: string;
  };
  notifications: {
    smsProvider: 'console' | 'http';
    smsHttpUrl?: string;
    smsApiKey?: string;
    smsSenderId?: string;
    emailProvider: 'console' | 'smtp';
    smtpUrl?: string;
    emailFrom: string;
    pushProvider: 'console' | 'fcm';
    fcmProjectId?: string;
    fcmClientEmail?: string;
    fcmPrivateKey?: string;
  };
  monitoring: { errorWebhookUrl?: string };
}

function str(name: string, fallback?: string): string {
  const v = process.env[name];
  if (v === undefined || v === '') {
    if (fallback === undefined) throw new Error(`Missing required environment variable ${name}`);
    return fallback;
  }
  return v;
}
function optional(name: string): string | undefined {
  const v = process.env[name];
  return v === undefined || v === '' ? undefined : v;
}
function int(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`Environment variable ${name} must be a number`);
  return n;
}
function bool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(raw.toLowerCase());
}
function list(name: string, fallback: string[]): string[] {
  const raw = process.env[name];
  if (!raw) return fallback;
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

export function loadConfig(): AppConfig {
  const env = (process.env.NODE_ENV ?? 'development') as AppConfig['env'];
  const isProd = env === 'production';
  const devDefault = (v: string) => (isProd ? undefined : v);

  const cfg: AppConfig = {
    env,
    port: int('PORT', 3000),
    appName: str('APP_NAME', 'quiz-master-api'),
    publicBaseUrl: str('PUBLIC_BASE_URL', 'http://localhost:3000'),
    corsOrigins: list('CORS_ORIGINS', isProd ? [] : ['http://localhost:3001', 'http://localhost:3000']),
    trustProxy: bool('TRUST_PROXY', isProd),
    logLevel: str('LOG_LEVEL', isProd ? 'info' : 'debug'),
    workersEnabled: bool('WORKERS_ENABLED', true),
    schedulersEnabled: bool('SCHEDULERS_ENABLED', env !== 'test'),
    databaseUrl: str('DATABASE_URL'),
    redisUrl: str('REDIS_URL', 'redis://localhost:6379/0'),
    auth: {
      accessSecret: str('JWT_ACCESS_SECRET', devDefault('dev-access-secret-change-me-0123456789abcdef')),
      accessTtlSeconds: int('JWT_ACCESS_TTL_SECONDS', 900),
      refreshTtlDays: int('REFRESH_TOKEN_TTL_DAYS', 30),
      adminRefreshTtlDays: int('ADMIN_REFRESH_TOKEN_TTL_DAYS', 1),
      otpHmacSecret: str('OTP_HMAC_SECRET', devDefault('dev-otp-secret-change-me-0123456789abcdef')),
      otpTtlSeconds: int('OTP_TTL_SECONDS', 300),
      otpMaxAttempts: int('OTP_MAX_ATTEMPTS', 5),
      otpResendCooldownSeconds: int('OTP_RESEND_COOLDOWN_SECONDS', 60),
      loginMaxFailures: int('LOGIN_MAX_FAILURES', 5),
      loginLockMinutes: int('LOGIN_LOCK_MINUTES', 15),
      passwordLoginEnabled: bool('PASSWORD_LOGIN_ENABLED', true),
      // Only ever true outside production: returns the OTP in the API response for local testing.
      exposeDevOtp: !isProd && bool('EXPOSE_DEV_OTP', true),
    },
    rateLimit: {
      ttlSeconds: int('RATE_LIMIT_TTL_SECONDS', 60),
      limit: int('RATE_LIMIT_MAX', 120),
      authLimit: int('RATE_LIMIT_AUTH_MAX', 10),
    },
    storage: {
      driver: str('STORAGE_DRIVER', 'local') as 'local' | 's3',
      localPath: str('STORAGE_LOCAL_PATH', './storage'),
      signingSecret: str('STORAGE_SIGNING_SECRET', devDefault('dev-storage-signing-secret-0123456789')),
      maxUploadBytes: int('MAX_UPLOAD_BYTES', 20 * 1024 * 1024),
      s3: {
        bucket: str('S3_BUCKET', 'quiz-master'),
        region: str('S3_REGION', 'ap-southeast-1'),
        endpoint: optional('S3_ENDPOINT'),
        accessKeyId: optional('S3_ACCESS_KEY_ID'),
        secretAccessKey: optional('S3_SECRET_ACCESS_KEY'),
        forcePathStyle: bool('S3_FORCE_PATH_STYLE', false),
      },
    },
    ai: {
      providers: list('AI_PROVIDERS', ['local']),
      chatModel: {
        openai: str('OPENAI_CHAT_MODEL', 'gpt-4o-mini'),
        anthropic: str('ANTHROPIC_CHAT_MODEL', 'claude-opus-5-5'),
        local: 'local-extractive-v1',
      },
      embeddingProvider: str('AI_EMBEDDING_PROVIDER', 'local'),
      embeddingModel: str('AI_EMBEDDING_MODEL', 'text-embedding-3-small'),
      openaiApiKey: optional('OPENAI_API_KEY'),
      openaiBaseUrl: str('OPENAI_BASE_URL', 'https://api.openai.com/v1'),
      anthropicApiKey: optional('ANTHROPIC_API_KEY'),
      anthropicBaseUrl: str('ANTHROPIC_BASE_URL', 'https://api.anthropic.com'),
      requestTimeoutMs: int('AI_REQUEST_TIMEOUT_MS', 30000),
      freeDailyMessages: int('AI_FREE_DAILY_MESSAGES', 10),
    },
    payments: {
      defaultProvider: str('PAYMENT_DEFAULT_PROVIDER', isProd ? 'sslcommerz' : 'sandbox'),
      sandboxWebhookSecret: str('WEBHOOK_SANDBOX_SECRET', devDefault('dev-sandbox-webhook-secret')),
      sslcommerz: {
        storeId: optional('SSLCOMMERZ_STORE_ID'),
        storePassword: optional('SSLCOMMERZ_STORE_PASSWORD'),
        sandbox: bool('SSLCOMMERZ_SANDBOX', !isProd),
      },
      successRedirectUrl: str('PAYMENT_SUCCESS_REDIRECT_URL', 'http://localhost:3001/payments/success'),
      failRedirectUrl: str('PAYMENT_FAIL_REDIRECT_URL', 'http://localhost:3001/payments/failed'),
    },
    notifications: {
      smsProvider: str('SMS_PROVIDER', 'console') as 'console' | 'http',
      smsHttpUrl: optional('SMS_HTTP_URL'),
      smsApiKey: optional('SMS_API_KEY'),
      smsSenderId: optional('SMS_SENDER_ID'),
      emailProvider: str('EMAIL_PROVIDER', 'console') as 'console' | 'smtp',
      smtpUrl: optional('SMTP_URL'),
      emailFrom: str('EMAIL_FROM', 'Quiz Master <no-reply@example.com>'),
      pushProvider: str('PUSH_PROVIDER', 'console') as 'console' | 'fcm',
      fcmProjectId: optional('FCM_PROJECT_ID'),
      fcmClientEmail: optional('FCM_CLIENT_EMAIL'),
      fcmPrivateKey: optional('FCM_PRIVATE_KEY')?.replace(/\\n/g, '\n'),
    },
    monitoring: { errorWebhookUrl: optional('ERROR_WEBHOOK_URL') },
  };

  validateConfig(cfg);
  return cfg;
}

export function validateConfig(cfg: AppConfig): void {
  if (!['development', 'test', 'production'].includes(cfg.env)) {
    throw new Error(`NODE_ENV must be development, test or production (got ${cfg.env})`);
  }
  if (cfg.env === 'production') {
    const secrets: Array<[string, string]> = [
      ['JWT_ACCESS_SECRET', cfg.auth.accessSecret],
      ['OTP_HMAC_SECRET', cfg.auth.otpHmacSecret],
      ['STORAGE_SIGNING_SECRET', cfg.storage.signingSecret],
      ['WEBHOOK_SANDBOX_SECRET', cfg.payments.sandboxWebhookSecret],
    ];
    for (const [name, value] of secrets) {
      if (value.length < 32 || value.startsWith('dev-')) {
        throw new Error(`${name} must be a strong secret (>= 32 chars) in production`);
      }
    }
    if (cfg.corsOrigins.includes('*')) throw new Error('Wildcard CORS origin is not allowed in production');
    if (cfg.payments.defaultProvider === 'sandbox') throw new Error('Sandbox payment provider cannot be default in production');
  }
  if (!['local', 's3'].includes(cfg.storage.driver)) throw new Error('STORAGE_DRIVER must be local or s3');
}

export const APP_CONFIG = 'APP_CONFIG';
