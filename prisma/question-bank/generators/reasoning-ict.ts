import {
  BankQuestion,
  Diff,
  ExamFit,
  ALL_EXAMS,
  JOB_EXAMS,
  fmt,
  numericDistractors,
  pick,
  q,
} from '../types';

type Out = BankQuestion[];

function mk(
  subject: string,
  chapter: string,
  topic: string,
  key: string,
  difficulty: Diff,
  stem: string,
  answer: string,
  distractors: string[],
  explanation: string,
  exams: ExamFit[] = ALL_EXAMS,
): BankQuestion {
  return q({
    key: `${subject}:${topic}:${key}`,
    subject,
    chapter,
    topic,
    difficulty,
    stem,
    answer,
    distractors,
    explanation,
    exams,
  });
}

const R = (topic: string, key: string, d: Diff, stem: string, ans: string, ds: string[], ex: string) =>
  mk('mental-ability', 'reasoning', topic, key, d, stem, ans, ds, ex, JOB_EXAMS);

export function numberSeries(): Out {
  const out: Out = [];
  for (const a of [2, 3, 5, 7, 10, 12])
    for (const d of [3, 4, 6, 7, 9, 11]) {
      const s = [0, 1, 2, 3, 4].map((i) => a + i * d);
      const next = a + 5 * d;
      out.push(
        R(
          'number-series',
          `ap-${a}-${d}`,
          'EASY',
          `What comes next: ${s.join(', ')}, ?`,
          fmt(next),
          numericDistractors(next, `ap-${a}-${d}`),
          `Each term increases by ${d}: ${s[4]} + ${d} = ${next}.`,
        ),
      );
    }
  for (const a of [1, 2, 3, 5])
    for (const r of [2, 3]) {
      const s = [0, 1, 2, 3].map((i) => a * r ** i);
      const next = a * r ** 4;
      out.push(
        R(
          'number-series',
          `gp-${a}-${r}`,
          'EASY',
          `What comes next: ${s.join(', ')}, ?`,
          fmt(next),
          numericDistractors(next, `gp-${a}-${r}`),
          `Each term is multiplied by ${r}: ${s[3]} × ${r} = ${next}.`,
        ),
      );
    }
  for (const start of [1, 2, 3, 4, 5, 6]) {
    const s = [0, 1, 2, 3].map((i) => (start + i) ** 2);
    const next = (start + 4) ** 2;
    out.push(
      R(
        'number-series',
        `sq-${start}`,
        'MEDIUM',
        `What comes next: ${s.join(', ')}, ?`,
        fmt(next),
        numericDistractors(next, `sq-${start}`),
        `Consecutive squares: ${start + 4}² = ${next}.`,
      ),
    );
  }
  for (const [a, b] of [
    [1, 1],
    [2, 3],
    [1, 3],
    [3, 4],
    [2, 5],
  ]) {
    const s = [a, b];
    while (s.length < 6) s.push(s[s.length - 1] + s[s.length - 2]);
    const next = s[4] + s[5];
    out.push(
      R(
        'number-series',
        `fib-${a}-${b}`,
        'MEDIUM',
        `What comes next: ${s.join(', ')}, ?`,
        fmt(next),
        numericDistractors(next, `fib-${a}-${b}`),
        `Each term is the sum of the previous two: ${s[4]} + ${s[5]} = ${next}.`,
      ),
    );
  }
  for (const a of [2, 5, 10, 3]) {
    // differences increase by 1, 2, 3...
    const s = [a];
    for (let i = 1; i <= 4; i++) s.push(s[i - 1] + i * 2);
    const next = s[4] + 10;
    out.push(
      R(
        'number-series',
        `incdiff-${a}`,
        'HARD',
        `What comes next: ${s.join(', ')}, ?`,
        fmt(next),
        numericDistractors(next, `incdiff-${a}`),
        `Differences are 2, 4, 6, 8, so the next difference is 10: ${s[4]} + 10 = ${next}.`,
      ),
    );
  }
  return out;
}

const ABC = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const shift = (w: string, k: number) =>
  w
    .split('')
    .map((c) => ABC[(ABC.indexOf(c) + k + 26) % 26])
    .join('');

