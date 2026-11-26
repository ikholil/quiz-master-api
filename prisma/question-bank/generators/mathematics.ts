import {
  BankQuestion,
  Diff,
  ExamFit,
  JOB_EXAMS,
  ALL_EXAMS,
  fmt,
  gcd,
  lcm,
  numericDistractors,
  q,
} from '../types';

const S = 'mathematics';
type Out = BankQuestion[];

function mk(
  chapter: string,
  topic: string,
  key: string,
  difficulty: Diff,
  stem: string,
  answer: number | string,
  explanation: string,
  distractors?: string[],
  exams: ExamFit[] = ALL_EXAMS,
): BankQuestion {
  const a = typeof answer === 'number' ? fmt(answer) : answer;
  return q({
    key: `math:${topic}:${key}`,
    subject: S,
    chapter,
    topic,
    difficulty,
    stem,
    answer: a,
    distractors: distractors ?? numericDistractors(answer as number, key),
    explanation,
    exams,
  });
}

export function percentage(): Out {
  const out: Out = [];
  const ps = [5, 8, 10, 12, 12.5, 15, 16, 20, 25, 30, 35, 40, 45, 50, 60, 62.5, 75, 80, 120, 150];
  const ns = [
    40, 80, 120, 160, 200, 240, 250, 320, 360, 400, 480, 500, 640, 720, 800, 960, 1200, 1600, 2400, 4000,
  ];
  for (const p of ps)
    for (const n of ns) {
      const v = (p * n) / 100;
      if (!Number.isInteger(v) || (out.length % 3 !== 0 && n > 1000)) continue;
      out.push(
        mk(
          'arithmetic',
          'percentage',
          `of-${p}-${n}`,
          p > 100 || !Number.isInteger(p) ? 'MEDIUM' : 'EASY',
          `${n} এর ${p}% কত? (What is ${p}% of ${n}?)`,
          v,
          `${p}% of ${n} = ${n} × ${p} ÷ 100 = ${fmt(v)}.`,
        ),
      );
    }
  // Percentage change
  const pairs: Array<[number, number]> = [];
  for (const o of [40, 50, 80, 120, 160, 200, 250, 400, 500, 800])
    for (const pct of [5, 10, 15, 20, 25, 30, 40, 50, 75]) pairs.push([o, pct]);
  for (const [o, pct] of pairs) {
    const up = (o * (100 + pct)) / 100;
    const down = (o * (100 - pct)) / 100;
    if (Number.isInteger(up))
      out.push(
        mk(
          'arithmetic',
          'percentage',
          `inc-${o}-${pct}`,
          'MEDIUM',
          `A price rises from ${o} taka to ${fmt(up)} taka. What is the percentage increase?`,
          `${pct}%`,
          `Increase = ${fmt(up - o)}; ${fmt(up - o)} ÷ ${o} × 100 = ${pct}%.`,
          [`${pct + 5}%`, `${Math.max(1, pct - 5)}%`, `${fmt(((up - o) / up) * 100)}%`, `${pct * 2}%`],
        ),
      );
    if (Number.isInteger(down) && pct < 60)
      out.push(
        mk(
          'arithmetic',
          'percentage',
          `dec-${o}-${pct}`,
          'MEDIUM',
          `A population falls from ${o * 10} to ${fmt(down * 10)}. What is the percentage decrease?`,
          `${pct}%`,
          `Decrease = ${fmt((o - down) * 10)}; ÷ ${o * 10} × 100 = ${pct}%.`,
          [`${pct + 5}%`, `${Math.max(1, pct - 5)}%`, `${fmt(((o - down) / down) * 100)}%`, `${pct * 2}%`],
        ),
      );
  }
  // "x is what percent of y"
  for (const [x, y] of [
    [15, 60],
    [18, 72],
    [25, 125],
    [30, 150],
    [45, 180],
    [12, 96],
    [27, 90],
    [36, 48],
    [14, 56],
    [63, 84],
    [9, 36],
    [40, 160],
    [21, 35],
    [33, 132],
    [49, 70],
  ]) {
    const p = (x / y) * 100;
    out.push(
      mk(
        'arithmetic',
        'percentage',
        `whatpct-${x}-${y}`,
        'EASY',
        `${x} is what percent of ${y}?`,
        `${fmt(p)}%`,
        `${x} ÷ ${y} × 100 = ${fmt(p)}%.`,
        [`${fmt(p + 5)}%`, `${fmt(Math.max(1, p - 5))}%`, `${fmt((y / x) * 10)}%`, `${fmt(p * 2)}%`],
      ),
    );
  }
  return out;
}

