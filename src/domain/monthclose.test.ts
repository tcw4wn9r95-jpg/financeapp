import { describe, expect, it } from 'vitest';
import { computeBudget } from './budget';
import { closeAmounts, monthsToClose } from './monthclose';
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

  it('covering from another line moves the money in that month; the next month starts clean', () => {
    const w = household();
    const [m] = monthsToClose(computeBudget(w.input(), '2026-02'), w.input().categories, [], '2026-03');
    const amounts = closeAmounts(m!, [{ categoryId: 'food', short: eur(80), source: { kind: 'line', categoryId: 'fun' } }]);
    expect([...amounts]).toEqual([['food', eur(380)], ['fun', eur(120)]]);
    for (const [id, amount] of amounts) w.override(id, '2026-01', amount);
    const [jan, feb] = computeBudget(w.input(), '2026-02');
    expect(jan!.categories.get('food')!.available).toBe(0);
    expect(feb!.overspentLastMonth).toBe(0);
    expect(feb!.categories.get('food')!.carryIn).toBe(0);
    // Fun money keeps its leftover, less what it gave.
    expect(feb!.categories.get('fun')!.carryIn).toBe(eur(70));
  });

  it('from Ready to assign, or left for next month', () => {
    const w = household();
    const [m] = monthsToClose(computeBudget(w.input(), '2026-02'), w.input().categories, [], '2026-03');
    expect([...closeAmounts(m!, [{ categoryId: 'food', short: eur(80), source: { kind: 'ready' } }])]).toEqual([['food', eur(380)]]);
    expect([...closeAmounts(m!, [{ categoryId: 'food', short: eur(80), source: { kind: 'next' } }])]).toEqual([]);
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