export function letterSeries(): Out {
  const out: Out = [];
  for (const start of [0, 1, 2, 3, 4, 5, 7, 10])
    for (const step of [2, 3, 4]) {
      if (start + step * 5 >= 26) continue;
      const s = [0, 1, 2, 3].map((i) => ABC[start + i * step]);
      const next = ABC[start + 4 * step];
      const at = start + 4 * step;
      const ds = [ABC[(at + 1) % 26], ABC[(at + 25) % 26], ABC[(at + 2) % 26]];
      out.push(
        R(
          'letter-series',
          `ls-${start}-${step}`,
          'EASY',
          `Which letter comes next: ${s.join(', ')}, ?`,
          next,
          ds,
          `Letters advance by ${step} positions: ${s[3]} + ${step} = ${next}.`,
        ),
      );
    }
  return out;
}

const WORDS = [
  'CAT',
  'DOG',
  'SUN',
  'BOOK',
  'PEN',
  'TREE',
  'BOAT',
  'FISH',
  'MILK',
  'RAIN',
  'STAR',
  'GOLD',
  'LAMP',
  'ROSE',
  'BIRD',
  'CAKE',
  'DESK',
  'HILL',
  'KING',
  'MOON',
];
export function codingDecoding(): Out {
  const out: Out = [];
  WORDS.forEach((w, i) => {
    const k = (i % 4) + 1;
    const other = WORDS[(i + 7) % WORDS.length];
    const ans = shift(other, k);
    out.push(
      R(
        'coding-decoding',
        `shift-${w}-${k}`,
        'MEDIUM',
        `In a certain code, ${w} is written as ${shift(w, k)}. How is ${other} written in that code?`,
        ans,
        [shift(other, k + 1), shift(other, k - 1), shift(other, -k)],
        `Each letter is shifted ${k} place(s) forward in the alphabet, so ${other} → ${ans}.`,
      ),
    );
  });
  WORDS.slice(0, 10).forEach((w) => {
    const rev = w.split('').reverse().join('');
    const other = WORDS[(WORDS.indexOf(w) + 11) % WORDS.length];
    const ans = other.split('').reverse().join('');
    out.push(
      R(
        'coding-decoding',
        `rev-${w}`,
        'EASY',
        `In a code, ${w} is written as ${rev}. How is ${other} written?`,
        ans,
        [shift(ans, 1), shift(other, 1), other],
        `The letters are written in reverse order: ${other} → ${ans}.`,
      ),
    );
  });
  return out;
}

export function directions(): Out {
  const out: Out = [];
  for (const [a, b, c] of [
    [3, 4, 5],
    [6, 8, 10],
    [5, 12, 13],
    [8, 15, 17],
    [9, 12, 15],
    [12, 16, 20],
    [7, 24, 25],
    [15, 20, 25],
  ])
    out.push(
      R(
        'directions',
        `pyth-${a}-${b}`,
        'MEDIUM',
        `Karim walks ${a} km north and then ${b} km east. How far is he from the starting point (straight line)?`,
        `${c} km`,
        [`${a + b} km`, `${c + 1} km`, `${Math.abs(b - a)} km`],
        `Distance = √(${a}² + ${b}²) = ${c} km.`,
      ),
    );
  const dirs = ['North', 'East', 'South', 'West'];
  dirs.forEach((d, i) => {
    out.push(
      R(
        'directions',
        `right-${d}`,
        'EASY',
        `A person faces ${d} and turns 90° to the right. Which direction does he face now?`,
        dirs[(i + 1) % 4],
        dirs.filter((x) => x !== dirs[(i + 1) % 4]),
        `A right turn from ${d} is ${dirs[(i + 1) % 4]}.`,
      ),
    );
    out.push(
      R(
        'directions',
        `about-${d}`,
        'EASY',
        `A person faces ${d}, turns right, then right again. Which direction does he face?`,
        dirs[(i + 2) % 4],
        dirs.filter((x) => x !== dirs[(i + 2) % 4]),
        `Two right turns make 180°: ${d} → ${dirs[(i + 2) % 4]}.`,
      ),
    );
    out.push(
      R(
        'directions',
        `left-${d}`,
        'EASY',
        `A person faces ${d} and turns 90° to the left. Which direction does he face now?`,
        dirs[(i + 3) % 4],
        dirs.filter((x) => x !== dirs[(i + 3) % 4]),
        `A left turn from ${d} is ${dirs[(i + 3) % 4]}.`,
      ),
    );
  });
  return out;
}

