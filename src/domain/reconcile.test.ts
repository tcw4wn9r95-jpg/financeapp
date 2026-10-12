import { describe, expect, it } from 'vitest';
import { budgetForMonth } from './budget';
import { classify, ReconcileError, unclassify } from './reconcile';
import { testClock, World } from './testkit';
import type { Transaction } from './types';

const tx = (id: string, accountId: string, amount: number, date = '2026-09-10'): Transaction => ({
  id, accountId, date, amount, descriptionRaw: 'To Compte flexible', merchantNorm: 'COMPTE FLEXIBLE', counterparty: '',
  status: 'new', createdAt: '', updatedAt: '', source: 'manual',
});

describe('splitting one payment into categories and accounts (D-51)', () => {
  it('800 € from Revolut: 300 € for a provision, 500 € to the savings account', () => {
    const w = new World('2026-01');
    w.account('rev', 'current', 200000);
    w.account('sav', 'savings', 0);
    w.category('carIns', 'provisions', 'roll');
    const t = tx('t1', 'rev', -80000);
    const view = { accounts: w.accounts, transactions: [t], allocations: [] };
    const ch = classify(t, { kind: 'split', lines: [{ kind: 'category', categoryId: 'carIns', amount: -30000 }, { kind: 'transfer', accountId: 'sav', amount: -50000 }] }, view, testClock());
    const mirror = ch.putTransactions.find((x) => x.accountId === 'sav')!;
    expect(mirror).toMatchObject({ amount: 50000, isMirror: true });
    expect(ch.putAllocations.filter((a) => a.transactionId === 't1').map((a) => [a.targetType, a.amount])).toEqual([
      ['category', -30000],
      ['transfer', -50000],
    ]);
    w.transactions = [...ch.putTransactions];
    w.allocations = [...ch.putAllocations];
    const sep = budgetForMonth(w.input(), '2026-09')!;
    expect(sep.categories.get('carIns')!.activity).toBe(-30000);
    expect(sep.uncategorised).toBe(0);
    // Undo removes the created savings side.
    const back = unclassify(w.transactions.find((x) => x.id === 't1')!, { accounts: w.accounts, transactions: w.transactions, allocations: w.allocations }, testClock());
    expect(back.deleteTransactions).toEqual([mirror.id]);
  });

  it('pairs a part with a matching row already imported in the other account; rejects unbalanced splits', () => {
    const w = new World('2026-01');
    w.account('rev', 'current', 0);
    w.account('sav', 'savings', 0);
    w.category('fun', 'variable', 'roll');
    const t = tx('t1', 'rev', -80000);
    const arrived = tx('t2', 'sav', 50000, '2026-09-11');
    const view = { accounts: w.accounts, transactions: [t, arrived], allocations: [] };
    const ch = classify(t, { kind: 'split', lines: [{ kind: 'category', categoryId: 'fun', amount: -30000 }, { kind: 'transfer', accountId: 'sav', amount: -50000 }] }, view, testClock());
    expect(ch.putTransactions.find((x) => x.id === 't2')).toMatchObject({ status: 'reconciled' });
    expect(ch.putTransactions.some((x) => x.isMirror)).toBe(false);
    expect(() => classify(t, { kind: 'split', lines: [{ kind: 'transfer', accountId: 'sav', amount: -50000 }] }, view, testClock())).toThrow(ReconcileError);
  });
});

describe('inbox sorted by repeats (D-63)', () => {
  it('puts the merchant with most open items first, grouped, newest first', async () => {
    const { byRepeats } = await import('./reconcile');
    const m = (id: string, merchant: string, amount: number, date: string): Transaction => ({ ...tx(id, 'a', amount, date), merchantNorm: merchant, descriptionRaw: merchant });
    const items = [
      m('1', 'BAKERY', -500, '2026-09-20'),
      m('2', 'SUPERMARKET', -4000, '2026-09-01'),
      m('3', 'SUPERMARKET', -3000, '2026-09-15'),
      m('4', 'SUPERMARKET', 1200, '2026-09-16'), // a refund: other direction, own group
      m('5', 'SUPERMARKET', -2000, '2026-09-10'),
      m('6', '', -100, '2026-09-30'),
    ];
    const r = byRepeats(items);
    expect(r.items.map((x) => x.id)).toEqual(['3', '5', '2', '6', '1', '4']);
    expect([r.count.get('3'), r.count.get('4'), r.count.get('6')]).toEqual([3, 1, 1]);
  });
});
