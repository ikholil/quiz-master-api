/** Feature keys used for backend entitlement checks. Plans map to these via PlanFeature rows. */
export const FEATURES = {
  /** Premium mock examinations. */
  MOCK_PREMIUM: 'mock.premium',
  /** Practice question quota (limitValue = questions/day; null = unlimited). */
  PRACTICE_QUESTIONS: 'practice.questions',
  /** AI assistant messages/day (null = unlimited). */
  AI_ASSISTANT: 'ai.assistant',
  /** Premium learning materials. */
  MATERIALS_PREMIUM: 'materials.premium',
  /** Advanced analytics (percentile, comparisons). */
  ANALYTICS_ADVANCED: 'analytics.advanced',
  /** Knowledge sources marked ENTITLED. */
  KNOWLEDGE_PREMIUM: 'knowledge.premium',
} as const;

export type FeatureKey = (typeof FEATURES)[keyof typeof FEATURES];
export const ALL_FEATURES = Object.values(FEATURES) as string[];
