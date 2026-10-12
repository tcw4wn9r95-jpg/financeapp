import { computeBudget, isOnBudget, type BudgetInput } from './budget';
import { addMonths, compareMonths, monthOf } from './dates';
import { occurrences, parseRecurrence } from './plan';
import type { Cents, EventFund, Id, MonthKey, Provision, Transaction } from './types';

/**
 * Provisions and trips as buckets of real money (D-56). The budget plans
 * how much each one should get every month; a bucket only fills with money
 * actually moved into the provisions account, and empties when its bill or
 * trip spending is paid.
 *
 * Money moved into the provisions account fills a bucket only when the user
 * allocates it (D-65): one move can be split between several provisions and
 * trips, and what is not allocated stays plain savings. "Fill by plan"
 * proposes a split by what each bucket is short of its plan.
 */

export interface BucketWindow {
  categoryId: Id;
  /** Target of the current cycle. */
  target: Cents;
  /** First month of the current cycle (after the last due date of a recurring bill). */
  cycleStart: MonthKey;
}

export interface BucketView {
  categoryId: Id;
  target: Cents;
  /** Planned by the budget in this cycle, this month included. */
  planned: Cents;
  /** Moved into the provisions account for this bucket in this cycle. */
  loaded: Cents;
  /** Paid out of the bucket (bill, trip spending) in this cycle. */
  spent: Cents;
  /** In the bucket now. */
  level: Cents;
  /** Planned before this month but not moved yet. */
  behind: Cents;
  plannedThisMonth: Cents;
  percent: number;
  /** False when no provisions account is chosen: "loaded" then follows the plan. */
  tracked: boolean;
}

const BUCKET_GROUPS = new Set(['provisions', 'events']);

/** Moves into `accountId` from other on-budget accounts: the provisions account's side of each. */
export function moveTransactions(input: BudgetInput, accountId: Id): Transaction[] {
  const onBudget = new Set(input.accounts.filter(isOnBudget).map((a) => a.id));
  const byId = new Map(input.transactions.map((t) => [t.id, t]));
  return input.transactions.filter(
    (t) =>
      t.accountId === accountId &&
      t.amount > 0 &&
      input.allocations.some((a) => a.transactionId === t.id && a.targetType === 'transfer' && onBudget.has(byId.get(a.targetId)?.accountId ?? '') && byId.get(a.targetId)?.accountId !== accountId),
  );
}

/** Money moved into `accountId` from other on-budget accounts, by month. */
export function movesInto(input: BudgetInput, accountId: Id): Map<MonthKey, Cents> {
  const out = new Map<MonthKey, Cents>();
  for (const t of moveTransactions(input, accountId)) {
    const m = monthOf(t.date);
    out.set(m, (out.get(m) ?? 0) + t.amount);
  }
  return out;
}

type CycleOf = (categoryId: Id, month: MonthKey) => MonthKey | undefined;

/** The parts of a move allocated to buckets (the legacy single pin counts as the whole move). */
export function earmarksOf(t: Transaction): { categoryId: Id; amount: Cents }[] {
  if (t.earmarks) return t.earmarks.filter((e) => e.amount > 0);
  return t.earmarkCategoryId ? [{ categoryId: t.earmarkCategoryId, amount: t.amount }] : [];
}

/** What is left of a move after its allocations. */
export function unallocatedOf(t: Transaction): Cents {
  return Math.max(0, t.amount - earmarksOf(t).reduce((s, e) => s + e.amount, 0));
}

/**
 * Moves into the provisions account nobody has allocated yet, from the budget
 * start. Once saved, an allocation is decided even if part of it stays savings.
 */
export function unallocatedMoves(input: BudgetInput, accountId: Id): { tx: Transaction; left: Cents }[] {
  const start = input.startMonth;
  return moveTransactions(input, accountId)
    .filter((t) => t.earmarks === undefined && !t.earmarkCategoryId)
    .filter((t) => !start || compareMonths(monthOf(t.date), start) >= 0)
    .map((tx) => ({ tx, left: tx.amount }))
    .sort((a, b) => b.tx.date.localeCompare(a.tx.date));
}

/**
 * Money loaded into each bucket by month: the allocated parts of the moves
 * (moves before the budget start count in its first month). Without a
 * provisions account the plan stands in for real money.
 */
