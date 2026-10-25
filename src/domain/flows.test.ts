import { describe, expect, it } from 'vitest';
import { accountBalances } from './budget';
import { accountFlows, monthCashFlow, provisionHistory, provisionsAhead, transferPairs, transferRows } from './flows';
import { monthRange } from './dates';
import { World } from './testkit';
import type { Provision } from './types';

const eur = (n: number) => Math.round(n * 100);

function household() {
  const w = new World('2026-01');
  const bank = w.account('bank', 'current', eur(5000));
  const flex = w.account('flex', 'savings', 0);
  w.account('loan', 'loan', eur(-10000));
  w.category('tax', 'provisions', 'roll');
  w.setDefault('tax', eur(100));
  w.entry(bank, '2026-01-05', eur(-300), { kind: 'transfer', toAccountId: flex });
  w.entry(bank, '2026-02-05', eur(-300), { kind: 'transfer', toAccountId: flex });
  w.entry(flex, '2026-02-20', eur(-50), { kind: 'transfer', toAccountId: bank });
  w.entry(bank, '2026-02-10', eur(-200), { kind: 'transfer', toAccountId: 'loan' });
  return w;
}

describe('transfers between accounts (D-87)', () => {
  it('counts each transfer once, from the account it leaves', () => {
    const rows = transferRows(household().input(), '2026-01', '2026-02');
    expect(rows.map((r) => [r.from, r.to, r.amount])).toEqual([
      ['flex', 'bank', eur(50)],
      ['bank', 'loan', eur(200)],
      ['bank', 'flex', eur(300)],
      ['bank', 'flex', eur(300)],
    ]);
    const pairs = transferPairs(rows);
    expect(pairs[0]).toMatchObject({ from: 'bank', to: 'flex', total: eur(600), count: 2 });
    expect(accountFlows(rows, 'flex', ['2026-01', '2026-02'])).toEqual([
      { month: '2026-01', in: eur(300), out: 0 },
      { month: '2026-02', in: eur(300), out: eur(50) },
    ]);
  });

  it('a transfer seen only where it arrives counts when the sender shows nothing that month', () => {
    const w = household();
    w.entry('flex', '2026-03-03', eur(400), { kind: 'none' });
    const tx = w.transactions.at(-1)!;
    w.allocations.push({ ...w.allocations.at(-1)!, id: 'loose', transactionId: tx.id, targetType: 'transfer', targetId: 'bank', amount: eur(400) });
    expect(transferRows(w.input(), '2026-03', '2026-03').map((r) => [r.from, r.to, r.amount])).toEqual([['bank', 'flex', eur(400)]]);
    w.spend('bank', '2026-03-10', eur(5), 'tax');
    expect(transferRows(w.input(), '2026-03', '2026-03')).toEqual([]);
  });
});

describe('the provisions account month by month (D-87)', () => {
  const tax: Provision = {
    id: 'p', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '', source: 'manual', name: 'Tax', amount: eur(1200), dueDate: '2026-12-31', recurrence: '', startDate: '2026-01-01',
    fundedBalance: 0, monthlyContribution: 0, categoryId: 'tax',
  };
  it('shows balance, what it should hold and the moves', () => {
    const w = household();
    const months = monthRange('2026-01', '2026-02');
    const h = provisionHistory(w.input(), [tax], [], 'flex', months, transferRows(w.input(), '2026-01', '2026-02'));
    expect(h.map((m) => [m.balance, m.claimed, m.free, m.short, m.movedIn, m.movedOut, m.other])).toEqual([
      [eur(300), eur(100), eur(200), 0, eur(300), 0, 0],
      [eur(550), eur(200), eur(350), 0, eur(300), eur(50), 0],
    ]);
  });
  it('lists what is set aside and the bills due ahead', () => {
    const ahead = provisionsAhead(household().input(), [tax], [], '2026-11', 3);
    expect(ahead.map((m) => [m.month, m.setAside, m.due])).toEqual([
      ['2026-11', eur(100), 0],
      ['2026-12', eur(100), eur(1200)],
      ['2027-01', eur(100), 0],
    ]);
  });
});

