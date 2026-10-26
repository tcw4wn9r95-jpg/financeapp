import { accountBalances, computeBudget, defaultFor, isOnBudget, overrideFor, type BudgetInput } from './budget';
import { addDays, addMonths, daysInMonth, lastDayOfMonth, monthOf } from './dates';
import { occurrences } from './plan';
import type { Cents, EventFund, Id, IsoDate, MonthKey, Provision, ScenarioChange, Transaction } from './types';

/**
 * Cash-flow forecast (PRD F9). A computed view, never stored as truth.
 *
 * Starts from today's real balances of on-budget accounts and simulates every
 * day of the horizon from the plan (D-35):
 * - expected income per income category: its planned amount; a line with no
 *   plan only when it is regular (paid in each of the last three complete
 *   months), at its typical amount, so one-off refunds are not repeated (D-105);
 * - Fixed categories: the assigned amount on their usual day;
 * - Variable categories: the assigned amount spread evenly over the month;
 * - on the "recent pace" basis (D-105), spending lines at what they really
 *   cost over the last six complete months instead (fixed: the average;
 *   variable: the typical month), where there is enough history;
 * - provisions: the full bill on each due date (not the monthly set-aside);
 * - events: what is left to spend, on the event date;
 * - Savings categories: no outflow (the money stays in your accounts);
 * - extra items: tax refunds or balances due, scenario changes.
 * In the current month only what has not happened yet is counted.
 */

export type CashKind = 'income' | 'fixed' | 'variable' | 'provision' | 'event' | 'tax' | 'scenario' | 'transfer';

export interface CashItem {
  date: IsoDate;
  amount: Cents;
  label: string;
  kind: CashKind;
  /** Category or record the item comes from, for per-account distribution. */
  categoryId?: Id;
  accountId?: Id;
}

export interface ForecastInput {
  today: IsoDate;
  months: number;
  budget: BudgetInput;
  provisions: readonly Provision[];
  events: readonly EventFund[];
  extra?: readonly CashItem[];
  changes?: readonly ScenarioChange[];
  /** What spending lines cost ahead: the plan (default) or the recent pace (D-105). */
  basis?: 'plan' | 'recent';
}

export interface ForecastMonth {
  month: MonthKey;
  end: Cents;
  min: Cents;
  minDate: IsoDate;
  inflow: Cents;
  outflow: Cents;
  /** Money the provisions and trips should hold at the month end, for bills still to come (D-105). */
  held: Cents;
  /** Set aside for provisions and trips that month (D-106). */
  setAside: Cents;
  /** Bills and trips paid that month out of what was set aside for them (D-106). */
  fromProvisions: Cents;
  /** Out as the budget sees it (D-106): spending plus what was set aside; a provisioned bill is not spent again. */
  spent: Cents;
  /** Lowest balance of the month less what provisions and trips hold: money not set aside (D-106). */
  free: Cents;
  /** Spending lines (fixed and variable) that month: the base of an emergency reserve. */
  living: Cents;
}

export interface ForecastResult {
  start: Cents;
  days: { date: IsoDate; balance: Cents }[];
  months: ForecastMonth[];
  items: CashItem[];
  byAccount: Map<Id, { month: MonthKey; end: Cents }[]>;
}

const SPEND_LOOKBACK = 6;

