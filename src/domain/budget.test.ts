import { describe, expect, it } from 'vitest';
import { accountBalances, backdateDefaults, budgetForMonth, computeBudget, defaultFor, invested, isOnBudget } from './budget';
import { lastDayOfMonth, monthRange } from './dates';
import { World } from './testkit';

const eur = (n: number) => Math.round(n * 100);

describe('F1 Ready to assign', () => {
  it('reaches exactly 0.00 when salary and 12 categories are fully assigned (M1 exit gate)', () => {
    const w = new World('2026-09');
    const bank = w.account('bank');
    const salary = w.income('salary');
    const plan: [string, number][] = [
      ['rent', 1950],
      ['utilities', 180],
      ['phone', 89.9],
      ['insurance', 120],
      ['groceries', 650],
      ['eating-out', 250],
      ['transport', 200],
      ['health', 80],
      ['clothing', 120],
      ['fun', 150],
      ['emergency', 1860.1],
      ['pension', 300],
    ];
    for (const [id, amount] of plan) {
      w.category(id);
      w.setDefault(id, eur(amount));
    }
    w.earn(bank, '2026-09-25', eur(5950), salary);

    const sept = budgetForMonth(w.input(), '2026-09')!;
    expect(w.categories.filter((c) => !c.isIncome)).toHaveLength(12);
    expect(sept.income).toBe(eur(5950));
    expect(sept.assignedTotal).toBe(eur(5950));
    expect(sept.readyToAssign).toBe(0);
  });

  it('is income received minus amounts assigned', () => {
    const w = new World('2026-01');
    const bank = w.account('bank');
    const salary = w.income('salary');
    w.category('food');
    w.setDefault('food', eur(400));
    w.earn(bank, '2026-01-28', eur(3000), salary);
    expect(budgetForMonth(w.input(), '2026-01')!.readyToAssign).toBe(eur(2600));
  });

  it('counts opening balances of on-budget accounts, not loans', () => {
    const w = new World('2026-01');
    w.account('bank', 'current', eur(1000));
    w.account('savings', 'savings', eur(5000));
    w.account('card', 'card', eur(-200));
    w.account('mortgage', 'loan', eur(-250000));
    expect(budgetForMonth(w.input(), '2026-01')!.readyToAssign).toBe(eur(5800));
    expect(isOnBudget({ type: 'loan' })).toBe(false);
  });

  it('goes negative when more is assigned than received', () => {
    const w = new World('2026-01');
    w.account('bank');
    w.category('food');
    w.setDefault('food', eur(400));
    expect(budgetForMonth(w.input(), '2026-01')!.readyToAssign).toBe(eur(-400));
  });

  it('treats uncategorised spending as coming out of Ready to assign', () => {
    const w = new World('2026-01');
    const bank = w.account('bank', 'current', eur(100));
    w.entry(bank, '2026-01-05', eur(-30), { kind: 'none' });
    expect(budgetForMonth(w.input(), '2026-01')!.readyToAssign).toBe(eur(70));
  });

  it('ignores transfers between own accounts', () => {
    const w = new World('2026-01');
    const bank = w.account('bank', 'current', eur(500));
    const sav = w.account('sav', 'savings');
    w.entry(bank, '2026-01-10', eur(-200), { kind: 'transfer', toAccountId: sav });
    const m = budgetForMonth(w.input(), '2026-01')!;
    expect(m.readyToAssign).toBe(eur(500));
    expect(m.uncategorised).toBe(0);
  });

  it('a transfer to an off-budget loan leaves the budget', () => {
    const w = new World('2026-01');
    const bank = w.account('bank', 'current', eur(500));
    const loan = w.account('loan', 'loan', eur(-10000));
    w.entry(bank, '2026-01-10', eur(-200), { kind: 'transfer', toAccountId: loan });
    expect(budgetForMonth(w.input(), '2026-01')!.readyToAssign).toBe(eur(300));
  });

  it('returns undefined before the start month', () => {
    const w = new World('2026-05');
    expect(budgetForMonth(w.input(), '2026-04')).toBeUndefined();
  });
});

