import { describe, expect, it } from 'vitest';
import { accountBalances } from './budget';
import { applyToView, classify, linkLoanPayments, type LedgerView } from './reconcile';
import { testClock, World } from './testkit';

const eur = (n: number) => Math.round(n * 100);

/** A car loan of 10,000 € with its own fixed line, repaid from the current account. */
function household() {
  const w = new World('2026-01');
  w.account('bank', 'current', eur(5000));
  w.account('loan', 'loan', eur(-10000));
  w.category('carloan', 'fixed', 'reset');
  w.accounts.find((a) => a.id === 'loan')!.categoryId = 'carloan';
  return w;
}
const view = (w: World): LedgerView => ({ accounts: w.accounts, transactions: w.transactions, allocations: w.allocations });
const owed = (v: LedgerView) => accountBalances(v.accounts, v.transactions, '2026-12-31').get('loan');

describe('a payment filed to a loan’s line lowers the loan (D-93)', () => {
  it('adds the loan side for a payment filed straight to the line', () => {
    const w = household();
    w.spend('bank', '2026-02-05', eur(300), 'carloan');
    expect(owed(view(w))).toBe(eur(-10000));
    const { changes, linked } = linkLoanPayments(view(w), testClock('t'));
    expect(linked).toBe(1);
    const after = applyToView(view(w), changes);
    expect(owed(after)).toBe(eur(-9700));
    // Run again: nothing more to do.
    expect(linkLoanPayments(after, testClock('t')).linked).toBe(0);
  });

  it('leaves a payment filed as a transfer to the loan alone: it already has its loan side', () => {
    const w = household();
    w.entry('bank', '2026-02-05', eur(-300), { kind: 'none' });
    const tx = w.transactions.at(-1)!;
    const v = applyToView(view(w), classify(tx, { kind: 'transfer', accountId: 'loan', categoryId: 'carloan' }, view(w), testClock('t')));
    expect(owed(v)).toBe(eur(-9700));
    expect(linkLoanPayments(v, testClock('t')).linked).toBe(0);
  });

  it('skips payments made before the loan is tracked: its opening balance has them already', () => {
    const w = household();
    w.accounts.find((a) => a.id === 'loan')!.openingDate = '2026-03-01';
    w.spend('bank', '2026-02-05', eur(300), 'carloan');
    expect(linkLoanPayments(view(w), testClock('t')).linked).toBe(0);
  });

  it('uses the loan’s own statement row when there is one', () => {
    const w = household();
    w.entry('loan', '2026-02-06', eur(300), { kind: 'none' });
    const own = w.transactions.at(-1)!;
    own.importBatchId = 'b1';
    w.spend('bank', '2026-02-05', eur(300), 'carloan');
    const { changes } = linkLoanPayments(view(w), testClock('t'));
    expect(changes.putTransactions.map((t) => t.id)).toEqual([own.id]);
    expect(owed(applyToView(view(w), changes))).toBe(eur(-9700));
  });
});

describe('with an interest rate (D-93)', () => {
  it('lowers the loan by the capital only, and recomputes when the rate changes', () => {
    const w = household();
    w.spend('bank', '2026-02-05', eur(300), 'carloan');
    w.spend('bank', '2026-03-05', eur(300), 'carloan');
    const first = applyToView(view(w), linkLoanPayments(view(w), testClock('a')).changes);
    expect(owed(first)).toBe(eur(-9400));
    // 6% a year: 50 € interest on 10,000 €, then 48.75 € on 9,750 €.
    const loan = first.accounts.find((a) => a.id === 'loan')!;
    const rated: LedgerView = { ...first, accounts: first.accounts.map((a) => (a.id === 'loan' ? { ...loan, interestRate: 6 } : a)) };
    const { changes, linked } = linkLoanPayments(rated, testClock('b'));
    expect(linked).toBe(2);
    expect(owed(applyToView(rated, changes))).toBe(eur(-10000) + eur(250) + eur(251.25));
  });
});
