import { computeBudget, defaultFor, isOnBudget, type BudgetInput, type BudgetMonth } from './budget';
import { addMonths, compareMonths, daysInMonth, lastDayOfMonth, monthOf, monthRange } from './dates';
import { amountFor, occurrences } from './plan';
import type { Category, CategoryGroup, Cents, Id, IsoDate, MonthKey, Provision } from './types';

/**
 * Spending analysis (D-86): budget against what was spent, month by month and
 * per category, a projection of the months ahead, and insights that say what
 * to do about it.
 *
 * Spending is what the spending groups record (fixed, variable, provisions,
 * events), net of refunds. Savings and investments are money kept, not spent.
 * Averages use full months only: the current month is still running.
 */

export const SPEND_GROUPS = ['fixed', 'variable', 'provisions', 'events'] as const;
export type SpendGroup = (typeof SPEND_GROUPS)[number];
export const isSpendGroup = (g: CategoryGroup): g is SpendGroup => (SPEND_GROUPS as readonly string[]).includes(g);

export type PointKind = 'past' | 'current' | 'projected';

export interface MonthPoint {
  month: MonthKey;
  budgeted: Cents;
  /** Spent (net of refunds); for the current month what is spent so far; projected for later months. */
  spent: Cents;
  kind: PointKind;
}

export interface CategoryAnalysis {
  category: Category;
  group: SpendGroup;
  /** From the first analysed month through the current one, then the months ahead. */
  points: MonthPoint[];
  /** Full months in the window. */
  fullMonths: number;
  avgSpent: Cents;
  avgBudget: Cents;
  /** Full months over budget by more than 5%, and under 70% of budget. */
  overMonths: number;
  underMonths: number;
  /** Average of the last 3 full months, and of the 3 before. */
  recent: Cents;
  earlier: Cents;
  /** Middle month of the last 6 full months. */
  medianSpent: Cents;
  /** Highest full month of the last 6. */
  maxSpent: Cents;
  /** Usual monthly spending the projection starts from. */
  typical: Cents;
  /** The current month: assigned, spent so far, what is available. */
  assignedNow: Cents;
  spentNow: Cents;
  available: Cents;
  /** The current month's expected total (at least what is spent so far). */
  currentEstimate: Cents;
}

export interface TotalPoint extends MonthPoint {
  income: Cents;
}

export interface YearPoint {
  month: MonthKey;
  /** Cumulative spending recorded (null after the current month). */
  actual: Cents | null;
  /** Cumulative spending: recorded, then the current month's estimate and the projection. */
  projected: Cents;
  /** Cumulative budget. */
  budget: Cents;
}

export type InsightKind = 'over' | 'under' | 'unused' | 'unbudgeted' | 'lumpy' | 'rising' | 'falling' | 'pace' | 'carried' | 'yearEnd' | 'onTrack' | 'drivers' | 'unfiled';
export type Severity = 'warn' | 'tip' | 'info';

export type InsightAction =
  | { type: 'default'; categoryId: Id; amount: Cents; from: MonthKey }
  | { type: 'cover'; categoryId: Id; month: MonthKey; amount: Cents }
  | { type: 'inbox' };

export interface Insight {
  kind: InsightKind;
  severity: Severity;
  categoryId?: Id;
  /** Money at stake over a year, to rank insights. */
  impact: Cents;
  /** Values for the message: amounts in cents, counts, names. */
  values: Record<string, number | string>;
  action?: InsightAction;
}

export interface SpendingAnalysis {
  current: MonthKey;
  /** Share of the current month gone (0–1). */
  dayShare: number;
  /** Analysed months through the current one. */
  months: MonthKey[];
  fullMonths: MonthKey[];
  ahead: MonthKey[];
  categories: CategoryAnalysis[];
  /** Income per month: received, then expected. */
  income: Map<MonthKey, Cents>;
  /** What the income lines expect this month (the usual amount without them). */
  expectedIncomeNow: Cents;
  year: YearPoint[];
  insights: Insight[];
  unfiled: { count: number; out: Cents };
}

