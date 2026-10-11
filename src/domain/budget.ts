import { compareMonths, monthOf, monthRange } from './dates';
import { assertCents } from './money';
import type {
  Account,
  Allocation,
  BudgetDefault,
  BudgetOverride,
  Category,
  Cents,
  Id,
  MonthKey,
  Transaction,
} from './types';

/**
 * Budget engine (PRD F1, F2). Pure functions, no I/O.
 *
 * Model (DECISIONS.md D-08 to D-12):
 * - Assigned(category, month) = the month override if any, else the latest
 *   default whose effectiveFrom ≤ month, else 0.
 * - Activity(category, month) = sum of allocations to that category on
 *   transactions dated in the month (negative = spending).
 * - Available = carry-in + assigned + activity.
 * - At month end the leftover is handled by the category's rollover mode:
 *   roll  → carried into next month (positive or negative);
 *   reset → returned to Ready to assign next month (positive or negative);
 *   sweep → a positive leftover moves to the sweep target category, a negative
 *           one is returned to Ready to assign like reset.
 * - Ready to assign(month) = opening funds + income received up to the month
 *   + uncategorised activity up to the month + leftovers returned so far
 *   − everything assigned up to the month.
 *
 * Invariant (tested): for every month, Ready to assign + Σ available equals the
 * total balance of on-budget accounts at month end.
 */

export interface BudgetInput {
  startMonth: MonthKey;
  categories: readonly Category[];
  defaults: readonly BudgetDefault[];
  overrides: readonly BudgetOverride[];
  accounts: readonly Account[];
  transactions: readonly Transaction[];
  allocations: readonly Allocation[];
  sweepTargetCategoryId?: Id;
}

export interface CategoryMonth {
  categoryId: Id;
  /** Default amount in force this month (before any override). */
  defaultAmount: Cents;
  /** Amount actually assigned: override if present, else default. */
  assigned: Cents;
  overrideId?: Id;
  carryIn: Cents;
  activity: Cents;
  available: Cents;
  /** What the rollover mode does with `available` at month end. */
  rolledOver: Cents;
  returnedToReady: Cents;
  sweptOut: Cents;
}

export interface BudgetMonth {
  month: MonthKey;
  categories: Map<Id, CategoryMonth>;
  income: Cents;
  assignedTotal: Cents;
  activityTotal: Cents;
  /** Activity on on-budget accounts not covered by a category or income allocation. */
  uncategorised: Cents;
  /** Leftovers from last month's reset/sweep categories returned this month. */
  returnedFromLastMonth: Cents;
  readyToAssign: Cents;
}

/** On-budget accounts carry spendable money. Loans are tracked but off-budget (D-10). */
export function isOnBudget(account: Pick<Account, 'type'>): boolean {
  return account.type !== 'loan';
}

/** Default monthly amount for a category in a month, from the dated history. */
export function defaultFor(
  defaults: readonly BudgetDefault[],
  categoryId: Id,
  month: MonthKey,
): BudgetDefault | undefined {
  let best: BudgetDefault | undefined;
  for (const d of defaults) {
    if (d.categoryId !== categoryId || compareMonths(d.effectiveFrom, month) > 0) continue;
    if (
      !best ||
      compareMonths(d.effectiveFrom, best.effectiveFrom) > 0 ||
      (d.effectiveFrom === best.effectiveFrom && d.updatedAt > best.updatedAt)
    ) {
      best = d;
    }
  }
  return best;
}

export function overrideFor(
  overrides: readonly BudgetOverride[],
  categoryId: Id,
  month: MonthKey,
): BudgetOverride | undefined {
  return overrides.find((o) => o.categoryId === categoryId && o.month === month);
}

interface MonthActivity {
  byCategory: Map<Id, Cents>;
  income: Cents;
  uncategorised: Cents;
}

/**
 * Group the ledger by budget month. Transactions dated before the start month
 * are folded into the start month so balances and budget agree (D-11).
 */
function activityByMonth(input: BudgetInput): Map<MonthKey, MonthActivity> {
  const onBudget = new Set(input.accounts.filter(isOnBudget).map((a) => a.id));
  const incomeIds = new Set(input.categories.filter((c) => c.isIncome).map((c) => c.id));
  const expenseIds = new Set(input.categories.filter((c) => !c.isIncome).map((c) => c.id));

  const allocsByTxn = new Map<Id, Allocation[]>();
  for (const a of input.allocations) {
    const list = allocsByTxn.get(a.transactionId);
    if (list) list.push(a);
    else allocsByTxn.set(a.transactionId, [a]);
  }

  const txnAccount = new Map<Id, Id>(input.transactions.map((t) => [t.id, t.accountId]));

  const out = new Map<MonthKey, MonthActivity>();
  const bucket = (month: MonthKey): MonthActivity => {
    let b = out.get(month);
    if (!b) {
      b = { byCategory: new Map(), income: 0, uncategorised: 0 };
      out.set(month, b);
    }
    return b;
  };

  for (const t of input.transactions) {
    if (!onBudget.has(t.accountId)) continue;
    assertCents(t.amount);
    const raw = monthOf(t.date);
    const b = bucket(compareMonths(raw, input.startMonth) < 0 ? input.startMonth : raw);
    let covered = 0;
    for (const a of allocsByTxn.get(t.id) ?? []) {
      if (a.targetType === 'category' && expenseIds.has(a.targetId)) {
        b.byCategory.set(a.targetId, (b.byCategory.get(a.targetId) ?? 0) + a.amount);
        covered += a.amount;
      } else if (a.targetType === 'income' && incomeIds.has(a.targetId)) {
        b.income += a.amount;
        covered += a.amount;
      } else if (a.targetType === 'transfer') {
        // Between two on-budget accounts: no budget effect. A transfer to or
        // from an off-budget account (a loan) moves money in or out of the
        // budget, so it stays uncategorised and hits Ready to assign (D-10).
        const other = txnAccount.get(a.targetId);
        if (other !== undefined && onBudget.has(other)) covered += a.amount;
      }
      // provision / event allocations are budgeted from M3; until then they
      // fall through to "uncategorised" so the invariant still holds.
    }
    b.uncategorised += t.amount - covered;
  }
  return out;
}

