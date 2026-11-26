/** Subject → chapter → topic taxonomy used by the bank (slugs are stable identifiers). */
export const TAXONOMY: Record<
  string,
  {
    name: string;
    nameBn: string;
    chapters: Record<string, { name: string; nameBn?: string; topics: Record<string, string> }>;
  }
> = {
  mathematics: {
    name: 'Mathematics',
    nameBn: 'গণিত',
    chapters: {
      arithmetic: {
        name: 'Arithmetic',
        nameBn: 'পাটিগণিত',
        topics: {
          percentage: 'Percentage',
          'profit-loss': 'Profit and loss',
          interest: 'Simple and compound interest',
          ratio: 'Ratio and proportion',
          average: 'Average',
          'time-speed-distance': 'Time, speed and distance',
          'time-work': 'Time and work',
          'lcm-hcf': 'LCM and HCF',
          'number-system': 'Number system',
          fractions: 'Fractions',
          ages: 'Problems on ages',
          'boats-streams': 'Boats and streams',
          'unit-conversion': 'Units and measurement',
        },
      },
      algebra: {
        name: 'Algebra',
        nameBn: 'বীজগণিত',
        topics: { 'linear-equations': 'Linear equations', powers: 'Squares, cubes and roots' },
      },
      geometry: {
        name: 'Geometry & mensuration',
        nameBn: 'জ্যামিতি ও পরিমিতি',
        topics: { mensuration: 'Area and perimeter', 'clock-angles': 'Clock angles' },
      },
    },
  },
  'mental-ability': {
    name: 'Mental ability',
    nameBn: 'মানসিক দক্ষতা',
    chapters: {
      reasoning: {
        name: 'Reasoning',
        nameBn: 'যুক্তি',
        topics: {
          'number-series': 'Number series',
          'letter-series': 'Letter series',
          'coding-decoding': 'Coding and decoding',
          directions: 'Direction sense',
          calendar: 'Calendar and days',
          ranking: 'Ranking and order',
        },
      },
    },
  },
  english: {
    name: 'English language',
    nameBn: 'ইংরেজি ভাষা',
    chapters: {
      vocabulary: {
        name: 'Vocabulary',
        topics: {
          synonyms: 'Synonyms',
          antonyms: 'Antonyms',
          spelling: 'Spelling',
          'one-word': 'One-word substitution',
          idioms: 'Idioms and phrases',
        },
      },
      grammar: {
        name: 'Grammar',
        topics: {
          'verb-forms': 'Verb forms',
          plurals: 'Plurals',
          comparison: 'Degrees of comparison',
          articles: 'Articles',
        },
      },
    },
  },
  'bangla-language': {
    name: 'Bangla language',
    nameBn: 'বাংলা ভাষা',
    chapters: {
      vocabulary: {
        name: 'Vocabulary',
        nameBn: 'শব্দভান্ডার',
        topics: { 'bn-synonyms': 'সমার্থক শব্দ', 'bn-antonyms': 'বিপরীত শব্দ' },
      },
    },
  },
  'bangla-literature': {
    name: 'Bangla literature',
    nameBn: 'বাংলা সাহিত্য',
    chapters: {
      literature: {
        name: 'Literature',
        nameBn: 'সাহিত্য',
        topics: { 'works-authors': 'গ্রন্থ ও রচয়িতা', 'literary-titles': 'সাহিত্যিক উপাধি ও তথ্য' },
      },
    },
  },
  'bangladesh-affairs': {
    name: 'Bangladesh affairs',
    nameBn: 'বাংলাদেশ বিষয়াবলি',
    chapters: {
      general: {
        name: 'General',
        nameBn: 'সাধারণ',
        topics: {
          'national-symbols': 'National symbols',
          history: 'History and liberation war',
          geography: 'Geography and heritage',
          institutions: 'Institutions',
        },
      },
    },
  },
  'international-affairs': {
    name: 'International affairs',
    nameBn: 'আন্তর্জাতিক বিষয়াবলি',
    chapters: {
      world: {
        name: 'World',
        topics: {
          capitals: 'Capitals',
          currencies: 'Currencies',
          organizations: 'International organizations',
          'world-geography': 'World geography',
          'world-history': 'World history',
        },
      },
    },
  },
  'general-science': {
    name: 'General science',
    nameBn: 'সাধারণ বিজ্ঞান',
    chapters: {
      science: {
        name: 'Science',
        topics: {
          chemistry: 'Elements and chemistry',
          physics: 'Physics and units',
          biology: 'Human body and biology',
          space: 'Space and the solar system',
        },
      },
    },
  },
  ict: {
    name: 'Information & communication technology',
    nameBn: 'তথ্য ও যোগাযোগ প্রযুক্তি',
    chapters: {
      computing: {
        name: 'Computing',
        topics: {
          'number-systems': 'Number systems',
          'logic-gates': 'Logic gates',
          terminology: 'Terminology and acronyms',
          'ict-facts': 'Computing history and facts',
        },
      },
    },
  },
};
