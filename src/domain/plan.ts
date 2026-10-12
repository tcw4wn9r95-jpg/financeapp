import { computeBudget, type BudgetInput, type PlanPart } from './budget';
import { addMonths, daysInMonth, monthDiff, monthOf } from './dates';
import type { Allocation, Cents, EventFund, Id, IsoDate, MonthKey, Provision } from './types';

/**
 * Provisions and events (PRD F3, F4). Each one is backed by a budget category
 * (D-33, D-34): money set aside is that category's available balance, and a
 * bill or trip expense classified to it draws from it, never from Variable.
 */

// ------------------------------------------------------------ recurrence

export interface Recurrence {
  freq: 'MONTHLY' | 'YEARLY';
  interval: number;
}

export function parseRecurrence(rrule: string): Recurrence | null {
  const parts = Object.fromEntries(
    rrule
      .split(';')
      .map((p) => p.split('='))
      .filter((kv) => kv.length === 2)
      .map(([k, v]) => [k!.toUpperCase(), v!.toUpperCase()]),
  );
  if (parts.FREQ !== 'MONTHLY' && parts.FREQ !== 'YEARLY') return null;
  const interval = Math.max(1, Number(parts.INTERVAL ?? 1) || 1);
  return { freq: parts.FREQ, interval };
}

export function formatRecurrence(r: Recurrence | null): string {
  return r ? `FREQ=${r.freq};INTERVAL=${r.interval}` : '';
}

/** Months between occurrences (12 for yearly). */
export function periodMonths(r: Recurrence): number {
  return r.freq === 'YEARLY' ? 12 * r.interval : r.interval;
}

/** Same day of month n months later, clamped to the month's length. */
export function addMonthsToDate(date: IsoDate, n: number): IsoDate {
  const month = addMonths(monthOf(date), n);
  const [y, m] = month.split('-').map(Number) as [number, number];
  return `${month}-${String(Math.min(Number(date.slice(8, 10)), daysInMonth(y, m))).padStart(2, '0')}`;
}

/** All due dates of a provision between two dates (inclusive). */
export function occurrences(p: Pick<Provision, 'dueDate' | 'recurrence'>, from: IsoDate, to: IsoDate): IsoDate[] {
  const r = parseRecurrence(p.recurrence);
  if (!r) return p.dueDate >= from && p.dueDate <= to ? [p.dueDate] : [];
  const step = periodMonths(r);
  const out: IsoDate[] = [];
  let k = 0;
  // Step back from the anchor if needed, then forward to the end.
  while (addMonthsToDate(p.dueDate, k * step) > from && k > -600) k--;
  for (let d = addMonthsToDate(p.dueDate, k * step); d <= to; d = addMonthsToDate(p.dueDate, ++k * step)) {
    if (d >= from) out.push(d);
  }
  return out;
}

/** The next due date on or after `today` (the anchor itself for a one-off). */
export function nextDue(p: Pick<Provision, 'dueDate' | 'recurrence'>, today: IsoDate): IsoDate {
  if (!parseRecurrence(p.recurrence)) return p.dueDate;
  return occurrences(p, today, addMonthsToDate(today, 12 * 50))[0] ?? p.dueDate;
}

/**
 * Monthly set-aside so the money is there by the due month:
 * (amount − already set aside) spread over the months left, this month included.
 * Rounded up to the cent so the target is always reached.
 */
export function monthlySetAside(amount: Cents, funded: Cents, currentMonth: MonthKey, dueDate: IsoDate): Cents {
  const months = Math.max(1, monthDiff(currentMonth, monthOf(dueDate)) + 1);
  return Math.max(0, Math.ceil((amount - funded) / months));
}

/**
 * The monthly amounts a provision budgets, as dated steps (D-49):
 * - from the start month to the first due month: the target spread evenly;
 * - after that, for a recurring bill, the target spread over one full cycle;
 * - for a one-off, nothing after the due month.
 * Amounts are rounded up to the cent so the target is always reached.
 */
export function provisionSchedule(p: Pick<Provision, 'amount' | 'dueDate' | 'recurrence' | 'startDate'>, fallbackStart: MonthKey): { from: MonthKey; amount: Cents }[] {
  const start = p.startDate ? monthOf(p.startDate) : fallbackStart;
  const r = parseRecurrence(p.recurrence);
  const firstDue = r ? occurrences(p, `${start}-01`, addMonthsToDate(`${start}-01`, 12 * 50))[0] : p.dueDate;
  if (!firstDue || monthOf(firstDue) < start) return [{ from: start, amount: 0 }];
  const months = monthDiff(start, monthOf(firstDue)) + 1;
  const out = [{ from: start, amount: Math.ceil(p.amount / months) }];
  const after = addMonths(monthOf(firstDue), 1);
  if (!r) out.push({ from: after, amount: 0 });
  else {
    const cycle = Math.ceil(p.amount / periodMonths(r));
    if (cycle !== out[0]!.amount) out.push({ from: after, amount: cycle });
  }
  return out;
}

