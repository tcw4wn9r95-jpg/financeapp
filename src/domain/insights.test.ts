import { describe, expect, it } from 'vitest';
import { analyseSpending, sumPoints } from './insights';
import { World } from './testkit';
import type { Provision } from './types';

const eur = (n: number) => Math.round(n * 100);

/** Jan–Jun 2026 of history; "today" is 20 July. */
function household() {
  const w = new World('2026-01');
  const bank = w.account('bank', 'current', eur(20000));
  w.income('salary');
  w.category('food', 'variable', 'roll');
  w.category('fun', 'variable', 'roll');
  w.category('phone', 'fixed', 'reset');
  w.category('loan', 'fixed', 'reset');
  w.category('gym', 'fixed', 'reset');
  w.category('pets', 'variable', 'reset');
  w.category('tax', 'provisions', 'roll');
  w.setDefault('salary', eur(4000));
  w.setDefault('food', eur(400));
  w.setDefault('fun', eur(100));
  w.setDefault('phone', eur(100));
  w.setDefault('loan', eur(300));
  w.setDefault('loan', 0, '2026-09'); // the loan ends in August
  w.setDefault('gym', eur(50));
  w.setDefault('tax', eur(100));
  for (const m of ['01', '02', '03', '04', '05', '06']) {
    w.earn(bank, `2026-${m}-25`, eur(4000), 'salary');
    w.spend(bank, `2026-${m}-10`, eur(550), 'food'); // always over
    w.spend(bank, `2026-${m}-11`, eur(30), 'phone'); // always under
    w.spend(bank, `2026-${m}-12`, eur(300), 'loan');
    w.spend(bank, `2026-${m}-13`, eur(60), 'pets'); // no budget
  }
  w.spend(bank, '2026-07-05', eur(150), 'fun'); // over budget a third into July
  w.spend(bank, '2026-07-06', eur(200), 'food');
  return w;
}

const tax: Provision = {
  id: 'p', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '', source: 'manual', name: 'Tax', amount: eur(1200), dueDate: '2026-12-31', recurrence: '', startDate: '2026-01-01',
  fundedBalance: 0, monthlyContribution: 0, categoryId: 'tax',
};

