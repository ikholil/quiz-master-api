import { BankQuestion, Diff, ALL_EXAMS, pick, q } from '../types';

type Out = BankQuestion[];

// Semantically distinct headwords so that distractors drawn from other rows are never correct.
const SYNONYMS: Array<[string, string]> = [
  ['abundant', 'plentiful'],
  ['brave', 'courageous'],
  ['ancient', 'old'],
  ['begin', 'commence'],
  ['candid', 'frank'],
  ['diligent', 'hard-working'],
  ['eminent', 'famous'],
  ['fragile', 'delicate'],
  ['generous', 'liberal'],
  ['hostile', 'unfriendly'],
  ['immense', 'huge'],
  ['jubilant', 'joyful'],
  ['lethargic', 'sluggish'],
  ['novice', 'beginner'],
  ['obstinate', 'stubborn'],
  ['prudent', 'wise'],
  ['quarrel', 'dispute'],
  ['rapid', 'fast'],
  ['scarce', 'rare'],
  ['tranquil', 'calm'],
  ['vacant', 'empty'],
  ['wealthy', 'rich'],
  ['zeal', 'enthusiasm'],
  ['conceal', 'hide'],
  ['dwell', 'reside'],
  ['gloomy', 'dismal'],
  ['hazard', 'danger'],
  ['inquire', 'ask'],
  ['lucid', 'clear'],
  ['mend', 'repair'],
  ['obey', 'comply'],
  ['rigid', 'stiff'],
  ['summit', 'peak'],
  ['terminate', 'end'],
  ['vanish', 'disappear'],
  ['wicked', 'evil'],
  ['assist', 'help'],
  ['comprehend', 'understand'],
  ['eradicate', 'eliminate'],
  ['frugal', 'thrifty'],
  ['vigilant', 'watchful'],
];

const ANTONYMS: Array<[string, string]> = [
  ['ancient', 'modern'],
  ['brave', 'cowardly'],
  ['accept', 'reject'],
  ['ascend', 'descend'],
  ['abundant', 'scarce'],
  ['artificial', 'natural'],
  ['benevolent', 'malevolent'],
  ['cheap', 'expensive'],
  ['confess', 'deny'],
  ['victory', 'defeat'],
  ['expand', 'contract'],
  ['friend', 'foe'],
  ['generous', 'stingy'],
  ['humble', 'arrogant'],
  ['import', 'export'],
  ['include', 'exclude'],
  ['increase', 'decrease'],
  ['innocent', 'guilty'],
  ['maximum', 'minimum'],
  ['optimist', 'pessimist'],
  ['permanent', 'temporary'],
  ['praise', 'criticise'],
  ['private', 'public'],
  ['rigid', 'flexible'],
  ['shallow', 'deep'],
  ['superior', 'inferior'],
  ['transparent', 'opaque'],
  ['visible', 'invisible'],
  ['wisdom', 'folly'],
  ['zenith', 'nadir'],
  ['attack', 'defend'],
  ['lend', 'borrow'],
  ['major', 'minor'],
  ['punctual', 'late'],
  ['rude', 'polite'],
  ['sharp', 'blunt'],
  ['strong', 'weak'],
  ['wet', 'dry'],
  ['rural', 'urban'],
  ['heavy', 'light'],
  ['entrance', 'exit'],
];

