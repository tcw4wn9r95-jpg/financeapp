import { describe, expect, it } from 'vitest';
import { budgetForMonth } from './budget';
import { firstBelow, forecast, recurringTransfers, scheduleItems } from './forecast';
import { eventStatus, monthlySetAside, nextDue, occurrences, planCloseEvent, provisionStatus } from './plan';
import { World } from './testkit';
import type { EventFund, Provision } from './types';

const eur = (n: number) => Math.round(n * 100);
const base = { createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', source: 'manual' as const };

const provision = (over: Partial<Provision> = {}): Provision => ({
  ...base,
  id: 'p1',
  name: 'Car insurance',
  amount: eur(1200),
  dueDate: '2027-06-15',
  recurrence: 'FREQ=YEARLY;INTERVAL=1',
  fundedBalance: 0,
  monthlyContribution: 0,
  categoryId: 'carIns',
  ...over,
});

describe('provisions (F3)', () => {
  it('car insurance of 1,200 due in June suggests 100 a month from July', () => {
    expect(monthlySetAside(eur(1200), 0, '2026-07', '2027-06-15')).toBe(eur(100));
    expect(monthlySetAside(eur(1200), eur(600), '2027-01', '2027-06-15')).toBe(eur(100));
    expect(monthlySetAside(eur(1000), 0, '2026-07', '2026-09-01')).toBe(33334); // rounded up
    expect(monthlySetAside(eur(100), eur(200), '2026-07', '2026-09-01')).toBe(0);
  });

  it('computes recurring due dates', () => {
    expect(occurrences(provision(), '2026-01-01', '2028-12-31')).toEqual(['2026-06-15', '2027-06-15', '2028-06-15']);
    expect(occurrences(provision({ recurrence: 'FREQ=MONTHLY;INTERVAL=3', dueDate: '2026-01-31' }), '2026-01-01', '2026-12-31')).toEqual([
      '2026-01-31', '2026-04-30', '2026-07-31', '2026-10-31',
    ]);
    expect(occurrences(provision({ recurrence: '' }), '2026-01-01', '2026-12-31')).toEqual([]);
    expect(nextDue(provision(), '2027-06-16')).toBe('2028-06-15');
  });

  it('paying the bill draws from the provision, not from Variable (PRD acceptance)', () => {
    const w = new World('2026-07');
    const bank = w.account('bank', 'current', eur(5000));
    w.category('carIns', 'provisions', 'roll');
    w.category('groceries', 'variable', 'roll');
    w.setDefault('carIns', eur(100));
    w.setDefault('groceries', eur(400));
    const p = provision();
    expect(provisionStatus(p, w.input(), '2026-07', '2026-07-10').suggested).toBe(eur(100));
    w.spend(bank, '2027-06-15', eur(1200), 'carIns');
    const june = budgetForMonth(w.input(), '2027-06')!;
    expect(june.categories.get('carIns')!.available).toBe(0);
    expect(june.categories.get('groceries')!.activity).toBe(0);
    const s = provisionStatus(p, w.input(), '2027-06', '2027-06-20');
    expect(s.nextDue).toBe('2028-06-15');
    expect(s.suggested).toBe(eur(100));
  });
});

describe('events and trips (F4)', () => {
  it('trip of 3,000 funded at 500/month; 14 expenses of 2,740; surplus 260 moved to savings on close (PRD acceptance)', () => {
    const w = new World('2026-01');
    const card = w.account('card', 'card', 0);
    w.account('bank', 'current', eur(10000));
    w.category('trip', 'events', 'roll');
    w.category('savings', 'savings', 'roll');
    w.setDefault('trip', eur(500));
    const amounts = [400, 250, 180, 300, 120, 90, 160, 210, 140, 220, 180, 150, 190, 150];
    expect(amounts.reduce((s, x) => s + x, 0)).toBe(2740);
    amounts.forEach((a, i) => w.spend(card, `2026-06-${String(10 + i).padStart(2, '0')}`, eur(a), 'trip'));
    w.allocations.filter((a) => a.targetId === 'trip').slice(0, 2).forEach((a) => (a.subBudget = 'Flights'));
    const e: EventFund = {
      ...base, id: 'e1', name: 'Summer trip', targetAmount: eur(3000), targetDate: '2026-06-30',
      subBudgets: [{ name: 'Flights', amount: eur(700) }], fundedBalance: 0, status: 'active', categoryId: 'trip',
    };
    const s = eventStatus(e, w.input(), '2026-06', w.allocations);
    expect(s).toMatchObject({ contributed: eur(3000), spent: eur(2740), available: eur(260), overUnder: eur(260), fundedPercent: 100 });
    expect(s.bySubBudget).toEqual([{ name: 'Flights', budget: eur(700), spent: eur(650) }]);

    const plan = planCloseEvent(e, w.input(), '2026-06', 'savings');
    expect(plan.moved).toBe(eur(260));
    for (const o of plan.overrides) w.override(o.categoryId, o.month, o.amount);
    const june = budgetForMonth(w.input(), '2026-06')!;
    expect(june.categories.get('trip')!.available).toBe(0);
    expect(june.categories.get('savings')!.available).toBe(eur(260));
  });
});

describe('forecast (F9)', () => {
  function household() {
    const w = new World('2026-08');
    const bank = w.account('bank', 'current', eur(2000));
    const sav = w.account('sav', 'savings', eur(10000));
    w.income('salary');
    w.category('rent', 'fixed', 'reset');
    w.category('groceries', 'variable', 'roll');
    w.category('emergency', 'savings', 'roll');
    w.category('carIns', 'provisions', 'roll');
    w.setDefault('salary', eur(5000));
    w.setDefault('rent', eur(1800));
    w.setDefault('groceries', eur(600));
    w.setDefault('emergency', eur(500));
    w.setDefault('carIns', eur(100));
    for (const m of ['2026-08', '2026-09']) {
      w.earn(bank, `${m}-25`, eur(5000), 'salary');
      w.spend(bank, `${m}-01`, eur(1800), 'rent');
      w.spend(bank, `${m}-12`, eur(600), 'groceries');
      w.entry(bank, `${m}-26`, eur(-500), { kind: 'transfer', toAccountId: sav });
    }
    w.entry(bank, '2026-07-26', eur(-500), { kind: 'transfer', toAccountId: sav });
    return w;
  }

  it('projects income, fixed, variable and provisions month by month', () => {
    const w = household();
    const f = forecast({ today: '2026-10-10', months: 12, budget: w.input(), provisions: [provision({ dueDate: '2027-06-15' })], events: [] });
    // Start: 2000 + 2×(5000−1800−600−500) + 10000 + 2×500 = 17,200 on-budget.
    expect(f.start).toBe(eur(17200));
    // October: rent and groceries not yet spent this month, salary still to come.
    expect(f.months[0]).toMatchObject({ month: '2026-10', inflow: eur(5000), outflow: eur(2400), end: eur(19800) });
    // A normal month nets +2,600 (savings stay in the accounts).
    expect(f.months[1]!.end - f.months[0]!.end).toBe(eur(2600));
    // June 2027 pays the 1,200 insurance in one go.
    const june = f.months.find((m) => m.month === '2027-06')!;
    const may = f.months.find((m) => m.month === '2027-05')!;
    expect(june.end - may.end).toBe(eur(2600 - 1200));
    // Days add up to the items.
    const items = scheduleItems({ today: '2026-10-10', months: 12, budget: w.input(), provisions: [provision({ dueDate: '2027-06-15' })], events: [] });
    expect(f.days.at(-1)!.balance - f.start).toBe(items.reduce((s, i) => s + i.amount, 0));
    // The lowest point of a month is the day before payday.
    expect(f.months[1]!.minDate).toBe('2026-11-24');
  });

  it('per account: categories keep their accounts, regular transfers continue', () => {
    const w = household();
    expect(recurringTransfers(w.input(), '2026-10-10')).toEqual([{ from: 'bank', to: 'sav', amount: eur(500), day: 26 }]);
    const f = forecast({ today: '2026-10-10', months: 3, budget: w.input(), provisions: [], events: [] });
    const bank = f.byAccount.get('bank')!;
    const sav = f.byAccount.get('sav')!;
    expect(sav.map((x) => x.end)).toEqual([eur(12000), eur(12500), eur(13000)]);
    expect(bank.at(-1)!.end + sav.at(-1)!.end).toBe(f.months.at(-1)!.end);
  });

  it('scenario "Move to bigger flat": +600 rent from March shows the first month below the buffer (PRD acceptance)', () => {
    const w = household();
    w.setDefault('groceries', eur(3000), '2026-11'); // a tight household: −200 a month after salary
    const baseline = forecast({ today: '2026-10-10', months: 24, budget: w.input(), provisions: [], events: [] });
    const flat = forecast({
      today: '2026-10-10', months: 24, budget: w.input(), provisions: [], events: [],
      changes: [{ type: 'expense', start: '2027-03', amount: eur(600) }],
    });
    const buffer = eur(10000);
    const b = firstBelow(baseline.months, buffer);
    const s = firstBelow(flat.months, buffer);
    expect(s).toBeDefined();
    expect(!b || s!.month < b.month).toBe(true);
    expect(flat.months.find((m) => m.month === '2027-02')!.end).toBe(baseline.months.find((m) => m.month === '2027-02')!.end);
    expect(flat.months.find((m) => m.month === '2027-03')!.end).toBe(baseline.months.find((m) => m.month === '2027-03')!.end - eur(600));
  });
});
