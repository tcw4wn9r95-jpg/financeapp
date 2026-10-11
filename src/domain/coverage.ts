import { compareMonths, lastDayOfMonth, monthRange } from './dates';
import type { Account, Id, MonthKey, Statement, Transaction } from './types';

/**
 * Which months of each account are covered by imported statements (D-45):
 * the backfill checklist from the budget start to this month.
 */

export type MonthCoverage = 'statement' | 'rows' | 'none';

export interface AccountCoverage {
  accountId: Id;
  months: { month: MonthKey; status: MonthCoverage }[];
  missing: number;
}

export function coverage(
  accounts: readonly Account[],
  statements: readonly Statement[],
  transactions: readonly Transaction[],
  from: MonthKey,
  to: MonthKey,
): AccountCoverage[] {
  if (compareMonths(from, to) > 0) return [];
  const months = monthRange(from, to);
  return accounts
    .filter((a) => !a.closedAt && a.type !== 'loan' && a.type !== 'cash')
    .map((a) => {
      const own = statements.filter((s) => s.accountId === a.id);
      const rows = new Set(transactions.filter((t) => t.accountId === a.id && t.importBatchId && !t.isMirror).map((t) => t.date.slice(0, 7)));
      const list = months.map((month) => {
        const covered = own.some((s) => s.periodStart <= lastDayOfMonth(month) && s.periodEnd >= `${month}-01`);
        return { month, status: (covered ? 'statement' : rows.has(month) ? 'rows' : 'none') as MonthCoverage };
      });
      return { accountId: a.id, months: list, missing: list.filter((m) => m.status === 'none').length };
    });
}