export function profitLoss(): Out {
  const out: Out = [];
  for (const cp of [
    80, 120, 150, 200, 240, 250, 300, 400, 450, 500, 600, 750, 800, 900, 1000, 1200, 1500, 2000, 2500,
  ])
    for (const pct of [5, 10, 12, 15, 20, 25, 30, 40, 50]) {
      const sp = (cp * (100 + pct)) / 100;
      const lsp = (cp * (100 - pct)) / 100;
      if (Number.isInteger(sp) && (cp + pct) % 2 === 0)
        out.push(
          mk(
            'arithmetic',
            'profit-loss',
            `gain-${cp}-${pct}`,
            'EASY',
            `A shopkeeper buys an item for ${cp} taka and sells it for ${fmt(sp)} taka. What is the profit percentage?`,
            `${pct}%`,
            `Profit = ${fmt(sp - cp)}; profit% = ${fmt(sp - cp)} ÷ ${cp} × 100 = ${pct}% (profit is always on cost price).`,
            [`${fmt(((sp - cp) / sp) * 100)}%`, `${pct + 5}%`, `${Math.max(1, pct - 5)}%`, `${pct * 2}%`],
          ),
        );
      if (Number.isInteger(sp) && (cp + pct) % 2 === 1)
        out.push(
          mk(
            'arithmetic',
            'profit-loss',
            `sp-${cp}-${pct}`,
            'EASY',
            `Cost price ${cp} taka. To gain ${pct}%, the selling price must be:`,
            `${fmt(sp)} taka`,
            `SP = CP × (100 + ${pct}) ÷ 100 = ${fmt(sp)}.`,
            numericDistractors(sp, `sp-${cp}-${pct}`).map((d) => `${d} taka`),
          ),
        );
      if (Number.isInteger(lsp) && pct <= 30 && cp % 3 === 0)
        out.push(
          mk(
            'arithmetic',
            'profit-loss',
            `loss-${cp}-${pct}`,
            'MEDIUM',
            `An article bought for ${cp} taka is sold at a loss of ${pct}%. Find the selling price.`,
            `${fmt(lsp)} taka`,
            `SP = ${cp} × (100 − ${pct}) ÷ 100 = ${fmt(lsp)}.`,
            numericDistractors(lsp, `loss-${cp}-${pct}`).map((d) => `${d} taka`),
          ),
        );
    }
  return out;
}

export function interest(): Out {
  const out: Out = [];
  for (const p of [500, 1000, 1200, 1500, 2000, 2500, 4000, 5000, 6000, 8000, 10000, 12000, 15000, 20000])
    for (const r of [4, 5, 6, 8, 10, 12])
      for (const t of [2, 3, 4, 5]) {
        const si = (p * r * t) / 100;
        if (!Number.isInteger(si) || (p + r + t) % 3 !== 0) continue;
        out.push(
          mk(
            'arithmetic',
            'interest',
            `si-${p}-${r}-${t}`,
            'EASY',
            `Find the simple interest on ${p} taka at ${r}% per annum for ${t} years.`,
            `${fmt(si)} taka`,
            `SI = P × R × T ÷ 100 = ${p} × ${r} × ${t} ÷ 100 = ${fmt(si)}.`,
            numericDistractors(si, `si-${p}-${r}-${t}`).map((d) => `${d} taka`),
          ),
        );
      }
  // Compound interest, 2 years, compounded annually (values chosen so results are exact)
  const ci: Array<[number, number]> = [
    [1000, 10],
    [2000, 10],
    [5000, 10],
    [10000, 10],
    [400, 5],
    [800, 5],
    [1600, 5],
    [4000, 5],
    [8000, 5],
    [500, 20],
    [1000, 20],
    [2500, 20],
    [10000, 20],
    [625, 4],
    [2500, 4],
  ];
  for (const [p, r] of ci) {
    const amount = p * (1 + r / 100) ** 2;
    const c = Math.round((amount - p) * 100) / 100;
    const simple = (p * r * 2) / 100;
    out.push(
      mk(
        'arithmetic',
        'interest',
        `ci-${p}-${r}`,
        'MEDIUM',
        `What is the compound interest on ${p} taka for 2 years at ${r}% per annum, compounded annually?`,
        `${fmt(c)} taka`,
        `Amount = ${p} × (1 + ${r}/100)² = ${fmt(amount)}; CI = ${fmt(amount)} − ${p} = ${fmt(c)}.`,
        [`${fmt(simple)} taka`, `${fmt(c + p / 100)} taka`, `${fmt(amount)} taka`, `${fmt(c * 2)} taka`],
      ),
    );
    out.push(
      mk(
        'arithmetic',
        'interest',
        `ci-si-${p}-${r}`,
        'HARD',
        `For ${p} taka at ${r}% per annum for 2 years, what is the difference between compound interest (annual) and simple interest?`,
        `${fmt(Math.round(c - simple) === c - simple ? c - simple : Math.round((c - simple) * 100) / 100)} taka`,
        `For 2 years, CI − SI = P × (R/100)² = ${p} × (${r}/100)² = ${fmt(c - simple)}.`,
        [
          `${fmt((c - simple) * 2)} taka`,
          `${fmt(simple)} taka`,
          `${fmt(c - simple + r)} taka`,
          `${fmt((c - simple) / 2)} taka`,
        ],
      ),
    );
  }
  return out;
}

