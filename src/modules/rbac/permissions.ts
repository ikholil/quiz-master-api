/**
 * Canonical permission catalogue. Permissions are synced into the database at seed/startup;
 * roles are data so administrators can compose new roles without code changes.
 */
export const PERMISSIONS = {
  ADMIN_ACCESS: 'admin.access',

  USERS_READ: 'users.read',
  USERS_MANAGE: 'users.manage',
  ROLES_MANAGE: 'roles.manage',

  CATALOG_MANAGE: 'catalog.manage',
  SYLLABUS_MANAGE: 'syllabus.manage',
  NOTICES_MANAGE: 'notices.manage',

  QUESTIONS_READ: 'questions.read',
  QUESTIONS_CREATE: 'questions.create',
  QUESTIONS_EDIT: 'questions.edit',
  QUESTIONS_REVIEW: 'questions.review',
  QUESTIONS_PUBLISH: 'questions.publish',
  QUESTIONS_IMPORT: 'questions.import',
  QUESTION_REPORTS_MANAGE: 'questions.reports.manage',

  MOCK_EXAMS_MANAGE: 'mock_exams.manage',
  ATTEMPTS_READ: 'attempts.read',
  EVALUATION_MANAGE: 'evaluation.manage',

  MATERIALS_MANAGE: 'materials.manage',
  FLASHCARDS_MANAGE: 'flashcards.manage',
  COURSES_MANAGE: 'courses.manage',

  AI_MANAGE: 'ai.manage',
  KNOWLEDGE_MANAGE: 'knowledge.manage',

  PLANS_MANAGE: 'subscriptions.plans.manage',
  SUBSCRIPTIONS_MANAGE: 'subscriptions.manage',
  PAYMENTS_READ: 'payments.read',
  PAYMENTS_REFUND: 'payments.refund',

  NOTIFICATIONS_SEND: 'notifications.send',
  COMMUNITY_MODERATE: 'community.moderate',
  SUPPORT_MANAGE: 'support.manage',
  ANALYTICS_READ: 'analytics.read',
  AUDIT_READ: 'audit.read',
  SETTINGS_MANAGE: 'settings.manage',
  FILES_MANAGE: 'files.manage',
} as const;

export type PermissionKey = (typeof PERMISSIONS)[keyof typeof PERMISSIONS];

export const ALL_PERMISSIONS: PermissionKey[] = Object.values(PERMISSIONS);

const P = PERMISSIONS;

export const SYSTEM_ROLES: Record<string, { name: string; description: string; permissions: PermissionKey[] }> = {
  SUPER_ADMIN: { name: 'Super administrator', description: 'Full platform access', permissions: ALL_PERMISSIONS },
  ADMIN: {
    name: 'Administrator',
    description: 'Platform operations without role management',
    permissions: ALL_PERMISSIONS.filter((p) => p !== P.ROLES_MANAGE && p !== P.SETTINGS_MANAGE),
  },
  CONTENT_EDITOR: {
    name: 'Content editor',
    description: 'Creates and edits questions, materials and mock examinations',
    permissions: [
      P.ADMIN_ACCESS,
      P.CATALOG_MANAGE,
      P.SYLLABUS_MANAGE,
      P.NOTICES_MANAGE,
      P.QUESTIONS_READ,
      P.QUESTIONS_CREATE,
      P.QUESTIONS_EDIT,
      P.QUESTIONS_IMPORT,
      P.MOCK_EXAMS_MANAGE,
      P.MATERIALS_MANAGE,
      P.FLASHCARDS_MANAGE,
      P.COURSES_MANAGE,
      P.KNOWLEDGE_MANAGE,
      P.FILES_MANAGE,
    ],
  },
  CONTENT_REVIEWER: {
    name: 'Content reviewer',
    description: 'Reviews, approves and publishes content; evaluates written answers',
    permissions: [
      P.ADMIN_ACCESS,
      P.QUESTIONS_READ,
      P.QUESTIONS_REVIEW,
      P.QUESTIONS_PUBLISH,
      P.QUESTION_REPORTS_MANAGE,
      P.EVALUATION_MANAGE,
      P.ATTEMPTS_READ,
      P.KNOWLEDGE_MANAGE,
    ],
  },
  MODERATOR: {
    name: 'Community moderator',
    description: 'Moderates discussions and reports',
    permissions: [P.ADMIN_ACCESS, P.COMMUNITY_MODERATE, P.USERS_READ],
  },
  SUPPORT_AGENT: {
    name: 'Support agent',
    description: 'Handles support tickets',
    permissions: [P.ADMIN_ACCESS, P.SUPPORT_MANAGE, P.USERS_READ, P.PAYMENTS_READ],
  },
  FINANCE: {
    name: 'Finance',
    description: 'Payments, refunds and subscriptions',
    permissions: [P.ADMIN_ACCESS, P.PAYMENTS_READ, P.PAYMENTS_REFUND, P.SUBSCRIPTIONS_MANAGE, P.PLANS_MANAGE, P.ANALYTICS_READ],
  },
  STUDENT: { name: 'Student', description: 'Default learner role', permissions: [] },
};

export const DEFAULT_ROLE = 'STUDENT';