export interface ProvisionStatus {
  provision: Provision;
  nextDue: IsoDate;
  /** Set aside before this month (the category's carry-in). */
  fundedBefore: Cents;
  /** Available now (after this month's assignment and payments). */
  available: Cents;
  suggested: Cents;
  assignedThisMonth: Cents;
  percent: number;
}

export function provisionStatus(p: Provision, input: BudgetInput, month: MonthKey, today: IsoDate): ProvisionStatus {
  const budget = computeBudget(input, month).at(-1);
  const cm = budget?.categories.get(p.categoryId);
  const due = nextDue(p, today);
  const fundedBefore = cm?.carryIn ?? 0;
  const available = cm?.available ?? 0;
  // Money already there, not counting this month's own assignment (a bill paid
  // this month has already left it).
  // Not live yet: nothing to set aside before the start month (D-49).
  const notStarted = !!p.startDate && monthOf(p.startDate) > month;
  const suggested = notStarted ? 0 : monthlySetAside(p.amount, fundedBefore + (cm?.activity ?? 0), month, due);
  return {
    provision: p,
    nextDue: due,
    fundedBefore,
    available,
    suggested,
    assignedThisMonth: cm?.assigned ?? 0,
    percent: p.amount > 0 ? Math.max(0, Math.min(100, Math.round((available / p.amount) * 100))) : 0,
  };
}

// ----------------------------------------------------------------- events

export interface EventStatusView {
  event: EventFund;
  /** Total assigned to the event's category so far (contributions). */
  contributed: Cents;
  /** Total spent from it (positive number). */
  spent: Cents;
  /** Money left in the fund. */
  available: Cents;
  remainingToSpend: Cents;
  fundedPercent: number;
  /** Positive = under budget (surplus), negative = over. */
  overUnder: Cents;
  suggested: Cents;
  bySubBudget: { name: string; budget: Cents; spent: Cents; due: IsoDate; paid: boolean }[];
  unassignedSpent: Cents;
}

export function eventStatus(e: EventFund, input: BudgetInput, month: MonthKey, allocations: readonly Allocation[]): EventStatusView {
  const months = computeBudget(input, month);
  let contributed = 0;
  let spentActivity = 0;
  for (const m of months) {
    const c = m.categories.get(e.categoryId);
    if (!c) continue;
    contributed += c.assigned;
    spentActivity += c.activity;
  }
  const available = months.at(-1)?.categories.get(e.categoryId)?.available ?? 0;
  const spent = -spentActivity;
  const allocs = allocations.filter((a) => a.targetType === 'category' && a.targetId === e.categoryId);
  const bySubBudget = e.subBudgets.map((sb) => ({
    name: sb.name,
    budget: sb.amount,
    due: sb.dueDate ?? e.targetDate,
    paid: !!sb.paidMonth,
    spent: -allocs.filter((a) => a.subBudget === sb.name).reduce((s, a) => s + a.amount, 0),
  }));
  const unassignedSpent = spent - bySubBudget.reduce((s, b) => s + b.spent, 0);
  // With a plan (D-54) this month's amount comes from it; otherwise the even split to the date.
  const planned = input.plans?.has(e.categoryId) ? months.at(-1)?.categories.get(e.categoryId)?.defaultAmount : undefined;
  const suggested = e.status === 'closed' ? 0 : planned ?? monthlySetAside(e.targetAmount, available + spent, month, e.targetDate);
  return {
    event: e,
    contributed,
    spent,
    available,
    remainingToSpend: Math.max(0, e.targetAmount - spent),
    fundedPercent: e.targetAmount > 0 ? Math.round(((available + spent) / e.targetAmount) * 100) : 0,
    overUnder: available,
    suggested,
    bySubBudget,
    unassignedSpent,
  };
}

/**
 * A trip as a plan (D-54): one part per sub-budget, each needed by its own
 * date, plus "the rest" (target minus the parts) by the trip date. A closed
 * trip's parts all end in the month it was closed, so its history stays.
 */