export function ratio(): Out {
  const out: Out = [];
  for (const [a, b] of [
    [2, 3],
    [3, 5],
    [4, 5],
    [5, 7],
    [1, 4],
    [3, 4],
    [2, 7],
    [5, 8],
    [7, 9],
    [3, 7],
  ])
    for (const mult of [12, 15, 20, 24, 30, 40, 60, 100]) {
      const total = (a + b) * mult;
      if ((a * mult) % 7 === 3) continue;
      out.push(
        mk(
          'arithmetic',
          'ratio',
          `share-${a}-${b}-${mult}`,
          'EASY',
          `Divide ${total} taka between A and B in the ratio ${a} : ${b}. What is B's share?`,
          `${b * mult} taka`,
          `Total parts = ${a + b}; one part = ${total} ÷ ${a + b} = ${mult}; B = ${b} × ${mult} = ${b * mult}.`,
          [
            `${a * mult} taka`,
            `${b * mult + mult} taka`,
            `${Math.round(total / 2)} taka`,
            `${b * mult - mult} taka`,
          ],
        ),
      );
    }
  for (const [a, b, c, d] of [
    [2, 3, 4, 5],
    [3, 4, 5, 6],
    [1, 2, 3, 4],
    [5, 6, 7, 8],
    [2, 5, 3, 4],
  ]) {
    // A:B = a:b, B:C = c:d → A:B:C = ac : bc : bd
    const g = gcd(gcd(a * c, b * c), b * d);
    const ans = `${(a * c) / g} : ${(b * c) / g} : ${(b * d) / g}`;
    out.push(
      mk(
        'arithmetic',
        'ratio',
        `chain-${a}${b}${c}${d}`,
        'MEDIUM',
        `If A : B = ${a} : ${b} and B : C = ${c} : ${d}, then A : B : C = ?`,
        ans,
        `Make B common: A:B = ${a * c}:${b * c}, B:C = ${b * c}:${b * d} → ${ans}.`,
        [
          `${a} : ${b} : ${d}`,
          `${a * d} : ${b * c} : ${b * d}`,
          `${c} : ${a} : ${d}`,
          `${a + c} : ${b} : ${d}`,
        ],
      ),
    );
  }
  return out;
}

export function average(): Out {
  const out: Out = [];
  const sets = [
    [12, 18, 24, 30],
    [45, 55, 65],
    [7, 14, 21, 28, 35],
    [10, 20, 30, 40, 50],
    [11, 13, 17, 19],
    [25, 35, 45, 55, 65, 75],
    [6, 9, 12, 15, 18],
    [100, 120, 140, 160],
    [32, 48, 64],
    [15, 25, 35, 45],
    [8, 16, 24, 32, 40, 48],
    [21, 27, 33, 39],
    [5, 10, 15],
    [60, 70, 80, 90, 100],
    [13, 26, 39, 52],
  ];
  for (const s of sets) {
    const avg = s.reduce((a, b) => a + b, 0) / s.length;
    out.push(
      mk(
        'arithmetic',
        'average',
        `set-${s.join('-')}`,
        'EASY',
        `Find the average of ${s.join(', ')}.`,
        avg,
        `Sum = ${s.reduce((a, b) => a + b, 0)}; count = ${s.length}; average = ${fmt(avg)}.`,
      ),
    );
  }
  for (const n of [9, 11, 15, 19, 21, 25, 31, 41, 49, 51, 99, 101])
    out.push(
      mk(
        'arithmetic',
        'average',
        `natural-${n}`,
        'EASY',
        `What is the average of the first ${n} natural numbers?`,
        (n + 1) / 2,
        `Average of 1…n = (n + 1) ÷ 2 = ${(n + 1) / 2}.`,
      ),
    );
  for (const [n, avg, newAvg] of [
    [10, 20, 22],
    [5, 40, 42],
    [20, 15, 16],
    [8, 30, 31],
    [12, 25, 27],
    [6, 50, 48],
    [15, 18, 19],
    [25, 40, 41],
  ]) {
    const added = newAvg * (n + 1) - avg * n;
    out.push(
      mk(
        'arithmetic',
        'average',
        `added-${n}-${avg}-${newAvg}`,
        'MEDIUM',
        `The average of ${n} numbers is ${avg}. When one more number is added, the average becomes ${newAvg}. What is the new number?`,
        added,
        `New total = ${newAvg} × ${n + 1} = ${newAvg * (n + 1)}; old total = ${avg * n}; new number = ${added}.`,
      ),
    );
  }
  return out;
}

