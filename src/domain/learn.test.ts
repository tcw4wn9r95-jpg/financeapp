import { describe, expect, it } from 'vitest';
import { classify, acceptSuggestion, unclassify } from './reconcile';
import { planImport } from './import/plan';
import {
  aiPrompt,
  aiTargets,
  amountBucket,
  applyDecisions,
  autoApplied,
  countryOf,
  DEFAULT_THRESHOLD,
  examplesFromChanges,
  exampleFor,
  historyMatch,
  learn,
  learnOnImport,
  predictTargets,
  filterLog,
  type FiledRow,
  matchRule,
  readAiAnswers,
  redact,
  ruleFromProposal,
  ruleProposals,
  type LearnContext,
} from './learn';
import { testClock } from './testkit';
import type { Account, Allocation, Category, Rule, Transaction, TrainingExample } from './types';

const base = { createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', source: 'manual' as const };
const eur = (n: number) => Math.round(n * 100);

const accounts: Account[] = [
  { ...base, id: 'bank', name: 'Joint', type: 'current', institution: '', ibanLast4: '1111', openingBalance: 0 },
  { ...base, id: 'sav', name: 'Savings', type: 'savings', institution: '', ibanLast4: '2222', openingBalance: 0 },
];
const categories: Category[] = [
  { ...base, id: 'groceries', name: 'Groceries', groupId: 'variable', rolloverMode: 'roll', isIncome: false, sortOrder: 0 },
  { ...base, id: 'eating', name: 'Eating out', groupId: 'variable', rolloverMode: 'roll', isIncome: false, sortOrder: 1 },
  { ...base, id: 'salary', name: 'Salary', groupId: 'fixed', rolloverMode: 'reset', isIncome: true, sortOrder: 2 },
  { ...base, id: 'old', name: 'Old', groupId: 'variable', rolloverMode: 'roll', isIncome: false, sortOrder: 3, archivedAt: '2026-02-01T00:00:00.000Z' },
];

let n = 0;
function tx(merchant: string, amount: number, over: Partial<Transaction> = {}): Transaction {
  n++;
  return {
    ...base,
    id: `t${n}`,
    accountId: 'bank',
    date: `2026-03-${String((n % 27) + 1).padStart(2, '0')}`,
    amount: eur(amount),
    descriptionRaw: merchant,
    merchantNorm: merchant.toUpperCase(),
    counterparty: '',
    status: 'new',
    ...over,
  };
}

function example(merchant: string, amount: number, targetId: string, when: string, targetType: 'category' | 'income' = 'category'): TrainingExample {
  const t = tx(merchant, amount);
  const clock = { now: () => when, newId: () => `e-${when}-${merchant}-${n}` };
  return exampleFor(t, { targetType, targetId }, clock);
}

const rule = (over: Partial<Rule>): Rule => ({
  ...base,
  id: `r${Math.random()}`,
  priority: 10,
  conditions: {},
  action: { targetType: 'category', targetId: 'groceries' },
  hits: 0,
  createdFrom: 'user',
  ...over,
});

const ctx = (over: Partial<LearnContext> = {}): LearnContext => ({ rules: [], examples: [], accounts, categories, threshold: DEFAULT_THRESHOLD, ...over });

describe('features', () => {
  it('buckets amounts by direction and size', () => {
    expect(amountBucket(eur(-3.2))).toBe('out:0-5');
    expect(amountBucket(eur(-42))).toBe('out:25-50');
    expect(amountBucket(eur(4200))).toBe('in:1000+');
  });
  it('reads a trailing country code', () => {
    expect(countryOf({ descriptionRaw: 'DELHAIZE BERTRANGE LU' })).toBe('LU');
    expect(countryOf({ descriptionRaw: 'Rent April' })).toBe('');
  });
});

describe('rules', () => {
  it('first matching rule by priority wins; amount and account conditions apply', () => {
    const rules = [
      rule({ id: 'big', priority: 5, conditions: { merchantRegex: 'delhaize', amountMin: eur(200) }, action: { targetType: 'category', targetId: 'eating' } }),
      rule({ id: 'any', priority: 10, conditions: { merchantRegex: 'delhaize' } }),
      rule({ id: 'sav', priority: 1, conditions: { accountId: 'sav' } }),
    ];
    expect(matchRule(tx('Delhaize Strassen', -45), rules)?.id).toBe('any');
    expect(matchRule(tx('Delhaize Strassen', -250), rules)?.id).toBe('big');
    expect(matchRule(tx('Cactus', -12), rules)).toBeUndefined();
  });
  it('treats an invalid regular expression as plain text', () => {
    expect(matchRule(tx('SHOP (LU', -5), [rule({ conditions: { merchantRegex: 'shop (lu' } })])).toBeDefined();
  });
  it('a rule applies with confidence 1 and counts its hits', () => {
    const r = rule({ id: 'r1', conditions: { merchantRegex: '^CACTUS' } });
    const out = learn([tx('Cactus Howald', -30), tx('Cactus Bascharage', -12), tx('Aldi', -9)], ctx({ rules: [r] }), testClock());
    expect(out.applied).toBe(2);
    expect(out.allocations.every((a) => a.decidedBy === 'rule' && a.confidence === 1 && a.targetId === 'groceries')).toBe(true);
    expect(out.rules).toEqual([expect.objectContaining({ id: 'r1', hits: 2 })]);
  });
  it('a rule pointing at an archived category is ignored', () => {
    const r = rule({ action: { targetType: 'category', targetId: 'old' }, conditions: { merchantRegex: 'x' } });
    expect(learn([tx('X shop', -5)], ctx({ rules: [r] }), testClock()).applied).toBe(0);
  });
});

describe('history match (kNN)', () => {
  it('one past decision gives a suggestion, not an automatic decision', () => {
    const examples = [example('ALDI', -30, 'groceries', '2026-02-01')];
    const h = historyMatch(tx('Aldi', -28), examples)!;
    expect(h).toMatchObject({ targetId: 'groceries', confidence: 0.8 });
    const out = learn([tx('Aldi', -28)], ctx({ examples }), testClock());
    expect(out).toMatchObject({ applied: 0, suggested: 1 });
    expect(out.transactions[0]!.suggestion).toMatchObject({ decidedBy: 'history', targetId: 'groceries' });
  });
  it('consistent history at or above the threshold is applied', () => {
    const examples = ['01', '02', '03'].map((d) => example('ALDI', -30, 'groceries', `2026-02-${d}`));
    const out = learn([tx('Aldi', -35)], ctx({ examples }), testClock());
    expect(out.applied).toBe(1);
    expect(out.allocations[0]).toMatchObject({ decidedBy: 'history', confidence: 1, reason: 'Like 3 of 3 earlier' });
  });
  it('mixed history gives the share that agrees, below the threshold → suggestion', () => {
    const examples = [
      example('PAUL', -8, 'eating', '2026-02-01'),
      example('PAUL', -9, 'eating', '2026-02-02'),
      example('PAUL', -7, 'groceries', '2026-02-03'),
    ];
    const h = historyMatch(tx('Paul', -8), examples)!;
    expect(h).toMatchObject({ targetId: 'eating', confidence: 0.67, count: 2, of: 3 });
    expect(learn([tx('Paul', -8)], ctx({ examples }), testClock()).applied).toBe(0);
  });
  it('prefers the same amount band and keeps directions apart', () => {
    const examples = [
      example('AMAZON', -20, 'groceries', '2026-02-01'),
      example('AMAZON', -20, 'groceries', '2026-02-02'),
      example('AMAZON', -400, 'eating', '2026-02-03'),
    ];
    expect(historyMatch(tx('Amazon', -450), examples)).toMatchObject({ targetId: 'eating' });
    expect(historyMatch(tx('Amazon', -22), examples)).toMatchObject({ targetId: 'groceries', confidence: 1 });
    expect(historyMatch(tx('Amazon', 20), examples)).toBeUndefined();
  });
  it('the threshold is a setting', () => {
    const examples = [example('PAUL', -8, 'eating', '2026-02-01'), example('PAUL', -9, 'eating', '2026-02-02'), example('PAUL', -7, 'groceries', '2026-02-03')];
    expect(learn([tx('Paul', -8)], ctx({ examples, threshold: 0.6 }), testClock()).applied).toBe(1);
  });
});

describe('recording decisions and proposing rules', () => {
  it('records the user choice; reclassifying replaces it; splits teach nothing', () => {
    const t = tx('Aldi', -30);
    const view = { accounts, transactions: [t], allocations: [] };
    const clock = testClock();
    const ex1 = examplesFromChanges(classify(t, { kind: 'category', categoryId: 'groceries' }, view, clock), clock);
    expect(ex1).toEqual([expect.objectContaining({ id: `ex:${t.id}`, merchantNorm: 'ALDI', chosenTarget: { targetType: 'category', targetId: 'groceries' } })]);
    const ex2 = examplesFromChanges(classify(t, { kind: 'category', categoryId: 'eating' }, view, clock), clock);
    expect(ex2[0]!.id).toBe(ex1[0]!.id);
    const split = classify(t, { kind: 'split', lines: [{ kind: 'category', categoryId: 'groceries', amount: eur(-20) }, { kind: 'category', categoryId: 'eating', amount: eur(-10) }] }, view, clock);
    expect(examplesFromChanges(split, clock)).toEqual([]);
  });
  it('a transfer teaches the other account; an accepted suggestion counts as a confirmation', () => {
    const out = tx('Savings', -100);
    const inn = tx('Savings', 100, { accountId: 'sav' });
    const clock = testClock();
    const view = { accounts, transactions: [out, inn], allocations: [] };
    const ex = examplesFromChanges(classify(out, { kind: 'transfer', accountId: 'sav' }, view, clock), clock);
    expect(ex.find((e) => e.id === `ex:${out.id}`)!.chosenTarget).toEqual({ targetType: 'transfer', targetId: 'sav' });
    const sug = tx('Aldi', -30, { status: 'suggested', suggestion: { targetType: 'category', targetId: 'groceries', confidence: 0.8, decidedBy: 'history', reason: 'x' } });
    expect(examplesFromChanges(acceptSuggestion(sug, { accounts, transactions: [sug], allocations: [] }, clock), clock)).toHaveLength(1);
  });
  it('automatic decisions are not fed back', () => {
    const r = learn([tx('Cactus', -30)], ctx({ rules: [rule({ conditions: { merchantRegex: 'cactus' } })] }), testClock());
    const ch = { putTransactions: r.transactions, putAllocations: r.allocations, deleteTransactions: [], deleteAllocations: [], putStatements: [], deleteStatements: [], deleteBatches: [] };
    expect(examplesFromChanges(ch, testClock())).toEqual([]);
  });
  it('proposes a rule after three consistent confirmations, not when covered or dismissed', () => {
    const two = ['01', '02'].map((d) => example('LIDL', -30, 'groceries', `2026-02-${d}`));
    expect(ruleProposals(two, [])).toEqual([]);
    const three = [...two, example('LIDL', -31, 'groceries', '2026-02-03')];
    expect(ruleProposals(three, [])).toEqual([{ merchantNorm: 'LIDL', target: { targetType: 'category', targetId: 'groceries' }, count: 3 }]);
    expect(ruleProposals([...three, example('LIDL', -5, 'eating', '2026-02-04')], [])).toEqual([]);
    expect(ruleProposals(three, [], ['LIDL'])).toEqual([]);
    const r = ruleFromProposal(ruleProposals(three, [])[0]!, [], testClock());
    expect(r).toMatchObject({ createdFrom: 'hardened', conditions: { merchantRegex: '^LIDL$' } });
    expect(ruleProposals(three, [r])).toEqual([]);
    expect(matchRule(tx('Lidl', -12), [r])).toBeDefined();
  });
  it('lists automatic decisions for undo; undo sends the row back to the inbox', () => {
    const t = tx('Cactus', -30);
    const r = learn([t], ctx({ rules: [rule({ conditions: { merchantRegex: 'cactus' } })] }), testClock());
    const log = autoApplied(r.allocations, r.transactions);
    expect(log).toHaveLength(1);
    const back = unclassify(log[0]!.transaction, { accounts, transactions: r.transactions, allocations: r.allocations }, testClock());
    expect(back.deleteAllocations).toEqual([r.allocations[0]!.id]);
    expect(back.putTransactions[0]!.status).toBe('new');
  });
});

describe('Claude fallback (redaction and answers)', () => {
  it('sends no IBANs, card numbers, household names or ids; transfers are anonymous', () => {
    const items = [
      tx('Card 4111 1111 1111 1111 DELHAIZE LU', -45, { merchantNorm: 'DELHAIZE', descriptionRaw: 'DELHAIZE BERTRANGE LU' }),
      tx('Transfer', -500, { merchantNorm: 'SAM EXAMPLE', descriptionRaw: 'Transfer to Sam Example IBAN LU12 0019 1234 5678 9000', counterpartyIbanLast4: '9000' }),
      tx('Gift shop', -20, { merchantNorm: 'GIFT FOR ALEX REF 123456789' }),
    ];
    const red = redact(items, ['Alex Example', 'Sam Example']);
    expect(red).toEqual([
      { ref: '1', merchant: 'DELHAIZE', amount: -45, date: items[0]!.date, country: 'LU' },
      { ref: '2', merchant: 'PERSONAL TRANSFER', amount: -500, date: items[1]!.date, country: '' },
      { ref: '3', merchant: 'GIFT FOR PERSON REF', amount: -20, date: items[2]!.date, country: '' },
    ]);
    const prompt = aiPrompt(red, aiTargets(categories));
    for (const secret of ['Sam', 'Alex', 'LU12', '9000', 'groceries', 't1']) expect(prompt).not.toContain(secret);
    expect(prompt).toContain('c1: Groceries (expense, variable)');
    expect(prompt).not.toContain('Old');
  });
  it('maps answers back; low confidence suggests, high confidence applies; junk is dropped', () => {
    const items = [tx('Delhaize', -45), tx('Employer', 3000), tx('Mystery', -9)];
    const targets = aiTargets(categories);
    const d = readAiAnswers(
      [
        { ref: '1', target: 'c1', confidence: 0.97, reason: 'supermarket' },
        { ref: '2', target: 'c3', confidence: 0.7, reason: 'salary' },
        { ref: '3', target: 'none', confidence: 0.1, reason: 'unknown' },
        { ref: '9', target: 'c1', confidence: 1, reason: 'no such row' },
      ],
      items,
      targets,
      DEFAULT_THRESHOLD,
    );
    expect(d.size).toBe(2);
    const out = applyDecisions(items, d, testClock());
    expect(out).toMatchObject({ applied: 1, suggested: 1 });
    expect(out.allocations[0]).toMatchObject({ decidedBy: 'ai', targetId: 'groceries', confidence: 0.97 });
    expect(out.transactions[1]!.suggestion).toMatchObject({ decidedBy: 'ai', targetType: 'income', targetId: 'salary' });
    // Income category for money going out is refused.
    expect(readAiAnswers([{ ref: '1', target: 'c3', confidence: 1, reason: '' }], items, targets, 0.9).size).toBe(0);
  });
});

describe('on import', () => {
  it('rules file new rows and history suggests, inside the import batch', () => {
    const row = (line: number, description: string, amount: number) => ({ line, date: '2026-09-0' + line, amount: eur(amount), description, accountKey: '', accountId: 'bank' });
    const planned = planImport(
      { fileName: 'x.csv', format: 'csv', rows: [row(1, 'CACTUS HOWALD', -30), row(2, 'PAUL KIRCHBERG', -8), row(3, 'MYSTERY', -5)], skipped: [], statements: [], warnings: [], budgetStartMonth: '2026-01' },
      { accounts, transactions: [], allocations: [], statements: [] },
      testClock('imp'),
    );
    const examples = [example('PAUL KIRCHBERG', -8, 'eating', '2026-02-01')];
    const r = rule({ id: 'r1', conditions: { merchantRegex: 'cactus' } });
    const { changes, rules } = learnOnImport(planned, ctx({ rules: [r], examples }), testClock('learn'));
    expect(changes.batch.report).toMatchObject({ newCount: 3, autoApplied: 1, suggestions: 1 });
    expect(changes.allocations).toEqual([expect.objectContaining({ decidedBy: 'rule', targetId: 'groceries', source: changes.batch.source })]);
    expect(changes.transactions.map((t) => t.status)).toEqual(['reconciled', 'suggested', 'new']);
    expect(rules[0]!.hits).toBe(1);
  });
});

describe('the monthly provisions move is recognised (D-55)', () => {
  it('a transfer of the planned amount is suggested as a move to the provisions account', () => {
    const c = ctx({ provisionsMove: { accountId: 'sav', byMonth: new Map([['2026-03', eur(350)]]) } });
    const out = learn([tx('Transfer to my other account', -350.4, { date: '2026-03-02' })], c, testClock());
    expect(out.transactions[0]!.suggestion).toMatchObject({ targetType: 'transfer', targetId: 'sav', decidedBy: 'rule' });
    expect(learn([tx('Transfer', -500, { date: '2026-03-02' })], c, testClock()).suggested).toBe(0);
  });
});

describe('predicting the category from what was filed before (D-80)', () => {
  const filed = (desc: string, amount: number, targetId: string, date: string, targetType: 'category' | 'income' = 'category'): FiledRow => ({
    tx: tx(desc, amount, { date, status: 'reconciled' }),
    target: { targetType, targetId },
  });
  const cats = [
    { id: 'groceries', name: 'Groceries', isIncome: false },
    { id: 'eatingOut', name: 'Eating out', isIncome: false },
    { id: 'health', name: 'Health', isIncome: false },
    { id: 'salary', name: 'Salary', isIncome: true },
  ];
  const history = [
    filed('DEBIT TPV AUCHAN KIRCHBERG', -64, 'groceries', '2026-08-01'),
    filed('DEBIT TPV AUCHAN CLOCHE D OR', -40, 'groceries', '2026-08-15'),
    filed('DEBIT TPV CAFE DES ARTISTES', -12, 'eatingOut', '2026-08-20'),
    filed('PHARMACIE DU CENTRE', -18, 'health', '2026-09-01'),
    filed('CREDIT TRANSFER FROM EMPLOYER SA SALAIRE', 5000, 'salary', '2026-08-25', 'income'),
  ];
  it('a similar merchant text wins, even with another shop name around it', () => {
    expect(predictTargets(tx('DEBIT TPV AUCHAN GASPERICH', -33, { date: '2026-10-02' }), history, cats, () => true)[0]).toEqual({ targetType: 'category', targetId: 'groceries' });
  });
  it('only money going the same way is compared; a sure suggestion comes first', () => {
    const t = tx('CREDIT TRANSFER FROM EMPLOYER SA SALAIRE', 5100, { date: '2026-10-25' });
    expect(predictTargets(t, history, cats, () => true)[0]).toEqual({ targetType: 'income', targetId: 'salary' });
    const sure = { ...t, suggestion: { targetType: 'category' as const, targetId: 'health', confidence: 1, decidedBy: 'rule' as const, reason: '' } };
    expect(predictTargets(sure, history, cats, () => true)[0]!.targetId).toBe('health');
  });
  it('nothing alike yet: common merchant words are matched to category names', () => {
    expect(predictTargets(tx('LIDL BERTRANGE', -25, { date: '2026-10-02' }), [], cats, () => true)[0]).toEqual({ targetType: 'category', targetId: 'groceries' });
  });
});

describe('the automatic-filing log: filters and sorting (D-83)', () => {
  const mk = (id: string, desc: string, amount: number, date: string, by: 'rule' | 'history' | 'ai', conf: number, target: string, created: string) => {
    const t = tx(desc, amount, { id, date, status: 'reconciled' });
    const a = { id: `a-${id}`, createdAt: created, updatedAt: created, source: 'manual', transactionId: id, targetType: 'category', targetId: target, amount, confidence: conf, decidedBy: by, reason: 'r' } as Allocation;
    return { allocation: a, transaction: t };
  };
  const log = [
    mk('1', 'AUCHAN KIRCHBERG', -60, '2026-09-01', 'rule', 1, 'groceries', '2026-10-01T10:00:00Z'),
    mk('2', 'AUCHAN GASPERICH', -35, '2026-09-20', 'history', 0.7, 'groceries', '2026-10-01T11:00:00Z'),
    mk('3', 'PHARMACIE', -18, '2026-09-10', 'ai', 0.6, 'health', '2026-10-01T09:00:00Z'),
  ];
  const name = (a: Allocation) => a.targetId;
  it('searches, filters by who filed it and what it was filed under', () => {
    expect(filterLog(log, { text: 'auchan' }, name).map((x) => x.transaction.id).sort()).toEqual(['1', '2']);
    expect(filterLog(log, { by: 'ai' }, name).map((x) => x.transaction.id)).toEqual(['3']);
    expect(filterLog(log, { targetKey: 'category:health' }, name).map((x) => x.transaction.id)).toEqual(['3']);
    expect(filterLog(log, { text: 'health' }, name).map((x) => x.transaction.id)).toEqual(['3']); // matches the category name
  });
  it('sorts: latest filed, newest transaction, least sure first, biggest first', () => {
    const ids = (sort: 'filed' | 'date' | 'confidence' | 'amount' | 'merchant') => filterLog(log, { sort }, name).map((x) => x.transaction.id);
    expect(ids('filed')).toEqual(['2', '1', '3']);
    expect(ids('date')).toEqual(['2', '3', '1']);
    expect(ids('confidence')).toEqual(['3', '2', '1']);
    expect(ids('amount')).toEqual(['1', '2', '3']);
  });
});