const DAYS = ['Saturday', 'Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'];
export function calendar(): Out {
  const out: Out = [];
  DAYS.forEach((d, i) => {
    for (const n of [10, 15, 23, 30, 45, 61, 100]) {
      if ((i + n) % 3 !== 0) continue;
      const ans = DAYS[(i + n) % 7];
      out.push(
        R(
          'calendar',
          `after-${d}-${n}`,
          'MEDIUM',
          `If today is ${d}, what day of the week will it be after ${n} days?`,
          ans,
          pick(DAYS, 3, `cal-${d}-${n}`, (x) => x === ans),
          `${n} = ${Math.floor(n / 7)} weeks + ${n % 7} days; ${d} + ${n % 7} days = ${ans}.`,
        ),
      );
    }
  });
  for (const y of [1900, 2000, 2024, 2100, 1996, 2023, 2400, 1800]) {
    const leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
    out.push(
      R(
        'calendar',
        `leap-${y}`,
        'MEDIUM',
        `How many days are there in the year ${y}?`,
        leap ? '366' : '365',
        leap ? ['365', '364', '367'] : ['366', '364', '367'],
        leap
          ? `${y} is a leap year (divisible by 4${y % 100 === 0 ? ' and by 400' : ''}).`
          : `${y} is not a leap year${y % 100 === 0 ? ' (century year not divisible by 400)' : ''}.`,
      ),
    );
  }
  return out;
}

export function ranking(): Out {
  const out: Out = [];
  for (const [top, bottom] of [
    [7, 12],
    [10, 21],
    [15, 16],
    [5, 30],
    [18, 23],
    [11, 11],
    [25, 6],
    [9, 40],
  ])
    out.push(
      R(
        'ranking',
        `rank-${top}-${bottom}`,
        'MEDIUM',
        `In a row of students, Rima is ${top}th from the front and ${bottom}th from the back. How many students are in the row?`,
        fmt(top + bottom - 1),
        [fmt(top + bottom), fmt(top + bottom + 1), fmt(top + bottom - 2)],
        `Total = ${top} + ${bottom} − 1 = ${top + bottom - 1} (Rima is counted twice).`,
      ),
    );
  return out;
}

// ───────────────────────── ICT ─────────────────────────

const I = (topic: string, key: string, d: Diff, stem: string, ans: string, ds: string[], ex: string) =>
  mk('ict', 'computing', topic, key, d, stem, ans, ds, ex);

