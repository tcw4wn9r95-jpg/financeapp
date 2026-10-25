import { computeBudget, isOnBudget, type BudgetInput } from './budget';
import { allBucketWindows, balanceAt, fillBuckets } from './buckets';
import { addMonths, compareMonths, lastDayOfMonth, monthOf, monthRange } from './dates';
import { amountFor, occurrences } from './plan';
import { ownStatementCovers } from './reconcile';
import type { Allocation, Cents, EventFund, Id, MonthKey, Provision, Transaction } from './types';

/**
 * Money moved between own accounts (D-87): every transfer once, from the
 * account it leaves to the account it reaches, including card repayments and
 * loans; and the provisions account month by month against what its buckets
 * should hold.
 */

/**
 * Is there a matching row where the money arrived? (D-88)
 * - matched: paired with the receiving account's own row;
 * - mirror: the app wrote the receiving side (that account's statement is not imported);
 * - grouped: several transfers received as one amount;
 * - candidate: not paired, but a row with that amount is waiting there;
 * - different: a row close in date arrived with a slightly different amount;
 * - missing: that account's statement covers the day but shows no such money;
 * - unchecked: no statement of that account for the day (or a card or loan);
 * - receivedOnly: seen only where it arrived; the sender's statement shows nothing that month.
 */
export type TransferCheck = 'matched' | 'mirror' | 'grouped' | 'candidate' | 'different' | 'missing' | 'unchecked' | 'receivedOnly';

export interface TransferRow {
  tx: Transaction;
  from: Id;
  to: Id;
  /** Positive: what moved. */
  amount: Cents;
  month: MonthKey;
  check: TransferCheck;
  /** The receiving row (matched, grouped) or the one waiting (candidate). */
  receiving?: Transaction;
}

/** Checks that call for a look. */
export const needsLook = (r: Pick<TransferRow, 'check'>) => r.check === 'missing' || r.check === 'candidate' || r.check === 'different';

