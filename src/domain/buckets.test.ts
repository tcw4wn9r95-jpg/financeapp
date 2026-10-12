import { describe, expect, it } from 'vitest';
import { bucketDetail, buckets, provisionCycleStart, provisionWindow, suggestAllocation, unallocatedMoves } from './buckets';
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

  it('a move fills nothing until it is allocated; paying the bill empties the bucket', () => {
    const { w, bank, flex } = household();
    w.entry(bank, '2026-07-02', eur(-200), { kind: 'transfer', toAccountId: flex });
    w.entry(bank, '2026-08-02', eur(-200), { kind: 'transfer', toAccountId: flex });
    let v = buckets(w.input(), '2026-08', flex, [provisionWindow(prov(), '2026-08')]).get('ins')!;
    expect(v).toMatchObject({ loaded: 0, level: 0, behind: eur(100) });
    expect(unallocatedMoves(w.input(), flex).map((x) => x.left)).toEqual([eur(200), eur(200)]);

    allocate(w, flex, '2026-07-02', { ins: eur(100), tax: eur(50) }); // 50 stays savings
    allocate(w, flex, '2026-08-02', { ins: eur(100) });
    v = buckets(w.input(), '2026-08', flex, [provisionWindow(prov(), '2026-08')]).get('ins')!;
    expect(v).toMatchObject({ loaded: eur(200), level: eur(200), behind: 0, percent: 17 });
    // Once allocated, a move is decided: what was left out stays savings and is not asked again.
    expect(unallocatedMoves(w.input(), flex)).toEqual([]);
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

describe('allocating moves by hand (D-65)', () => {
  it('"Fill by plan" proposes what each bucket is short of, and no more', () => {
    const { w, bank, flex } = household();
    w.entry(bank, '2026-10-05', eur(-500), { kind: 'transfer', toAccountId: flex });
    const tx = w.transactions.find((t) => t.accountId === flex)!;
    // Owed this cycle through October: insurance 400 (July–October), tax 400.
    expect(Object.fromEntries(suggestAllocation(w.input(), '2026-10', flex, eur(500), () => '2026-07', tx.id))).toEqual({ ins: eur(250), tax: eur(250) });
    allocate(w, flex, '2026-10-05', { ins: eur(400) });
    // Its own allocation is ignored when proposing again; another move only fills tax now.
    expect(Object.fromEntries(suggestAllocation(w.input(), '2026-10', flex, eur(300), () => '2026-07'))).toEqual({ tax: eur(300) });
    const v = buckets(w.input(), '2026-10', flex, [provisionWindow(prov(), '2026-10')]).get('ins')!;
    expect(v).toMatchObject({ loaded: eur(400), behind: 0 });
  });

  it('the detail lists the allocated part of each move, the spending and money that is not a move', () => {
    const { w, bank, flex } = household();
    w.entry(bank, '2026-08-02', eur(-200), { kind: 'transfer', toAccountId: flex });
    allocate(w, flex, '2026-08-02', { ins: eur(120), tax: eur(80) });
    w.spend(flex, '2026-09-20', eur(50), 'ins');
    w.transactions.push({ ...base, id: 'loose', accountId: flex, date: '2026-09-25', amount: eur(80), descriptionRaw: 'From joint', merchantNorm: 'JOINT', counterparty: '', status: 'new' });
    const d = bucketDetail(w.input(), '2026-10', flex, provisionWindow(prov(), '2026-10'));
    expect(d.months.map((m) => [m.month, m.loaded, m.moves.map((x) => x.amount), m.spending.map((s) => s.amount)])).toEqual([
      ['2026-09', 0, [], [eur(-50)]],
      ['2026-08', eur(120), [eur(120)], []],
    ]);
    expect(d.notCounted.map((t) => t.id)).toEqual(['loose']);
  });

  it('a legacy single pin counts as the whole move', () => {
    const { w, bank, flex } = household();
    w.entry(bank, '2026-10-05', eur(-300), { kind: 'transfer', toAccountId: flex });
    w.transactions.find((t) => t.accountId === flex)!.earmarkCategoryId = 'tax';
    const v = buckets(w.input(), '2026-10', flex, [provisionWindow(prov({ categoryId: 'tax' }), '2026-10')]).get('tax')!;
    expect(v.loaded).toBe(eur(300));
  });
});

describe('two provisions (D-66)', () => {
  function two() {
    const w = new World('2026-01');
    const bank = w.account('bank', 'current', eur(10000));
    const flex = w.account('flex', 'savings', 0);
    w.category('a', 'provisions');
    w.category('b', 'provisions');
    w.setDefault('a', eur(100), '2026-07');
    w.setDefault('b', eur(100), '2026-07');
    const windows = [provisionWindow(prov({ id: 'pa', categoryId: 'a', startDate: '2026-07-01', dueDate: '2027-06-15' }), '2026-10'), provisionWindow(prov({ id: 'pb', categoryId: 'b', startDate: '2026-07-01', dueDate: '2027-06-15' }), '2026-10')];
    return { w, bank, flex, windows };
  }

  it('money allocated before a provision starts stays in its bucket', () => {
    const { w, bank, flex, windows } = two();
    w.entry(bank, '2026-03-05', eur(-300), { kind: 'transfer', toAccountId: flex });
    allocate(w, flex, '2026-03-05', { b: eur(300) });
    expect(buckets(w.input(), '2026-10', flex, windows).get('b')).toMatchObject({ carried: eur(300), loaded: eur(300), level: eur(300), behind: 0, toMove: eur(100) });
  });

  it('one bucket allocated ahead does not hide what the other still needs', () => {
    const { w, bank, flex, windows } = two();
    w.entry(bank, '2026-10-05', eur(-400), { kind: 'transfer', toAccountId: flex });
    allocate(w, flex, '2026-10-05', { a: eur(400) });
    const v = buckets(w.input(), '2026-10', flex, windows);
    // a is fully funded through October; b planned 400 (July–October) and got nothing.
    expect([v.get('a')!.toMove, v.get('b')!.toMove, v.get('b')!.behind]).toEqual([0, eur(400), eur(300)]);
    expect(Object.fromEntries(suggestAllocation(w.input(), '2026-10', flex, eur(500), () => '2026-07'))).toEqual({ b: eur(400) });
  });
});

function allocate(w: World, accountId: string, date: string, parts: Record<string, number>) {
  const t = w.transactions.find((x) => x.accountId === accountId && x.date === date)!;
  t.earmarks = Object.entries(parts).map(([categoryId, amount]) => ({ categoryId, amount }));
}