export function numberSystems(): Out {
  const out: Out = [];
  const nums = [5, 9, 10, 12, 13, 17, 20, 25, 31, 32, 45, 50, 63, 64, 75, 100, 127, 128, 150, 200, 255];
  for (const n of nums) {
    const b = n.toString(2);
    out.push(
      I(
        'number-systems',
        `d2b-${n}`,
        n > 64 ? 'MEDIUM' : 'EASY',
        `What is the binary representation of decimal ${n}?`,
        b,
        [
          (n + 1).toString(2),
          (n - 1).toString(2),
          b.split('').reverse().join('') === b ? (n + 2).toString(2) : b.split('').reverse().join(''),
        ],
        `${n} = ${b
          .split('')
          .map((c, i) => (c === '1' ? `2^${b.length - 1 - i}` : ''))
          .filter(Boolean)
          .join(' + ')} → ${b}₂.`,
      ),
    );
    out.push(
      I(
        'number-systems',
        `b2d-${n}`,
        'EASY',
        `Binary ${b} equals which decimal number?`,
        String(n),
        numericDistractors(n, `b2d-${n}`),
        `Sum of place values: ${n}.`,
      ),
    );
    if (n >= 16)
      out.push(
        I(
          'number-systems',
          `d2h-${n}`,
          'MEDIUM',
          `What is decimal ${n} in hexadecimal?`,
          n.toString(16).toUpperCase(),
          [(n + 1).toString(16).toUpperCase(), (n - 1).toString(16).toUpperCase(), n.toString(8)],
          `${n} = ${Math.floor(n / 16)} × 16 + ${n % 16} → ${n.toString(16).toUpperCase()}₁₆.`,
        ),
      );
    if (n >= 8 && n % 2 === 1)
      out.push(
        I(
          'number-systems',
          `d2o-${n}`,
          'MEDIUM',
          `What is decimal ${n} in octal?`,
          n.toString(8),
          [(n + 1).toString(8), (n - 1).toString(8), n.toString(16)],
          `Repeated division by 8 gives ${n.toString(8)}₈.`,
        ),
      );
  }
  out.push(
    I(
      'number-systems',
      'base-hex',
      'EASY',
      'What is the base of the hexadecimal number system?',
      '16',
      ['8', '2', '10'],
      'Hexadecimal uses 16 symbols: 0–9 and A–F.',
    ),
  );
  out.push(
    I(
      'number-systems',
      'base-octal',
      'EASY',
      'What is the base of the octal number system?',
      '8',
      ['16', '2', '10'],
      'Octal uses the digits 0–7.',
    ),
  );
  out.push(
    I(
      'number-systems',
      'bits-byte',
      'EASY',
      'How many bits make one byte?',
      '8',
      ['4', '16', '2'],
      '1 byte = 8 bits.',
    ),
  );
  out.push(
    I(
      'number-systems',
      'nibble',
      'EASY',
      'How many bits are there in a nibble?',
      '4',
      ['8', '2', '16'],
      'A nibble is half a byte: 4 bits.',
    ),
  );
  out.push(
    I(
      'number-systems',
      'kib',
      'EASY',
      'In binary (power-of-two) usage, 1 KB equals how many bytes?',
      '1024',
      ['1000', '512', '2048'],
      '1 KB = 2¹⁰ = 1024 bytes in binary usage (1 KiB).',
    ),
  );
  out.push(
    I(
      'number-systems',
      'ipv4-bits',
      'MEDIUM',
      'How many bits long is an IPv4 address?',
      '32',
      ['64', '128', '16'],
      'IPv4 addresses are 32 bits (four octets).',
    ),
  );
  out.push(
    I(
      'number-systems',
      'ipv6-bits',
      'MEDIUM',
      'How many bits long is an IPv6 address?',
      '128',
      ['64', '32', '256'],
      'IPv6 addresses are 128 bits.',
    ),
  );
  out.push(
    I(
      'number-systems',
      'mac-bits',
      'HARD',
      'How many bits long is a standard (EUI-48) MAC address?',
      '48',
      ['32', '64', '128'],
      'A MAC address is 48 bits, usually written as six hexadecimal pairs.',
    ),
  );
  return out;
}

export function logicGates(): Out {
  const out: Out = [];
  const gates: Record<string, (a: number, b: number) => number> = {
    AND: (a, b) => a & b,
    OR: (a, b) => a | b,
    NAND: (a, b) => 1 - (a & b),
    NOR: (a, b) => 1 - (a | b),
    XOR: (a, b) => a ^ b,
    XNOR: (a, b) => 1 - (a ^ b),
  };
  for (const [g, f] of Object.entries(gates))
    for (const [a, b] of [
      [0, 0],
      [0, 1],
      [1, 0],
      [1, 1],
    ]) {
      const r = f(a, b);
      out.push(
        I(
          'logic-gates',
          `${g}-${a}${b}`,
          g.length > 3 ? 'MEDIUM' : 'EASY',
          `What is the output of a 2-input ${g} gate when the inputs are A = ${a} and B = ${b}?`,
          String(r),
          [String(1 - r), 'Undefined', 'Both 0 and 1'],
          `${g}(${a}, ${b}) = ${r}.`,
        ),
      );
    }
  out.push(
    I(
      'logic-gates',
      'universal',
      'MEDIUM',
      'Which pair of gates are called universal gates?',
      'NAND and NOR',
      ['AND and OR', 'XOR and XNOR', 'NOT and AND'],
      'Any Boolean function can be built using only NAND gates or only NOR gates.',
    ),
  );
  return out;
}