describe('checking the receiving side (D-88)', () => {
  /** A transfer filed against the other account, with no partner row (D-68). */
  function loose(w: World, account: string, date: string, amount: number, to: string) {
    w.entry(account, date, amount, { kind: 'none' });
    const tx = w.transactions.at(-1)!;
    tx.status = 'reconciled';
    w.allocations.push({ ...w.allocations[0]!, id: `l-${w.allocations.length}`, transactionId: tx.id, targetType: 'transfer', targetId: to, amount });
    return tx;
  }
  function arrival(w: World, account: string, date: string, amount: number, imported = true) {
    w.entry(account, date, amount, { kind: 'none' });
    const tx = w.transactions.at(-1)!;
    if (imported) tx.importBatchId = 'b1';
    return tx;
  }
  const check = (w: World) => transferRows(w.input(), '2026-04', '2026-04').map((r) => [r.check, r.amount, r.receiving?.amount]);

  it('paired rows are matched; rows the app wrote are mirrors', () => {
    const w = household();
    w.entry('bank', '2026-04-02', eur(-100), { kind: 'transfer', toAccountId: 'flex' });
    expect(check(w)).toEqual([['matched', eur(100), eur(100)]]);
    w.transactions.at(-1)!.isMirror = true;
    expect(check(w)[0]![0]).toBe('mirror');
  });

  it('finds the money waiting, received as one, slightly different, or missing', () => {
    const w = household();
    w.allocations.push({ id: 'seed', createdAt: '', updatedAt: '', source: 'manual', transactionId: 'x', targetType: 'category', targetId: 'tax', amount: 0, confidence: 1, decidedBy: 'user', reason: '' });
    arrival(w, 'flex', '2026-04-01', eur(1), true);
    arrival(w, 'flex', '2026-04-28', eur(1), true);
    loose(w, 'bank', '2026-04-05', eur(-200), 'flex');
    arrival(w, 'flex', '2026-04-06', eur(200));
    loose(w, 'bank', '2026-04-10', eur(-300), 'flex');
    loose(w, 'bank', '2026-04-11', eur(-400), 'flex');
    arrival(w, 'flex', '2026-04-12', eur(700));
    loose(w, 'bank', '2026-04-18', eur(-500), 'flex');
    arrival(w, 'flex', '2026-04-19', eur(498));
    loose(w, 'bank', '2026-04-24', eur(-50), 'flex');
    expect(check(w)).toEqual([
      ['missing', eur(50), undefined],
      ['different', eur(500), eur(498)],
      ['grouped', eur(400), eur(700)],
      ['grouped', eur(300), eur(700)],
      ['candidate', eur(200), eur(200)],
    ]);
  });

  it('cannot check an account without its own statement that day', () => {
    const w = household();
    w.allocations.push({ id: 'seed', createdAt: '', updatedAt: '', source: 'manual', transactionId: 'x', targetType: 'category', targetId: 'tax', amount: 0, confidence: 1, decidedBy: 'user', reason: '' });
    loose(w, 'bank', '2026-04-24', eur(-50), 'flex');
    expect(check(w)).toEqual([['unchecked', eur(50), undefined]]);
  });
});

describe('a month’s net cash flow (D-103)', () => {
  it('is the change in what the budget accounts hold, with in and out apart', () => {
    const w = household();
    const bank = 'bank';
    w.category('food');
    w.income('pay');
    w.earn(bank, '2026-01-25', eur(3000), 'pay');
    w.spend(bank, '2026-01-12', eur(-400), 'food');
    const input = w.input();
    const jan = monthCashFlow(input, '2026-01');
    // Pay in; food out; the move to the savings account stays home.
    expect(jan).toEqual({ in: eur(3000), out: eur(400), net: eur(2600) });
    // February: the 200 € loan payment leaves the budget accounts; the moves between bank and savings do not count.
    const feb = monthCashFlow(input, '2026-02');
    expect(feb.net).toBe(eur(-200));
    const onBudget = input.accounts.filter((a) => a.type !== 'loan');
    const held = (day: string) => [...accountBalances(onBudget, input.transactions, day).values()].reduce((s, v) => s + v, 0);
    expect(feb.net).toBe(held('2026-02-28') - held('2026-01-31'));
  });
});
