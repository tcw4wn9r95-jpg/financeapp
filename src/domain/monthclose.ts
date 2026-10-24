import type { BudgetMonth } from './budget';
import { compareMonths } from './dates';
import type { Category, Cents, Id, MonthKey } from './types';

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
export function monthsToClose(months: readonly BudgetMonth[], categories: readonly Category[], closed: readonly ClosedMonth[], current: MonthKey): MonthToClose[] {
  const byId = new Map(categories.map((c) => [c.id, c]));
  const out: MonthToClose[] = [];
  for (const m of months) {
    if (compareMonths(m.month, current) >= 0) continue;
    const left = new Set(closed.find((x) => x.month === m.month)?.left ?? []);
    const lines: CloseLine[] = [];
    const sources: CloseSource[] = [];
    for (const [id, cm] of m.categories) {
      if (cm.uncovered < 0 && !left.has(id)) lines.push({ categoryId: id, short: -cm.uncovered, assigned: cm.assigned });
      if (cm.available > 0 && canLend(byId.get(id))) sources.push({ categoryId: id, available: cm.available, assigned: cm.assigned });
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
}

/**
 * The budget amounts a month's decisions set: each covered line gets its gap
 * added; a line lending money gives it up. Amounts are the new assigned
 * amounts for that month, keyed by line.
 */
export function closeAmounts(m: MonthToClose, decisions: readonly CloseDecision[]): Map<Id, Cents> {
  const out = new Map<Id, Cents>();
  const assigned = (id: Id) => out.get(id) ?? m.lines.find((l) => l.categoryId === id)?.assigned ?? m.sources.find((s) => s.categoryId === id)?.assigned ?? 0;
  for (const d of decisions) {
    if (d.source.kind === 'next') continue;
    out.set(d.categoryId, assigned(d.categoryId) + d.short);
    if (d.source.kind === 'line') out.set(d.source.categoryId, assigned(d.source.categoryId) - d.short);
  }
  return out;
}