export function speed(): Out {
  const out: Out = [];
  for (const s of [30, 36, 40, 45, 48, 50, 54, 60, 72, 75, 80, 90])
    for (const t of [1.5, 2, 2.5, 3, 4, 5]) {
      const d = s * t;
      if (!Number.isInteger(d) || (s + t * 2) % 3 === 0) continue;
      out.push(
        mk(
          'arithmetic',
          'time-speed-distance',
          `d-${s}-${t}`,
          'EASY',
          `A bus travels at ${s} km/h for ${t} hours. How far does it go?`,
          `${d} km`,
          `Distance = speed × time = ${s} × ${t} = ${d} km.`,
          numericDistractors(d, `d-${s}-${t}`).map((x) => `${x} km`),
        ),
      );
    }
  for (const kmh of [18, 36, 54, 72, 90, 108, 126, 144])
    out.push(
      mk(
        'arithmetic',
        'time-speed-distance',
        `ms-${kmh}`,
        'EASY',
        `${kmh} km/h is equal to how many metres per second?`,
        `${(kmh * 5) / 18} m/s`,
        `Multiply by 5/18: ${kmh} × 5 ÷ 18 = ${(kmh * 5) / 18} m/s.`,
        [`${kmh / 2} m/s`, `${(kmh * 18) / 5} m/s`, `${(kmh * 5) / 18 + 5} m/s`, `${kmh / 10} m/s`],
      ),
    );
  for (const [len, kmh] of [
    [100, 36],
    [150, 54],
    [200, 72],
    [120, 36],
    [240, 72],
    [180, 54],
    [300, 90],
    [250, 90],
    [360, 108],
    [140, 63],
  ]) {
    const ms = (kmh * 5) / 18;
    const t = len / ms;
    if (!Number.isInteger(t)) continue;
    out.push(
      mk(
        'arithmetic',
        'time-speed-distance',
        `pole-${len}-${kmh}`,
        'MEDIUM',
        `A train ${len} m long runs at ${kmh} km/h. How long does it take to pass a pole?`,
        `${t} seconds`,
        `${kmh} km/h = ${ms} m/s; time = ${len} ÷ ${ms} = ${t} s.`,
        numericDistractors(t, `pole-${len}-${kmh}`).map((x) => `${x} seconds`),
      ),
    );
  }
  // Average speed for equal distances
  for (const [a, b] of [
    [40, 60],
    [30, 60],
    [20, 30],
    [36, 45],
    [60, 90],
    [40, 120],
    [50, 75],
    [12, 24],
  ]) {
    const avg = (2 * a * b) / (a + b);
    out.push(
      mk(
        'arithmetic',
        'time-speed-distance',
        `avg-${a}-${b}`,
        'HARD',
        `A person goes to a town at ${a} km/h and returns at ${b} km/h. What is the average speed for the whole journey?`,
        `${fmt(avg)} km/h`,
        `For equal distances, average speed = 2ab ÷ (a + b) = 2 × ${a} × ${b} ÷ ${a + b} = ${fmt(avg)} km/h.`,
        [`${(a + b) / 2} km/h`, `${fmt(avg + 2)} km/h`, `${fmt(Math.sqrt(a * b))} km/h`, `${b - a} km/h`],
      ),
    );
  }
  return out;
}

export function work(): Out {
  const out: Out = [];
  for (let a = 4; a <= 40; a++)
    for (let b = a + 1; b <= 60; b++) {
      if ((a * b) % (a + b) !== 0) continue;
      const t = (a * b) / (a + b);
      out.push(
        mk(
          'arithmetic',
          'time-work',
          `together-${a}-${b}`,
          'MEDIUM',
          `A can finish a job in ${a} days and B in ${b} days. Working together, in how many days will they finish it?`,
          `${t} days`,
          `Together per day = 1/${a} + 1/${b} = ${a + b}/${a * b}; time = ${a * b} ÷ ${a + b} = ${t} days.`,
          [`${(a + b) / 2} days`, `${t + 1} days`, `${Math.max(1, t - 1)} days`, `${b - a} days`].filter(
            (x) => x !== `${t} days`,
          ),
        ),
      );
    }
  return out;
}

export function lcmHcf(): Out {
  const out: Out = [];
  const pairs = [
    [12, 18],
    [15, 25],
    [24, 36],
    [16, 40],
    [21, 28],
    [18, 30],
    [14, 35],
    [20, 48],
    [27, 36],
    [32, 48],
    [45, 60],
    [36, 54],
    [42, 56],
    [25, 40],
    [9, 15],
    [8, 12],
    [30, 45],
    [48, 72],
    [26, 39],
    [22, 33],
  ];
  for (const [a, b] of pairs) {
    out.push(
      mk(
        'arithmetic',
        'lcm-hcf',
        `hcf-${a}-${b}`,
        'EASY',
        `What is the HCF (GCD) of ${a} and ${b}?`,
        gcd(a, b),
        `Common factors of ${a} and ${b}: the greatest is ${gcd(a, b)}.`,
      ),
    );
    out.push(
      mk(
        'arithmetic',
        'lcm-hcf',
        `lcm-${a}-${b}`,
        'EASY',
        `What is the LCM of ${a} and ${b}?`,
        lcm(a, b),
        `LCM = (${a} × ${b}) ÷ HCF = ${a * b} ÷ ${gcd(a, b)} = ${lcm(a, b)}.`,
      ),
    );
  }
  for (const [a, b, c] of [
    [4, 6, 8],
    [6, 8, 12],
    [5, 10, 15],
    [3, 4, 5],
    [8, 12, 16],
    [9, 12, 18],
    [10, 15, 20],
    [6, 9, 15],
  ]) {
    const l = lcm(lcm(a, b), c);
    out.push(
      mk(
        'arithmetic',
        'lcm-hcf',
        `bells-${a}-${b}-${c}`,
        'MEDIUM',
        `Three bells ring at intervals of ${a}, ${b} and ${c} minutes. If they ring together now, after how many minutes will they next ring together?`,
        `${l} minutes`,
        `They ring together after LCM(${a}, ${b}, ${c}) = ${l} minutes.`,
        [`${a * b * c} minutes`, `${l / 2} minutes`, `${l + a} minutes`, `${a + b + c} minutes`],
      ),
    );
  }
  for (const [h, l, x] of [
    [6, 36, 12],
    [4, 48, 12],
    [5, 60, 15],
    [3, 42, 21],
    [8, 96, 24],
    [7, 84, 21],
  ]) {
    const y = (h * l) / x;
    out.push(
      mk(
        'arithmetic',
        'lcm-hcf',
        `product-${h}-${l}-${x}`,
        'MEDIUM',
        `The HCF of two numbers is ${h} and their LCM is ${l}. If one number is ${x}, what is the other?`,
        y,
        `Product of numbers = HCF × LCM = ${h * l}; other = ${h * l} ÷ ${x} = ${y}.`,
      ),
    );
  }
  return out;
}

