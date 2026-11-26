// Environment for integration tests: a dedicated database and Redis DB, no background workers or schedulers
// (tests invoke job handlers directly so assertions are deterministic).
process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgresql://quiz:quiz@localhost:5432/quiz_master_test?schema=public';
process.env.REDIS_URL = process.env.TEST_REDIS_URL ?? 'redis://localhost:6379/15';
process.env.WORKERS_ENABLED = 'false';
process.env.SCHEDULERS_ENABLED = 'false';
process.env.LOG_LEVEL = 'error';
process.env.EXPOSE_DEV_OTP = 'true';
process.env.AI_PROVIDERS = 'local';
process.env.RATE_LIMIT_MAX = '10000';
process.env.STORAGE_LOCAL_PATH = './storage-test';
process.env.WEBHOOK_SANDBOX_SECRET = 'test-sandbox-secret';
process.env.PAYMENT_DEFAULT_PROVIDER = 'sandbox';
process.env.OTP_MAX_PER_IP_HOUR = '100000';
process.env.RATE_LIMIT_AUTH_MAX = '100000';
