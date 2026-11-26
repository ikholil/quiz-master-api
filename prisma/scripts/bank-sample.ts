import { buildQuestionBank } from '../question-bank';
import { seededRandom, shuffle } from '../../src/common/utils/random.util';

const bank = buildQuestionBank();
const n = Number(process.argv[2] ?? 20);
for (const item of shuffle(bank, seededRandom(process.argv[3] ?? 'sample')).slice(0, n)) {
  console.log(`[${item.subject}/${item.topic} ${item.difficulty}] ${item.stem}`);
  item.options.forEach((o, i) => console.log(`   ${i === item.correct ? '✔' : ' '} ${'ABCD'[i]}. ${o}`));
}