function isPrime(n: number) {
  if (n < 2) return false;
  for (let i = 2; i * i <= n; i++) if (n % i === 0) return false;
  return true;
}

export function numberSystem(): Out {
  const out: Out = [];
  const composites = Array.from({ length: 200 }, (_, i) => i + 4).filter(
    (n) => !isPrime(n) && n % 2 === 1 && n % 5 !== 0,
  );
  const primes = Array.from({ length: 200 }, (_, i) => i + 10).filter(isPrime);
  primes.forEach((p, i) => {
    const ds = [
      composites[(i * 3) % composites.length],
      composites[(i * 3 + 1) % composites.length],
      composites[(i * 3 + 2) % composites.length],
    ].map(String);
    out.push(
      mk(
        'arithmetic',
        'number-system',
        `prime-${p}`,
        'EASY',
        'Which of the following is a prime number?',
        String(p),
        `${p} has no divisors other than 1 and itself; the others are composite (e.g. ${ds[0]} = ${smallestFactor(Number(ds[0]))} × ${Number(ds[0]) / smallestFactor(Number(ds[0]))}).`,
        ds,
      ),
    );
  });
  for (const [n, k] of [
    [1000, 7],
    [500, 9],
    [250, 13],
    [999, 11],
    [1234, 8],
    [800, 17],
    [2000, 23],
    [345, 12],
    [777, 19],
    [5000, 31],
    [123, 4],
    [650, 15],
  ]) {
    const add = (k - (n % k)) % k;
    out.push(
      mk(
        'arithmetic',
        'number-system',
        `add-${n}-${k}`,
        'MEDIUM',
        `What is the smallest number that must be added to ${n} to make it exactly divisible by ${k}?`,
        add,
        `${n} ÷ ${k} leaves remainder ${n % k}; add ${k} − ${n % k} = ${add}.`,
        numericDistractors(add, `add-${n}-${k}`, { min: 0 }),
      ),
    );
  }
  for (const n of [10, 15, 20, 25, 30, 40, 50, 60, 75, 100])
    out.push(
      mk(
        'arithmetic',
        'number-system',
        `sum-${n}`,
        'EASY',
        `What is the sum of the first ${n} natural numbers?`,
        (n * (n + 1)) / 2,
        `Sum = n(n + 1) ÷ 2 = ${n} × ${n + 1} ÷ 2 = ${(n * (n + 1)) / 2}.`,
      ),
    );
  for (const n of [5, 10, 15, 20, 25, 30])
    out.push(
      mk(
        'arithmetic',
        'number-system',
        `odd-sum-${n}`,
        'MEDIUM',
        `What is the sum of the first ${n} odd numbers?`,
        n * n,
        `The sum of the first n odd numbers is n² = ${n * n}.`,
      ),
    );
  return out;
}

function smallestFactor(n: number) {
  for (let i = 2; i <= n; i++) if (n % i === 0) return i;
  return n;
}