export interface AnalyseOptions {
  today: IsoDate;
  /** First month to analyse (not before the budget start). */
  from: MonthKey;
  /** Months to project after the current one. */
  ahead: number;
  provisions?: readonly Provision[];
}

const median = (xs: readonly number[]) => {
  if (!xs.length) return 0;
  const o = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(o.length / 2);
  return o.length % 2 ? o[mid]! : Math.round((o[mid - 1]! + o[mid]!) / 2);
};
const avg = (xs: readonly number[]) => (xs.length ? Math.round(xs.reduce((s, x) => s + x, 0) / xs.length) : 0);
/** Up to the next 10 €. */
const roundUp10 = (c: Cents) => Math.ceil(c / 1000) * 1000;
const EUR = 100;

/** Sum of categories' points month by month (they share the same months). */
export function sumPoints(cats: readonly CategoryAnalysis[], months: readonly MonthKey[], kindOf: (m: MonthKey) => PointKind): MonthPoint[] {
  return months.map((month, i) => {
    let budgeted = 0;
    let spent = 0;
    for (const c of cats) {
      const p = c.points[i];
      if (p) {
        budgeted += p.budgeted;
        spent += p.spent;
      }
    }
    return { month, budgeted, spent, kind: kindOf(month) };
  });
}

export function analyseSpending(input: BudgetInput, opts: AnalyseOptions): SpendingAnalysis {
  const current = monthOf(opts.today);
  const from = compareMonths(opts.from, input.startMonth) < 0 ? input.startMonth : opts.from;
  const yearEnd = `${current.slice(0, 4)}-12` as MonthKey;
  const last = addMonths(current, opts.ahead);
  const through = compareMonths(last, yearEnd) > 0 ? last : yearEnd;
  const computed = computeBudget(input, through);
  const byMonth = new Map<MonthKey, BudgetMonth>(computed.map((m) => [m.month, m]));
  const months = compareMonths(from, current) <= 0 ? monthRange(from, current) : [];
  const fullMonths = months.filter((m) => compareMonths(m, current) < 0);
  const ahead = opts.ahead > 0 ? monthRange(addMonths(current, 1), last) : [];
  const day = Number(opts.today.slice(8, 10));
  const [cy, cm] = current.split('-').map(Number) as [number, number];
  const dayShare = Math.min(1, day / daysInMonth(cy, cm));

  const assigned = (id: Id, m: MonthKey) => byMonth.get(m)?.categories.get(id)?.assigned ?? 0;
  const spentIn = (id: Id, m: MonthKey) => -(byMonth.get(m)?.categories.get(id)?.activity ?? 0);

  // Bills and trip parts due in a month: what provisions and events will pay.
  const due = (c: Category, m: MonthKey): Cents => {
    let sum = 0;
    if (c.groupId === 'provisions') {
      for (const p of opts.provisions ?? []) {
        if (p.categoryId !== c.id) continue;
        for (const d of occurrences(p, `${m}-01`, lastDayOfMonth(m))) sum += amountFor(p, d);
      }
    } else if (c.groupId === 'events') {
      for (const part of input.plans?.get(c.id) ?? []) if (part.due === m && !part.doneMonth) sum += part.amount;
    }
    return sum;
  };

  const categories: CategoryAnalysis[] = [];
  for (const c of input.categories) {
    if (c.isIncome || !isSpendGroup(c.groupId)) continue;
    const group = c.groupId;
    const full = fullMonths.map((m) => ({ m, b: assigned(c.id, m), s: spentIn(c.id, m) }));
    const window6 = full.slice(-6);
    const recent = avg(full.slice(-3).map((x) => x.s));
    const earlier = avg(full.slice(-6, -3).map((x) => x.s));
    const avg6 = avg(window6.map((x) => x.s));
    const budgetNow = assigned(c.id, current);
    let typical: Cents;
    if (window6.length === 0) typical = budgetNow;
    // The middle month, not the mean: one big trip or repair does not set the usual amount.
    else if (group === 'variable') typical = median(window6.map((x) => x.s));
    else typical = avg6;
    typical = Math.max(0, typical);
    const project = (m: MonthKey): Cents => {
      if (group === 'provisions' || group === 'events') return due(c, m);
      // Usual spending, moved by any budget change planned ahead (a loan that ends, a raise).
      const b = assigned(c.id, m);
      if (b === 0 && budgetNow > 0) return 0;
      return Math.max(0, typical + (b - budgetNow));
    };
    const spentNow = spentIn(c.id, current);
    const currentEstimate = group === 'provisions' || group === 'events' ? Math.max(spentNow, due(c, current)) : Math.max(spentNow, typical);
    const points: MonthPoint[] = [
      ...months.map((m): MonthPoint => ({ month: m, budgeted: assigned(c.id, m), spent: spentIn(c.id, m), kind: m === current ? 'current' : 'past' })),
      ...ahead.map((m): MonthPoint => ({ month: m, budgeted: assigned(c.id, m), spent: project(m), kind: 'projected' })),
    ];
    // Kept when used in the window or this year: the year's projection must not depend on the window.
    const yearStart = `${current.slice(0, 4)}-01` as MonthKey;
    const used = points.some((p) => p.budgeted !== 0 || p.spent !== 0) || computed.some((bm) => compareMonths(bm.month, yearStart) >= 0 && compareMonths(bm.month, current) <= 0 && (bm.categories.get(c.id)?.assigned || bm.categories.get(c.id)?.activity));
    if (!used) continue;
    categories.push({
      category: c,
      group,
      points,
      fullMonths: full.length,
      avgSpent: avg(full.map((x) => x.s)),
      avgBudget: avg(full.map((x) => x.b)),
      overMonths: full.filter((x) => x.s > x.b * 1.05 && x.s - x.b >= 5 * EUR).length,
      underMonths: full.filter((x) => x.s < x.b * 0.7).length,
      recent,
      earlier,
      medianSpent: median(window6.map((x) => x.s)),
      maxSpent: window6.length ? Math.max(...window6.map((x) => x.s)) : 0,
      typical,
      assignedNow: budgetNow,
      spentNow,
      available: byMonth.get(current)?.categories.get(c.id)?.available ?? 0,
      currentEstimate,
    });
  }

  // Income: received, then what the income lines expect (or the usual amount).
  const incomeCats = input.categories.filter((c) => c.isIncome && !c.archivedAt);
  const income = new Map<MonthKey, Cents>();
  for (const m of months) income.set(m, byMonth.get(m)?.income ?? 0);
  const received = fullMonths.map((m) => byMonth.get(m)?.income ?? 0);
  const usualIncome = median(received);
  const expected = (m: MonthKey) => {
    let sum = 0;
    for (const c of incomeCats) sum += input.overrides.find((o) => o.categoryId === c.id && o.month === m)?.amount ?? defaultFor(input.defaults, c.id, m)?.monthlyAmount ?? 0;
    return sum || usualIncome;
  };
  for (const m of ahead) income.set(m, expected(m));

  // This year, cumulative: recorded through last month, this month's estimate, then the projection.
  const year: YearPoint[] = [];
  let act = 0;
  let proj = 0;
  let bud = 0;
  for (const m of monthRange(compareMonths(`${current.slice(0, 4)}-01`, input.startMonth) < 0 ? input.startMonth : `${current.slice(0, 4)}-01`, yearEnd)) {
    let spent = 0;
    let estimate = 0;
    let budget = 0;
    for (const c of categories) {
      budget += assigned(c.category.id, m);
      if (compareMonths(m, current) < 0) spent += spentIn(c.category.id, m);
      else if (m === current) {
        spent += c.spentNow;
        estimate += c.currentEstimate;
      } else {
        const i = c.points.findIndex((p) => p.month === m);
        estimate += i >= 0 ? c.points[i]!.spent : 0;
      }
    }
    // Months past the projection horizon still get a projection for the year end.
    if (compareMonths(m, last) > 0) {
      estimate = 0;
      for (const c of categories) {
        const b = assigned(c.category.id, m);
        estimate += c.group === 'provisions' || c.group === 'events' ? due(c.category, m) : b === 0 && c.assignedNow > 0 ? 0 : Math.max(0, c.typical + (b - c.assignedNow));
      }
    }
    bud += budget;
    if (compareMonths(m, current) < 0) {
      act += spent;
      proj += spent;
    } else if (m === current) {
      act += spent;
      proj += estimate;
    } else proj += estimate;
    year.push({ month: m, actual: compareMonths(m, current) <= 0 ? act : null, projected: proj, budget: bud });
  }

  // Unfiled money out on budget accounts in the window: missing from these numbers.
  const onBudget = new Set(input.accounts.filter(isOnBudget).map((a) => a.id));
  let count = 0;
  let out = 0;
  for (const t of input.transactions) {
    if (!onBudget.has(t.accountId) || (t.status !== 'new' && t.status !== 'suggested') || t.amount >= 0) continue;
    if (compareMonths(monthOf(t.date), from) < 0 || compareMonths(monthOf(t.date), current) > 0) continue;
    count++;
    out -= t.amount;
  }

  const analysis: SpendingAnalysis = { current, dayShare, months, fullMonths, ahead, categories, income, expectedIncomeNow: expected(current), year, insights: [], unfiled: { count, out } };
  analysis.insights = findInsights(analysis);
  return analysis;
}

