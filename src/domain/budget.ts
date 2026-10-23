import { addMonths, compareMonths, monthDiff, monthOf, monthRange } from './dates';
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
 * - Income in a category paid for the next month (D-74) received from its
 *   day on counts in the next month; until then it is "held for next month".
 * - A category with a target for a month (D-75, free savings) is assigned
 *   whatever makes its available equal that target.
 *
 * Invariant (tested): for every month, Ready to assign + Σ available + held
 * for next month equals the total balance of on-budget accounts at month end.
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
  /** Categories budgeted by a plan of dated parts (trips) instead of defaults (D-54). */
  plans?: ReadonlyMap<Id, readonly PlanPart[]>;
  /**
   * What a category's available should be in a month (D-75): it is assigned
   * the difference. An override for that month still wins.
   */
  availableTargets?: ReadonlyMap<Id, ReadonlyMap<MonthKey, Cents>>;
}

/**
 * One part of a plan, e.g. a trip's flights: `amount` needed by `due`, saved
 * from `start`. Each month assigns what is still missing divided by the months
 * left. A part stops when its spending (allocations tagged with `key`; ''
 * means untagged) reaches its amount, after `doneMonth`, or after `due`.
 */
export interface PlanPart {
  key: string;
  amount: Cents;
  start: MonthKey;
  due: MonthKey;
  doneMonth?: MonthKey;
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
  /** Income counted this month, per income category. */
  incomeByCategory: Map<Id, Cents>;
  assignedTotal: Cents;
  activityTotal: Cents;
  /** Activity on on-budget accounts not filed yet (no category, income or transfer). */
  uncategorised: Cents;
  /** Transfers between own budget accounts this month, by row (D-85); 0 when both sides fall in the month. */
  transit: Cents;
  /** Transfers to or from off-budget accounts this month (a loan repayment without a budget line). */
  offBudget: Cents;
  /** Leftovers from last month's reset/sweep categories returned this month. */
  returnedFromLastMonth: Cents;
  readyToAssign: Cents;
  /** Income already received this month that counts next month (D-74). */
  heldForNextMonth: Cents;
}

/** On-budget accounts carry spendable money. Loans are tracked but off-budget (D-10). */
export function isOnBudget(account: Pick<Account, 'type'>): boolean {
  return account.type !== 'loan';
}

/** A planned change of a budget line's usual monthly amount (D-78). */
export interface LineChange {
  categoryId: Id;
  defaultId: Id;
  month: MonthKey;
  before: Cents;
  after: Cents;
}

/**
 * Changes to usual monthly amounts dated after `from` (a raise, a loan that
 * ends, a subscription that stops), soonest first. Provisions and trips follow
 * their own schedules and are left out.
 */
export function futureChanges(categories: readonly Category[], defaults: readonly BudgetDefault[], from: MonthKey): LineChange[] {
  const own = new Set(categories.filter((c) => c.isIncome || (c.groupId !== 'provisions' && c.groupId !== 'events')).map((c) => c.id));
  const out: LineChange[] = [];
  for (const d of defaults) {
    if (!own.has(d.categoryId) || compareMonths(d.effectiveFrom, from) <= 0) continue;
    const before = defaultFor(defaults, d.categoryId, addMonths(d.effectiveFrom, -1))?.monthlyAmount ?? 0;
    if (before === d.monthlyAmount) continue;
    out.push({ categoryId: d.categoryId, defaultId: d.id, month: d.effectiveFrom, before, after: d.monthlyAmount });
  }
  return out.sort((a, b) => a.month.localeCompare(b.month));
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
  incomeByCategory: Map<Id, Cents>;
  uncategorised: Cents;
  /** Transfers between own budget accounts, each row by its own amount and date (D-85). */
  transit: Cents;
  /** Transfers to or from off-budget accounts (a loan without its own budget line). */
  offBudget: Cents;
  /** Income received in this month that counts in the next one. */
  held: Cents;
}

/**
 * Group the ledger by budget month. Transactions dated before the start month
 * are folded into the start month so balances and budget agree (D-11).
 */