describe('spending analysis (D-86)', () => {
  it('lists budget against spending month by month, then a projection', () => {
    const a = analyseSpending(household().input(), { today: '2026-07-20', from: '2026-01', ahead: 6, provisions: [tax] });
    expect(a.fullMonths).toHaveLength(6);
    expect(a.ahead).toEqual(['2026-08', '2026-09', '2026-10', '2026-11', '2026-12', '2027-01']);
    const food = a.categories.find((c) => c.category.id === 'food')!;
    expect([food.avgSpent, food.avgBudget, food.overMonths, food.typical]).toEqual([eur(550), eur(400), 6, eur(550)]);
    expect(food.points.find((p) => p.month === '2026-07')).toMatchObject({ kind: 'current', spent: eur(200), budgeted: eur(400) });
    expect(food.points.find((p) => p.month === '2026-08')).toMatchObject({ kind: 'projected', spent: eur(550) });
    // A fixed cost whose budget ends stops in the projection.
    const loan = a.categories.find((c) => c.category.id === 'loan')!;
    expect(loan.points.filter((p) => p.kind === 'projected').map((p) => p.spent).slice(0, 2)).toEqual([eur(300), 0]);
    // A provision projects its bill in the month it is due.
    const bill = a.categories.find((c) => c.category.id === 'tax')!;
    expect(bill.points.filter((p) => p.spent > 0).map((p) => p.month)).toEqual(['2026-12']);
    // Income ahead is what the income lines expect.
    expect(a.income.get('2026-08')).toBe(eur(4000));
    const totals = sumPoints(a.categories, a.months, () => 'past');
    expect(totals[0]).toMatchObject({ spent: eur(940) });
  });

  it('projects the year to December against the budget', () => {
    const a = analyseSpending(household().input(), { today: '2026-07-20', from: '2026-01', ahead: 3, provisions: [tax] });
    const dec = a.year.at(-1)!;
    expect(dec.month).toBe('2026-12');
    expect(dec.actual).toBeNull();
    // Jul: the current month's estimate; Aug–Dec projected (past the 3-month horizon too).
    const jun = a.year.find((y) => y.month === '2026-06')!;
    expect(jun.actual).toBe(6 * eur(940));
    expect(dec.projected).toBeGreaterThan(jun.actual!);
    expect(dec.projected - a.year.find((y) => y.month === '2026-11')!.projected).toBeGreaterThanOrEqual(eur(1200));
  });

  it('turns the history into insights with something to do', () => {
    const a = analyseSpending(household().input(), { today: '2026-07-20', from: '2026-01', ahead: 6, provisions: [tax] });
    const byKind = (kind: string, id?: string) => a.insights.find((i) => i.kind === kind && (!id || i.categoryId === id));
    expect(byKind('over', 'food')).toMatchObject({ severity: 'warn', values: { over: 6, n: 6, gap: eur(150), suggested: eur(550) }, action: { type: 'default', categoryId: 'food', amount: eur(550), from: '2026-08' } });
    expect(byKind('under', 'phone')).toMatchObject({ values: { suggested: eur(30), frees: eur(70) }, action: { type: 'default', amount: eur(30) } });
    expect(byKind('unused', 'gym')).toMatchObject({ action: { type: 'default', amount: 0 } });
    expect(byKind('unbudgeted', 'pets')).toMatchObject({ values: { suggested: eur(60) } });
    expect(byKind('pace', 'fun')).toMatchObject({ values: { already: 1, spent: eur(150), budget: eur(100) } });
    // Food is 6 × 150 € short, carried from month to month (July: +400 assigned, −200 spent): cover it now.
    expect(byKind('carried', 'food')).toMatchObject({ values: { short: eur(700) }, action: { type: 'cover', month: '2026-07' } });
    // Warnings come first.
    expect(a.insights[0]!.severity).toBe('warn');
    expect(a.insights.map((i) => i.severity).join()).toMatch(/^(warn,)*(tip,)*(info,?)*$/);
  });

  it('one big month does not set the usual amount', () => {
    const w = new World('2026-01');
    const bank = w.account('bank', 'current', eur(20000));
    w.category('travel', 'variable', 'roll');
    w.setDefault('travel', eur(100));
    for (const [m, x] of [['01', 50], ['02', 0], ['03', 80], ['04', 3000], ['05', 60], ['06', 40]] as const) if (x) w.spend(bank, `2026-${m}-10`, eur(x), 'travel');
    const a = analyseSpending(w.input(), { today: '2026-07-01', from: '2026-01', ahead: 1 });
    const travel = a.categories[0]!;
    expect(travel.typical).toBeLessThan(eur(100));
    expect(a.insights.find((i) => i.categoryId === 'travel' && i.kind !== 'carried')).toMatchObject({ kind: 'lumpy', values: { max: eur(3000) } });
  });

  it('counts unfiled spending missing from the numbers', () => {
    const w = household();
    w.entry('bank', '2026-05-02', eur(-80), { kind: 'none' });
    const a = analyseSpending(w.input(), { today: '2026-07-20', from: '2026-01', ahead: 0 });
    expect(a.unfiled).toEqual({ count: 1, out: eur(80) });
    expect(a.insights.find((i) => i.kind === 'unfiled')).toMatchObject({ action: { type: 'inbox' } });
  });
});

describe('the year projection', () => {
  it('does not depend on the analysed window', () => {
    const w = household();
    w.category('old', 'variable', 'reset');
    w.spend('bank', '2026-02-03', eur(500), 'old');
    const wide = analyseSpending(w.input(), { today: '2026-07-20', from: '2026-01', ahead: 6 });
    const narrow = analyseSpending(w.input(), { today: '2026-07-20', from: '2026-05', ahead: 6 });
    expect(narrow.year.at(-1)).toEqual(wide.year.at(-1));
  });
});