const ACRONYMS: Array<[string, string]> = [
  ['CPU', 'Central Processing Unit'],
  ['RAM', 'Random Access Memory'],
  ['ROM', 'Read Only Memory'],
  ['URL', 'Uniform Resource Locator'],
  ['HTTP', 'HyperText Transfer Protocol'],
  ['HTML', 'HyperText Markup Language'],
  ['LAN', 'Local Area Network'],
  ['WAN', 'Wide Area Network'],
  ['ISP', 'Internet Service Provider'],
  ['DNS', 'Domain Name System'],
  ['USB', 'Universal Serial Bus'],
  ['PDF', 'Portable Document Format'],
  ['GPS', 'Global Positioning System'],
  ['SQL', 'Structured Query Language'],
  ['ALU', 'Arithmetic Logic Unit'],
  ['OCR', 'Optical Character Recognition'],
  ['OMR', 'Optical Mark Recognition'],
  ['FTP', 'File Transfer Protocol'],
  ['SMTP', 'Simple Mail Transfer Protocol'],
  ['WWW', 'World Wide Web'],
  ['ASCII', 'American Standard Code for Information Interchange'],
  ['BIOS', 'Basic Input Output System'],
  ['GUI', 'Graphical User Interface'],
  ['IoT', 'Internet of Things'],
  ['AI', 'Artificial Intelligence'],
  ['VPN', 'Virtual Private Network'],
  ['SSD', 'Solid State Drive'],
  ['HDD', 'Hard Disk Drive'],
  ['GPU', 'Graphics Processing Unit'],
  ['LED', 'Light Emitting Diode'],
  ['LCD', 'Liquid Crystal Display'],
  ['MAN', 'Metropolitan Area Network'],
  ['DBMS', 'Database Management System'],
  ['OS', 'Operating System'],
  ['IP', 'Internet Protocol'],
  ['TCP', 'Transmission Control Protocol'],
  ['Wi-Fi', 'Wireless Fidelity'],
  ['PAN', 'Personal Area Network'],
  ['UPS', 'Uninterruptible Power Supply'],
  ['CAD', 'Computer-Aided Design'],
  ['ICT', 'Information and Communication Technology'],
  ['MODEM', 'Modulator–Demodulator'],
];

export function terminology(): Out {
  return ACRONYMS.map(([a, full], i) =>
    I(
      'terminology',
      `acr-${a}`,
      a.length > 3 ? 'MEDIUM' : 'EASY',
      `What does ${a} stand for?`,
      full,
      pick(
        ACRONYMS.map((x) => x[1]),
        3,
        `acr-${a}-${i}`,
        (x) => x === full,
      ),
      `${a} = ${full}.`,
    ),
  );
}