const ONE_WORD: Array<[string, string]> = [
  ['A person who knows many languages', 'polyglot'],
  ['A person who does not believe in God', 'atheist'],
  ['One who is present everywhere', 'omnipresent'],
  ['One who knows everything', 'omniscient'],
  ['A life history written by oneself', 'autobiography'],
  ['A life history written by someone else', 'biography'],
  ['A speech made without preparation', 'extempore'],
  ['That which cannot be read', 'illegible'],
  ['That which cannot be avoided', 'inevitable'],
  ['One who eats only vegetables', 'vegetarian'],
  ['A place where birds are kept', 'aviary'],
  ['A place where bees are kept', 'apiary'],
  ['A list of books', 'catalogue'],
  ['Fear of water', 'hydrophobia'],
  ['A person who loves mankind', 'philanthropist'],
  ['A person who hates mankind', 'misanthrope'],
  ['Murder of a king', 'regicide'],
  ['Government by the people', 'democracy'],
  ['Rule by one person with absolute power', 'autocracy'],
  ['A medicine that counteracts poison', 'antidote'],
  ['One who walks in sleep', 'somnambulist'],
  ['A word opposite in meaning', 'antonym'],
  ['A word having the same meaning', 'synonym'],
  ['Animals that eat flesh', 'carnivorous'],
  ['Animals that eat plants', 'herbivorous'],
  ['A cure for all diseases', 'panacea'],
  ['One who is new to a profession', 'novice'],
  ['Study of ancient things', 'archaeology'],
  ['Study of the stars and planets', 'astronomy'],
  ['A period of ten years', 'decade'],
  ['A period of a hundred years', 'century'],
  ['A period of a thousand years', 'millennium'],
  ['Handwriting that is beautiful', 'calligraphy'],
  ['One who travels on foot', 'pedestrian'],
];

const IDIOMS: Array<[string, string]> = [
  ['Break the ice', 'start a conversation in an awkward situation'],
  ['A piece of cake', 'something very easy'],
  ['Once in a blue moon', 'very rarely'],
  ['Spill the beans', 'reveal a secret'],
  ['Hit the nail on the head', 'describe something exactly right'],
  ['Under the weather', 'feeling ill'],
  ['Cost an arm and a leg', 'be very expensive'],
  ['Let the cat out of the bag', 'disclose a secret by mistake'],
  ['Burn the midnight oil', 'work late into the night'],
  ['Bite the bullet', 'face a difficult situation bravely'],
  ['A bolt from the blue', 'a complete surprise'],
  ['Call it a day', 'stop working for the day'],
  ['In hot water', 'in trouble'],
  ['Keep one’s fingers crossed', 'hope for good luck'],
  ['At the eleventh hour', 'at the last possible moment'],
  ['A white elephant', 'a costly but useless possession'],
  ['Turn over a new leaf', 'change one’s behaviour for the better'],
  ['Beat around the bush', 'avoid coming to the point'],
  ['By hook or by crook', 'by any means, fair or unfair'],
  ['To cry over spilt milk', 'regret what cannot be undone'],
  ['A blessing in disguise', 'something good that seemed bad at first'],
  ['Get cold feet', 'become nervous before something important'],
  ['Through thick and thin', 'in good times and bad'],
  ['To be all ears', 'to listen eagerly'],
];

const SPELLINGS = [
  'accommodation',
  'achievement',
  'address',
  'beginning',
  'believe',
  'business',
  'calendar',
  'committee',
  'conscience',
  'definitely',
  'embarrass',
  'environment',
  'existence',
  'February',
  'government',
  'grammar',
  'guarantee',
  'harass',
  'immediately',
  'independent',
  'knowledge',
  'maintenance',
  'millennium',
  'necessary',
  'occasion',
  'occurrence',
  'parliament',
  'privilege',
  'questionnaire',
  'receive',
  'recommend',
  'rhythm',
  'separate',
  'successful',
  'surprise',
  'tomorrow',
  'unnecessary',
  'vacuum',
  'Wednesday',
  'withhold',
];

function misspellings(w: string): string[] {
  const out = new Set<string>();
  // double ↔ single letters
  for (let i = 0; i < w.length - 1; i++) if (w[i] === w[i + 1]) out.add(w.slice(0, i) + w.slice(i + 1));
  for (let i = 1; i < w.length - 1; i++)
    if (w[i] !== w[i + 1] && w[i] !== w[i - 1] && 'cmnlstr'.includes(w[i]))
      out.add(w.slice(0, i) + w[i] + w.slice(i));
  out.add(w.replace('ie', 'ei').replace('ei', 'ie'));
  out.add(w.replace(/e(?=[^e]*$)/, 'a'));
  out.add(w.replace('a', 'e'));
  out.add(w.replace('ence', 'ance'));
  out.add(w.replace('ar', 'er'));
  out.delete(w);
  return [...out].filter((x) => x.length > 3);
}