describe('F2 month overrides and default history', () => {
  it('December override of Groceries leaves January on the default (PRD acceptance test)', () => {
    const w = new World('2026-10');
    w.category('groceries');
    w.setDefault('groceries', eur(650));
    w.override('groceries', '2026-12', eur(900));
    const months = computeBudget(w.input(), '2027-01');
    const dec = months.find((m) => m.month === '2026-12')!.categories.get('groceries')!;
    const jan = months.find((m) => m.month === '2027-01')!.categories.get('groceries')!;
    expect(dec.assigned).toBe(eur(900));
    expect(dec.defaultAmount).toBe(eur(650));
    expect(dec.overrideId).toBeDefined();
    expect(jan.assigned).toBe(eur(650));
    expect(jan.overrideId).toBeUndefined();
  });

  it('a new default applies from its month on and past months keep the old one', () => {
    const w = new World('2026-01');
    w.category('rent');
    w.setDefault('rent', eur(1800), '2026-01');
    w.setDefault('rent', eur(1950), '2026-07');
    expect(defaultFor(w.defaults, 'rent', '2026-06')!.monthlyAmount).toBe(eur(1800));
    expect(defaultFor(w.defaults, 'rent', '2026-07')!.monthlyAmount).toBe(eur(1950));
    expect(defaultFor(w.defaults, 'rent', '2025-12')).toBeUndefined();
  });

  it('an override can assign zero', () => {
    const w = new World('2026-01');
    w.category('gym');
    w.setDefault('gym', eur(50));
    w.override('gym', '2026-08', 0);
    expect(budgetForMonth(w.input(), '2026-08')!.categories.get('gym')!.assigned).toBe(0);
  });
});

describe('F2 rollover', () => {
  function setup(mode: 'roll' | 'reset' | 'sweep') {
    const w = new World('2026-01');
    const bank = w.account('bank', 'current', eur(1000));
    w.category('food', 'variable', mode);
    w.category('savings', 'savings', 'roll');
    w.setDefault('food', eur(300));
    w.spend(bank, '2026-01-15', eur(250), 'food');
    return w;
  }

  it('roll carries the leftover into next month', () => {
    const w = setup('roll');
    const [jan, feb] = computeBudget(w.input(), '2026-02');
    expect(jan!.categories.get('food')!.available).toBe(eur(50));
    expect(feb!.categories.get('food')!.carryIn).toBe(eur(50));
    expect(feb!.categories.get('food')!.available).toBe(eur(350));
  });

  it('roll carries overspending too', () => {
    const w = setup('roll');
    w.spend('bank', '2026-01-20', eur(100), 'food');
    const [, feb] = computeBudget(w.input(), '2026-02');
    expect(feb!.categories.get('food')!.carryIn).toBe(eur(-50));
  });

  it('reset returns the leftover to Ready to assign next month', () => {
    const w = setup('reset');
    const [jan, feb] = computeBudget(w.input(), '2026-02');
    expect(jan!.readyToAssign).toBe(eur(700));
    expect(feb!.categories.get('food')!.carryIn).toBe(0);
    expect(feb!.returnedFromLastMonth).toBe(eur(50));
    // 700 + 50 returned − 300 assigned in February
    expect(feb!.readyToAssign).toBe(eur(450));
  });

  it('sweep moves a positive leftover to the savings category', () => {
    const w = setup('sweep');
    const [jan, feb] = computeBudget(w.input('savings'), '2026-02');
    expect(jan!.categories.get('food')!.sweptOut).toBe(eur(50));
    expect(feb!.categories.get('savings')!.carryIn).toBe(eur(50));
    expect(feb!.categories.get('food')!.carryIn).toBe(0);
    expect(feb!.returnedFromLastMonth).toBe(0);
  });

  it('sweep returns a negative leftover to Ready to assign', () => {
    const w = setup('sweep');
    w.spend('bank', '2026-01-20', eur(100), 'food');
    const [, feb] = computeBudget(w.input('savings'), '2026-02');
    expect(feb!.categories.get('savings')!.carryIn).toBe(0);
    expect(feb!.returnedFromLastMonth).toBe(eur(-50));
  });

  it('sweep without a target behaves like roll', () => {
    const w = setup('sweep');
    const [, feb] = computeBudget(w.input(), '2026-02');
    expect(feb!.categories.get('food')!.carryIn).toBe(eur(50));
  });
});

