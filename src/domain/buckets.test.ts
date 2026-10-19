import { describe, expect, it } from 'vitest';
import { bucketDetail, buckets, fillBuckets, provisionCycleStart, provisionWindow, tripWindow } from './buckets';
import { World } from './testkit';
import type { EventFund, Provision } from './types';

const eur = (n: number) => Math.round(n * 100);
const base = { createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '', source: 'manual' as const };
const prov = (over: Partial<Provision> = {}): Provision => ({
  ...base, id: 'p', name: 'Car insurance', amount: eur(1200), dueDate: '2026-06-15', recurrence: 'FREQ=YEARLY;INTERVAL=1', startDate: '2026-01-01',
  fundedBalance: 0, monthlyContribution: 0, categoryId: 'ins', ...over,
});
const taxProv = (over: Partial<Provision> = {}) => prov({ id: 'p2', name: 'Tax', categoryId: 'tax', amount: eur(1200), dueDate: '2026-12-31', recurrence: '', startDate: '2026-07-01', ...over });

function household() {
  const w = new World('2026-01');
  const bank = w.account('bank', 'current', eur(10000));
  const flex = w.account('flex', 'savings', 0);
  w.category('ins', 'provisions', 'roll');
  w.category('tax', 'provisions', 'roll');
  w.setDefault('ins', eur(200)); // 1,200 by June
  w.setDefault('ins', eur(100), '2026-07'); // then the yearly cycle
  w.setDefault('tax', eur(200), '2026-07'); // 1,200 by December
  const windows = (m: string) => [provisionWindow(prov(), m), provisionWindow(taxProv(), m)];
  return { w, bank, flex, windows };
}

describe('buckets filled from the provisions account balance (D-69)', () => {
  it('nothing in the account: every bucket is short by what it should hold', () => {
    const { w, flex, windows } = household();
    expect(provisionCycleStart(prov(), '2026-10')).toBe('2026-07');
    const s = fillBuckets(w.input(), '2026-10', flex, windows('2026-10'));
    // Insurance: 4 × 100 since July. Tax: 4 × 200 since July.
    expect(s.views.get('ins')).toMatchObject({ planned: eur(400), claim: eur(400), level: 0, toMove: eur(400), behind: eur(300) });
    expect(s).toMatchObject({ balance: 0, claimed: eur(1200), toMove: eur(1200), free: 0 });
  });

  it('the balance covers the soonest bill first; the rest is free savings', () => {
    const { w, bank, flex, windows } = household();
    // Moves in any chunks, from any account: only the balance counts.
    w.entry(bank, '2026-08-22', eur(-300), { kind: 'transfer', toAccountId: flex });
    w.entry(bank, '2026-08-22', eur(-350), { kind: 'transfer', toAccountId: flex });
    w.entry(bank, '2026-10-05', eur(-450), { kind: 'transfer', toAccountId: flex });
    let s = fillBuckets(w.input(), '2026-10', flex, windows('2026-10'));
    // Tax is due 31 Dec, insurance 15 Jun: tax first.
    expect([s.views.get('tax')!.level, s.views.get('ins')!.level, s.toMove]).toEqual([eur(800), eur(300), eur(100)]);
    w.entry(bank, '2026-10-06', eur(-2000), { kind: 'transfer', toAccountId: flex });
    s = fillBuckets(w.input(), '2026-10', flex, windows('2026-10'));
    expect([s.views.get('ins')!.level, s.toMove, s.free]).toEqual([eur(400), 0, eur(1900)]);
  });

  it('paying the bill lowers what the bucket should hold; interest and withdrawals only change the balance', () => {
    const { w, bank, flex, windows } = household();
    w.entry(bank, '2026-10-01', eur(-1500), { kind: 'transfer', toAccountId: flex });
    w.income('interest');
    w.earn(flex, '2026-10-31', eur(5), 'interest'); // interest is income: it only adds to the balance
    // The tax bill is paid from the current account after moving money back.
    w.entry(flex, '2026-12-20', eur(-1200), { kind: 'transfer', toAccountId: bank });
    w.spend(bank, '2026-12-21', eur(1200), 'tax');
    const s = fillBuckets(w.input(), '2026-12', flex, windows('2026-12'));
    expect(s.views.get('tax')).toMatchObject({ planned: eur(1200), spent: eur(1200), claim: 0, level: 0, loaded: eur(1200) });
    expect(s.views.get('ins')!.claim).toBe(eur(600));
    expect(s.balance).toBe(eur(305));
    expect(s.toMove).toBe(eur(295));
  });

  it('a refund filed to the bucket does not raise what it should hold', () => {
    const { w, bank, flex, windows } = household();
    w.earn(bank, '2026-08-01', eur(7335), 'tax');
    expect(fillBuckets(w.input(), '2026-10', flex, windows('2026-10')).views.get('tax')!.claim).toBe(eur(800));
  });

  it('without a provisions account the plan stands in for the money', () => {
    const { w, windows } = household();
    const v = buckets(w.input(), '2026-10', undefined, windows('2026-10')).get('ins')!;
    expect(v).toMatchObject({ level: eur(400), tracked: false, toMove: 0 });
  });

  it('a trip is filled by its soonest unpaid part', () => {
    const trip: EventFund = { ...base, id: 'e', name: 'Trip', targetAmount: eur(3000), targetDate: '2027-12-13', startDate: '2026-08-01', subBudgets: [{ name: 'Flights', amount: eur(2200), dueDate: '2027-06-30' }], fundedBalance: 0, status: 'saving', categoryId: 'trip' };
    expect(tripWindow(trip).due).toBe('2027-06-30');
    expect(tripWindow({ ...trip, subBudgets: [{ name: 'Flights', amount: eur(2200), dueDate: '2027-06-30', paidMonth: '2027-05' }] }).due).toBe('2027-12-13');
  });

  it('the detail lists what was planned and paid in the cycle', () => {
    const { w, bank } = household();
    w.spend(bank, '2026-09-20', eur(50), 'ins');
    const d = bucketDetail(w.input(), '2026-10', provisionWindow(prov(), '2026-10'));
    expect(d.map((m) => [m.month, m.planned, m.spending.map((s) => s.amount)])).toEqual([
      ['2026-10', eur(100), []],
      ['2026-09', eur(100), [eur(-50)]],
      ['2026-08', eur(100), []],
      ['2026-07', eur(100), []],
    ]);
  });
});