const VERBS: Array<[string, string, string]> = [
  ['go', 'went', 'gone'],
  ['see', 'saw', 'seen'],
  ['write', 'wrote', 'written'],
  ['take', 'took', 'taken'],
  ['begin', 'began', 'begun'],
  ['break', 'broke', 'broken'],
  ['choose', 'chose', 'chosen'],
  ['drink', 'drank', 'drunk'],
  ['drive', 'drove', 'driven'],
  ['eat', 'ate', 'eaten'],
  ['fall', 'fell', 'fallen'],
  ['fly', 'flew', 'flown'],
  ['forget', 'forgot', 'forgotten'],
  ['give', 'gave', 'given'],
  ['know', 'knew', 'known'],
  ['ride', 'rode', 'ridden'],
  ['ring', 'rang', 'rung'],
  ['rise', 'rose', 'risen'],
  ['sing', 'sang', 'sung'],
  ['speak', 'spoke', 'spoken'],
  ['steal', 'stole', 'stolen'],
  ['swim', 'swam', 'swum'],
  ['throw', 'threw', 'thrown'],
  ['wear', 'wore', 'worn'],
  ['teach', 'taught', 'taught'],
  ['catch', 'caught', 'caught'],
  ['buy', 'bought', 'bought'],
  ['think', 'thought', 'thought'],
  ['bring', 'brought', 'brought'],
  ['lie (recline)', 'lay', 'lain'],
];

const PLURALS: Array<[string, string, string[]]> = [
  ['child', 'children', ['childs', 'childrens', 'childes']],
  ['ox', 'oxen', ['oxes', 'oxs', 'oxens']],
  ['mouse', 'mice', ['mouses', 'mices', 'mousen']],
  ['crisis', 'crises', ['crisises', 'crisis', 'crisies']],
  ['phenomenon', 'phenomena', ['phenomenons', 'phenomenas', 'phenomenae']],
  ['criterion', 'criteria', ['criterions', 'criterias', 'criterium']],
  ['analysis', 'analyses', ['analysises', 'analysis', 'analysies']],
  ['tooth', 'teeth', ['tooths', 'teeths', 'toothes']],
  ['foot', 'feet', ['foots', 'feets', 'footes']],
  ['woman', 'women', ['womans', 'womens', 'womanes']],
  ['knife', 'knives', ['knifes', 'knive', 'knifs']],
  ['leaf', 'leaves', ['leafs', 'leafes', 'leave']],
  ['sheep', 'sheep', ['sheeps', 'sheepes', 'shoop']],
  ['radius', 'radii', ['radiuses', 'radiusi', 'radies']],
  ['curriculum', 'curricula', ['curriculums', 'curriculas', 'curriculi']],
  ['thesis', 'theses', ['thesises', 'thesis', 'thesies']],
  ['goose', 'geese', ['gooses', 'geeses', 'goosen']],
  ['potato', 'potatoes', ['potatos', 'potatoies', 'potatoss']],
];

const COMPARISON: Array<[string, string, string]> = [
  ['good', 'better', 'best'],
  ['bad', 'worse', 'worst'],
  ['many', 'more', 'most'],
  ['little', 'less', 'least'],
  ['far', 'farther', 'farthest'],
  ['big', 'bigger', 'biggest'],
  ['happy', 'happier', 'happiest'],
  ['hot', 'hotter', 'hottest'],
  ['beautiful', 'more beautiful', 'most beautiful'],
  ['thin', 'thinner', 'thinnest'],
];