function activityByMonth(input: BudgetInput): Map<MonthKey, MonthActivity> {
  const onBudget = new Set(input.accounts.filter(isOnBudget).map((a) => a.id));
  const incomeIds = new Set(input.categories.filter((c) => c.isIncome).map((c) => c.id));
  const nextFrom = new Map(input.categories.filter((c) => c.isIncome && c.nextMonthFromDay).map((c) => [c.id, c.nextMonthFromDay!]));
  const expenseIds = new Set(input.categories.filter((c) => !c.isIncome).map((c) => c.id));

  const allocsByTxn = new Map<Id, Allocation[]>();
  for (const a of input.allocations) {
    const list = allocsByTxn.get(a.transactionId);
    if (list) list.push(a);
    else allocsByTxn.set(a.transactionId, [a]);
  }

  const txnAccount = new Map<Id, Id>(input.transactions.map((t) => [t.id, t.accountId]));
  // A transfer can point at the other account itself when that account's own
  // statement shows the money differently (D-68).
  for (const a of input.accounts) txnAccount.set(a.id, a.id);

  const out = new Map<MonthKey, MonthActivity>();
  const bucket = (month: MonthKey): MonthActivity => {
    let b = out.get(month);
    if (!b) {
      b = { byCategory: new Map(), income: 0, incomeByCategory: new Map(), uncategorised: 0, transit: 0, offBudget: 0, held: 0 };
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
        const from = nextFrom.get(a.targetId);
        if (from && Number(t.date.slice(8, 10)) >= from) {
          // Paid for next month (D-74): counted then; held until then.
          const next = addMonths(raw, 1);
          const nb = bucket(compareMonths(next, input.startMonth) < 0 ? input.startMonth : next);
          nb.income += a.amount;
          nb.incomeByCategory.set(a.targetId, (nb.incomeByCategory.get(a.targetId) ?? 0) + a.amount);
          if (compareMonths(raw, input.startMonth) >= 0) b.held += a.amount;
        } else {
          b.income += a.amount;
          b.incomeByCategory.set(a.targetId, (b.incomeByCategory.get(a.targetId) ?? 0) + a.amount);
        }
        covered += a.amount;
      } else if (a.targetType === 'transfer') {
        // Each transfer row counts by its own amount and date (D-85): the two sides of a transfer
        // between budget accounts cancel out (in the same month; across a month end the money is
        // in transit for a few days), and a side whose other half is missing cannot vanish. A
        // transfer to or from an off-budget account (a loan) moves money in or out of the budget
        // and hits Ready to assign (D-10).
        const other = txnAccount.get(a.targetId);
        if (other !== undefined && onBudget.has(other)) b.transit += a.amount;
        else b.offBudget += a.amount;
        covered += a.amount;
      }
      // provision / event allocations are budgeted from M3; until then they
      // fall through to "uncategorised" so the invariant still holds.
    }
    b.uncategorised += t.amount - covered;
  }
  return out;
}

/**
 * Opening balances of on-budget accounts that join Ready to assign in a
 * month: at the budget start for accounts without a later opening date,
 * otherwise in the month of their opening date (D-47).
 */