const ICT_FACTS: Array<[string, string, string[], string, Diff]> = [
  [
    'Who is widely known as the "father of the computer"?',
    'Charles Babbage',
    ['Alan Turing', 'Tim Berners-Lee', 'John von Neumann'],
    'Charles Babbage designed the Difference Engine and the Analytical Engine.',
    'EASY',
  ],
  [
    'Who invented the World Wide Web?',
    'Tim Berners-Lee',
    ['Charles Babbage', 'Bill Gates', 'Vint Cerf'],
    'Tim Berners-Lee proposed the Web at CERN in 1989.',
    'EASY',
  ],
  [
    'Who created the Linux kernel?',
    'Linus Torvalds',
    ['Dennis Ritchie', 'Richard Stallman', 'Ken Thompson'],
    'Linus Torvalds released Linux in 1991.',
    'MEDIUM',
  ],
  [
    'Who developed the C programming language?',
    'Dennis Ritchie',
    ['James Gosling', 'Guido van Rossum', 'Bjarne Stroustrup'],
    'Dennis Ritchie created C at Bell Labs in the early 1970s.',
    'MEDIUM',
  ],
  [
    'Who created the Python programming language?',
    'Guido van Rossum',
    ['James Gosling', 'Dennis Ritchie', 'Linus Torvalds'],
    'Guido van Rossum released Python in 1991.',
    'MEDIUM',
  ],
  [
    'Who is the principal creator of the Java programming language?',
    'James Gosling',
    ['Bjarne Stroustrup', 'Dennis Ritchie', 'Guido van Rossum'],
    'James Gosling led Java’s development at Sun Microsystems.',
    'MEDIUM',
  ],
  [
    'Who created C++?',
    'Bjarne Stroustrup',
    ['Dennis Ritchie', 'James Gosling', 'Ken Thompson'],
    'Bjarne Stroustrup developed C++ at Bell Labs.',
    'MEDIUM',
  ],
  [
    'Which memory is volatile (loses its contents when power is off)?',
    'RAM',
    ['ROM', 'Hard disk', 'Flash drive'],
    'RAM requires power to retain data.',
    'EASY',
  ],
  [
    'Which of these is an input device?',
    'Keyboard',
    ['Monitor', 'Printer', 'Speaker'],
    'A keyboard sends data into the computer.',
    'EASY',
  ],
  [
    'Which of these is an output device?',
    'Printer',
    ['Scanner', 'Mouse', 'Microphone'],
    'A printer produces output from the computer.',
    'EASY',
  ],
  [
    'Which program translates an entire high-level program into machine code before execution?',
    'Compiler',
    ['Interpreter', 'Assembler', 'Loader'],
    'A compiler translates the whole program; an interpreter translates statement by statement.',
    'MEDIUM',
  ],
  [
    'Which device forwards data packets between different networks?',
    'Router',
    ['Hub', 'Repeater', 'Monitor'],
    'Routers forward packets between networks using IP addresses.',
    'MEDIUM',
  ],
  [
    'What is the default port number for HTTP?',
    '80',
    ['443', '21', '25'],
    'HTTP uses port 80; HTTPS uses 443.',
    'MEDIUM',
  ],
  [
    'What is the default port number for HTTPS?',
    '443',
    ['80', '8080', '22'],
    'HTTPS uses port 443.',
    'MEDIUM',
  ],
  [
    'In a relational database, which key uniquely identifies each row of a table?',
    'Primary key',
    ['Foreign key', 'Candidate index', 'Composite view'],
    'A primary key is unique and not null for every row.',
    'EASY',
  ],
  [
    'Which network topology connects every device to a central hub or switch?',
    'Star',
    ['Bus', 'Ring', 'Mesh'],
    'In a star topology all nodes connect to a central device.',
    'EASY',
  ],
  [
    'Which number system do computers use internally?',
    'Binary',
    ['Decimal', 'Octal', 'Roman'],
    'Digital circuits represent data with two states: 0 and 1.',
    'EASY',
  ],
  [
    'Which of these is an example of system software?',
    'Operating system',
    ['Spreadsheet', 'Web browser', 'Word processor'],
    'The operating system manages hardware and provides services to applications.',
    'EASY',
  ],
  [
    'Which of these is NOT an operating system?',
    'Oracle Database',
    ['Linux', 'Windows', 'Android'],
    'Oracle Database is a database management system, not an OS.',
    'MEDIUM',
  ],
  [
    'Which unit of the CPU performs arithmetic and logical operations?',
    'ALU',
    ['Control unit', 'Cache', 'Register file'],
    'The Arithmetic Logic Unit does calculations and comparisons.',
    'EASY',
  ],
  [
    'Which technology is used for short-range wireless connection between a phone and headphones?',
    'Bluetooth',
    ['Fibre optics', 'Ethernet', 'Coaxial cable'],
    'Bluetooth is a short-range wireless standard.',
    'EASY',
  ],
  [
    'Which of these is a cloud storage service?',
    'Google Drive',
    ['MS Paint', 'Notepad', 'Calculator'],
    'Google Drive stores files on remote servers.',
    'EASY',
  ],
  [
    'Malicious software that encrypts files and demands payment is called:',
    'Ransomware',
    ['Firmware', 'Shareware', 'Freeware'],
    'Ransomware holds data hostage for a ransom.',
    'MEDIUM',
  ],
  [
    'A fraudulent email trying to trick users into revealing passwords is called:',
    'Phishing',
    ['Spooling', 'Caching', 'Booting'],
    'Phishing impersonates trusted parties to steal credentials.',
    'EASY',
  ],
  [
    'Which storage device has no moving parts?',
    'Solid state drive (SSD)',
    ['Hard disk drive (HDD)', 'Floppy disk drive', 'DVD drive'],
    'SSDs use flash memory.',
    'EASY',
  ],
];

export function ictFacts(): Out {
  return ICT_FACTS.map(([stem, ans, ds, ex, d], i) => I('ict-facts', `fact-${i}`, d, stem, ans, ds, ex));
}

export function allReasoningIct(): Out {
  return [
    ...numberSeries(),
    ...letterSeries(),
    ...codingDecoding(),
    ...directions(),
    ...calendar(),
    ...ranking(),
    ...numberSystems(),
    ...logicGates(),
    ...terminology(),
    ...ictFacts(),
  ];
}