function loadedByMonthOf(input: BudgetInput, months: ReturnType<typeof computeBudget>, accountId: Id | undefined) {
  const ids = input.categories.filter((c) => !c.isIncome && BUCKET_GROUPS.has(c.groupId)).map((c) => c.id);
  const isBucket = new Set(ids);
  const first = months[0]?.month;
  const out = new Map<MonthKey, Map<Id, Cents>>();
  if (!accountId) {
    for (const bm of months) {
      const share = new Map<Id, Cents>();
      for (const id of ids) {
        const a = Math.max(0, bm.categories.get(id)?.assigned ?? 0);
        if (a > 0) share.set(id, a);
      }
      out.set(bm.month, share);
    }
    return out;
  }
  for (const t of moveTransactions(input, accountId)) {
    const raw = monthOf(t.date);
    const m = first && compareMonths(raw, first) < 0 ? first : raw;
    for (const e of earmarksOf(t)) {
      if (!isBucket.has(e.categoryId)) continue;
      const mm = out.get(m) ?? new Map<Id, Cents>();
      mm.set(e.categoryId, (mm.get(e.categoryId) ?? 0) + e.amount);
      out.set(m, mm);
    }
  }
  return out;
}

/**
 * A proposed split of `amount` moved in `month`: first what each bucket is
 * short of its plan in its current cycle up to that month (not counting
 * `excludeTxId`'s own allocation), then any extra ahead by that month's plan.
 */
export function suggestAllocation(input: BudgetInput, month: MonthKey, accountId: Id, amount: Cents, cycleOf: CycleOf, excludeTxId?: Id): Map<Id, Cents> {
  const months = computeBudget(input, month);
  const without = excludeTxId ? { ...input, transactions: input.transactions.map((t) => (t.id === excludeTxId ? { ...t, earmarks: [], earmarkCategoryId: undefined } : t)) } : input;
  const loaded = loadedByMonthOf(without, months, accountId);
  const ids = input.categories.filter((c) => !c.isIncome && BUCKET_GROUPS.has(c.groupId)).map((c) => c.id);
  const needs = ids
    .map((id) => {
      const from = cycleOf(id, month);
      let n = 0;
      for (const bm of months) {
        if (from && compareMonths(bm.month, from) < 0) continue;
        n += Math.max(0, bm.categories.get(id)?.assigned ?? 0) - (loaded.get(bm.month)?.get(id) ?? 0);
      }
      return [id, Math.max(0, n)] as const;
    })
    .filter(([, n]) => n > 0);
  const out = new Map<Id, Cents>();
  const needTotal = needs.reduce((s, [, n]) => s + n, 0);
  if (amount > 0 && needTotal > 0) distribute(Math.min(amount, needTotal), needs, out);
  const extra = amount - Math.min(amount, needTotal);
  const last = months.at(-1);
  const ahead = ids.map((id) => [id, Math.max(0, last?.categories.get(id)?.assigned ?? 0)] as const).filter(([, a]) => a > 0);
  if (extra > 0 && ahead.length > 0) distribute(extra, ahead, out);
  return out;
}

/** `windows` lists the buckets to report, each from the start of its current cycle. */
export function buckets(
  input: BudgetInput,
  month: MonthKey,
  accountId: Id | undefined,
  windows: readonly BucketWindow[],
): Map<Id, BucketView> {
  const months = computeBudget(input, month);
  const loadedByMonth = loadedByMonthOf(input, months, accountId);

  const out = new Map<Id, BucketView>();
  for (const w of windows) {
    let planned = 0;
    let loaded = 0;
    let spent = 0;
    let plannedThisMonth = 0;
    let loadedThisMonth = 0;
    for (const bm of months) {
      if (compareMonths(bm.month, w.cycleStart) < 0) continue;
      const cm = bm.categories.get(w.categoryId);
      const a = Math.max(0, cm?.assigned ?? 0);
      const l = loadedByMonth.get(bm.month)?.get(w.categoryId) ?? 0;
      planned += a;
      loaded += l;
      spent += -(cm?.activity ?? 0);
      if (bm.month === month) {
        plannedThisMonth = a;
        loadedThisMonth = l;
      }
    }
    const level = loaded - spent;
    // Short of the plan before this month; extra moved this month pays it down.
    const behind = Math.max(0, planned - loaded - Math.max(0, plannedThisMonth - loadedThisMonth));
    out.set(w.categoryId, {
      categoryId: w.categoryId,
      target: w.target,
      planned,
      loaded,
      spent,
      level,
      behind,
      plannedThisMonth,
      percent: w.target > 0 ? Math.max(0, Math.min(100, Math.round((level / w.target) * 100))) : 0,
      tracked: !!accountId,
    });
  }
  return out;
}

/** Share `amount` by weight (rounding leftovers to the largest weight), adding into `into`. */
function distribute(amount: Cents, weights: readonly (readonly [Id, Cents])[], into: Map<Id, Cents>): void {
  const total = weights.reduce((s, [, w]) => s + w, 0);
  let given = 0;
  for (const [id, w] of weights) {
    const part = Math.floor((amount * w) / total);
    into.set(id, (into.get(id) ?? 0) + part);
    given += part;
  }
  const largest = weights.reduce((x, y) => (y[1] > x[1] ? y : x))[0];
  into.set(largest, (into.get(largest) ?? 0) + amount - given);
}