export function openingFunds(accounts: readonly Account[], month?: MonthKey, startMonth?: MonthKey): Cents {
  return accounts
    .filter(isOnBudget)
    .filter((a) => {
      if (month === undefined) return true;
      const opens = a.openingDate && startMonth && compareMonths(monthOf(a.openingDate), startMonth) > 0 ? monthOf(a.openingDate) : startMonth;
      return opens === month;
    })
    .reduce((s, a) => s + a.openingBalance, 0);
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

  const plans = input.plans ?? new Map<Id, readonly PlanPart[]>();
  const partSpend = planSpending(input, plans);
  const partAssigned = new Map<string, Cents>();

  const result: BudgetMonth[] = [];
  let ready = 0;
  let carry = new Map<Id, Cents>();
  let returned = 0;

  for (const month of months) {
    const act = activity.get(month) ?? { byCategory: new Map(), income: 0, incomeByCategory: new Map(), uncategorised: 0, transit: 0, offBudget: 0, held: 0 };
    const cats = new Map<Id, CategoryMonth>();
    const nextCarry = new Map<Id, Cents>();
    let nextReturned = 0;
    let assignedTotal = 0;
    let activityTotal = 0;

    for (const c of expense) {
      const plan = plans.get(c.id);
      const ovr = overrideFor(input.overrides, c.id, month);
      let defaultAmount = 0;
      if (plan) {
        for (const part of plan) {
          const k = `${c.id}\u0000${part.key}`;
          const a = planPartAmount(part, month, partAssigned.get(k) ?? 0, partSpend.get(k));
          if (a > 0) partAssigned.set(k, (partAssigned.get(k) ?? 0) + a);
          defaultAmount += a;
        }
      } else {
        defaultAmount = defaultFor(input.defaults, c.id, month)?.monthlyAmount ?? 0;
      }
      const carryIn = carry.get(c.id) ?? 0;
      const catActivity = act.byCategory.get(c.id) ?? 0;
      const target = input.availableTargets?.get(c.id)?.get(month);
      const assigned = ovr ? ovr.amount : target !== undefined ? target - carryIn - catActivity : defaultAmount;
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

    ready += openingFunds(input.accounts, month, input.startMonth) + act.income + act.uncategorised + act.transit + act.offBudget + returned - assignedTotal;
    assertCents(ready);
    result.push({
      month,
      categories: cats,
      income: act.income,
      incomeByCategory: act.incomeByCategory,
      assignedTotal,
      activityTotal,
      uncategorised: act.uncategorised,
      transit: act.transit,
      offBudget: act.offBudget,
      returnedFromLastMonth: returned,
      readyToAssign: ready,
      heldForNextMonth: act.held,
    });
    carry = nextCarry;
    returned = nextReturned;
  }
  return result;
}

/** What a plan part assigns in a month, given what it already got and what was spent on it before. */
export function planPartAmount(part: PlanPart, month: MonthKey, assignedSoFar: Cents, spentByMonth?: ReadonlyMap<MonthKey, Cents>): Cents {
  if (compareMonths(month, part.start) < 0 || compareMonths(month, part.due) > 0) return 0;
  if (part.doneMonth && compareMonths(month, part.doneMonth) > 0) return 0;
  let spentBefore = 0;
  for (const [m, v] of spentByMonth ?? []) if (compareMonths(m, month) < 0) spentBefore += v;
  if (spentBefore >= part.amount) return 0; // milestone reached: this part is paid
  const left = part.amount - assignedSoFar;
  if (left <= 0) return 0;
  return Math.ceil(left / (monthDiff(month, part.due) + 1));
}

/** Spending per plan part and month (positive cents), keyed "categoryId\0partKey". */
function planSpending(input: BudgetInput, plans: ReadonlyMap<Id, readonly PlanPart[]>): Map<string, Map<MonthKey, Cents>> {
  const out = new Map<string, Map<MonthKey, Cents>>();
  if (plans.size === 0) return out;
  const dates = new Map(input.transactions.map((t) => [t.id, t.date]));
  for (const a of input.allocations) {
    if (a.targetType !== 'category') continue;
    const plan = plans.get(a.targetId);
    if (!plan) continue;
    const date = dates.get(a.transactionId);
    if (!date) continue;
    const key = plan.some((p) => p.key === a.subBudget && p.key !== '') ? a.subBudget! : '';
    const k = `${a.targetId}\u0000${key}`;
    const m = monthOf(date);
    const bucket = out.get(k) ?? new Map<MonthKey, Cents>();
    bucket.set(m, (bucket.get(m) ?? 0) - a.amount);
    out.set(k, bucket);
  }
  return out;
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
  // Before its opening date an account has no opening balance yet (D-47).
  const out = new Map<Id, Cents>(accounts.map((a) => [a.id, a.openingDate && throughDate && throughDate < a.openingDate ? 0 : a.openingBalance]));
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

/**
 * Money put into investments (D-57): what was filed under categories of the
 * Investments group, all time, this year and this month. Sales or
 * withdrawals filed there count back. No market value: only what went in.
 */
export function invested(input: Pick<BudgetInput, 'categories' | 'transactions' | 'allocations'>, month: MonthKey): { total: Cents; year: Cents; month: Cents; byCategory: Map<Id, Cents> } {
  const ids = new Set(input.categories.filter((c) => !c.isIncome && c.groupId === 'investments').map((c) => c.id));
  const dates = new Map(input.transactions.map((t) => [t.id, t.date]));
  const out = { total: 0, year: 0, month: 0, byCategory: new Map<Id, Cents>() };
  for (const a of input.allocations) {
    if (a.targetType !== 'category' || !ids.has(a.targetId)) continue;
    const date = dates.get(a.transactionId);
    if (!date || monthOf(date) > month) continue;
    const v = -a.amount;
    out.total += v;
    if (date.slice(0, 4) === month.slice(0, 4)) out.year += v;
    if (monthOf(date) === month) out.month += v;
    out.byCategory.set(a.targetId, (out.byCategory.get(a.targetId) ?? 0) + v);
  }
  return out;
}

/** Where Ready to assign comes from, from the budget start through `month` (D-85). */
export interface ReadyExplained {
  month: MonthKey;
  /** Balances of the budget accounts when they start counting. */
  opening: Cents;
  /** Income received, per income category. */
  income: Cents;
  incomeByCategory: Map<Id, Cents>;
  /** Given to categories, per category group (negative of what was assigned). */
  assigned: Cents;
  assignedByGroup: Map<string, Cents>;
  /** Leftovers of reset categories handed back. */
  returned: Cents;
  /** Not filed yet: money in and money out still in the inbox. */
  unfiled: Cents;
  /** Transfers between own budget accounts whose two sides do not cancel out (yet). */
  transit: Cents;
  /** Loans repaid without their own budget line, and other off-budget transfers. */
  offBudget: Cents;
  readyToAssign: Cents;
  /** Cross-check: cash in the budget accounts at the month end, money held in categories, income held for next month. */
  cash: Cents;
  inCategories: Cents;
  held: Cents;
}

export function explainReady(input: BudgetInput, month: MonthKey): ReadyExplained | undefined {
  const months = computeBudget(input, month);
  const last = months.at(-1);
  if (!last) return undefined;
  const groupOf = new Map(input.categories.map((c) => [c.id, c.groupId as string]));
  const out: ReadyExplained = {
    month,
    opening: 0,
    income: 0,
    incomeByCategory: new Map(),
    assigned: 0,
    assignedByGroup: new Map(),
    returned: 0,
    unfiled: 0,
    transit: 0,
    offBudget: 0,
    readyToAssign: last.readyToAssign,
    cash: 0,
    inCategories: 0,
    held: last.heldForNextMonth,
  };
  for (const m of months) {
    out.opening += openingFunds(input.accounts, m.month, input.startMonth);
    out.income += m.income;
    for (const [id, v] of m.incomeByCategory) out.incomeByCategory.set(id, (out.incomeByCategory.get(id) ?? 0) + v);
    out.returned += m.returnedFromLastMonth;
    out.unfiled += m.uncategorised;
    out.transit += m.transit;
    out.offBudget += m.offBudget;
    for (const [id, cm] of m.categories) {
      out.assigned -= cm.assigned;
      const g = groupOf.get(id) ?? 'other';
      out.assignedByGroup.set(g, (out.assignedByGroup.get(g) ?? 0) - cm.assigned);
    }
  }
  const balances = accountBalances(input.accounts, input.transactions, `${month}-31`);
  for (const a of input.accounts) if (isOnBudget(a)) out.cash += balances.get(a.id) ?? 0;
  for (const cm of last.categories.values()) out.inCategories += cm.available;
  return out;
}

export interface LooseTransfer {
  tx: Transaction;
  amount: Cents;
  /** 'transit': between budget accounts but its other side is missing or falls later; 'offBudget': to or from a loan or other off-budget account. */
  kind: 'transit' | 'offBudget';
}

/**
 * The transfer rows behind the "transfers" lines of `explainReady` (D-85),
 * through the end of `month`, newest first: transfers between budget accounts
 * that do not cancel out against their other side (in the same month), and
 * every transfer to or from an off-budget account.
 */
export function looseTransfers(input: BudgetInput, month: MonthKey): LooseTransfer[] {
  const end = `${month}-31`;
  const onBudget = new Set(input.accounts.filter(isOnBudget).map((a) => a.id));
  const accountIds = new Set(input.accounts.map((a) => a.id));
  const byId = new Map(input.transactions.map((t) => [t.id, t]));
  const out: LooseTransfer[] = [];
  // Transfers between budget accounts, grouped by who points at whom: a group
  // whose rows add up to zero cancels out (one move settled by several, too).
  const parent = new Map<Id, Id>();
  const root = (id: Id): Id => {
    let r = id;
    while (parent.get(r) !== undefined && parent.get(r) !== r) r = parent.get(r)!;
    parent.set(id, r);
    return r;
  };
  const inside: { tx: Transaction; amount: Cents }[] = [];
  for (const a of input.allocations) {
    if (a.targetType !== 'transfer') continue;
    const tx = byId.get(a.transactionId);
    if (!tx || !onBudget.has(tx.accountId) || tx.date > end) continue;
    const other = accountIds.has(a.targetId) ? a.targetId : byId.get(a.targetId)?.accountId;
    if (other === undefined || !onBudget.has(other)) {
      out.push({ tx, amount: a.amount, kind: 'offBudget' });
      continue;
    }
    inside.push({ tx, amount: a.amount });
    if (!parent.has(tx.id)) parent.set(tx.id, tx.id);
    const mate = byId.get(a.targetId);
    if (mate && mate.date <= end) {
      if (!parent.has(mate.id)) parent.set(mate.id, mate.id);
      parent.set(root(tx.id), root(mate.id));
    }
  }
  const net = new Map<Id, Cents>();
  for (const r of inside) net.set(root(r.tx.id), (net.get(root(r.tx.id)) ?? 0) + r.amount);
  const open = inside.filter((r) => net.get(root(r.tx.id)) !== 0);
  // A transfer filed against the other account (D-68) has no partner row: those
  // of a month that add up to zero cancel out too.
  const byMonth = new Map<MonthKey, Cents>();
  for (const r of open) byMonth.set(monthOf(r.tx.date), (byMonth.get(monthOf(r.tx.date)) ?? 0) + r.amount);
  for (const r of open) if (byMonth.get(monthOf(r.tx.date)) !== 0) out.push({ ...r, kind: 'transit' });
  return out.sort((x, y) => y.tx.date.localeCompare(x.tx.date));
}
