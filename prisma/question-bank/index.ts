import { allGeneralKnowledge } from './generators/general-knowledge';
import { allLanguages } from './generators/languages';
import { allMathematics } from './generators/mathematics';
import { allReasoningIct } from './generators/reasoning-ict';
import { TAXONOMY } from './taxonomy';
import { BankQuestion } from './types';

export { TAXONOMY };

/**
 * Builds the Quiz Master original practice bank. Every item is either computed (maths, reasoning, number
 * systems, logic) or drawn from a curated list of stable, well-established facts. None of it is presented as an
 * official past-paper question. Throws on any structural problem so a bad generator can never ship.
 */
export function buildQuestionBank(): BankQuestion[] {
  const all = [...allMathematics(), ...allReasoningIct(), ...allLanguages(), ...allGeneralKnowledge()];
  const seenKeys = new Set<string>();
  const seenStems = new Map<string, string>();
  const out: BankQuestion[] = [];
  for (const item of all) {
    if (seenKeys.has(item.key)) throw new Error(`Duplicate bank key ${item.key}`);
    seenKeys.add(item.key);
    const t = TAXONOMY[item.subject]?.chapters[item.chapter]?.topics[item.topic];
    if (!t)
      throw new Error(`Unknown taxonomy for ${item.key}: ${item.subject}/${item.chapter}/${item.topic}`);
    if (item.options.length !== 4 || new Set(item.options).size !== 4)
      throw new Error(`Options must be 4 unique values: ${item.key}`);
    if (item.correct < 0 || item.correct > 3) throw new Error(`Invalid answer index: ${item.key}`);
    // Identical stem + identical option set would be a true duplicate; skip it rather than ship twice.
    const sig = `${item.stem}|${[...item.options].sort().join('|')}`;
    if (seenStems.has(sig)) continue;
    seenStems.set(sig, item.key);
    out.push(item);
  }
  return out;
}

export function bankSummary(bank: BankQuestion[]) {
  const by: Record<string, number> = {};
  for (const q of bank) by[q.subject] = (by[q.subject] ?? 0) + 1;
  return { total: bank.length, bySubject: by };
}