function median(xs: number[]): number | undefined {
  if (xs.length === 0) return undefined;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

function dateIn(month: MonthKey, day: number): IsoDate {
  const [y, m] = month.split('-').map(Number) as [number, number];
  return `${month}-${String(Math.min(Math.max(1, day), daysInMonth(y, m))).padStart(2, '0')}`;
}

interface History {
  /** Signed activity per category per month. */
  actual: Map<Id, Map<MonthKey, Cents>>;
  /** Days of month on which a category's transactions happened. */
  days: Map<Id, number[]>;
  /** Absolute activity per category per account (for per-account shares). */
  byAccount: Map<Id, Map<Id, Cents>>;
}

function history(input: BudgetInput, today: IsoDate): History {
  const fromMonth = addMonths(monthOf(today), -SPEND_LOOKBACK);
  const txById = new Map<Id, Transaction>(input.transactions.map((t) => [t.id, t]));
  const h: History = { actual: new Map(), days: new Map(), byAccount: new Map() };
  for (const a of input.allocations) {
    if (a.targetType !== 'category' && a.targetType !== 'income') continue;
    const t = txById.get(a.transactionId);
    if (!t || t.date > today) continue;
    const m = monthOf(t.date);
    const perMonth = h.actual.get(a.targetId) ?? new Map<MonthKey, Cents>();
    perMonth.set(m, (perMonth.get(m) ?? 0) + a.amount);
    h.actual.set(a.targetId, perMonth);
    if (m >= fromMonth) {
      h.days.set(a.targetId, [...(h.days.get(a.targetId) ?? []), Number(t.date.slice(8, 10))]);
      const acc = h.byAccount.get(a.targetId) ?? new Map<Id, Cents>();
      acc.set(t.accountId, (acc.get(t.accountId) ?? 0) + Math.abs(a.amount));
      h.byAccount.set(a.targetId, acc);
    }
  }
  return h;
}

function planned(input: BudgetInput, categoryId: Id, month: MonthKey): Cents | undefined {
  const o = overrideFor(input.overrides, categoryId, month);
  if (o) return o.amount;
  return defaultFor(input.defaults, categoryId, month)?.monthlyAmount;
}

/**
 * What-if changes to budget lines (D-79), as month amounts of their own: the
 * line's planned amount plus or minus the change, or the amount set (0 stops it).
 */
export function withLineChanges(budget: BudgetInput, changes: readonly ScenarioChange[], from: MonthKey, through: MonthKey): BudgetInput {
  const lines = changes.filter((c) => c.type === 'line' && c.target);
  if (lines.length === 0) return budget;
  const overrides = [...budget.overrides];
  for (const c of lines) {
    const id = c.target!.targetId;
    const last = c.end && c.end < through ? c.end : through;
    for (let m = c.start < from ? from : c.start; m <= last; m = addMonths(m, 1)) {
      const base = overrides.find((o) => o.categoryId === id && o.month === m)?.amount ?? defaultFor(budget.defaults, id, m)?.monthlyAmount ?? 0;
      const amount = c.mode === 'set' ? c.amount : Math.max(0, base + c.amount);
      const i = overrides.findIndex((o) => o.categoryId === id && o.month === m);
      const record = { id: `scenario:${id}:${m}`, createdAt: '', updatedAt: '', source: 'manual' as const, categoryId: id, month: m, amount, note: '' };
      if (i >= 0) overrides[i] = record;
      else overrides.push(record);
    }
  }
  return { ...budget, overrides };
}

/** Scheduled cash items over the horizon (exported for tests and the item list). */
export function scheduleItems(f: ForecastInput): CashItem[] {
  const { today } = f;
  const tomorrow = addDays(today, 1);
  const thisMonth = monthOf(today);
  const lastMonth = addMonths(thisMonth, f.months - 1);
  const budget = withLineChanges(f.budget, f.changes ?? [], thisMonth, lastMonth);
  const end = lastDayOfMonth(lastMonth);
  const h = history(budget, today);
  const items: CashItem[] = [];
  const push = (date: IsoDate, amount: Cents, label: string, kind: CashKind, categoryId?: Id) => {
    if (amount === 0 || date < tomorrow || date > end) return;
    items.push({ date, amount, label, kind, ...(categoryId ? { categoryId } : {}) });
  };
  const provisionCats = new Set(f.provisions.map((p) => p.categoryId));
  const eventCats = new Set(f.events.map((e) => e.categoryId));
  // What each spending line really cost over the last six complete months (D-105).
  const pace = new Map<Id, Cents>();
  for (const c of budget.categories) {
    if (c.isIncome) continue;
    const spent = Array.from({ length: SPEND_LOOKBACK }, (_, k) => -(h.actual.get(c.id)?.get(addMonths(thisMonth, -(k + 1))) ?? 0));
    if (spent.filter((x) => x !== 0).length < 3) continue;
    pace.set(c.id, Math.max(0, c.groupId === 'fixed' ? Math.round(spent.reduce((x, y) => x + y, 0) / spent.length) : median(spent)!));
  }

  for (let i = 0; i < f.months; i++) {
    const month = addMonths(thisMonth, i);
    const isCurrent = month === thisMonth;
    const firstDay = isCurrent ? tomorrow : `${month}-01`;
    const lastDay = lastDayOfMonth(month);
    if (firstDay > lastDay) continue;
    const dayCount = Number(lastDay.slice(8)) - Number(firstDay.slice(8)) + 1;

    for (const c of budget.categories) {
      if (c.archivedAt) continue;
      const done = h.actual.get(c.id)?.get(month) ?? 0;
      const usual = median(h.days.get(c.id) ?? []);
      if (c.isIncome) {
        let expected = planned(budget, c.id, month);
        if (expected === undefined) {
          // No plan: only a regular income continues (paid in each of the last three months), at its typical amount.
          const recent = [1, 2, 3].map((k) => h.actual.get(c.id)?.get(addMonths(thisMonth, -k)) ?? 0);
          expected = recent.every((x) => x > 0) ? median(recent)! : 0;
        }
        const amount = isCurrent ? Math.max(0, expected - done) : expected;
        if (amount <= 0) continue;
        let date = dateIn(month, usual ?? 25);
        if (date < firstDay) date = firstDay;
        push(date, amount, c.name, 'income', c.id);
        continue;
      }
      if (c.groupId === 'savings') continue;
      if (provisionCats.has(c.id) || eventCats.has(c.id)) continue;
      const assigned = f.basis === 'recent' ? (pace.get(c.id) ?? planned(budget, c.id, month) ?? 0) : (planned(budget, c.id, month) ?? 0);
      if (assigned <= 0) continue;
      const amount = isCurrent ? Math.max(0, assigned + done) : assigned; // done is negative spending
      if (amount <= 0) continue;
      if (c.groupId === 'fixed' || c.groupId === 'provisions' || c.groupId === 'investments') {
        let date = dateIn(month, usual ?? 1);
        if (date < firstDay) date = firstDay;
        // Money invested leaves the accounts but is not a living cost.
        push(date, -amount, c.name, c.groupId === 'investments' ? 'transfer' : 'fixed', c.id);
      } else {
        // Spread evenly; the remainder goes on the first day so cents add up.
        const per = Math.floor(amount / dayCount);
        const rest = amount - per * dayCount;
        for (let d = 0; d < dayCount; d++) {
          push(addDays(firstDay, d), -(per + (d === 0 ? rest : 0)), c.name, 'variable', c.id);
        }
      }
    }
  }

  for (const p of f.provisions) {
    for (const due of occurrences(p, monthOf(today) + '-01', end)) {
      // A bill due this month that is already paid is not counted again.
      const paidThisMonth = (h.actual.get(p.categoryId)?.get(thisMonth) ?? 0) <= -p.amount * 0.9;
      if (monthOf(due) === thisMonth && paidThisMonth) continue;
      push(due < tomorrow ? tomorrow : due, -p.amount, p.name, 'provision', p.categoryId);
    }
  }

  for (const e of f.events) {
    if (e.status === 'closed') continue;
    let spent = 0;
    for (const v of h.actual.get(e.categoryId)?.values() ?? []) spent += -v;
    const left = e.targetAmount - spent;
    if (left > 0) push(e.targetDate < tomorrow ? tomorrow : e.targetDate, -left, e.name, 'event', e.categoryId);
  }

  for (const c of f.changes ?? []) {
    if (c.type === 'line') continue; // already in the budget lines above
    const last = c.end ?? lastMonth;
    for (let m = c.start; m <= last && m <= lastMonth; m = addMonths(m, 1)) {
      if (c.type === 'oneOff') {
        push(`${m}-01`, c.amount, 'Scenario', 'scenario');
        break;
      }
      const sign = c.type === 'income' ? 1 : -1;
      push(dateIn(m, c.type === 'income' ? 25 : 1), sign * Math.abs(c.amount), 'Scenario', 'scenario', c.target?.targetId);
    }
  }

  for (const x of f.extra ?? []) push(x.date, x.amount, x.label, x.kind, x.categoryId);
  return items.sort((a, b) => a.date.localeCompare(b.date));
}

/** Regular monthly transfers between own accounts (present in each of the last 3 complete months). */
export function recurringTransfers(input: BudgetInput, today: IsoDate): { from: Id; to: Id; amount: Cents; day: number }[] {
  const months = [1, 2, 3].map((k) => addMonths(monthOf(today), -k));
  const txById = new Map(input.transactions.map((t) => [t.id, t]));
  const seen = new Map<string, { perMonth: Map<MonthKey, Cents>; days: number[] }>();
  for (const a of input.allocations) {
    if (a.targetType !== 'transfer') continue;
    const t = txById.get(a.transactionId);
    const other = txById.get(a.targetId);
    if (!t || !other || t.amount >= 0) continue;
    const m = monthOf(t.date);
    if (!months.includes(m)) continue;
    const key = `${t.accountId}>${other.accountId}`;
    const entry = seen.get(key) ?? { perMonth: new Map<MonthKey, Cents>(), days: [] as number[] };
    entry.perMonth.set(m, (entry.perMonth.get(m) ?? 0) - t.amount);
    entry.days.push(Number(t.date.slice(8, 10)));
    seen.set(key, entry);
  }
  const out: { from: Id; to: Id; amount: Cents; day: number }[] = [];
  for (const [key, e] of seen) {
    if (months.some((m) => !e.perMonth.has(m))) continue;
    const [from, to] = key.split('>') as [Id, Id];
    out.push({ from, to, amount: median([...e.perMonth.values()])!, day: median(e.days)! });
  }
  return out;
}

export function forecast(f: ForecastInput): ForecastResult {
  const { today, budget } = f;
  const onBudget = budget.accounts.filter((a) => isOnBudget(a) && !a.closedAt);
  const balances = accountBalances(budget.accounts, budget.transactions, today);
  const start = onBudget.reduce((s, a) => s + (balances.get(a.id) ?? 0), 0);
  const items = scheduleItems(f);
  const end = lastDayOfMonth(addMonths(monthOf(today), f.months - 1));

  // ------------------------------------------------------------- total
  const perDay = new Map<IsoDate, Cents>();
  for (const it of items) perDay.set(it.date, (perDay.get(it.date) ?? 0) + it.amount);
  const days: { date: IsoDate; balance: Cents }[] = [{ date: today, balance: start }];
  const months: ForecastMonth[] = [];
  let bal = start;
  let cur: ForecastMonth | null = null;
  for (let d = addDays(today, 1); d <= end; d = addDays(d, 1)) {
    const delta = perDay.get(d) ?? 0;
    bal += delta;
    days.push({ date: d, balance: bal });
    const m = monthOf(d);
    if (!cur || cur.month !== m) {
      if (cur) months.push(cur);
      cur = { month: m, end: bal, min: bal, minDate: d, inflow: 0, outflow: 0, held: 0, living: 0, setAside: 0, fromProvisions: 0, spent: 0, free: 0 };
    }
    cur.end = bal;
    if (bal < cur.min) {
      cur.min = bal;
      cur.minDate = d;
    }
  }
  const lastMonthAcc = cur as ForecastMonth | null;
  if (lastMonthAcc) months.push(lastMonthAcc);
  for (const it of items) {
    const m = months.find((x) => x.month === monthOf(it.date));
    if (!m) continue;
    if (it.amount > 0) m.inflow += it.amount;
    else m.outflow -= it.amount;
    if (it.kind === 'fixed' || it.kind === 'variable') m.living -= it.amount;
  }
  const flow = provisionFlow(f, months.map((m) => m.month));
  for (const m of months) {
    const x = flow.get(m.month)!;
    m.held = x.held;
    m.setAside = x.setAside;
    m.fromProvisions = x.paid;
    m.spent = m.outflow - x.paid + x.setAside;
    m.free = m.min - x.held;
  }

  // -------------------------------------------------------- per account
  // Each category keeps being paid from the accounts it was paid from in the
  // last months; regular transfers between accounts continue (D-35).
  const h = history(budget, today);
  const primary =
    onBudget
      .filter((a) => a.type === 'current')
      .sort((a, b) => budget.transactions.filter((t) => t.accountId === b.id).length - budget.transactions.filter((t) => t.accountId === a.id).length)[0] ??
    onBudget[0];
  const accDelta = new Map<Id, Map<IsoDate, Cents>>(onBudget.map((a) => [a.id, new Map()]));
  const add = (acc: Id, date: IsoDate, amount: Cents) => {
    const m = accDelta.get(acc);
    if (m) m.set(date, (m.get(date) ?? 0) + amount);
  };
  for (const it of items) {
    const shares = it.categoryId ? h.byAccount.get(it.categoryId) : undefined;
    const valid = shares ? [...shares].filter(([id]) => accDelta.has(id)) : [];
    const total = valid.reduce((s, [, v]) => s + v, 0);
    if (total === 0) {
      if (primary) add(it.accountId ?? primary.id, it.date, it.amount);
      continue;
    }
    let left = it.amount;
    valid.forEach(([id, v], i) => {
      const part = i === valid.length - 1 ? left : Math.round((it.amount * v) / total);
      left -= part;
      add(id, it.date, part);
    });
  }
  for (const r of recurringTransfers(budget, today)) {
    if (!accDelta.has(r.from) || !accDelta.has(r.to)) continue;
    for (let i = 0; i < f.months; i++) {
      const month = addMonths(monthOf(today), i);
      const date = dateIn(month, r.day);
      if (date <= today) continue;
      add(r.from, date, -r.amount);
      add(r.to, date, r.amount);
    }
  }
  const byAccount = new Map<Id, { month: MonthKey; end: Cents }[]>();
  for (const a of onBudget) {
    let b = balances.get(a.id) ?? 0;
    const series: { month: MonthKey; end: Cents }[] = [];
    const deltas = accDelta.get(a.id)!;
    for (let d = addDays(today, 1); d <= end; d = addDays(d, 1)) {
      b += deltas.get(d) ?? 0;
      if (d === lastDayOfMonth(monthOf(d))) series.push({ month: monthOf(d), end: b });
    }
    byAccount.set(a.id, series);
  }

  return { start, days, months, items, byAccount };
}

/**
 * What the provisions and trips should hold at each month end (D-105): what
 * they hold today, plus what the plan sets aside each month, less the bills
 * and trips paid on the way (never below zero). Money in the accounts beyond
 * this, and beyond an emergency reserve, is free.
 */
/** What the provisions and trips should hold at each month end; `months`: consecutive, from this month. */
export function heldAhead(f: ForecastInput, months: readonly MonthKey[]): Map<MonthKey, Cents> {
  return new Map([...provisionFlow(f, months)].map(([m, x]) => [m, x.held]));
}

/**
 * Provisions and trips month by month (D-105, D-106): what they hold at the
 * month end (what they hold today, plus the planned set-aside, less the bills
 * and trips paid on the way, never below zero), what was set aside that
 * month, and how much of the bills paid came out of what was set aside (the
 * rest, when they were short, is new spending). `months`: consecutive, from
 * this month.
 */
export function provisionFlow(f: ForecastInput, months: readonly MonthKey[]): Map<MonthKey, { held: Cents; setAside: Cents; paid: Cents }> {
  const thisMonth = monthOf(f.today);
  const now = computeBudget(f.budget, thisMonth).at(-1);
  const out = new Map(months.map((m) => [m, { held: 0, setAside: 0, paid: 0 }]));
  const lines: { categoryId: Id; bills: { date: IsoDate; amount: Cents }[] }[] = [
    ...f.provisions.map((p) => ({ categoryId: p.categoryId, bills: occurrences(p, `${thisMonth}-01`, lastDayOfMonth(months.at(-1) ?? thisMonth)).filter((d) => d > f.today).map((d) => ({ date: d, amount: p.amount })) })),
    ...f.events.filter((e) => e.status !== 'closed').map((e) => ({ categoryId: e.categoryId, bills: e.targetDate > f.today ? [{ date: e.targetDate, amount: e.targetAmount }] : [] })),
  ];
  for (const l of lines) {
    let have = Math.max(0, now?.categories.get(l.categoryId)?.available ?? 0);
    for (const m of months) {
      const x = out.get(m)!;
      if (m !== thisMonth) {
        const add = planned(f.budget, l.categoryId, m) ?? 0;
        have += add;
        x.setAside += add;
      }
      for (const b of l.bills) {
        if (monthOf(b.date) !== m) continue;
        const fromHeld = Math.min(have, b.amount);
        x.paid += fromHeld;
        have -= fromHeld;
      }
      x.held += have;
    }
  }
  return out;
}

/** First month whose money not set aside falls below the buffer (D-106). */
export function firstBelow(months: readonly ForecastMonth[], buffer: Cents): ForecastMonth | undefined {
  return months.find((m) => m.free < buffer);
}
