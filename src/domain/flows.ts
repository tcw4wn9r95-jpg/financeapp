import { computeBudget, type BudgetInput } from './budget';
import { allBucketWindows, balanceAt, fillBuckets } from './buckets';
import { addMonths, compareMonths, lastDayOfMonth, monthOf, monthRange } from './dates';
import { amountFor, occurrences } from './plan';
import type { Cents, EventFund, Id, MonthKey, Provision, Transaction } from './types';

/**
 * Money moved between own accounts (D-87): every transfer once, from the
 * account it leaves to the account it reaches, including card repayments and
 * loans; and the provisions account month by month against what its buckets
 * should hold.
 */

export interface TransferRow {
  tx: Transaction;
  from: Id;
  to: Id;
  /** Positive: what moved. */
  amount: Cents;
  month: MonthKey;
}

/**
 * Each transfer counted once: from the side the money leaves. A transfer seen
 * only where it arrives (filed against the other account, D-68) counts when
 * the sending account has no rows of its own that month, so nothing is
 * counted twice.
 */
export function transferRows(input: Pick<BudgetInput, 'accounts' | 'transactions' | 'allocations'>, from: MonthKey, through: MonthKey): TransferRow[] {
  const accountIds = new Set(input.accounts.map((a) => a.id));
  const byId = new Map(input.transactions.map((t) => [t.id, t]));
  const active = new Set(input.transactions.filter((t) => !t.isMirror).map((t) => `${t.accountId}|${monthOf(t.date)}`));
  const out: TransferRow[] = [];
  for (const a of input.allocations) {
    if (a.targetType !== 'transfer' || a.amount === 0) continue;
    const tx = byId.get(a.transactionId);
    if (!tx) continue;
    const month = monthOf(tx.date);
    if (compareMonths(month, from) < 0 || compareMonths(month, through) > 0) continue;
    const other = accountIds.has(a.targetId) ? a.targetId : byId.get(a.targetId)?.accountId;
    if (!other || other === tx.accountId) continue;
    if (a.amount < 0) out.push({ tx, from: tx.accountId, to: other, amount: -a.amount, month });
    else if (accountIds.has(a.targetId) && !active.has(`${other}|${month}`)) out.push({ tx, from: other, to: tx.accountId, amount: a.amount, month });
  }
  return out.sort((x, y) => y.tx.date.localeCompare(x.tx.date));
}

export interface TransferPair {
  from: Id;
  to: Id;
  total: Cents;
  count: number;
  byMonth: Map<MonthKey, Cents>;
  rows: TransferRow[];
}

/** Transfers grouped by route (from → to), biggest first. */
export function transferPairs(rows: readonly TransferRow[]): TransferPair[] {
  const map = new Map<string, TransferPair>();
  for (const r of rows) {
    const key = `${r.from}>${r.to}`;
    let p = map.get(key);
    if (!p) map.set(key, (p = { from: r.from, to: r.to, total: 0, count: 0, byMonth: new Map(), rows: [] }));
    p.total += r.amount;
    p.count++;
    p.byMonth.set(r.month, (p.byMonth.get(r.month) ?? 0) + r.amount);
    p.rows.push(r);
  }
  return [...map.values()].sort((a, b) => b.total - a.total);
}

/** Into and out of one account, per month. */
export function accountFlows(rows: readonly TransferRow[], accountId: Id, months: readonly MonthKey[]): { month: MonthKey; in: Cents; out: Cents }[] {
  return months.map((month) => {
    let into = 0;
    let out = 0;
    for (const r of rows) {
      if (r.month !== month) continue;
      if (r.to === accountId) into += r.amount;
      if (r.from === accountId) out += r.amount;
    }
    return { month, in: into, out };
  });
}

export interface ProvisionMonth {
  month: MonthKey;
  /** Balance of the provisions account at the month end (today for this month). */
  balance: Cents;
  /** What provisions and trips should hold then. */
  claimed: Cents;
  free: Cents;
  short: Cents;
  movedIn: Cents;
  movedOut: Cents;
  /** Interest, fees and anything else that changed the balance besides transfers. */
  other: Cents;
}

/** The provisions account month by month (D-69 buckets, each month as it stood). */
export function provisionHistory(
  input: BudgetInput,
  provisions: readonly Provision[],
  events: readonly EventFund[],
  accountId: Id,
  months: readonly MonthKey[],
  rows: readonly TransferRow[],
): ProvisionMonth[] {
  if (months.length === 0) return [];
  const computed = computeBudget(input, months.at(-1)!);
  const flows = accountFlows(rows, accountId, months);
  let prev = balanceAt(input, accountId, addMonths(months[0]!, -1));
  return months.map((m, i) => {
    const s = fillBuckets(input, m, accountId, allBucketWindows(provisions, events, m), computed);
    const f = flows[i]!;
    const other = s.balance - prev - f.in + f.out;
    prev = s.balance;
    return { month: m, balance: s.balance, claimed: s.claimed, free: s.free, short: s.toMove, movedIn: f.in, movedOut: f.out, other };
  });
}

export interface ProvisionAhead {
  month: MonthKey;
  /** Planned for provisions and trips in the budget. */
  setAside: Cents;
  /** Bills and trip parts due. */
  due: Cents;
  bills: { name: string; amount: Cents }[];
}

/** The months ahead: what the budget sets aside for provisions and trips, and the bills due. */
export function provisionsAhead(input: BudgetInput, provisions: readonly Provision[], events: readonly EventFund[], from: MonthKey, months: number): ProvisionAhead[] {
  const through = addMonths(from, months - 1);
  const computed = new Map(computeBudget(input, through).map((m) => [m.month, m]));
  const ids = new Set([...provisions.map((p) => p.categoryId), ...events.filter((e) => e.status !== 'closed').map((e) => e.categoryId)]);
  return monthRange(from, through).map((month) => {
    let setAside = 0;
    for (const id of ids) setAside += Math.max(0, computed.get(month)?.categories.get(id)?.assigned ?? 0);
    const bills: ProvisionAhead['bills'] = [];
    for (const p of provisions) for (const d of occurrences(p, `${month}-01`, lastDayOfMonth(month))) bills.push({ name: p.name, amount: amountFor(p, d) });
    for (const e of events) {
      if (e.status === 'closed') continue;
      for (const part of e.subBudgets) if (!part.paidMonth && monthOf(part.dueDate ?? e.targetDate) === month) bills.push({ name: `${e.name} · ${part.name}`, amount: part.amount });
    }
    return { month, setAside, due: bills.reduce((s, b) => s + b.amount, 0), bills };
  });
}