const ARTICLES: Array<[string, string]> = [
  ['He is ___ honest man.', 'an'],
  ['She is ___ university teacher.', 'a'],
  ['I waited for ___ hour.', 'an'],
  ['It was ___ one-day match.', 'a'],
  ['He is ___ MBA.', 'an'],
  ['She bought ___ umbrella.', 'an'],
  ['This is ___ European city.', 'a'],
  ['He gave me ___ apple.', 'an'],
  ['___ sun rises in the east.', 'The'],
  ['He is ___ honourable person.', 'an'],
  ['She wants to be ___ engineer.', 'an'],
  ['It is ___ useful book.', 'a'],
];

const E = (
  topic: string,
  chapter: string,
  key: string,
  d: Diff,
  stem: string,
  ans: string,
  ds: string[],
  ex: string,
) =>
  q({
    key: `english:${topic}:${key}`,
    subject: 'english',
    chapter,
    topic,
    difficulty: d,
    stem,
    answer: ans,
    distractors: ds,
    explanation: ex,
    exams: ALL_EXAMS,
  });

export function english(): Out {
  const out: Out = [];
  SYNONYMS.forEach(([w, s]) =>
    out.push(
      E(
        'synonyms',
        'vocabulary',
        w,
        w.length > 7 ? 'MEDIUM' : 'EASY',
        `Choose the word closest in meaning to "${w}".`,
        s,
        pick(
          SYNONYMS.map((x) => x[1]),
          3,
          `syn-${w}`,
          (x) => x === s,
        ),
        `"${w}" means ${s}.`,
      ),
    ),
  );
  ANTONYMS.forEach(([w, a]) =>
    out.push(
      E(
        'antonyms',
        'vocabulary',
        w,
        w.length > 7 ? 'MEDIUM' : 'EASY',
        `Choose the word opposite in meaning to "${w}".`,
        a,
        pick(
          ANTONYMS.map((x) => x[1]),
          3,
          `ant-${w}`,
          (x) => x === a,
        ),
        `The opposite of "${w}" is "${a}".`,
      ),
    ),
  );
  ONE_WORD.forEach(([p, w]) =>
    out.push(
      E(
        'one-word',
        'vocabulary',
        w,
        'MEDIUM',
        `One word for: "${p}"`,
        w,
        pick(
          ONE_WORD.map((x) => x[1]),
          3,
          `ow-${w}`,
          (x) => x === w,
        ),
        `${p} = ${w}.`,
      ),
    ),
  );
  IDIOMS.forEach(([i, m]) =>
    out.push(
      E(
        'idioms',
        'vocabulary',
        i,
        'MEDIUM',
        `What does the idiom "${i}" mean?`,
        m,
        pick(
          IDIOMS.map((x) => x[1]),
          3,
          `id-${i}`,
          (x) => x === m,
        ),
        `"${i}" means to ${m.replace(/^to /, '')}.`,
      ),
    ),
  );
  SPELLINGS.forEach((w) => {
    const wrong = misspellings(w).slice(0, 3);
    if (wrong.length === 3)
      out.push(
        E(
          'spelling',
          'vocabulary',
          w,
          'MEDIUM',
          'Choose the correctly spelt word.',
          w,
          wrong,
          `The correct spelling is "${w}".`,
        ),
      );
  });
  VERBS.forEach(([b, p, pp]) => {
    out.push(
      E(
        'verb-forms',
        'grammar',
        `past-${b}`,
        'EASY',
        `What is the past tense of "${b.replace(' (recline)', '')}"${b.includes('(') ? ' (meaning to recline)' : ''}?`,
        p,
        [pp === p ? `${b.split(' ')[0]}ed` : pp, `${b.split(' ')[0]}ed`, `${b.split(' ')[0]}s`, `${p}ed`],
        `${b} – ${p} – ${pp}.`,
      ),
    );
    if (pp !== p)
      out.push(
        E(
          'verb-forms',
          'grammar',
          `pp-${b}`,
          'MEDIUM',
          `Choose the past participle of "${b.replace(' (recline)', '')}"${b.includes('(') ? ' (meaning to recline)' : ''}.`,
          pp,
          [p, `${b.split(' ')[0]}ed`, `${b.split(' ')[0]}en`].filter((x) => x !== pp).concat([`${p}en`]),
          `${b} – ${p} – ${pp}.`,
        ),
      );
  });
  PLURALS.forEach(([s, p, ds]) =>
    out.push(
      E(
        'plurals',
        'grammar',
        s,
        'MEDIUM',
        `What is the plural of "${s}"?`,
        p,
        ds,
        `The plural of "${s}" is "${p}".`,
      ),
    ),
  );
  COMPARISON.forEach(([pos, comp, sup]) => {
    out.push(
      E(
        'comparison',
        'grammar',
        `sup-${pos}`,
        'EASY',
        `What is the superlative degree of "${pos}"?`,
        sup,
        [comp, `${pos}est`, `${pos}er`, `most ${pos}er`].filter((x) => x !== sup),
        `${pos} – ${comp} – ${sup}.`,
      ),
    );
    out.push(
      E(
        'comparison',
        'grammar',
        `comp-${pos}`,
        'EASY',
        `What is the comparative degree of "${pos}"?`,
        comp,
        [sup, `${pos}er`, `more ${pos}er`, `${pos}est`].filter((x) => x !== comp),
        `${pos} – ${comp} – ${sup}.`,
      ),
    );
  });
  ARTICLES.forEach(([s, a], i) =>
    out.push(
      E(
        'articles',
        'grammar',
        `art-${i}`,
        'EASY',
        `Fill in the blank: ${s}`,
        a,
        ['a', 'an', 'the', 'no article']
          .map((x) => (a === 'The' && x === 'the' ? 'The' : x))
          .filter((x) => x.toLowerCase() !== a.toLowerCase()),
        a.toLowerCase() === 'the'
          ? 'Unique objects take "the".'
          : `"${a}" is used because the next word begins with a ${a === 'an' ? 'vowel' : 'consonant'} sound.`,
      ),
    ),
  );
  return out;
}