/** First month of the provision's current cycle in `month`. */
export function provisionCycleStart(p: Provision, month: MonthKey): MonthKey {
  const start = monthOf(p.startDate ?? p.createdAt.slice(0, 10));
  if (!parseRecurrence(p.recurrence)) return start;
  const dues = occurrences(p, `${start}-01`, `${month}-01`).map(monthOf).filter((m) => compareMonths(m, month) < 0);
  const last = dues.at(-1);
  return last ? addMonths(last, 1) : start;
}

export function provisionWindow(p: Provision, month: MonthKey): BucketWindow {
  return { categoryId: p.categoryId, target: p.amount, cycleStart: provisionCycleStart(p, month) };
}

/** Cycle starts for every provision and trip, for sharing moves fairly. */
export function cycleLookup(provisions: readonly Provision[], events: readonly EventFund[]): (categoryId: Id, month: MonthKey) => MonthKey | undefined {
  const prov = new Map(provisions.map((p) => [p.categoryId, p]));
  const trips = new Map(events.map((e) => [e.categoryId, e]));
  return (id, month) => {
    const p = prov.get(id);
    if (p) return provisionCycleStart(p, month);
    const e = trips.get(id);
    return e ? tripWindow(e).cycleStart : undefined;
  };
}

export function tripWindow(e: EventFund): BucketWindow {
  return { categoryId: e.categoryId, target: e.targetAmount, cycleStart: monthOf(e.startDate ?? e.createdAt.slice(0, 10)) };
}

export interface BucketMonth {
  month: MonthKey;
  /** Allocated to this bucket from the moves of this month. */
  loaded: Cents;
  /** The moves with a part allocated to this bucket, and that part. */
  moves: { tx: Transaction; amount: Cents }[];
  /** Paid out of the bucket (negative) or refunded into it (positive), per transaction. */
  spending: { tx: Transaction; amount: Cents }[];
}

export interface BucketDetail {
  months: BucketMonth[];
  /**
   * Money that came into the provisions account in the cycle but is not
   * counted as a move: not classified yet, or classified as something else.
   */
  notCounted: Transaction[];
}

/** What fed and emptied one bucket in its current cycle, month by month, newest first (D-64, D-65). */
export function bucketDetail(input: BudgetInput, month: MonthKey, accountId: Id | undefined, window: BucketWindow): BucketDetail {
  const months = computeBudget(input, month);
  const loadedByMonth = loadedByMonthOf(input, months, accountId);
  const first = months[0]?.month;
  const shownMonth = (d: string): MonthKey => {
    const m = monthOf(d);
    return first && compareMonths(m, first) < 0 ? first : m;
  };
  const inCycle = (m: MonthKey) => compareMonths(m, window.cycleStart) >= 0 && compareMonths(m, month) <= 0;
  const moves = accountId ? moveTransactions(input, accountId) : [];
  const moveIds = new Set(moves.map((t) => t.id));
  const byId = new Map(input.transactions.map((t) => [t.id, t]));
  const out: BucketMonth[] = [];
  for (const bm of months) {
    if (!inCycle(bm.month)) continue;
    const spending: BucketMonth['spending'] = [];
    for (const a of input.allocations) {
      if (a.targetType !== 'category' || a.targetId !== window.categoryId) continue;
      const tx = byId.get(a.transactionId);
      if (tx && monthOf(tx.date) === bm.month) spending.push({ tx, amount: a.amount });
    }
    const monthMoves = moves
      .filter((t) => shownMonth(t.date) === bm.month)
      .map((tx) => ({ tx, amount: earmarksOf(tx).filter((e) => e.categoryId === window.categoryId).reduce((s, e) => s + e.amount, 0) }))
      .filter((x) => x.amount > 0);
    const loaded = loadedByMonth.get(bm.month)?.get(window.categoryId) ?? 0;
    if (loaded || monthMoves.length || spending.length) {
      out.push({
        month: bm.month,
        loaded,
        moves: monthMoves.sort((a, b) => b.tx.date.localeCompare(a.tx.date)),
        spending: spending.sort((a, b) => b.tx.date.localeCompare(a.tx.date)),
      });
    }
  }
  const notCounted = accountId
    ? input.transactions
        .filter((t) => t.accountId === accountId && t.amount > 0 && !moveIds.has(t.id) && inCycle(shownMonth(t.date)))
        .sort((a, b) => b.date.localeCompare(a.date))
    : [];
  return { months: out.reverse(), notCounted };
}