export function eventPlanParts(e: EventFund): PlanPart[] {
  const start = monthOf(e.startDate ?? e.createdAt.slice(0, 10));
  const closed = e.closedAt ? monthOf(e.closedAt.slice(0, 10)) : undefined;
  const tripDue = monthOf(e.targetDate);
  const part = (key: string, amount: Cents, due: MonthKey, paid?: MonthKey): PlanPart => {
    const done = [paid, closed].filter((x): x is MonthKey => !!x).sort()[0];
    const p: PlanPart = { key, amount, start, due: due < start ? start : due };
    if (done) p.doneMonth = done;
    return p;
  };
  const parts = e.subBudgets.filter((sb) => sb.amount > 0).map((sb) => part(sb.name, sb.amount, sb.dueDate ? monthOf(sb.dueDate) : tripDue, sb.paidMonth));
  const rest = e.targetAmount - e.subBudgets.reduce((s, sb) => s + Math.max(0, sb.amount), 0);
  if (rest > 0) parts.push(part('', rest, tripDue));
  return parts;
}

/** Plans for every trip, for the budget engine. */
export function eventPlans(events: readonly EventFund[]): Map<Id, PlanPart[]> {
  return new Map(events.map((e) => [e.categoryId, eventPlanParts(e)]));
}

export interface CloseEventPlan {
  overrides: { categoryId: Id; month: MonthKey; amount: Cents; note: string }[];
  /** Positive = surplus moved to the target, negative = deficit covered by it. */
  moved: Cents;
}

/**
 * Close an event in `month`: whatever is left in its fund (surplus) moves to
 * the chosen category; a deficit is covered by it. Done with this month's
 * assigned amounts, so the ledger is untouched (scenario/plan layer only).
 */
export function planCloseEvent(
  e: EventFund,
  input: BudgetInput,
  month: MonthKey,
  targetCategoryId: Id,
): CloseEventPlan {
  const budget = computeBudget(input, month).at(-1);
  const ev = budget?.categories.get(e.categoryId);
  const tg = budget?.categories.get(targetCategoryId);
  const moved = ev?.available ?? 0;
  const note = `Closed ${e.name}`;
  const overrides = [
    { categoryId: e.categoryId, month, amount: (ev?.assigned ?? 0) - moved, note },
    { categoryId: targetCategoryId, month, amount: (tg?.assigned ?? 0) + moved, note },
  ];
  return { overrides, moved };
}

/**
 * How much to move to the provisions account in a month (D-55): what the
 * budget sets aside for provisions and trips that month, less what was
 * already moved there from other on-budget accounts.
 */
export function provisionsMove(input: BudgetInput, month: MonthKey, accountId: Id): { planned: Cents; moved: Cents; left: Cents; parts: { categoryId: Id; amount: Cents }[] } {
  const b = computeBudget(input, month).at(-1);
  const groups = new Set(['provisions', 'events']);
  const parts: { categoryId: Id; amount: Cents }[] = [];
  for (const c of input.categories) {
    if (c.isIncome || !groups.has(c.groupId)) continue;
    const a = b?.categories.get(c.id)?.assigned ?? 0;
    if (a > 0) parts.push({ categoryId: c.id, amount: a });
  }
  const planned = parts.reduce((s, p) => s + p.amount, 0);
  const onBudget = new Set(input.accounts.filter((a) => a.type !== 'loan').map((a) => a.id));
  const bucketIds = new Set(input.categories.filter((c) => !c.isIncome && groups.has(c.groupId)).map((c) => c.id));
  // Only money allocated to provisions and trips counts as moved for them (D-65).
  const moved = input.transactions
    .filter((t) => t.accountId === accountId && t.amount > 0 && monthOf(t.date) === month)
    .filter((t) => input.allocations.some((a) => a.transactionId === t.id && a.targetType === 'transfer' && onBudget.has(input.transactions.find((x) => x.id === a.targetId)?.accountId ?? '')))
    .reduce((s, t) => {
      const parts = t.earmarks ?? (t.earmarkCategoryId ? [{ categoryId: t.earmarkCategoryId, amount: t.amount }] : []);
      return s + parts.filter((e) => bucketIds.has(e.categoryId)).reduce((x, e) => x + Math.max(0, e.amount), 0);
    }, 0);
  return { planned, moved, left: Math.max(0, planned - moved), parts };
}

/** Planned provisions moves by month, for recognising the transfer when it is imported. */
export function provisionsMoveByMonth(input: BudgetInput, through: MonthKey): Map<MonthKey, Cents> {
  const out = new Map<MonthKey, Cents>();
  const groups = new Set(['provisions', 'events']);
  const ids = new Set(input.categories.filter((c) => !c.isIncome && groups.has(c.groupId)).map((c) => c.id));
  for (const m of computeBudget(input, through)) {
    let sum = 0;
    for (const [id, cm] of m.categories) if (ids.has(id) && cm.assigned > 0) sum += cm.assigned;
    out.set(m.month, sum);
  }
  return out;
}