export function fractions(): Out {
  const out: Out = [];
  const fr = (a: number, b: number) => {
    const g = gcd(a, b);
    return b / g === 1 ? `${a / g}` : `${a / g}/${b / g}`;
  };
  const list: Array<[number, number, number, number]> = [
    [1, 2, 1, 3],
    [2, 3, 1, 4],
    [3, 4, 1, 6],
    [1, 5, 2, 3],
    [5, 6, 1, 4],
    [2, 5, 3, 10],
    [3, 8, 1, 4],
    [1, 6, 1, 9],
    [4, 7, 1, 2],
    [2, 9, 5, 6],
    [7, 12, 1, 8],
    [3, 5, 2, 7],
  ];
  for (const [a, b, c, d] of list) {
    const sum = fr(a * d + c * b, b * d);
    out.push(
      mk(
        'arithmetic',
        'fractions',
        `add-${a}${b}${c}${d}`,
        'EASY',
        `${a}/${b} + ${c}/${d} = ?`,
        sum,
        `LCD ${(b * d) / gcd(b, d)}: result ${sum}.`,
        [fr(a + c, b + d), fr(a * c, b * d), fr(a * d + c * b + 1, b * d)],
      ),
    );
    const prod = fr(a * c, b * d);
    out.push(
      mk(
        'arithmetic',
        'fractions',
        `mul-${a}${b}${c}${d}`,
        'EASY',
        `${a}/${b} × ${c}/${d} = ?`,
        prod,
        `Multiply numerators and denominators: ${a * c}/${b * d} = ${prod}.`,
        [fr(a + c, b + d), fr(a * d, b * c), fr(a * d + c * b, b * d)]
          .filter((x) => x !== prod)
          .concat([fr(a * c + 1, b * d)]),
      ),
    );
  }
  return out;
}

export function ages(): Out {
  const out: Out = [];
  for (const k of [2, 3, 4, 5])
    for (const b of [5, 6, 8, 9, 10, 12, 14, 15]) {
      const sum = b * (k + 1);
      if ((b + k) % 2 === 0) continue;
      out.push(
        mk(
          'arithmetic',
          'ages',
          `times-${k}-${b}`,
          'MEDIUM',
          `A father is ${k} times as old as his son. The sum of their ages is ${sum} years. How old is the son?`,
          `${b} years`,
          `Son = x, father = ${k}x; ${k + 1}x = ${sum} → x = ${b}.`,
          [`${b * k} years`, `${b + 2} years`, `${Math.max(1, b - 2)} years`, `${sum / 2} years`],
        ),
      );
    }
  for (const [now, years, ratioAfter] of [
    [10, 5, 2],
    [12, 4, 3],
    [8, 8, 2],
    [20, 10, 2],
    [15, 5, 3],
  ]) {
    const other = (now + years) * ratioAfter - years;
    out.push(
      mk(
        'arithmetic',
        'ages',
        `future-${now}-${years}-${ratioAfter}`,
        'HARD',
        `Rafi is ${now} years old. After ${years} years his mother will be ${ratioAfter} times as old as Rafi. How old is his mother now?`,
        `${other} years`,
        `After ${years} years Rafi is ${now + years}; mother then = ${(now + years) * ratioAfter}; now = ${other}.`,
        [
          `${now * ratioAfter} years`,
          `${other + years} years`,
          `${other - years} years`,
          `${(now + years) * ratioAfter} years`,
        ],
      ),
    );
  }
  return out;
}

export function boats(): Out {
  const out: Out = [];
  for (const [u, v] of [
    [10, 2],
    [12, 3],
    [15, 5],
    [8, 2],
    [20, 4],
    [14, 4],
    [18, 6],
    [9, 3],
    [11, 1],
    [16, 2],
  ]) {
    out.push(
      mk(
        'arithmetic',
        'boats-streams',
        `still-${u}-${v}`,
        'MEDIUM',
        `A boat goes downstream at ${u + v} km/h and upstream at ${u - v} km/h. What is its speed in still water?`,
        `${u} km/h`,
        `Still water speed = (downstream + upstream) ÷ 2 = (${u + v} + ${u - v}) ÷ 2 = ${u}.`,
        [`${v} km/h`, `${u + v} km/h`, `${u - v} km/h`, `${2 * u} km/h`],
      ),
    );
    out.push(
      mk(
        'arithmetic',
        'boats-streams',
        `stream-${u}-${v}`,
        'MEDIUM',
        `A boat goes downstream at ${u + v} km/h and upstream at ${u - v} km/h. What is the speed of the current?`,
        `${v} km/h`,
        `Current = (downstream − upstream) ÷ 2 = ${v}.`,
        [`${u} km/h`, `${2 * v} km/h`, `${u - v} km/h`, `${v + 1} km/h`],
      ),
    );
  }
  return out;
}

export function units(): Out {
  const out: Out = [];
  const rows: Array<[string, number, string, number]> = [
    ['km', 1, 'm', 1000],
    ['m', 1, 'cm', 100],
    ['kg', 1, 'g', 1000],
    ['hour', 1, 'minutes', 60],
    ['day', 1, 'hours', 24],
    ['dozen', 1, 'items', 12],
    ['score', 1, 'items', 20],
    ['gross', 1, 'items', 144],
    ['litre', 1, 'millilitres', 1000],
    ['minute', 1, 'seconds', 60],
    ['quintal', 1, 'kg', 100],
    ['tonne (metric)', 1, 'kg', 1000],
  ];
  for (const [u, , v, f] of rows)
    for (const n of [2, 3, 5, 7.5]) {
      const ans = n * f;
      out.push(
        mk(
          'arithmetic',
          'unit-conversion',
          `${u}-${n}`,
          'EASY',
          `${n} ${u}${n !== 1 && !u.includes('(') ? '' : ''} = how many ${v}?`,
          `${fmt(ans)} ${v}`,
          `1 ${u} = ${f} ${v}; ${n} × ${f} = ${fmt(ans)}.`,
          numericDistractors(ans, `${u}-${n}`).map((x) => `${x} ${v}`),
        ),
      );
    }
  out.push(
    mk(
      'arithmetic',
      'unit-conversion',
      'hectare-acre',
      'MEDIUM',
      'How many square metres are there in one hectare?',
      '10000 m²',
      '1 hectare = 100 m × 100 m = 10,000 m².',
      ['1000 m²', '100000 m²', '4047 m²'],
    ),
  );
  return out;
}

