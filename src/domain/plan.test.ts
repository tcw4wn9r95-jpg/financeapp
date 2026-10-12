import { describe, expect, it } from 'vitest';
import { budgetForMonth } from './budget';
import { firstBelow, forecast, recurringTransfers, scheduleItems } from './forecast';
import { eventPlanParts, eventPlans, provisionsMove, provisionsMoveByMonth, eventStatus, monthlySetAside, nextDue, occurrences, planCloseEvent, provisionSchedule, provisionStatus } from './plan';
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
    expect(s.bySubBudget).toEqual([{ name: 'Flights', budget: eur(700), spent: eur(650), due: '2026-06-30', paid: false }]);

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

describe('provision schedule: start, target date, target amount (D-49)', () => {
  it('car insurance 1,200 € due 15/06/2026, saving from January: 200 a month, then 100 a month for the yearly cycle', () => {
    expect(provisionSchedule(provision({ dueDate: '2026-06-15', startDate: '2026-01-01' }), '2026-01')).toEqual([
      { from: '2026-01', amount: eur(200) },
      { from: '2026-07', amount: eur(100) },
    ]);
  });
  it('a one-off goal stops after its target month; nothing before the start', () => {
    expect(provisionSchedule(provision({ amount: eur(1000), dueDate: '2026-12-20', recurrence: '', startDate: '2026-09-05' }), '2026-01')).toEqual([
      { from: '2026-09', amount: 25000 },
      { from: '2027-01', amount: 0 },
    ]);
  });
  it('a start after this year’s due date aims at the next occurrence; a full first cycle is one step', () => {
    expect(provisionSchedule(provision({ dueDate: '2026-06-15', startDate: '2026-07-01' }), '2026-01')).toEqual([{ from: '2026-07', amount: eur(100) }]);
    expect(provisionSchedule(provision({ amount: eur(1000), dueDate: '2026-03-31', recurrence: 'FREQ=MONTHLY;INTERVAL=3', startDate: '2026-01-10' }), '2026-01')).toEqual([
      { from: '2026-01', amount: 33334 },
    ]);
  });
});

describe('trip parts with their own dates (D-54)', () => {
  const trip = (over: Partial<EventFund> = {}): EventFund => ({
    ...base, createdAt: '2026-10-01T00:00:00.000Z', id: 'e1', name: 'Japan', targetAmount: eur(3000), targetDate: '2027-12-10', startDate: '2026-10-01',
    subBudgets: [{ name: 'Flights', amount: eur(800), dueDate: '2027-06-15' }], fundedBalance: 0, status: 'saving', categoryId: 'trip', ...over,
  });
  function world(e: EventFund) {
    const w = new World('2026-01');
    const card = w.account('card', 'card', 0);
    w.account('bank', 'current', eur(10000));
    w.category('trip', 'events', 'roll');
    return { w, card, input: () => ({ ...w.input(), plans: eventPlans([e]) }) };
  }
  const assigned = (input: ReturnType<ReturnType<typeof world>['input']>, m: string) => budgetForMonth(input, m)!.categories.get('trip')!.assigned;

  it('flights are saved for by June 2027, the rest by December 2027; nothing before the start', () => {
    const e = trip();
    expect(eventPlanParts(e)).toEqual([
      { key: 'Flights', amount: eur(800), start: '2026-10', due: '2027-06' },
      { key: '', amount: eur(2200), start: '2026-10', due: '2027-12' },
    ]);
    const { input } = world(e);
    expect(assigned(input(), '2026-09')).toBe(0);
    // 800 / 9 months + 2,200 / 15 months, each rounded up to the cent.
    expect(assigned(input(), '2026-10')).toBe(8889 + 14667);
    let total = 0;
    for (const m of ['2026-10', '2026-11', '2026-12', '2027-01', '2027-02', '2027-03', '2027-04', '2027-05', '2027-06', '2027-07', '2027-08', '2027-09', '2027-10', '2027-11', '2027-12']) total += assigned(input(), m);
    expect(total).toBe(eur(3000));
    expect(assigned(input(), '2028-01')).toBe(0);
  });

  it('buying the tickets early stops saving for flights; the rest carries on', () => {
    const e = trip();
    const { w, card, input } = world(e);
    w.spend(card, '2027-02-20', eur(800), 'trip');
    w.allocations.at(-1)!.subBudget = 'Flights';
    const march = assigned(input(), '2027-03');
    const restOnly = budgetForMonth({ ...w.input(), plans: eventPlans([trip({ subBudgets: [] , targetAmount: eur(2200) })]) }, '2027-03')!.categories.get('trip')!.assigned;
    expect(march).toBe(restOnly);
  });

  it('a part marked paid stops after that month', () => {
    const e = trip({ subBudgets: [{ name: 'Flights', amount: eur(800), dueDate: '2027-06-15', paidMonth: '2026-12' }] });
    const { input } = world(e);
    const rest = 14667;
    expect(assigned(input(), '2026-12')).toBe(8889 + rest);
    expect(assigned(input(), '2027-01')).toBe(rest);
  });
});

describe('monthly move to the provisions account (D-55)', () => {
  it('is what provisions and trips get this month, less what was already moved there', () => {
    const w = new World('2026-01');
    const bank = w.account('bank', 'current', eur(5000));
    const flex = w.account('flex', 'savings', 0);
    w.category('carIns', 'provisions', 'roll');
    w.category('groceries', 'variable', 'roll');
    w.setDefault('carIns', eur(100));
    w.setDefault('groceries', eur(400));
    const input = () => ({ ...w.input(), plans: eventPlans([{ ...base, createdAt: '2026-10-01T00:00:00Z', id: 'e', name: 'Trip', targetAmount: eur(1200), targetDate: '2027-09-30', startDate: '2026-10-01', subBudgets: [], fundedBalance: 0, status: 'saving', categoryId: 'trip' }]) });
    w.category('trip', 'events', 'roll');
    expect(provisionsMove(input(), '2026-10', flex)).toMatchObject({ planned: eur(200), moved: 0, left: eur(200) });
    w.entry(bank, '2026-10-03', eur(-150), { kind: 'transfer', toAccountId: flex });
    expect(provisionsMove(input(), '2026-10', flex)).toMatchObject({ planned: eur(200), moved: eur(150), left: eur(50) });
    expect(provisionsMoveByMonth(input(), '2026-10').get('2026-10')).toBe(eur(200));
  });
});
