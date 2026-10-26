import { describe, expect, it } from 'vitest';
import { forecast, heldAhead, monthCashPlan } from './forecast';
import { World } from './testkit';
import type { Provision } from './types';

/** The 24-month forecast (D-105), on a made-up household. */

const eur = (n: number) => Math.round(n * 100);

function household() {
  const w = new World('2026-01');
  const bank = w.account('bank', 'current', eur(10_000));
  w.income('pay');
  w.income('refunds');
  w.category('rent', 'fixed', 'reset');
  w.category('food', 'variable', 'roll');
  w.category('tax', 'provisions', 'roll');
  w.setDefault('pay', eur(4_000));
  w.setDefault('rent', eur(1_500));
  w.setDefault('food', eur(300));
  w.setDefault('tax', eur(100));
  for (const m of ['01', '02', '03', '04', '05', '06']) {
    w.earn(bank, `2026-${m}-25`, eur(4_000), 'pay');
    w.spend(bank, `2026-${m}-01`, eur(1_500), 'rent');
    // Food really costs about 600 € a month, twice the plan.
    w.spend(bank, `2026-${m}-10`, eur(m === '03' ? 900 : 600), 'food');
  }
  // A one-off refund in May: not income to repeat.
  w.earn(bank, '2026-05-15', eur(3_000), 'refunds');
  return w;
}

const provision = { id: 'p', name: 'Tax', amount: eur(1_000), dueDate: '2026-12-31', recurrence: '', fundedBalance: 0, monthlyContribution: eur(100), categoryId: 'tax', createdAt: '', updatedAt: '', source: 'manual' } as Provision;

describe('forecast (D-105)', () => {
  const w = household();
  const base = { today: '2026-07-01', months: 12, budget: w.input(), provisions: [provision], events: [] };

  it('does not repeat a one-off income that has no plan', () => {
    const r = forecast(base);
    expect(r.items.filter((x) => x.label === 'refunds')).toHaveLength(0);
    expect(r.months[1]!.inflow).toBe(eur(4_000));
  });
  it('spends what the plan says, or what the lines really cost lately', () => {
    const plan = forecast(base);
    const recent = forecast({ ...base, basis: 'recent' });
    expect(plan.months[1]!.living).toBe(eur(1_500 + 300));
    // Rent at its average, food at its typical month.
    expect(recent.months[1]!.living).toBe(eur(1_500 + 600));
  });
  it('counts what provisions hold for bills still to come, and lets it go when the bill is paid', () => {
    const held = heldAhead(base, ['2026-07', '2026-08', '2026-09', '2026-10', '2026-11', '2026-12', '2027-01']);
    // 7 months × 100 € set aside by July, 100 € more each month, the 1,000 € bill paid in December.
    expect(held.get('2026-07')).toBe(eur(700));
    expect(held.get('2026-08')).toBe(eur(800));
    expect(held.get('2026-12')).toBe(eur(200));
    expect(held.get('2027-01')).toBe(eur(300));
  });
});

describe('a month’s net cash flow, planned or at the recent pace (D-109)', () => {
  const w = household();
  const input = w.input();
  const assigned = () => undefined;
  it('adds income and takes off fixed, variable and provisions as planned', () => {
    const p = monthCashPlan(input, '2026-07', 'plan', assigned, () => 0);
    expect(p).toMatchObject({ income: eur(4_000), fixed: eur(1_500), variable: eur(300), provisions: eur(100), net: eur(4_000 - 1_500 - 300 - 100) });
  });
  it('at the recent pace, takes what the lines really cost before; months ahead use the last real months', () => {
    const p = monthCashPlan(input, '2026-07', 'recent', assigned, () => 0);
    expect(p.variable).toBe(eur(600));
    expect(p.fixed).toBe(eur(1_500));
    const ahead = monthCashPlan(input, '2027-03', 'recent', assigned, () => 0, '2026-07');
    expect(ahead.variable).toBe(eur(600));
  });
});