const SEVERITY: Record<Severity, number> = { warn: 0, tip: 1, info: 2 };

/** What to do, ranked: warnings first, then by money at stake. */
export function findInsights(a: SpendingAnalysis): Insight[] {
  const out: Insight[] = [];
  const next = addMonths(a.current, 1);
  for (const c of a.categories) {
    const id = c.category.id;
    const name = c.category.name;
    const steady = c.group === 'fixed' || c.group === 'variable';
    const n = Math.min(6, c.fullMonths);
    // One main finding per category, plus overspending carried and, without a main one, the trend or this month's pace.
    let main: Insight | undefined;
    if (steady && n >= 3) {
      const last = c.points.filter((p) => p.kind === 'past').slice(-n);
      const over = last.filter((p) => p.spent > p.budgeted * 1.05 && p.spent - p.budgeted >= 5 * EUR).length;
      const spent = avg(last.map((p) => p.spent));
      const budget = avg(last.map((p) => p.budgeted));
      // Refunds bigger than spending (health insurance paying back later) say nothing about the budget.
      const usual = Math.max(0, c.group === 'variable' ? c.typical : Math.max(spent, c.typical));
      const lumpy = c.group === 'variable' && c.maxSpent >= 500 * EUR && c.maxSpent > 3 * Math.max(c.medianSpent, 0);
      if (lumpy) {
        const suggested = roundUp10(Math.max(0, c.medianSpent));
        main = { kind: 'lumpy', severity: 'tip', categoryId: id, impact: Math.max(0, spent - budget) * 12, values: { name, median: Math.max(0, c.medianSpent), max: c.maxSpent, n, spent, budget, suggested } };
        if (suggested > c.assignedNow) main.action = { type: 'default', categoryId: id, amount: suggested, from: next };
      } else if (budget === 0 && spent >= 20 * EUR) {
        main = { kind: 'unbudgeted', severity: 'warn', categoryId: id, impact: spent * 12, values: { name, spent, n, suggested: roundUp10(usual) }, action: { type: 'default', categoryId: id, amount: roundUp10(usual), from: next } };
      } else if (budget > 0 && over >= Math.ceil(n / 2) && spent > budget * 1.1 && spent - budget >= 20 * EUR) {
        const suggested = roundUp10(Math.max(usual, budget));
        main = { kind: 'over', severity: 'warn', categoryId: id, impact: (spent - budget) * 12, values: { name, over, n, spent, budget, gap: spent - budget, suggested } };
        if (suggested > c.assignedNow) main.action = { type: 'default', categoryId: id, amount: suggested, from: next };
      } else if (budget > 0 && last.every((p) => p.spent === 0) && c.spentNow === 0) {
        main = { kind: 'unused', severity: 'tip', categoryId: id, impact: budget * 12, values: { name, n, budget }, action: { type: 'default', categoryId: id, amount: 0, from: next } };
      } else if (budget > 0 && spent > 0 && spent < budget * 0.7 && budget - spent >= 20 * EUR && last.filter((p) => p.spent < p.budgeted * 0.7).length >= Math.ceil((n * 2) / 3)) {
        const suggested = Math.min(c.assignedNow, roundUp10(Math.max(spent, c.recent)));
        if (suggested < c.assignedNow) main = { kind: 'under', severity: 'tip', categoryId: id, impact: (c.assignedNow - suggested) * 12, values: { name, n, spent, budget, suggested, frees: c.assignedNow - suggested }, action: { type: 'default', categoryId: id, amount: suggested, from: next } };
      }
      if (main) out.push(main);
      if (!main && c.group === 'variable' && c.fullMonths >= 6 && c.earlier >= 50 * EUR) {
        const change = (c.recent - c.earlier) / c.earlier;
        if (change >= 0.25 && c.recent - c.earlier >= 50 * EUR) out.push({ kind: 'rising', severity: 'warn', categoryId: id, impact: (c.recent - c.earlier) * 12, values: { name, recent: c.recent, earlier: c.earlier, pct: Math.round(change * 100) } });
        else if (change <= -0.25 && c.earlier - c.recent >= 50 * EUR) out.push({ kind: 'falling', severity: 'info', categoryId: id, impact: (c.earlier - c.recent) * 12, values: { name, recent: c.recent, earlier: c.earlier, pct: Math.round(-change * 100) } });
      }
    }
    // This month, for day-to-day spending, when nothing above says it already.
    if (!main && c.group === 'variable' && c.assignedNow > 0 && a.dayShare >= 0.25 && a.dayShare < 1) {
      const pace = Math.round(c.spentNow / a.dayShare);
      if (c.spentNow > c.assignedNow) out.push({ kind: 'pace', severity: 'warn', categoryId: id, impact: (c.spentNow - c.assignedNow) * 12, values: { name, spent: c.spentNow, budget: c.assignedNow, already: 1, pace } });
      else if (pace > c.assignedNow * 1.2 && pace - c.assignedNow >= 30 * EUR) out.push({ kind: 'pace', severity: 'warn', categoryId: id, impact: (pace - c.assignedNow) * 12, values: { name, spent: c.spentNow, budget: c.assignedNow, already: 0, pace } });
    }
    // Overspending carried from month to month: cover it now.
    if (c.category.rolloverMode === 'roll' && c.available < -10 * EUR) {
      out.push({ kind: 'carried', severity: 'warn', categoryId: id, impact: -c.available, values: { name, short: -c.available }, action: { type: 'cover', categoryId: id, month: a.current, amount: c.assignedNow - c.available } });
    }
  }

  // The year: where spending is heading against the budget.
  const end = a.year.at(-1);
  if (end && a.fullMonths.length >= 2) {
    const gap = end.projected - end.budget;
    const year = end.month.slice(0, 4);
    if (gap > end.budget * 0.03) out.push({ kind: 'yearEnd', severity: 'warn', impact: gap, values: { year, projected: end.projected, budget: end.budget, gap } });
    else out.push({ kind: 'onTrack', severity: 'info', impact: 0, values: { year, projected: end.projected, budget: end.budget, gap: -gap } });
  }

  // Where day-to-day money goes.
  const variable = a.categories.filter((c) => c.group === 'variable' && c.fullMonths > 0);
  const total = variable.reduce((s, c) => s + Math.max(0, c.avgSpent), 0);
  if (total > 0 && variable.length >= 4) {
    const top = [...variable].sort((x, y) => y.avgSpent - x.avgSpent).slice(0, 3);
    const share = Math.round((top.reduce((s, c) => s + Math.max(0, c.avgSpent), 0) / total) * 100);
    out.push({ kind: 'drivers', severity: 'info', impact: 0, values: { names: top.map((c) => c.category.name).join(', '), share, total } });
  }

  if (a.unfiled.count > 0) out.push({ kind: 'unfiled', severity: a.unfiled.out >= 500 * EUR ? 'warn' : 'tip', impact: a.unfiled.out, values: { count: a.unfiled.count, out: a.unfiled.out }, action: { type: 'inbox' } });

  return out.sort((x, y) => SEVERITY[x.severity] - SEVERITY[y.severity] || y.impact - x.impact);
}
