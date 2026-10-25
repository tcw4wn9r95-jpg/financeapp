import { describe, expect, it } from 'vitest';
import { computeBudget } from './budget';
import { monthsToClose, uncoverOverrides } from './monthclose';
import { World } from './testkit';

const eur = (n: number) => Math.round(n * 100);

function household() {
  const w = new World('2026-01');
  w.account('bank', 'current', eur(3000));
  w.category('food', 'variable', 'roll');
  w.category('fun', 'variable', 'roll');
  w.category('tax', 'provisions', 'roll');
  w.setDefault('food', eur(300));
  w.setDefault('fun', eur(200));
  w.spend('bank', '2026-01-10', eur(380), 'food'); // 80 over
  w.spend('bank', '2026-01-12', eur(50), 'fun'); // 150 left
  w.spend('bank', '2026-01-20', eur(500), 'tax'); // provisions may go below zero
  return w;
}

describe('closing a month (D-89)', () => {
  it('lists past months with spending lines below zero, and lines with money left', () => {
    const w = household();
    const months = computeBudget(w.input(), '2026-02');
    const open = monthsToClose(months, w.input().categories, [], '2026-03');
    expect(open.map((m) => [m.month, m.lines.map((l) => [l.categoryId, l.short]), m.sources.map((s) => [s.categoryId, s.available])])).toEqual([
      ['2026-01', [['food', eur(80)]], [['fun', eur(150)]]],
    ]);
    // Not the running month, and not once decided.
    expect(monthsToClose(months, w.input().categories, [], '2026-01')).toEqual([]);
    expect(monthsToClose(months, w.input().categories, [{ month: '2026-01', left: ['food'] }], '2026-03')).toEqual([]);
  });

  it('a cover from another line moves money in that month; budgets stay as planned (D-94)', () => {
    const w = household();
    const covers = [{ categoryId: 'food', month: '2026-01', amount: eur(80), fromCategoryId: 'fun' }];
    const [jan, feb] = computeBudget({ ...w.input(), covers }, '2026-02');
    expect([jan!.categories.get('food')!.assigned, jan!.categories.get('food')!.covered, jan!.categories.get('food')!.available]).toEqual([eur(300), eur(80), 0]);
    expect([jan!.categories.get('fun')!.assigned, jan!.categories.get('fun')!.covered]).toEqual([eur(200), eur(-80)]);
    expect(feb!.overspentLastMonth).toBe(0);
    expect(feb!.categories.get('food')!.carryIn).toBe(0);
    // Fun money keeps its leftover, less what it gave.
    expect(feb!.categories.get('fun')!.carryIn).toBe(eur(70));
  });

  it('a cover from unplanned money comes out of it in that month', () => {
    const w = household();
    const plain = computeBudget(w.input(), '2026-02');
    const covered = computeBudget({ ...w.input(), covers: [{ categoryId: 'food', month: '2026-01', amount: eur(80) }] }, '2026-02');
    expect(covered[0]!.readyToAssign).toBe(plain[0]!.readyToAssign - eur(80));
    expect(covered[0]!.coveredTotal).toBe(eur(80));
    // Same money in the end: uncovered, the gap comes out of February instead.
    expect(covered[1]!.readyToAssign).toBe(plain[1]!.readyToAssign);
  });
});

describe('covers written into the budget before D-94', () => {
  it('are taken back out of the overrides', () => {
    const base = { createdAt: '', updatedAt: '', source: 'manual' as const };
    const overrides = [
      { ...base, id: 'o1', categoryId: 'food', month: '2026-01', amount: eur(380), note: 'Month closed: overspending covered' },
      { ...base, id: 'o2', categoryId: 'fun', month: '2026-01', amount: eur(120), note: 'Month closed: overspending covered' },
      { ...base, id: 'o3', categoryId: 'food', month: '2026-02', amount: eur(500), note: 'Christmas' },
    ];
    const usual = (id: string) => (id === 'food' ? eur(300) : eur(200));
    const r = uncoverOverrides(overrides, usual, [{ categoryId: 'food', month: '2026-01', amount: eur(80), fromCategoryId: 'fun' }], ['Month closed: overspending covered']);
    expect(r).toEqual({ put: [], remove: ['o1', 'o2'] });
  });
});

describe('a line following an account balance', () => {
  it('does not lend: it already gives back when money leaves the account', () => {
    const w = household();
    const months = computeBudget(w.input(), '2026-02');
    const [m] = monthsToClose(months, w.input().categories, [], '2026-03', new Set(['fun']));
    expect(m!.sources).toEqual([]);
  });
});
