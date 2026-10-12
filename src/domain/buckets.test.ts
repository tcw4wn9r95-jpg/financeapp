import { describe, expect, it } from 'vitest';
import { bucketDetail, buckets, provisionCycleStart, provisionWindow } from './buckets';
import { World } from './testkit';
import type { Provision } from './types';

const eur = (n: number) => Math.round(n * 100);
const base = { createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '', source: 'manual' as const };
const prov = (over: Partial<Provision> = {}): Provision => ({
  ...base, id: 'p', name: 'Car insurance', amount: eur(1200), dueDate: '2026-06-15', recurrence: 'FREQ=YEARLY;INTERVAL=1', startDate: '2026-01-01',
  fundedBalance: 0, monthlyContribution: 0, categoryId: 'ins', ...over,
});

function household() {
  const w = new World('2026-01');
  const bank = w.account('bank', 'current', eur(10000));
  const flex = w.account('flex', 'savings', 0);
  w.category('ins', 'provisions', 'roll');
  w.category('tax', 'provisions', 'roll');
  w.setDefault('ins', eur(200)); // 1,200 by June
  w.setDefault('ins', eur(100), '2026-07'); // then the yearly cycle
  w.setDefault('tax', eur(100), '2026-07');
  return { w, bank, flex };
}

describe('provision buckets fill with real money (D-56)', () => {
  it('nothing moved yet: the bucket is empty and behind, though the budget planned it', () => {
    const { w, flex } = household();
    const v = buckets(w.input(), '2026-10', flex, [provisionWindow(prov(), '2026-10')]).get('ins')!;
    expect(provisionCycleStart(prov(), '2026-10')).toBe('2026-07');
    expect(v).toMatchObject({ planned: eur(400), loaded: 0, level: 0, percent: 0, behind: eur(300), plannedThisMonth: eur(100) });
  });

  it('a move into the provisions account is shared by plan; paying the bill empties the bucket', () => {
    const { w, bank, flex } = household();
    // July: 100 for insurance + 100 for tax planned; 200 moved.
    w.entry(bank, '2026-07-02', eur(-200), { kind: 'transfer', toAccountId: flex });
    w.entry(bank, '2026-08-02', eur(-200), { kind: 'transfer', toAccountId: flex });
    let v = buckets(w.input(), '2026-08', flex, [provisionWindow(prov(), '2026-08')]).get('ins')!;
    expect(v).toMatchObject({ loaded: eur(200), level: eur(200), behind: 0, percent: 17 });
    // A first-cycle bill paid from the bank in June does not touch the new cycle.
    w.spend(bank, '2026-06-15', eur(1200), 'ins');
    w.spend(flex, '2026-08-20', eur(50), 'ins');
    v = buckets(w.input(), '2026-08', flex, [provisionWindow(prov(), '2026-08')]).get('ins')!;
    expect(v).toMatchObject({ loaded: eur(200), spent: eur(50), level: eur(150) });
  });

  it('without a provisions account the plan stands in for the money (untracked)', () => {
    const { w } = household();
    const v = buckets(w.input(), '2026-10', undefined, [provisionWindow(prov(), '2026-10')]).get('ins')!;
    expect(v).toMatchObject({ loaded: eur(400), level: eur(400), tracked: false, behind: 0 });
  });
});

describe('catching up', () => {
  it('extra moved this month pays down what earlier months missed', () => {
    const { w, bank, flex } = household();
    w.entry(bank, '2026-10-05', eur(-500), { kind: 'transfer', toAccountId: flex });
    // Owed this cycle through October: insurance 400 (July–October), tax 400. 500 is shared by what each is short.
    const v = buckets(w.input(), '2026-10', flex, [provisionWindow(prov(), '2026-10')]).get('ins')!;
    expect(v).toMatchObject({ loaded: eur(250), behind: eur(150) });
    // Paying everything owed leaves nothing behind.
    w.entry(bank, '2026-10-06', eur(-300), { kind: 'transfer', toAccountId: flex });
    expect(buckets(w.input(), '2026-10', flex, [provisionWindow(prov(), '2026-10')]).get('ins')!.behind).toBe(0);
  });
});

describe('seeing and correcting what feeds a bucket (D-64)', () => {
  it('a move pinned to one provision counts for it alone; the rest is still shared', () => {
    const { w, bank, flex } = household();
    w.entry(bank, '2026-10-05', eur(-500), { kind: 'transfer', toAccountId: flex });
    w.entry(bank, '2026-10-06', eur(-300), { kind: 'transfer', toAccountId: flex });
    const pinnedTx = w.transactions.find((t) => t.accountId === flex && t.amount === eur(300))!;
    pinnedTx.earmarkCategoryId = 'tax';
    const windows = [provisionWindow(prov(), '2026-10'), provisionWindow(prov({ id: 'p2', categoryId: 'tax' }), '2026-10')];
    const v = buckets(w.input(), '2026-10', flex, windows, () => '2026-07');
    // Tax needs 400: 300 pinned, 100 of the shared 500; insurance gets the other 400.
    expect([v.get('tax')!.loaded, v.get('ins')!.loaded]).toEqual([eur(400), eur(400)]);
  });

  it('lists the moves, the spending and incoming money that does not count as a move', () => {
    const { w, bank, flex } = household();
    w.entry(bank, '2026-08-02', eur(-200), { kind: 'transfer', toAccountId: flex });
    w.spend(flex, '2026-09-20', eur(50), 'ins');
    w.transactions.push({ ...base, id: 'loose', accountId: flex, date: '2026-09-25', amount: eur(80), descriptionRaw: 'From joint', merchantNorm: 'JOINT', counterparty: '', status: 'new' });
    const d = bucketDetail(w.input(), '2026-10', flex, provisionWindow(prov(), '2026-10'), () => '2026-07');
    expect(d.months.map((m) => [m.month, m.loaded, m.moves.length, m.spending.map((s) => s.amount)])).toEqual([
      ['2026-09', 0, 0, [eur(-50)]],
      ['2026-08', eur(100), 1, []],
    ]);
    expect(d.notCounted.map((t) => t.id)).toEqual(['loose']);
  });
});
