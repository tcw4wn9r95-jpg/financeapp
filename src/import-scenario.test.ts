// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { beforeEach, describe, expect, it } from 'vitest';
import { accountBalances, budgetForMonth } from './domain/budget';
import { REVOLUT_MAPPING, type MappingSpec } from './domain/import/csv';
import { detectAndParse } from './domain/import/detect';
import { assignAccounts, planImport, subAccounts, type LedgerChanges } from './domain/import/plan';
import { acceptSuggestion, checkStatement, classify, inbox, lockStatement, similar, undoImport, type Changes } from './domain/reconcile';
import { testClock } from './domain/testkit';
import type { Account, Allocation, ImportBatch, Statement, Transaction } from './domain/types';
import { pdfToLines, type PdfJsLike } from './infra/pdf';

const dir = join(process.cwd(), 'fixtures/import');
const parseXml = (xml: string) => new DOMParser().parseFromString(xml, 'application/xml');
const JANE_CARD: MappingSpec = {
  name: 'Jane card (FR)',
  headers: ['Date opération', 'Date valeur', 'Libellé', 'Débit', 'Crédit'],
  delimiter: ';',
  columns: { date: 'Date opération', valueDate: 'Date valeur', description: 'Libellé', debit: 'Débit', credit: 'Crédit' },
  dateFormat: 'dmy',
  decimal: 'comma',
  okStates: [],
};

const base = { createdAt: '2026-10-10T00:00:00.000Z', updatedAt: '2026-10-10T00:00:00.000Z', source: 'manual' as const };
const acct = (id: string, type: Account['type'], extra: Partial<Account> = {}): Account => ({ ...base, id, name: id, type, institution: '', ibanLast4: '', openingBalance: 0, ...extra });

class Ledger {
  accounts: Account[] = [
    acct('joint', 'current', { ibanLast4: '1234', owner: 'joint' }),
    acct('johnRev', 'current', { ibanLast4: '5678', matchHints: ['REVOLUT**5678'] }),
    acct('johnRevSavings', 'savings'),
    acct('flex', 'savings', { matchHints: ['Compte flexible'] }),
    acct('visa', 'card', { ibanLast4: '4321', settlementAccountId: 'joint' }),
    acct('janeSav', 'savings', { ibanLast4: '9876' }),
    acct('janeCard', 'card', { ibanLast4: '2222', settlementAccountId: 'joint' }),
    acct('buyWay', 'loan', { matchHints: ['BUY WAY'], openingBalance: -500000 }),
  ];
  transactions: Transaction[] = [];
  allocations: Allocation[] = [];
  statements: Statement[] = [];
  batches: ImportBatch[] = [];
  clock = testClock('x');

  view() {
    return { accounts: this.accounts, transactions: this.transactions, allocations: this.allocations, statements: this.statements };
  }

  private upsert<T extends { id: string }>(list: T[], items: T[]) {
    for (const it of items) {
      const i = list.findIndex((x) => x.id === it.id);
      if (i >= 0) list[i] = it;
      else list.push(it);
    }
  }

  applyPlan(ch: LedgerChanges) {
    this.upsert(this.transactions, ch.transactions);
    this.upsert(this.allocations, ch.allocations);
    this.upsert(this.statements, ch.statements);
    this.upsert(this.accounts, ch.accounts);
    this.batches.push(ch.batch);
  }

  apply(ch: Changes) {
    const delT = new Set(ch.deleteTransactions);
    const delA = new Set(ch.deleteAllocations);
    this.transactions = this.transactions.filter((t) => !delT.has(t.id));
    this.allocations = this.allocations.filter((a) => !delA.has(a.id));
    this.statements = this.statements.filter((s) => !ch.deleteStatements.includes(s.id));
    this.batches = this.batches.filter((b) => !ch.deleteBatches.includes(b.id));
    this.upsert(this.transactions, ch.putTransactions);
    this.upsert(this.allocations, ch.putAllocations);
    this.upsert(this.statements, ch.putStatements);
  }

  async import(name: string, choice: Record<string, string> = {}) {
    const bytes = readFileSync(join(dir, name));
    const file = name.endsWith('.pdf')
      ? { kind: 'pdf' as const, name, lines: await pdfToLines(pdfjs as unknown as PdfJsLike, new Uint8Array(bytes)) }
      : { kind: 'text' as const, name, text: bytes.toString('utf8') };
    const d = detectAndParse(file, [REVOLUT_MAPPING, JANE_CARD], parseXml);
    if (d.kind !== 'parsed') throw new Error('needs mapping');
    const auto = Object.fromEntries(subAccounts(d.result, this.accounts).filter((s) => s.accountId).map((s) => [s.key, s.accountId!]));
    const assigned = assignAccounts(d.result, { ...auto, ...choice });
    const ch = planImport(
      { fileName: name, format: d.result.format, ...assigned, warnings: d.result.warnings, budgetStartMonth: '2026-08' },
      this.view(),
      this.clock,
    );
    this.applyPlan(ch);
    return ch.batch.report;
  }