// ───────────────────────── Bangla ─────────────────────────

const BN_SYNONYMS: Array<[string, string]> = [
  ['সূর্য', 'রবি'],
  ['চাঁদ', 'শশী'],
  ['জল', 'বারি'],
  ['আকাশ', 'গগন'],
  ['পৃথিবী', 'বসুন্ধরা'],
  ['পর্বত', 'অচল'],
  ['সমুদ্র', 'সাগর'],
  ['বাতাস', 'পবন'],
  ['আগুন', 'অনল'],
  ['রাত', 'রজনী'],
  ['দিন', 'দিবস'],
  ['মেঘ', 'জলদ'],
  ['ফুল', 'পুষ্প'],
  ['পাখি', 'বিহঙ্গ'],
  ['নদী', 'তটিনী'],
  ['গাছ', 'বৃক্ষ'],
  ['চোখ', 'নয়ন'],
  ['হাত', 'কর'],
  ['মা', 'জননী'],
  ['বন', 'অরণ্য'],
  ['সোনা', 'স্বর্ণ'],
  ['ঘর', 'গৃহ'],
  ['বিদ্যুৎ', 'তড়িৎ'],
  ['শরীর', 'দেহ'],
];

const BN_ANTONYMS: Array<[string, string]> = [
  ['আলো', 'অন্ধকার'],
  ['ধনী', 'দরিদ্র'],
  ['জন্ম', 'মৃত্যু'],
  ['সত্য', 'মিথ্যা'],
  ['উন্নতি', 'অবনতি'],
  ['আদি', 'অন্ত'],
  ['শীত', 'গ্রীষ্ম'],
  ['জয়', 'পরাজয়'],
  ['সুখ', 'দুঃখ'],
  ['আয়', 'ব্যয়'],
  ['উত্থান', 'পতন'],
  ['শত্রু', 'মিত্র'],
  ['দিন', 'রাত'],
  ['আশা', 'নিরাশা'],
  ['সরল', 'জটিল'],
  ['প্রাচীন', 'আধুনিক'],
  ['স্বাধীন', 'পরাধীন'],
  ['উদয়', 'অস্ত'],
  ['ক্রয়', 'বিক্রয়'],
  ['আকাশ', 'পাতাল'],
  ['গ্রহণ', 'বর্জন'],
  ['উত্তম', 'অধম'],
  ['নতুন', 'পুরাতন'],
  ['সবল', 'দুর্বল'],
  ['শুভ', 'অশুভ'],
  ['আস্তিক', 'নাস্তিক'],
  ['কৃতজ্ঞ', 'কৃতঘ্ন'],
  ['সাকার', 'নিরাকার'],
  ['জীবিত', 'মৃত'],
  ['মিলন', 'বিরহ'],
];