export function openingFunds(accounts: readonly Account[]): Cents {
  return accounts.filter(isOnBudget).reduce((s, a) => s + a.openingBalance, 0);
}

/**
 * Compute every budget month from the start month through `throughMonth`.
 * Returns an empty list when throughMonth is before the start.
 */
export function computeBudget(input: BudgetInput, throughMonth: MonthKey): BudgetMonth[] {
  const months = monthRange(input.startMonth, throughMonth);
  const activity = activityByMonth(input);
  const expense = input.categories.filter((c) => !c.isIncome);
  const expenseIds = new Set(expense.map((c) => c.id));
  const sweepTarget =
    input.sweepTargetCategoryId && expenseIds.has(input.sweepTargetCategoryId)
      ? input.sweepTargetCategoryId
      : undefined;

  const result: BudgetMonth[] = [];
  let ready = openingFunds(input.accounts);
  let carry = new Map<Id, Cents>();
  let returned = 0;

  for (const month of months) {
    const act = activity.get(month) ?? { byCategory: new Map(), income: 0, uncategorised: 0 };
    const cats = new Map<Id, CategoryMonth>();
    const nextCarry = new Map<Id, Cents>();
    let nextReturned = 0;
    let assignedTotal = 0;
    let activityTotal = 0;

    for (const c of expense) {
      const def = defaultFor(input.defaults, c.id, month);
      const ovr = overrideFor(input.overrides, c.id, month);
      const defaultAmount = def?.monthlyAmount ?? 0;
      const assigned = ovr ? ovr.amount : defaultAmount;
      const carryIn = carry.get(c.id) ?? 0;
      const catActivity = act.byCategory.get(c.id) ?? 0;
      const available = carryIn + assigned + catActivity;
      assignedTotal += assigned;
      activityTotal += catActivity;

      let rolledOver = 0;
      let returnedToReady = 0;
      let sweptOut = 0;
      const mode = c.rolloverMode === 'sweep' && (!sweepTarget || sweepTarget === c.id) ? 'roll' : c.rolloverMode;
      if (mode === 'roll') {
        rolledOver = available;
      } else if (mode === 'reset') {
        returnedToReady = available;
      } else if (available > 0) {
        sweptOut = available;
      } else {
        returnedToReady = available;
      }

      if (rolledOver !== 0) nextCarry.set(c.id, (nextCarry.get(c.id) ?? 0) + rolledOver);
      if (sweptOut !== 0 && sweepTarget) {
        nextCarry.set(sweepTarget, (nextCarry.get(sweepTarget) ?? 0) + sweptOut);
      }
      nextReturned += returnedToReady;

      cats.set(c.id, {
        categoryId: c.id,
        defaultAmount,
        assigned,
        ...(ovr ? { overrideId: ovr.id } : {}),
        carryIn,
        activity: catActivity,
        available,
        rolledOver,
        returnedToReady,
        sweptOut,
      });
    }

    ready += act.income + act.uncategorised + returned - assignedTotal;
    assertCents(ready);
    result.push({
      month,
      categories: cats,
      income: act.income,
      assignedTotal,
      activityTotal,
      uncategorised: act.uncategorised,
      returnedFromLastMonth: returned,
      readyToAssign: ready,
    });
    carry = nextCarry;
    returned = nextReturned;
  }
  return result;
}

/** Convenience: the budget for one month (computes the history it depends on). */
export function budgetForMonth(input: BudgetInput, month: MonthKey): BudgetMonth | undefined {
  if (compareMonths(month, input.startMonth) < 0) return undefined;
  return computeBudget(input, month).at(-1);
}

/** Balance of every account at the end of a month (opening + transactions dated up to then). */
export function accountBalances(
  accounts: readonly Account[],
  transactions: readonly Transaction[],
  throughDate?: string,
): Map<Id, Cents> {
  const out = new Map<Id, Cents>(accounts.map((a) => [a.id, a.openingBalance]));
  for (const t of transactions) {
    if (throughDate && t.date > throughDate) continue;
    if (!out.has(t.accountId)) continue;
    out.set(t.accountId, out.get(t.accountId)! + t.amount);
  }
  return out;
}

/**
 * Categories whose monthly amounts only begin after the budget start (for
 * example set up in October, then the start moved to January): their first
 * default, moved back to the start so the earlier months are budgeted too
 * (D-45). Later changes of amount keep their own dates.
 */
export function backdateDefaults(defaults: readonly BudgetDefault[], start: MonthKey): BudgetDefault[] {
  const first = new Map<Id, BudgetDefault>();
  for (const d of defaults) {
    const cur = first.get(d.categoryId);
    if (!cur || compareMonths(d.effectiveFrom, cur.effectiveFrom) < 0) first.set(d.categoryId, d);
  }
  return [...first.values()].filter((d) => compareMonths(d.effectiveFrom, start) > 0).map((d) => ({ ...d, effectiveFrom: start }));
}
