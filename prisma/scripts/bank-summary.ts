import { bankSummary, buildQuestionBank } from '../question-bank';

const bank = buildQuestionBank();
console.log(JSON.stringify(bankSummary(bank), null, 2));