describe('invariant: Ready to assign + Σ available + held for next month = on-budget cash', () => {
  // Deterministic pseudo-random ledger (LCG) so failures are reproducible.
  function lcg(seed: number) {
    let s = seed;
    return () => {
      s = (s * 1664525 + 1013904223) % 2 ** 32;
      return s / 2 ** 32;
    };
  }

  it.each([1, 2, 3, 4, 5, 6, 7, 8])('holds every month for random ledger #%i', (seed) => {
    const rand = lcg(seed);
    const w = new World('2026-01');
    w.account('bank', 'current', eur(2000));
    w.account('card', 'card', 0);
    w.account('sav', 'savings', eur(10000));
    w.account('loan', 'loan', eur(-100000));
    w.income('salary');
    // Half the ledgers: salary paid at the end of the month for the next one (D-74).
    if (seed % 2 === 0) w.categories.find((c) => c.id === 'salary')!.nextMonthFromDay = 20;
    const modes = ['roll', 'reset', 'sweep'] as const;
    for (let i = 0; i < 8; i++) {
      w.category(`c${i}`, 'variable', modes[i % 3]!);
      w.setDefault(`c${i}`, Math.floor(rand() * 50000));
    }
    w.override('c1', '2026-03', 12345);
    w.setDefault('c2', 777, '2026-04');
    const accounts = ['bank', 'card', 'sav', 'loan'];
    for (let n = 0; n < 200; n++) {
      const month = 1 + Math.floor(rand() * 6);
      const day = 1 + Math.floor(rand() * 28);
      const date = `2026-0${month}-${day.toString().padStart(2, '0')}`;
      const acc = accounts[Math.floor(rand() * accounts.length)]!;
      const r = rand();
      if (r < 0.6) w.spend(acc, date, 1 + Math.floor(rand() * 20000), `c${Math.floor(rand() * 8)}`);
      else if (r < 0.75) w.earn(acc, date, 1 + Math.floor(rand() * 400000), 'salary');
      else if (r < 0.9) {
        const to = accounts.filter((a) => a !== acc)[Math.floor(rand() * 3)]!;
        w.entry(acc, date, -(1 + Math.floor(rand() * 50000)), { kind: 'transfer', toAccountId: to });
      } else w.entry(acc, date, Math.floor(rand() * 20000) - 10000 || 1, { kind: 'none' });
    }
    // Pre-start transaction is folded into the start month.
    w.spend('bank', '2025-12-30', 999, 'c0');

    // A category whose available follows a target in some months (D-75).
    const targets = new Map([['c3', new Map([['2026-02', 12345], ['2026-05', 50000]])]]);
    const months = computeBudget({ ...w.input('c7'), availableTargets: targets }, '2026-06');
    expect(months[1]!.categories.get('c3')!.available).toBe(12345);
    expect(months[4]!.categories.get('c3')!.available).toBe(50000);
    expect(months.map((m) => m.month)).toEqual(monthRange('2026-01', '2026-06'));
    const onBudget = w.accounts.filter(isOnBudget).map((a) => a.id);
    for (const m of months) {
      const balances = accountBalances(w.accounts, w.transactions, lastDayOfMonth(m.month));
      const cash = onBudget.reduce((s, id) => s + balances.get(id)!, 0);
      let available = 0;
      for (const c of m.categories.values()) available += c.available;
      expect(m.readyToAssign + available + m.heldForNextMonth).toBe(cash);
      expect(Number.isSafeInteger(m.readyToAssign)).toBe(true);
    }
  });
});

