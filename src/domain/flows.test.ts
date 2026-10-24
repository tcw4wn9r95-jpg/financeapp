import { describe, expect, it } from 'vitest';
import { accountFlows, provisionHistory, provisionsAhead, transferPairs, transferRows } from './flows';
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