// Work → author (well-documented attributions only).
const WORKS: Array<[string, string]> = [
  ['গীতাঞ্জলি', 'রবীন্দ্রনাথ ঠাকুর'],
  ['গোরা', 'রবীন্দ্রনাথ ঠাকুর'],
  ['শেষের কবিতা', 'রবীন্দ্রনাথ ঠাকুর'],
  ['সোনার তরী', 'রবীন্দ্রনাথ ঠাকুর'],
  ['চোখের বালি', 'রবীন্দ্রনাথ ঠাকুর'],
  ['অগ্নিবীণা', 'কাজী নজরুল ইসলাম'],
  ['ব্যথার দান', 'কাজী নজরুল ইসলাম'],
  ['বিষের বাঁশী', 'কাজী নজরুল ইসলাম'],
  ['মৃত্যুক্ষুধা', 'কাজী নজরুল ইসলাম'],
  ['পথের পাঁচালী', 'বিভূতিভূষণ বন্দ্যোপাধ্যায়'],
  ['আরণ্যক', 'বিভূতিভূষণ বন্দ্যোপাধ্যায়'],
  ['দেবদাস', 'শরৎচন্দ্র চট্টোপাধ্যায়'],
  ['শ্রীকান্ত', 'শরৎচন্দ্র চট্টোপাধ্যায়'],
  ['গৃহদাহ', 'শরৎচন্দ্র চট্টোপাধ্যায়'],
  ['লালসালু', 'সৈয়দ ওয়ালীউল্লাহ'],
  ['চাঁদের অমাবস্যা', 'সৈয়দ ওয়ালীউল্লাহ'],
  ['কাঁদো নদী কাঁদো', 'সৈয়দ ওয়ালীউল্লাহ'],
  ['মেঘনাদবধ কাব্য', 'মাইকেল মধুসূদন দত্ত'],
  ['বুড়ো শালিকের ঘাড়ে রোঁ', 'মাইকেল মধুসূদন দত্ত'],
  ['আনন্দমঠ', 'বঙ্কিমচন্দ্র চট্টোপাধ্যায়'],
  ['কপালকুণ্ডলা', 'বঙ্কিমচন্দ্র চট্টোপাধ্যায়'],
  ['দুর্গেশনন্দিনী', 'বঙ্কিমচন্দ্র চট্টোপাধ্যায়'],
  ['পদ্মানদীর মাঝি', 'মানিক বন্দ্যোপাধ্যায়'],
  ['পুতুলনাচের ইতিকথা', 'মানিক বন্দ্যোপাধ্যায়'],
  ['বিষাদ-সিন্ধু', 'মীর মশাররফ হোসেন'],
  ['জমিদার দর্পণ', 'মীর মশাররফ হোসেন'],
  ['কবর (নাটক)', 'মুনীর চৌধুরী'],
  ['রক্তাক্ত প্রান্তর', 'মুনীর চৌধুরী'],
  ['নকশী কাঁথার মাঠ', 'জসীমউদ্‌দীন'],
  ['সোজন বাদিয়ার ঘাট', 'জসীমউদ্‌দীন'],
  ['রূপসী বাংলা', 'জীবনানন্দ দাশ'],
  ['বনলতা সেন', 'জীবনানন্দ দাশ'],
  ['সংশপ্তক', 'শহীদুল্লা কায়সার'],
  ['হাজার বছর ধরে', 'জহির রায়হান'],
  ['নীলদর্পণ', 'দীনবন্ধু মিত্র'],
  ['ক্রীতদাসের হাসি', 'শওকত ওসমান'],
  ['সূর্য দীঘল বাড়ী', 'আবু ইসহাক'],
  ['চিলেকোঠার সেপাই', 'আখতারুজ্জামান ইলিয়াস'],
  ['খোয়াবনামা', 'আখতারুজ্জামান ইলিয়াস'],
];