const days = (a: string, b: string) => Math.abs(Date.parse(a) - Date.parse(b)) / 86_400_000;

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
  // Rows already paired as one side of a transfer cannot be the match of another.
  const paired = new Set<Id>();
  for (const a of input.allocations) {
    if (a.targetType !== 'transfer') continue;
    if (byId.has(a.targetId)) {
      paired.add(a.transactionId);
      paired.add(a.targetId);
    }
  }
  const out: TransferRow[] = [];
  for (const a of input.allocations) {
    if (a.targetType !== 'transfer' || a.amount === 0) continue;
    const tx = byId.get(a.transactionId);
    if (!tx) continue;
    const month = monthOf(tx.date);
    if (compareMonths(month, from) < 0 || compareMonths(month, through) > 0) continue;
    const mate = byId.get(a.targetId);
    const other = accountIds.has(a.targetId) ? a.targetId : mate?.accountId;
    if (!other || other === tx.accountId) continue;
    if (a.amount < 0) {
      const row: TransferRow = { tx, from: tx.accountId, to: other, amount: -a.amount, month, check: 'unchecked' };
      if (mate) {
        row.check = mate.isMirror ? 'mirror' : 'matched';
        row.receiving = mate;
      }
      out.push(row);
    } else if (accountIds.has(a.targetId) && !active.has(`${other}|${month}`)) {
      out.push({ tx, from: other, to: tx.accountId, amount: a.amount, month, check: 'receivedOnly' });
    }
  }

  // Transfers filed against the account (no partner row): look for the money there.
  const loose = out.filter((r) => r.check === 'unchecked').sort((x, y) => x.tx.date.localeCompare(y.tx.date));
  const used = new Set<Id>();
  const arrivals = (to: Id) => input.transactions.filter((t) => t.accountId === to && t.amount > 0 && !t.isMirror);
  // Several sent within 3 days of each other and received as one amount.
  const clusters = new Map<string, TransferRow[][]>();
  for (const r of loose) {
    const key = `${r.from}>${r.to}`;
    const list = clusters.get(key) ?? [];
    const lastCluster = list.at(-1);
    if (lastCluster && days(lastCluster.at(-1)!.tx.date, r.tx.date) <= 3) lastCluster.push(r);
    else list.push([r]);
    clusters.set(key, list);
  }
  for (const list of clusters.values()) {
    for (const group of list) {
      if (group.length < 2) continue;
      const sum = group.reduce((s, r) => s + r.amount, 0);
      // Money sent back in the meantime nets out (3,000 + 4,000 sent, 850 back: 6,150 arrives).
      const first = group[0]!.tx.date;
      const last = group.at(-1)!.tx.date;
      const back = input.allocations
        .filter((a) => a.targetType === 'transfer' && a.targetId === group[0]!.to && a.amount > 0)
        .map((a) => byId.get(a.transactionId))
        .filter((t): t is Transaction => !!t && t.accountId === group[0]!.from && days(t.date, first) <= 3 + days(first, last) && days(t.date, last) <= 3 + days(first, last))
        .reduce((s, t) => s + t.amount, 0);
      const hit = arrivals(group[0]!.to).find((t) => (t.amount === sum || (back > 0 && t.amount === sum - back)) && !used.has(t.id) && days(t.date, first) <= 7);
      if (!hit) continue;
      used.add(hit.id);
      for (const r of group) {
        r.check = 'grouped';
        r.receiving = hit;
      }
    }
  }
  for (const r of loose) {
    if (r.check !== 'unchecked') continue;
    const near = arrivals(r.to)
      .filter((t) => t.amount === r.amount && !used.has(t.id) && !paired.has(t.id) && days(t.date, r.tx.date) <= 7)
      .sort((x, y) => days(x.date, r.tx.date) - days(y.date, r.tx.date))[0];
    const account = input.accounts.find((x) => x.id === r.to);
    if (near) {
      used.add(near.id);
      // Filed against the sender too (D-68): both sides are there, just not linked.
      const linked = input.allocations.some((a) => a.transactionId === near.id && a.targetType === 'transfer' && a.targetId === r.from);
      r.check = linked ? 'matched' : 'candidate';
      r.receiving = near;
    } else {
      const close = arrivals(r.to)
        .filter((t) => !used.has(t.id) && !paired.has(t.id) && days(t.date, r.tx.date) <= 7 && Math.abs(t.amount - r.amount) <= Math.min(1000, r.amount * 0.01))
        .sort((x, y) => Math.abs(x.amount - r.amount) - Math.abs(y.amount - r.amount))[0];
      if (close) {
        used.add(close.id);
        r.check = 'different';
        r.receiving = close;
      } else if (account && ownStatementCovers(account, r.tx.date, input.transactions)) r.check = 'missing';
    }
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

export interface MonthCashFlow {
  /** Money that came into the budget accounts (pay, refunds, money from loans or outside). */
  in: Cents;
  /** Money that left them (spending, loan payments, transfers to off-budget accounts), positive. */
  out: Cents;
  net: Cents;
}

/**
 * A month's net cash flow on the budget accounts (D-103): every row dated in
 * the month, leaving out transfers between two budget accounts whose both
 * sides fall in the month (the money stayed home). The net is the change in
 * what the budget accounts hold over the month.
 */
export function monthCashFlow(input: Pick<BudgetInput, 'accounts' | 'transactions' | 'allocations'>, month: MonthKey): MonthCashFlow {
  const onBudget = new Set(input.accounts.filter(isOnBudget).map((a) => a.id));
  const byId = new Map(input.transactions.map((t) => [t.id, t]));
  const allocs = new Map<Id, Allocation[]>();
  for (const a of input.allocations) allocs.set(a.transactionId, [...(allocs.get(a.transactionId) ?? []), a]);
  let inflow = 0;
  let outflow = 0;
  for (const t of input.transactions) {
    if (!onBudget.has(t.accountId) || monthOf(t.date) !== month) continue;
    const al = allocs.get(t.id) ?? [];
    // A transfer whose other side is a row on a budget account in the same month: the two cancel out.
    // Across a month end, or with no other row, it moved the balances that month and counts.
    const internal = al.length > 0 && al.every((a) => {
      const other = a.targetType === 'transfer' ? byId.get(a.targetId) : undefined;
      return !!other && onBudget.has(other.accountId) && monthOf(other.date) === month;
    });
    if (internal) continue;
    if (t.amount > 0) inflow += t.amount;
    else outflow -= t.amount;
  }
  return { in: inflow, out: outflow, net: inflow - outflow };
}
