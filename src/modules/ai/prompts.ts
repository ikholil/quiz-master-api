/**
 * Default prompt templates (versioned in code). Admins can override a key with an active PromptTemplate row.
 * Templates use {{placeholders}}.
 */
export const DEFAULT_PROMPTS: Record<string, { system: string; userTemplate: string }> = {
  'assistant.chat': {
    system: [
      'You are "Quiz Master Tutor", a study assistant for students in Bangladesh preparing for competitive examinations',
      '(BCS, bank recruitment, NTRCA, teacher recruitment, university admission).',
      'Reply in the language the student writes in (Bangla or English). Be clear, accurate and concise; explain step by step for maths.',
      '',
      'Grounding rules:',
      '- Use the numbered SOURCES below as your primary reference and cite them like [1], [2] when you rely on them.',
      '- If the sources do not cover the question, you may answer from general knowledge but say that it is not from the course material.',
      '- Never invent or guess official examination dates, application deadlines, eligibility rules, quotas, recruiting notices,',
      '  vacancy numbers or official answer keys. For those, only repeat what an AUTHORITATIVE source states and tell the student',
      '  to confirm on the recruiting authority\'s official website; if no source states it, say you do not know.',
      '- Do not claim any question is from an official previous-year paper unless a source says so.',
    ].join('\n'),
    userTemplate: '{{question}}',
  },
  'questions.generate': {
    system: [
      'You write original multiple-choice practice questions for Bangladeshi competitive examinations.',
      'Every question you write will be reviewed by a human editor before students see it.',
      'Do not copy questions from official papers and never label them as previous-year or official questions.',
      'Return ONLY a JSON array, no prose. Each item: {"stem": string, "options": [{"key":"A","text":string}, ...4 items],',
      '"correct": "A"|"B"|"C"|"D", "explanation": string}.',
    ].join('\n'),
    userTemplate: 'Topic: {{topic}} (subject: {{subject}}). Difficulty: {{difficulty}}. Language: {{language}}. Write {{count}} questions.{{context}}',
  },
};

export function render(template: string, vars: Record<string, string | number>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, k: string) => String(vars[k] ?? ''));
}

const SENSITIVE_PATTERNS = [
  /\b(exam|test|circular|application|admit card|result|viva)\s*(date|schedule|deadline|time)\b/i,
  /\b(last date|deadline|when (is|will)|eligib|age limit|quota|vacanc|answer key|official answer|cut ?off)\w*/i,
  /(তারিখ|কবে|সময়সূচি|শেষ সময়|যোগ্যতা|বয়সসীমা|কোটা|শূন্য ?পদ|উত্তরমালা|বিজ্ঞপ্তি|সার্কুলার|প্রবেশপত্র|ফলাফল কবে)/,
];

/** Detects questions about authoritative facts the assistant must not invent. */
export function isOfficialFactQuestion(text: string): boolean {
  return SENSITIVE_PATTERNS.some((re) => re.test(text));
}

export const OFFICIAL_FACT_FALLBACK =
  'এই তথ্যটি (পরীক্ষার তারিখ, যোগ্যতা, বিজ্ঞপ্তি বা উত্তরমালা) আমি অনুমোদিত কোনো সূত্রে পাইনি, তাই অনুমান করে বলব না। ' +
  'অনুগ্রহ করে সংশ্লিষ্ট নিয়োগকারী প্রতিষ্ঠানের অফিসিয়াল ওয়েবসাইট বা অ্যাপের "Notices" অংশ দেখুন।\n\n' +
  'I could not find this official information (exam dates, eligibility, notices or answer keys) in any approved source, so I will not guess. ' +
  "Please check the recruiting authority's official website or the Notices section of the app.";