const TITLES: Array<[string, string]> = [
  ['বিদ্রোহী কবি', 'কাজী নজরুল ইসলাম'],
  ['কবিগুরু / বিশ্বকবি', 'রবীন্দ্রনাথ ঠাকুর'],
  ['রূপসী বাংলার কবি', 'জীবনানন্দ দাশ'],
  ['পল্লীকবি', 'জসীমউদ্‌দীন'],
  ['অপরাজেয় কথাশিল্পী', 'শরৎচন্দ্র চট্টোপাধ্যায়'],
  ['সাহিত্যসম্রাট', 'বঙ্কিমচন্দ্র চট্টোপাধ্যায়'],
  ['মধুকবি', 'মাইকেল মধুসূদন দত্ত'],
];

const BN = (
  subject: string,
  chapter: string,
  topic: string,
  key: string,
  d: Diff,
  stem: string,
  ans: string,
  ds: string[],
  ex: string,
) =>
  q({
    key: `${subject}:${topic}:${key}`,
    subject,
    chapter,
    topic,
    difficulty: d,
    stem,
    answer: ans,
    distractors: ds,
    explanation: ex,
    exams: ALL_EXAMS,
  });

export function bangla(): Out {
  const out: Out = [];
  BN_SYNONYMS.forEach(([w, s]) =>
    out.push(
      BN(
        'bangla-language',
        'vocabulary',
        'bn-synonyms',
        w,
        'EASY',
        `'${w}' শব্দের সমার্থক শব্দ কোনটি?`,
        s,
        pick(
          BN_SYNONYMS.map((x) => x[1]),
          3,
          `bns-${w}`,
          (x) => x === s,
        ),
        `'${w}' এর সমার্থক '${s}'।`,
      ),
    ),
  );
  BN_ANTONYMS.forEach(([w, a]) =>
    out.push(
      BN(
        'bangla-language',
        'vocabulary',
        'bn-antonyms',
        w,
        'EASY',
        `'${w}' শব্দের বিপরীত শব্দ কোনটি?`,
        a,
        pick(
          BN_ANTONYMS.map((x) => x[1]),
          3,
          `bna-${w}`,
          (x) => x === a,
        ),
        `'${w}' এর বিপরীত শব্দ '${a}'।`,
      ),
    ),
  );
  const authors = [...new Set(WORKS.map((w) => w[1]))];
  WORKS.forEach(([work, author]) =>
    out.push(
      BN(
        'bangla-literature',
        'literature',
        'works-authors',
        work,
        'MEDIUM',
        `'${work}' গ্রন্থের রচয়িতা কে?`,
        author,
        pick(authors, 3, `bw-${work}`, (x) => x === author),
        `'${work}' ${author}-এর রচনা।`,
      ),
    ),
  );
  TITLES.forEach(([t, p]) =>
    out.push(
      BN(
        'bangla-literature',
        'literature',
        'literary-titles',
        t,
        'EASY',
        `'${t}' উপাধি কার?`,
        p,
        pick(
          [...authors, ...TITLES.map((x) => x[1])].filter((v, i, a) => a.indexOf(v) === i),
          3,
          `bt-${t}`,
          (x) => x === p,
        ),
        `'${t}' হিসেবে পরিচিত ${p}।`,
      ),
    ),
  );
  const facts: Array<[string, string, string[], string, Diff]> = [
    [
      'বাংলা সাহিত্যের প্রাচীনতম নিদর্শন কোনটি?',
      'চর্যাপদ',
      ['শ্রীকৃষ্ণকীর্তন', 'মঙ্গলকাব্য', 'বৈষ্ণব পদাবলি'],
      'চর্যাপদ বাংলা ভাষা ও সাহিত্যের আদি নিদর্শন।',
      'EASY',
    ],
    [
      'কোন গ্রন্থের জন্য রবীন্দ্রনাথ ঠাকুর ১৯১৩ সালে নোবেল পুরস্কার পান?',
      'Gitanjali (Song Offerings)',
      ['গোরা', 'সোনার তরী', 'চোখের বালি'],
      'ইংরেজি "Gitanjali (Song Offerings)" এর জন্য ১৯১৩ সালে সাহিত্যে নোবেল।',
      'MEDIUM',
    ],
    [
      'বাংলাদেশের জাতীয় সংগীত "আমার সোনার বাংলা" কার রচনা?',
      'রবীন্দ্রনাথ ঠাকুর',
      ['কাজী নজরুল ইসলাম', 'জসীমউদ্‌দীন', 'দ্বিজেন্দ্রলাল রায়'],
      'জাতীয় সংগীত রবীন্দ্রনাথ ঠাকুরের রচনা।',
      'EASY',
    ],
    [
      'বাংলাদেশের রণসংগীত "চল্ চল্ চল্" কার রচনা?',
      'কাজী নজরুল ইসলাম',
      ['রবীন্দ্রনাথ ঠাকুর', 'জসীমউদ্‌দীন', 'সুকান্ত ভট্টাচার্য'],
      'রণসংগীত কাজী নজরুল ইসলামের রচনা।',
      'MEDIUM',
    ],
    [
      'বাংলাদেশের জাতীয় কবি কে?',
      'কাজী নজরুল ইসলাম',
      ['রবীন্দ্রনাথ ঠাকুর', 'জীবনানন্দ দাশ', 'জসীমউদ্‌দীন'],
      'কাজী নজরুল ইসলাম বাংলাদেশের জাতীয় কবি।',
      'EASY',
    ],
    [
      'বাংলা ভাষার প্রথম সার্থক মহাকাব্য কোনটি?',
      'মেঘনাদবধ কাব্য',
      ['বিষাদ-সিন্ধু', 'অগ্নিবীণা', 'গীতাঞ্জলি'],
      'মাইকেল মধুসূদন দত্তের মেঘনাদবধ কাব্য।',
      'MEDIUM',
    ],
    [
      'বাংলা ভাষার প্রথম সার্থক উপন্যাস হিসেবে কোনটি স্বীকৃত?',
      'দুর্গেশনন্দিনী',
      ['আলালের ঘরের দুলাল', 'কপালকুণ্ডলা', 'পথের পাঁচালী'],
      'বঙ্কিমচন্দ্রের দুর্গেশনন্দিনী (১৮৬৫) প্রথম সার্থক উপন্যাস।',
      'HARD',
    ],
  ];
  facts.forEach(([s, a, ds, ex, d], i) =>
    out.push(BN('bangla-literature', 'literature', 'literary-titles', `fact-${i}`, d, s, a, ds, ex)),
  );
  return out;
}

export function allLanguages(): Out {
  return [...english(), ...bangla()];
}
