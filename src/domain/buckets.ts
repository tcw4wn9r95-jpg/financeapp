import { computeBudget, type BudgetInput } from './budget';
import { addMonths, compareMonths, monthOf } from './dates';
import { amountFor, nextDue, occurrences, parseRecurrence } from './plan';
import type { Cents, EventFund, Id, IsoDate, MonthKey, Provision, Transaction } from './types';

/**
 * Provisions and trips as buckets inside one savings account (D-69).
 *
 * The budget plans how much each provision and trip should have by now in its
 * current cycle; what was paid out of it in that cycle (the bill, the trip
 * spending) comes off. That is what the bucket should hold. The real balance
 * of the provisions account is then shared out in order of due date, the
 * soonest bill first; whatever is left is free savings. Nothing is allocated
 * by hand: moving money in, taking it out and earning interest just change
 * the balance.
 */

export interface BucketWindow {
  categoryId: Id;
  /** Target of the current cycle. */
  target: Cents;
  /** First month of the current cycle (after the last due date of a recurring bill). */
  cycleStart: MonthKey;
  /** Next due date: buckets are filled from the balance soonest first. */
  due: IsoDate;
}

export interface BucketView {
  categoryId: Id;
  target: Cents;
  /** Planned by the budget in this cycle, this month included. */
  planned: Cents;
  /** Paid out of the bucket (bill, trip spending) in this cycle; refunds do not count. */
  spent: Cents;
  /** What the bucket should hold now: planned less paid. */
  claim: Cents;
  /** Covered by the provisions account's balance: what is in the bucket now. */
  level: Cents;
  /** Gone into the bucket this cycle: what is in it plus what was paid from it. */
  loaded: Cents;
  /** What the bucket should hold but the balance does not cover. */
  toMove: Cents;
  /** Of `toMove`, what was planned before this month. */
  behind: Cents;
  plannedThisMonth: Cents;
  percent: number;
  /** False when no provisions account is chosen: the plan then stands in for the money. */
  tracked: boolean;
}

export interface BucketsSummary {
  /** Balance of the provisions account at the end of the month (today for this month). */
  balance: Cents;
  /** Sum of what all buckets should hold. */
  claimed: Cents;
  /** Balance left once every bucket is covered: free savings. */
  free: Cents;
  /** What to move into the provisions account so every bucket is covered. */
  toMove: Cents;
  views: Map<Id, BucketView>;
}


/** Balance of an account at the end of `month` (its opening balance counts from its opening date). */
export function balanceAt(input: Pick<BudgetInput, 'accounts' | 'transactions'>, accountId: Id, month: MonthKey): Cents {
  const account = input.accounts.find((a) => a.id === accountId);
  if (!account) return 0;
  const end = `${month}-31`;
  let b = !account.openingDate || account.openingDate <= end ? account.openingBalance : 0;
  for (const t of input.transactions) if (t.accountId === accountId && t.date <= end) b += t.amount;
  return b;
}

/**
 * Every provision and open trip, ready for `buckets`. Pass all of them, not
 * just the ones on screen: the balance is shared between all buckets.
 */
export function allBucketWindows(provisions: readonly Provision[], events: readonly EventFund[], month: MonthKey): BucketWindow[] {
  return [...provisions.map((p) => provisionWindow(p, month)), ...events.filter((e) => e.status !== 'closed').map(tripWindow)];
}