export function equations(): Out {
  const out: Out = [];
  for (const a of [2, 3, 4, 5, 6, 7, 8, 9])
    for (const x of [-4, -2, 3, 5, 6, 7, 9, 11, 12]) {
      const b = ((a * x) % 7) + 2;
      if ((a + x) % 3 !== 0) continue;
      const c = a * x + b;
      out.push(
        mk(
          'algebra',
          'linear-equations',
          `lin-${a}-${x}`,
          'EASY',
          `Solve for x: ${a}x + ${b} = ${c}`,
          x,
          `${a}x = ${c} − ${b} = ${c - b}; x = ${c - b} ÷ ${a} = ${x}.`,
          numericDistractors(x, `lin-${a}-${x}`, { min: -100 }),
        ),
      );
    }
  for (const [s, d] of [
    [20, 4],
    [30, 10],
    [50, 12],
    [16, 6],
    [40, 8],
    [25, 7],
    [100, 20],
    [36, 14],
  ]) {
    const big = (s + d) / 2;
    out.push(
      mk(
        'algebra',
        'linear-equations',
        `sumdiff-${s}-${d}`,
        'MEDIUM',
        `The sum of two numbers is ${s} and their difference is ${d}. What is the larger number?`,
        big,
        `Larger = (sum + difference) ÷ 2 = (${s} + ${d}) ÷ 2 = ${big}.`,
      ),
    );
  }
  return out;
}

export function powers(): Out {
  const out: Out = [];
  for (let n = 11; n <= 45; n++) {
    out.push(
      mk(
        'algebra',
        'powers',
        `sq-${n}`,
        n > 30 ? 'MEDIUM' : 'EASY',
        `${n}² = ?`,
        n * n,
        `${n} × ${n} = ${n * n}.`,
      ),
    );
    if (n % 2 === 0 || n > 35)
      out.push(
        mk(
          'algebra',
          'powers',
          `root-${n}`,
          'EASY',
          `√${n * n} = ?`,
          n,
          `${n} × ${n} = ${n * n}, so √${n * n} = ${n}.`,
        ),
      );
  }
  for (let n = 2; n <= 15; n++)
    out.push(
      mk(
        'algebra',
        'powers',
        `cube-${n}`,
        n > 10 ? 'MEDIUM' : 'EASY',
        `${n}³ = ?`,
        n ** 3,
        `${n} × ${n} × ${n} = ${n ** 3}.`,
      ),
    );
  for (const [b, e] of [
    [2, 10],
    [2, 8],
    [3, 5],
    [5, 4],
    [10, 6],
    [4, 5],
    [2, 12],
    [3, 6],
  ])
    out.push(
      mk(
        'algebra',
        'powers',
        `pow-${b}-${e}`,
        'MEDIUM',
        `${b}^${e} = ?`,
        b ** e,
        `${b} multiplied by itself ${e} times = ${b ** e}.`,
      ),
    );
  return out;
}