describe('moving the budget start earlier (D-45)', () => {
  it('moves each category’s first monthly amount back to the start; later changes keep their dates', () => {
    const w = new World('2026-01');
    w.category('rent', 'fixed', 'reset');
    w.category('food', 'variable', 'roll');
    w.category('old', 'variable', 'roll');
    w.setDefault('rent', 180000, '2026-10');
    w.setDefault('rent', 190000, '2026-12');
    w.setDefault('food', 60000, '2026-10');
    w.setDefault('old', 10000, '2026-01');
    const moved = backdateDefaults(w.defaults, '2026-01');
    expect(moved.map((d) => [d.categoryId, d.monthlyAmount, d.effectiveFrom])).toEqual([
      ['rent', 180000, '2026-01'],
      ['food', 60000, '2026-01'],
    ]);
    w.defaults = w.defaults.map((d) => moved.find((m) => m.id === d.id) ?? d);
    expect(budgetForMonth(w.input(), '2026-03')!.categories.get('rent')!.assigned).toBe(180000);
    expect(budgetForMonth(w.input(), '2026-12')!.categories.get('rent')!.assigned).toBe(190000);
  });
});

describe('accounts that start counting later (D-47)', () => {
  it('an account tracked from June adds its opening balance to Ready to assign in June, and has no balance before', () => {
    const w = new World('2026-01');
    w.account('joint', 'current', 100000);
    w.account('rev', 'current', 50000);
    w.accounts[1]!.openingDate = '2026-06-10';
    expect(budgetForMonth(w.input(), '2026-05')!.readyToAssign).toBe(100000);
    expect(budgetForMonth(w.input(), '2026-06')!.readyToAssign).toBe(150000);
    expect(accountBalances(w.accounts, [], '2026-06-09').get('rev')).toBe(0);
    expect(accountBalances(w.accounts, [], '2026-06-10').get('rev')).toBe(50000);
  });
  it('an opening date before the budget start counts at the start; a loan never touches the budget', () => {
    const w = new World('2026-01');
    w.account('joint', 'current', 100000);
    w.accounts[0]!.openingDate = '2025-11-01';
    w.account('car', 'loan', -1800000);
    w.accounts[1]!.openingDate = '2026-03-15';
    expect(budgetForMonth(w.input(), '2026-01')!.readyToAssign).toBe(100000);
    expect(budgetForMonth(w.input(), '2026-04')!.readyToAssign).toBe(100000);
    expect(accountBalances(w.accounts, [], '2026-02-28').get('car')).toBe(0);
    expect(accountBalances(w.accounts, [], '2026-03-15').get('car')).toBe(-1800000);
  });
});

describe('investments (D-57)', () => {
  it('counts what was put in, by year and month; a sale counts back; it is ordinary budget spending', () => {
    const w = new World('2026-01');
    const bank = w.account('bank', 'current', 500000);
    w.category('etf', 'investments', 'reset');
    w.setDefault('etf', 30000);
    w.spend(bank, '2026-03-05', 30000, 'etf');
    w.spend(bank, '2026-10-05', 30000, 'etf');
    w.earn(bank, '2026-10-20', 5000, 'etf'); // a small sale filed back
    w.allocations.at(-1)!.targetType = 'category';
    const inv = invested(w.input(), '2026-10');
    expect(inv).toMatchObject({ total: 55000, year: 55000, month: 25000 });
    expect(invested(w.input(), '2026-09').total).toBe(30000);
    expect(budgetForMonth(w.input(), '2026-03')!.categories.get('etf')!.activity).toBe(-30000);
  });
});

describe('salary paid at the end of the month for the next one (D-74)', () => {
  it('received from the 20th it counts next month, and is held until then', () => {
    const w = new World('2026-01');
    w.account('bank', 'current', 0);
    w.income('salary');
    w.categories.find((c) => c.id === 'salary')!.nextMonthFromDay = 20;
    w.earn('bank', '2026-01-28', eur(5000), 'salary');
    w.earn('bank', '2026-03-02', eur(5000), 'salary'); // late: counts in its own month
    const [jan, feb, mar] = computeBudget(w.input(), '2026-03');
    expect([jan!.income, jan!.readyToAssign, jan!.heldForNextMonth]).toEqual([0, 0, eur(5000)]);
    expect([feb!.income, feb!.readyToAssign, feb!.heldForNextMonth]).toEqual([eur(5000), eur(5000), 0]);
    expect(mar!.income).toBe(eur(5000));
  });
});