/** Share the provisions account's balance between the buckets, soonest due first. */
export function fillBuckets(input: BudgetInput, month: MonthKey, accountId: Id | undefined, windows: readonly BucketWindow[]): BucketsSummary {
  const months = computeBudget(input, month);
  const rows = windows.map((w) => {
    let planned = 0;
    let net = 0;
    let plannedThisMonth = 0;
    for (const bm of months) {
      if (compareMonths(bm.month, w.cycleStart) < 0) continue;
      const cm = bm.categories.get(w.categoryId);
      const a = Math.max(0, cm?.assigned ?? 0);
      planned += a;
      net += cm?.activity ?? 0;
      if (bm.month === month) plannedThisMonth = a;
    }
    // Monthly amounts are rounded up to the cent: never plan more than the cycle's target.
    if (w.target > 0) planned = Math.min(planned, w.target);
    // A refund filed to the bucket's category lands where it was paid, not in the provisions account.
    const spent = Math.max(0, -net);
    return { w, planned, spent, plannedThisMonth, claim: Math.max(0, planned - spent) };
  });

  const balance = accountId ? balanceAt(input, accountId, month) : 0;
  let left = Math.max(0, balance);
  const views = new Map<Id, BucketView>();
  const order = [...rows].sort((a, b) => a.w.due.localeCompare(b.w.due) || a.claim - b.claim);
  for (const r of order) {
    const level = accountId ? Math.min(r.claim, left) : r.claim;
    left -= accountId ? level : 0;
    const toMove = r.claim - level;
    views.set(r.w.categoryId, {
      categoryId: r.w.categoryId,
      target: r.w.target,
      planned: r.planned,
      spent: r.spent,
      claim: r.claim,
      level,
      loaded: level + r.spent,
      toMove,
      behind: Math.max(0, toMove - r.plannedThisMonth),
      plannedThisMonth: r.plannedThisMonth,
      percent: r.w.target > 0 ? Math.max(0, Math.min(100, Math.round((level / r.w.target) * 100))) : 0,
      tracked: !!accountId,
    });
  }
  const claimed = rows.reduce((s, r) => s + r.claim, 0);
  return {
    balance,
    claimed,
    free: accountId ? Math.max(0, balance - claimed) : 0,
    toMove: accountId ? Math.max(0, claimed - Math.max(0, balance)) : 0,
    views,
  };
}

/** The bucket views alone (see `fillBuckets`). */
export function buckets(input: BudgetInput, month: MonthKey, accountId: Id | undefined, windows: readonly BucketWindow[]): Map<Id, BucketView> {
  return fillBuckets(input, month, accountId, windows).views;
}

export interface BucketMonth {
  month: MonthKey;
  /** Planned for the bucket in this month. */
  planned: Cents;
  /** Paid out of the bucket (negative) or refunded into it (positive), per transaction. */
  spending: { tx: Transaction; amount: Cents }[];
}

/** What was planned for and paid from one bucket in its current cycle, month by month, newest first. */
export function bucketDetail(input: BudgetInput, month: MonthKey, window: BucketWindow): BucketMonth[] {
  const months = computeBudget(input, month);
  const byId = new Map(input.transactions.map((t) => [t.id, t]));
  const out: BucketMonth[] = [];
  for (const bm of months) {
    if (compareMonths(bm.month, window.cycleStart) < 0) continue;
    const spending: BucketMonth['spending'] = [];
    for (const a of input.allocations) {
      if (a.targetType !== 'category' || a.targetId !== window.categoryId) continue;
      const tx = byId.get(a.transactionId);
      if (tx && monthOf(tx.date) === bm.month) spending.push({ tx, amount: a.amount });
    }
    const planned = Math.max(0, bm.categories.get(window.categoryId)?.assigned ?? 0);
    if (planned || spending.length) out.push({ month: bm.month, planned, spending: spending.sort((a, b) => b.tx.date.localeCompare(a.tx.date)) });
  }
  return out.reverse();
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
  const due = nextDue(p, `${month}-01`);
  return { categoryId: p.categoryId, target: amountFor(p, due), cycleStart: provisionCycleStart(p, month), due };
}

export function tripWindow(e: EventFund): BucketWindow {
  const open = e.subBudgets.filter((s) => !s.paidMonth).map((s) => s.dueDate ?? e.targetDate);
  const due = [...open, e.targetDate].sort()[0]!;
  return { categoryId: e.categoryId, target: e.targetAmount, cycleStart: monthOf(e.startDate ?? e.createdAt.slice(0, 10)), due };
}

