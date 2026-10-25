import type { BudgetMonth } from './budget';
import { compareMonths } from './dates';
import type { BudgetOverride, Category, Cents, Cover, Id, MonthKey } from './types';

/**
 * Closing a month (D-89). A spending line that ends a month below zero does
 * not carry the gap: it is covered in that month from Ready to assign or from
 * another line with money left, or else it comes out of the next month's
 * Ready to assign. Closing records the choice.
 */

export interface ClosedMonth {
  month: MonthKey;
  /** Lines whose gap was left for the next month's Ready to assign. */
  left: Id[];
}

export interface CloseLine {
  categoryId: Id;
  /** How much below zero (positive). */
  short: Cents;
  assigned: Cents;
}

export interface CloseSource {
  categoryId: Id;
  /** Money left in the line at the month end. */
  available: Cents;
  assigned: Cents;
}

export interface MonthToClose {
  month: MonthKey;
  lines: CloseLine[];
  sources: CloseSource[];
  readyToAssign: Cents;
}

/** Lines that can lend money: spending and savings lines, not provisions or trips (they hold money for a bill). */
const canLend = (c: Category | undefined) => !!c && !c.isIncome && c.groupId !== 'provisions' && c.groupId !== 'events';

/** Past months with lines below zero nobody decided about yet, oldest first. */
export function monthsToClose(
  months: readonly BudgetMonth[],
  categories: readonly Category[],
  closed: readonly ClosedMonth[],
  current: MonthKey,
  /**
   * Lines that cannot lend: one whose amount follows an account balance (the
   * Emergency fund holding free savings, D-75) gives back to Ready to assign
   * by itself when money leaves that account; lending from it would count twice.
   */
  notLending: ReadonlySet<Id> = new Set(),
): MonthToClose[] {
  const byId = new Map(categories.map((c) => [c.id, c]));
  const out: MonthToClose[] = [];
  for (const m of months) {
    if (compareMonths(m.month, current) >= 0) continue;
    const left = new Set(closed.find((x) => x.month === m.month)?.left ?? []);
    const lines: CloseLine[] = [];
    const sources: CloseSource[] = [];
    for (const [id, cm] of m.categories) {
      if (cm.uncovered < 0 && !left.has(id)) lines.push({ categoryId: id, short: -cm.uncovered, assigned: cm.assigned });
      if (cm.available > 0 && canLend(byId.get(id)) && !notLending.has(id)) sources.push({ categoryId: id, available: cm.available, assigned: cm.assigned });
    }
    if (lines.length) out.push({ month: m.month, lines: lines.sort((a, b) => b.short - a.short), sources: sources.sort((a, b) => b.available - a.available), readyToAssign: m.readyToAssign });
  }
  return out;
}

export type CloseSourceChoice = { kind: 'ready' } | { kind: 'line'; categoryId: Id } | { kind: 'next' };

export interface CloseDecision {
  categoryId: Id;
  short: Cents;
  source: CloseSourceChoice;
  /** The account the money physically came from, when known. */
  fromAccountId?: Id;
}

/**
 * Covers used to be written into the month's budget (D-89, D-90); they are now
 * their own amounts (D-94). This takes each cover back out of the override it
 * was added to (and gives it back to a lending line); an override left equal
 * to the line's usual amount is removed.
 */
export function uncoverOverrides(
  overrides: readonly BudgetOverride[],
  usual: (categoryId: Id, month: MonthKey) => Cents,
  covers: readonly Pick<Cover, 'categoryId' | 'month' | 'amount' | 'fromCategoryId'>[],
  coverNotes: readonly string[],
): { put: BudgetOverride[]; remove: Id[] } {
  const amounts = new Map<Id, Cents>();
  const find = (categoryId: Id, month: MonthKey) => overrides.find((o) => o.categoryId === categoryId && o.month === month && coverNotes.includes(o.note));
  for (const c of covers) {
    const target = find(c.categoryId, c.month);
    if (target) amounts.set(target.id, (amounts.get(target.id) ?? target.amount) - c.amount);
    if (c.fromCategoryId) {
      const lender = find(c.fromCategoryId, c.month);
      if (lender) amounts.set(lender.id, (amounts.get(lender.id) ?? lender.amount) + c.amount);
    }
  }
  const put: BudgetOverride[] = [];
  const remove: Id[] = [];
  for (const [id, amount] of amounts) {
    const o = overrides.find((x) => x.id === id)!;
    if (amount === usual(o.categoryId, o.month)) remove.push(id);
    else put.push({ ...o, amount, note: '' });
  }
  return { put, remove };
}