export function mensuration(): Out {
  const out: Out = [];
  for (const [l, w] of [
    [12, 8],
    [15, 10],
    [20, 14],
    [25, 12],
    [18, 9],
    [30, 20],
    [16, 11],
    [22, 15],
    [40, 25],
    [13, 7],
  ]) {
    out.push(
      mk(
        'geometry',
        'mensuration',
        `rect-a-${l}-${w}`,
        'EASY',
        `What is the area of a rectangle ${l} m long and ${w} m wide?`,
        `${l * w} m²`,
        `Area = length × width = ${l} × ${w} = ${l * w} m².`,
        [`${2 * (l + w)} m²`, `${l * w + l} m²`, `${l + w} m²`, `${(l * w) / 2} m²`],
      ),
    );
    out.push(
      mk(
        'geometry',
        'mensuration',
        `rect-p-${l}-${w}`,
        'EASY',
        `What is the perimeter of a rectangle ${l} m long and ${w} m wide?`,
        `${2 * (l + w)} m`,
        `Perimeter = 2(l + w) = 2 × ${l + w} = ${2 * (l + w)} m.`,
        [`${l * w} m`, `${l + w} m`, `${2 * (l + w) + 4} m`, `${4 * l} m`],
      ),
    );
  }
  for (const r of [7, 14, 21, 28, 35, 42]) {
    out.push(
      mk(
        'geometry',
        'mensuration',
        `circle-a-${r}`,
        'MEDIUM',
        `Taking π = 22/7, what is the area of a circle of radius ${r} cm?`,
        `${(22 / 7) * r * r} cm²`,
        `Area = πr² = 22/7 × ${r} × ${r} = ${(22 / 7) * r * r} cm².`,
        [
          `${2 * (22 / 7) * r} cm²`,
          `${(22 / 7) * r * r * 2} cm²`,
          `${r * r} cm²`,
          `${(22 / 7) * r * r + 22} cm²`,
        ],
      ),
    );
    out.push(
      mk(
        'geometry',
        'mensuration',
        `circle-c-${r}`,
        'EASY',
        `Taking π = 22/7, what is the circumference of a circle of radius ${r} cm?`,
        `${2 * (22 / 7) * r} cm`,
        `Circumference = 2πr = 2 × 22/7 × ${r} = ${2 * (22 / 7) * r} cm.`,
        [`${(22 / 7) * r * r} cm`, `${(22 / 7) * r} cm`, `${2 * (22 / 7) * r + 7} cm`, `${4 * r} cm`],
      ),
    );
  }
  for (const [a, b, c] of [
    [3, 4, 5],
    [6, 8, 10],
    [5, 12, 13],
    [8, 15, 17],
    [9, 12, 15],
    [12, 16, 20],
    [7, 24, 25],
    [20, 21, 29],
  ]) {
    out.push(
      mk(
        'geometry',
        'mensuration',
        `hyp-${a}-${b}`,
        'MEDIUM',
        `The two shorter sides of a right-angled triangle are ${a} cm and ${b} cm. What is the hypotenuse?`,
        `${c} cm`,
        `By Pythagoras: √(${a}² + ${b}²) = √${a * a + b * b} = ${c}.`,
        [`${a + b} cm`, `${c + 1} cm`, `${c - 2} cm`, `${Math.round((a + b) / 1.5)} cm`],
      ),
    );
    out.push(
      mk(
        'geometry',
        'mensuration',
        `tri-a-${a}-${b}`,
        'EASY',
        `What is the area of a right-angled triangle with legs ${a} cm and ${b} cm?`,
        `${(a * b) / 2} cm²`,
        `Area = ½ × base × height = ½ × ${a} × ${b} = ${(a * b) / 2} cm².`,
        [`${a * b} cm²`, `${(a * c) / 2} cm²`, `${a + b + c} cm²`, `${(a * b) / 2 + a} cm²`],
      ),
    );
  }
  for (const s of [5, 8, 10, 12, 15])
    out.push(
      mk(
        'geometry',
        'mensuration',
        `cube-v-${s}`,
        'EASY',
        `What is the volume of a cube with edge ${s} cm?`,
        `${s ** 3} cm³`,
        `Volume = a³ = ${s ** 3} cm³.`,
        [`${6 * s * s} cm³`, `${s * s} cm³`, `${12 * s} cm³`, `${s ** 3 + s} cm³`],
      ),
    );
  for (let n = 5; n <= 12; n++)
    out.push(
      mk(
        'geometry',
        'mensuration',
        `polygon-${n}`,
        'MEDIUM',
        `What is the sum of the interior angles of a polygon with ${n} sides?`,
        `${(n - 2) * 180}°`,
        `Sum = (n − 2) × 180° = ${n - 2} × 180° = ${(n - 2) * 180}°.`,
        [`${n * 180}°`, `${(n - 1) * 180}°`, `${(n - 3) * 180}°`, `${360 * n}°`],
      ),
    );
  return out;
}

export function clocks(): Out {
  const out: Out = [];
  for (let h = 1; h <= 11; h++)
    for (const m of [0, 30]) {
      let a = Math.abs(30 * h - 5.5 * m);
      a = Math.min(a, 360 - a);
      const time = `${h}:${m === 0 ? '00' : '30'}`;
      out.push(
        mk(
          'geometry',
          'clock-angles',
          `clock-${h}-${m}`,
          m === 0 ? 'EASY' : 'MEDIUM',
          `What is the smaller angle between the hour and minute hands of a clock at ${time}?`,
          `${fmt(a)}°`,
          `Angle = |30H − 5.5M| = |${30 * h} − ${5.5 * m}| = ${fmt(Math.abs(30 * h - 5.5 * m))}°; smaller angle ${fmt(a)}°.`,
          [
            `${fmt(Math.abs(30 * h - 6 * m) % 360)}°`,
            `${fmt(a + 15)}°`,
            `${fmt(360 - a)}°`,
            `${fmt(Math.abs(a - 30))}°`,
          ].filter((x) => x !== `${fmt(a)}°`),
        ),
      );
    }
  return out;
}

export const jobOnly = JOB_EXAMS;

export function allMathematics(): Out {
  return [
    ...percentage(),
    ...profitLoss(),
    ...interest(),
    ...ratio(),
    ...average(),
    ...speed(),
    ...work(),
    ...lcmHcf(),
    ...numberSystem(),
    ...fractions(),
    ...ages(),
    ...boats(),
    ...units(),
    ...equations(),
    ...powers(),
    ...mensuration(),
    ...clocks(),
  ];
}
