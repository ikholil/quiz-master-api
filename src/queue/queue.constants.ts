export const QUEUES = {
  MESSAGING: 'messaging', // OTP / SMS / email delivery
  NOTIFICATIONS: 'notifications',
  KNOWLEDGE: 'knowledge-indexing',
  QUESTION_IMPORT: 'question-import',
  AI: 'ai',
  LEARNING: 'learning',
  ANALYTICS: 'analytics',
  PAYMENTS: 'payments',
  ATTEMPTS: 'attempts',
  MAINTENANCE: 'maintenance',
} as const;

export type QueueName = (typeof QUEUES)[keyof typeof QUEUES];

export const JOBS = {
  SEND_OTP: 'send-otp',
  SEND_EMAIL: 'send-email',
  DELIVER_NOTIFICATION: 'deliver-notification',
  BROADCAST_NOTIFICATION: 'broadcast-notification',
  INDEX_SOURCE: 'index-source',
  IMPORT_QUESTIONS: 'import-questions',
  AI_REPLY: 'ai-reply',
  UPDATE_MASTERY: 'update-mastery',
  GENERATE_DAILY_PLANS: 'generate-daily-plans',
  REVISION_REMINDERS: 'revision-reminders',
  AGGREGATE_DAILY: 'aggregate-daily',
  RECONCILE_PAYMENTS: 'reconcile-payments',
  PROCESS_WEBHOOK: 'process-webhook',
  AUTO_SUBMIT_ATTEMPT: 'auto-submit-attempt',
  SWEEP_EXPIRED_ATTEMPTS: 'sweep-expired-attempts',
  EXPIRE_SUBSCRIPTIONS: 'expire-subscriptions',
  RENEWAL_REMINDERS: 'renewal-reminders',
  DATA_EXPORT: 'data-export',
  CLEANUP: 'cleanup',
} as const;

export const DEFAULT_JOB_OPTIONS = {
  attempts: 5,
  backoff: { type: 'exponential' as const, delay: 2000 },
  removeOnComplete: { age: 24 * 3600, count: 1000 },
  removeOnFail: { age: 7 * 24 * 3600 },
};

/** Processors are only registered when WORKERS_ENABLED is not "false" (allows API-only / worker-only deployments). */
export function workers<T>(...providers: T[]): T[] {
  const flag = (process.env.WORKERS_ENABLED ?? 'true').toLowerCase();
  return flag === 'false' || flag === '0' ? [] : providers;
}