  balance(id: string, through = '2026-09-30') {
    return accountBalances(this.accounts, this.transactions, through).get(id)!;
  }

  tx(account: string, match: string | number) {
    return this.transactions.filter((t) => t.accountId === account && (typeof match === 'number' ? t.amount === match : t.descriptionRaw.includes(match)));
  }

  pairedWith(t: Transaction) {
    const a = this.allocations.find((x) => x.transactionId === t.id && x.targetType === 'transfer');
    return a ? this.transactions.find((x) => x.id === a.targetId) : undefined;
  }
}

const REVOLUT = { Current: 'johnRev', Deposit: 'johnRevSavings' };

describe('import scenario: a household month across six files', () => {
  let L: Ledger;
  beforeEach(() => {
    L = new Ledger();
  });

  it('links a card statement to its settlement debit as a transfer, never spending (F6)', async () => {
    await L.import('visa-john-2026-08.pdf');
    expect(L.statements[0]!.settlement).toMatchObject({ amount: 61240, date: '2026-09-05', fromAccountId: 'joint' });
    const report = await L.import('spuerkeess-joint-2026-09.pdf');
    expect(report.cardSettlementsLinked).toBe(1);
    const debit = L.tx('joint', -61240)[0]!;
    const cardSide = L.pairedWith(debit)!;
    expect(cardSide).toMatchObject({ accountId: 'visa', amount: 61240, isMirror: true });
    expect(L.statements.find((s) => s.accountId === 'visa')!.settlement!.transactionId).toBe(debit.id);
    // The card's spending counts once (on the card); the settlement is a transfer.
    expect(L.balance('visa')).toBe(0);
    // Budget: the transfer leaves Ready to assign untouched; only the four card purchases are activity.
    const budget = budgetForMonth({ startMonth: '2026-08', categories: [], defaults: [], overrides: [], accounts: L.accounts, transactions: L.transactions.filter((t) => t.accountId === 'visa' || t.id === debit.id), allocations: L.allocations }, '2026-09')!;
    expect(budget.uncategorised).toBe(0);
  });

  it('sets the opening balance from the first statement and balances to its closing balance', async () => {
    const report = await L.import('spuerkeess-joint-2026-09.pdf');
    expect(report.newCount).toBe(15);
    expect(report.warnings).toContain('openingSet:joint:1250000');
    const s = L.statements.find((x) => x.accountId === 'joint')!;
    expect(checkStatement(s, L.view()).difference).toBe(0);
  });

  it('creates the other side of transfers to accounts without statements, and replaces it when their statement arrives', async () => {
    const spk = await L.import('spuerkeess-joint-2026-09.pdf');
    // Revolut top-up (hint), Revolut standing order (IBAN), Jane savings (IBAN), Jane's card (••2222)
    // and John's Visa settlement (••4321). The loan repayment is only suggested.
    expect(spk.mirrorsCreated).toBe(5);
    expect(spk.suggestions).toBe(1);
    expect(L.tx('johnRev', 120000)[0]).toMatchObject({ isMirror: true });

    const rev = await L.import('revolut-john-2026-09.csv', REVOLUT);
    expect(rev.mirrorsReplaced).toBe(2);
    const payment = L.tx('johnRev', 'Payment from')[0]!;
    expect(payment.isMirror).toBeUndefined();
    expect(L.pairedWith(payment)!.accountId).toBe('joint');
    // "To EUR Compte flexible" lands in the flexible account.
    expect(rev.mirrorsCreated).toBe(2);
    expect(L.balance('flex')).toBe(100000 - 15000);
    expect(L.statements.find((s) => s.accountId === 'johnRev')!.openingBalance).toBe(41250);
    expect(checkStatement(L.statements.find((s) => s.accountId === 'johnRev')!, L.view()).difference).toBe(0);

    const camt = await L.import('camt053-jane-savings-2026-09.xml');
    expect(camt.mirrorsReplaced).toBe(1);
    expect(L.balance('janeSav')).toBe(847812);
    expect(checkStatement(L.statements.find((s) => s.accountId === 'janeSav')!, L.view()).difference).toBe(0);

    const card = await L.import('card-jane-2026-09.csv', { main: 'janeCard' });
    expect(card.mirrorsReplaced).toBe(1);
    expect(L.transactions.filter((t) => t.isMirror).map((t) => t.accountId).sort()).toEqual(['flex', 'flex', 'visa']);
  });

  it('retroactive upload: an older statement moves the opening balance back (D-32)', async () => {
    await L.import('revolut-john-2026-09-part2.csv', REVOLUT);
    const later = L.accounts.find((a) => a.id === 'johnRev')!;
    expect(later.openingFromStatement).toBe(true);
    await L.import('revolut-john-2026-09-part1.csv', REVOLUT);
    expect(L.accounts.find((a) => a.id === 'johnRev')!.openingBalance).toBe(41250);
    for (const s of L.statements.filter((x) => x.accountId === 'johnRev')) {
      expect(checkStatement(s, L.view()).difference).toBe(0);
    }
  });

  it('a typed opening balance is never replaced by a statement', async () => {
    L.accounts = L.accounts.map((a) => (a.id === 'joint' ? { ...a, openingBalance: 100 } : a));
    const r = await L.import('spuerkeess-joint-2026-09.pdf');
    expect(r.warnings.some((w) => w.startsWith('openingSet'))).toBe(false);
    expect(L.accounts.find((a) => a.id === 'joint')!.openingBalance).toBe(100);
  });

  it('an older statement than a hand-typed opening balance asks before replacing it (D-45)', async () => {
    await L.import('revolut-john-2026-09-part2.csv', REVOLUT);
    L.accounts = L.accounts.map((a) => (a.id === 'johnRev' ? { ...a, openingBalance: 999, openingFromStatement: false } : a));
    const r = await L.import('revolut-john-2026-09-part1.csv', REVOLUT);
    expect(r.warnings).toContain('openingDiffers:johnRev:41250');
    expect(L.accounts.find((a) => a.id === 'johnRev')!.openingBalance).toBe(999);
  });

  it('pairs transfers when the other statement was imported first', async () => {
    await L.import('revolut-john-2026-09.csv', REVOLUT);
    const spk = await L.import('spuerkeess-joint-2026-09.pdf');
    expect(spk.transfersPaired).toBe(2); // top-up and standing order
    const topUp = L.tx('johnRev', 'Top-Up')[0]!;
    expect(L.pairedWith(topUp)!.descriptionRaw).toContain('REVOLUT');
  });

  it('imports overlapping files with zero duplicates and reports them (F5)', async () => {
    const one = await L.import('revolut-john-2026-09-part1.csv', REVOLUT);
    const two = await L.import('revolut-john-2026-09-part2.csv', REVOLUT);
    expect(two.duplicateCount).toBe(5);
    expect(two.skipped.map((s) => s.reason).sort()).toEqual(['pending', 'reverted']);
    const again = await L.import('revolut-john-2026-09.csv', REVOLUT);
    expect(again.newCount).toBe(0);
    expect(again.duplicateCount).toBe(one.newCount + two.newCount);
    // Same ledger as importing the full month once.
    const fresh = new Ledger();
    await fresh.import('revolut-john-2026-09.csv', REVOLUT);
    expect(L.tx('johnRev', '').filter((t) => !t.isMirror)).toHaveLength(fresh.tx('johnRev', '').filter((t) => !t.isMirror).length);
    // Two identical parking payments on one day stay two.
    expect(L.tx('johnRev', 'Luxembourg parking')).toHaveLength(2);
  });

  it('suggests a transfer when the target account has its own statements', async () => {
    await L.import('visa-john-2026-09.pdf');
    await L.import('spuerkeess-joint-2026-09.pdf');
    const debit = L.tx('joint', -61240)[0]!;
    expect(debit.status).toBe('suggested');
    expect(debit.suggestion).toMatchObject({ targetType: 'transfer', targetId: 'visa' });
    L.apply(acceptSuggestion(debit, L.view(), L.clock));
    expect(L.pairedWith(L.tx('joint', -61240)[0]!)).toMatchObject({ accountId: 'visa', amount: 61240 });
  });

  it('links a pending card settlement when the debit arrives in a later statement', async () => {
    await L.import('visa-john-2026-09.pdf');
    const visaStatement = L.statements.find((s) => s.accountId === 'visa')!;
    expect(visaStatement.settlement!.transactionId).toBeUndefined();
    const ch = planImport(
      {
        fileName: 'october.pdf',
        format: 'pdf-spuerkeess',
        rows: [{ line: 1, date: '2026-10-07', amount: -21344, description: 'DIRECT DEBIT ••4321 CARTE VISA', accountKey: 'main', accountId: 'joint' }],
        skipped: [],
        statements: [],
        warnings: [],
        budgetStartMonth: '2026-08',
      },
      L.view(),
      L.clock,
    );
    L.applyPlan(ch);
    expect(ch.batch.report.cardSettlementsLinked).toBe(1);
    expect(L.balance('visa', '2026-10-31')).toBe(0);
  });

  it('reconciles a month: inbox to zero, balance equals statement, period locks (F7)', async () => {
    await L.import('spuerkeess-joint-2026-09.pdf');
    const s = L.statements.find((x) => x.accountId === 'joint')!;
    expect(checkStatement(s, L.view())).toMatchObject({ difference: 0, canLock: false });
    expect(() => lockStatement(s, L.view(), L.clock)).toThrow();

    // Classify the open items; "apply to similar" covers the two Auchan payments.
    const auchan = inbox(L.transactions).find((t) => t.descriptionRaw.includes('AUCHAN'))!;
    expect(similar(auchan, L.transactions)).toHaveLength(1);
    for (const t of inbox(L.transactions)) {
      L.apply(classify(t, t.amount > 0 ? { kind: 'income', categoryId: 'salary' } : { kind: 'category', categoryId: 'groceries' }, L.view(), L.clock));
    }
    expect(inbox(L.transactions)).toHaveLength(0);
    const check = checkStatement(s, L.view());
    expect(check).toMatchObject({ difference: 0, openItems: 0, canLock: true });
    L.apply(lockStatement(s, L.view(), L.clock));
    expect(L.tx('joint', '').every((t) => t.status === 'locked')).toBe(true);
    expect(() => classify(L.tx('joint', 'CACTUS')[0]!, { kind: 'category', categoryId: 'x' }, L.view(), L.clock)).toThrow();

    // Re-importing the locked month changes nothing.
    const again = await L.import('spuerkeess-joint-2026-09.pdf');
    expect(again).toMatchObject({ newCount: 0, duplicateCount: 15 });
  });

  it('a loan repayment is suggested, counts in a budget category and lowers the loan (D-29)', async () => {
    await L.import('spuerkeess-joint-2026-09.pdf');
    const debit = L.tx('joint', 'BUY WAY')[0]!;
    expect(debit).toMatchObject({ status: 'suggested', suggestion: { targetType: 'transfer', targetId: 'buyWay' } });
    L.apply(classify(debit, { kind: 'transfer', accountId: 'buyWay', categoryId: 'loanRepayments' }, L.view(), L.clock));
    expect(L.allocations.filter((a) => a.transactionId === debit.id)).toEqual([expect.objectContaining({ targetType: 'category', targetId: 'loanRepayments', amount: -18950 })]);
    expect(L.balance('buyWay')).toBe(-500000 + 18950);
    const input = { startMonth: '2026-08', categories: [{ ...base, id: 'loanRepayments', name: 'Loan', groupId: 'fixed' as const, rolloverMode: 'reset' as const, isIncome: false, sortOrder: 0 }], defaults: [], overrides: [], accounts: L.accounts, transactions: L.transactions, allocations: L.allocations };
    expect(budgetForMonth(input, '2026-09')!.categories.get('loanRepayments')!.activity).toBe(-18950);
    // Reclassifying removes the loan side again.
    L.apply(classify(L.tx('joint', 'BUY WAY')[0]!, { kind: 'category', categoryId: 'other' }, L.view(), L.clock));
    expect(L.balance('buyWay')).toBe(-500000);
    expect(L.tx('buyWay', '')).toHaveLength(0);
  });

  it('splits must sum to the transaction', async () => {
    await L.import('spuerkeess-joint-2026-09.pdf');
    const t = L.tx('joint', 'CACTUS')[0]!;
    expect(() => classify(t, { kind: 'split', lines: [{ kind: 'category', categoryId: 'a', amount: -4000 }] }, L.view(), L.clock)).toThrow();
    L.apply(classify(t, { kind: 'split', lines: [{ kind: 'category', categoryId: 'a', amount: -4000 }, { kind: 'category', categoryId: 'b', amount: -4437 }] }, L.view(), L.clock));
    expect(L.allocations.filter((a) => a.transactionId === t.id)).toHaveLength(2);
  });

  it('classifying a transfer to an account without a counterpart creates one; reclassifying removes it', async () => {
    await L.import('spuerkeess-joint-2026-09.pdf');
    const landlord = L.tx('joint', 'LANDLORD')[0]!;
    L.apply(classify(landlord, { kind: 'transfer', accountId: 'flex' }, L.view(), L.clock));
    expect(L.balance('flex')).toBe(195000);
    L.apply(classify(L.tx('joint', 'LANDLORD')[0]!, { kind: 'category', categoryId: 'rent' }, L.view(), L.clock));
    expect(L.balance('flex')).toBe(0);
  });

  it('undoes an import, sending paired transfers back to the inbox', async () => {
    await L.import('revolut-john-2026-09.csv', REVOLUT);
    await L.import('spuerkeess-joint-2026-09.pdf');
    const batch = L.batches.find((b) => b.fileName.startsWith('spuerkeess'))!;
    L.apply(undoImport(batch, L.view(), L.clock));
    expect(L.tx('joint', '')).toHaveLength(0);
    expect(L.tx('johnRev', 'Top-Up')[0]!.status).toBe('new');
    expect(L.allocations.some((a) => a.targetType === 'transfer')).toBe(true); // flexible-account transfers stay
  });
});
