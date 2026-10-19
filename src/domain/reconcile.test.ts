import { describe, expect, it } from 'vitest';
import { budgetForMonth } from './budget';
import { classify, cleanUpMirrors, ReconcileError, unclassify } from './reconcile';
import { testClock, World } from './testkit';
import type { Allocation, Transaction } from './types';

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

describe('transfers into accounts whose own statements cover them (D-68)', () => {
  const imported = (id: string, accountId: string, amount: number, date: string): Transaction => ({ ...tx(id, accountId, amount, date), importBatchId: 'b', descriptionRaw: id, merchantNorm: id });

  it('a top-up made of several transfers, bought as one sum, leaves no duplicate', () => {
    const w = new World('2026-01');
    w.account('rev', 'current', 0);
    w.account('flex', 'savings', 0);
    // Revolut: four transfers to Flexible on 22 Aug; Flexible's own export: one 2,700 purchase on 24 Aug.
    const rev = [...[300, 350, 600, 1450].map((e, i) => imported(`r${i}`, 'rev', -e * 100, '2026-08-22')), imported('r9', 'rev', -500, '2026-09-30')];
    const flex = [imported('f0', 'flex', 50000, '2026-08-01'), imported('f1', 'flex', 270000, '2026-08-24'), imported('f2', 'flex', 10000, '2026-09-30')];
    let view = { accounts: w.accounts, transactions: [...rev, ...flex], allocations: [] as Allocation[] };
    const apply = (ch: ReturnType<typeof classify>) => {
      const del = new Set([...ch.deleteAllocations]);
      const delT = new Set(ch.deleteTransactions);
      const tIds = new Set(ch.putTransactions.map((t) => t.id));
      const aIds = new Set(ch.putAllocations.map((a) => a.id));
      view = {
        accounts: view.accounts,
        transactions: [...view.transactions.filter((t) => !delT.has(t.id) && !tIds.has(t.id)), ...ch.putTransactions],
        allocations: [...view.allocations.filter((a) => !del.has(a.id) && !aIds.has(a.id)), ...ch.putAllocations],
      };
    };
    const clock = testClock();
    for (const r of rev.slice(0, 4)) apply(classify(view.transactions.find((t) => t.id === r.id)!, { kind: 'transfer', accountId: 'flex' }, view, clock));
    apply(classify(view.transactions.find((t) => t.id === 'f1')!, { kind: 'transfer', accountId: 'rev' }, view, clock));
    expect(view.transactions.filter((t) => t.isMirror)).toHaveLength(0);
    const balance = (id: string) => view.transactions.filter((t) => t.accountId === id).reduce((s, t) => s + t.amount, 0);
    expect(balance('flex')).toBe(330000);
    // Both sides count as transfers between own accounts: nothing left uncategorised.
    const b = budgetForMonth({ startMonth: '2026-01', categories: [], defaults: [], overrides: [], accounts: view.accounts, transactions: view.transactions.filter((t) => t.date.startsWith('2026-08') && t.id !== 'f0' && t.id !== 'r9'), allocations: view.allocations }, '2026-08')!;
    expect(b.uncategorised).toBe(0);
  });

  it('cleans up mirrors left in a covered period: the real open row takes over, or the transfer points at the account', () => {
    const w = new World('2026-01');
    w.account('rev', 'current', 0);
    w.account('flex', 'savings', 0);
    w.account('visa', 'card', 0);
    const r1 = imported('r1', 'rev', -100000, '2026-05-20');
    const r2 = imported('r2', 'rev', -75000, '2026-05-20');
    const r3 = imported('r3', 'rev', -40000, '2026-05-07');
    const m1: Transaction = { ...tx('m1', 'flex', 100000, '2026-05-20'), isMirror: true, status: 'reconciled' };
    const m2: Transaction = { ...tx('m2', 'flex', 75000, '2026-05-20'), isMirror: true, status: 'reconciled' };
    const m3: Transaction = { ...tx('m3', 'visa', 40000, '2026-05-07'), isMirror: true, status: 'reconciled' };
    const f1 = imported('f1', 'flex', 100000, '2026-05-21'); // matches m1
    const f0 = imported('f0', 'flex', 5000, '2026-05-01');
    const f9 = imported('f9', 'flex', 5000, '2026-06-30');
    const a = (id: string, from: string, to: string, amount: number): Allocation => ({ id, createdAt: '', updatedAt: '', source: 'manual', transactionId: from, targetType: 'transfer', targetId: to, amount, confidence: 1, decidedBy: 'user', reason: '' });
    const view = {
      accounts: w.accounts,
      transactions: [r1, r2, r3, m1, m2, m3, f0, f1, f9],
      allocations: [a('a1', 'r1', 'm1', -100000), a('a1m', 'm1', 'r1', 100000), a('a2', 'r2', 'm2', -75000), a('a2m', 'm2', 'r2', 75000), a('a3', 'r3', 'm3', -40000), a('a3m', 'm3', 'r3', 40000)],
    };
    const { changes, fixed } = cleanUpMirrors(view, testClock());
    expect(fixed).toBe(2); // the card's mirror stays: card statements do not list repayments
    expect(changes.deleteTransactions.sort()).toEqual(['m1', 'm2']);
    expect(changes.putAllocations.find((x) => x.id === 'a1')!.targetId).toBe('f1');
    expect(changes.putAllocations.find((x) => x.transactionId === 'f1')!.targetId).toBe('r1');
    expect(changes.putAllocations.find((x) => x.id === 'a2')!.targetId).toBe('flex');
  });
});
