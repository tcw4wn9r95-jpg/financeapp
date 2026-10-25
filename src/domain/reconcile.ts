import { accountBalances } from './budget';
import { stamp, type Clock } from './ledger';
import { looksLikeTransfer, makeMirror, recogniseAccount, transferDays, transferGap } from './import/plan';
import type { Account, Allocation, Cents, Id, ImportBatch, Statement, Transaction } from './types';

/**
 * Reconciliation inbox and period locking (PRD F7). Pure: each function
 * returns the records to write and the ids to delete.
 */

export interface Changes {
  putTransactions: Transaction[];
  putAllocations: Allocation[];
  deleteTransactions: Id[];
  deleteAllocations: Id[];
  putStatements: Statement[];
  deleteStatements: Id[];
  deleteBatches: Id[];
}

export const emptyChanges = (): Changes => ({
  putTransactions: [],
  putAllocations: [],
  deleteTransactions: [],
  deleteAllocations: [],
  putStatements: [],
  deleteStatements: [],
  deleteBatches: [],
});

export interface LedgerView {
  accounts: readonly Account[];
  transactions: readonly Transaction[];
  allocations: readonly Allocation[];
}

export type Classification =
  | { kind: 'category'; categoryId: Id; subBudget?: string }
  | { kind: 'income'; categoryId: Id }
  /**
   * Transfer to another own account. For a repayment to an off-budget loan,
   * `categoryId` makes the payment count in that budget category while the
   * loan's balance still goes down (D-29).
   */
  | { kind: 'transfer'; accountId: Id; categoryId?: Id }
  /**
   * Several parts: categories (including provisions and trips, which are
   * categories), income, and transfers to own accounts (D-51).
   */
  | { kind: 'split'; lines: SplitLine[] };

export type SplitLine =
  | { kind: 'category' | 'income'; categoryId: Id; amount: Cents }
  | { kind: 'transfer'; accountId: Id; amount: Cents };

export class ReconcileError extends Error {
  constructor(public readonly code: 'locked' | 'splitUnbalanced' | 'sameAccount' | 'unknownAccount') {
    super(code);
  }
}

export function inbox(transactions: readonly Transaction[]): Transaction[] {
  return transactions
    .filter((t) => t.status === 'new' || t.status === 'suggested')
    .sort((a, b) => b.date.localeCompare(a.date) || a.descriptionRaw.localeCompare(b.descriptionRaw));
}

/** Open inbox items that are the same transaction again: same merchant and exactly the same amount (D-72). */
export function similar(t: Transaction, transactions: readonly Transaction[]): Transaction[] {
  return inbox(transactions).filter((x) => x.id !== t.id && x.merchantNorm === t.merchantNorm && x.merchantNorm !== '' && x.amount === t.amount);
}

/** Key that groups repeats: same merchant and exactly the same amount (as `similar`, D-72). */
function repeatKey(t: Transaction): string {
  return t.merchantNorm === '' ? `#${t.id}` : `${t.amount}:${t.merchantNorm}`;
}

/**
 * Inbox items with the most repeats first (D-63): each merchant's items stay
 * together, newest first; groups of the same size keep the newest on top.
 * `count` gives how many open items share each item's merchant.
 */
export function byRepeats(items: readonly Transaction[]): { items: Transaction[]; count: Map<Id, number> } {
  const groups = new Map<string, Transaction[]>();
  for (const t of items) {
    const k = repeatKey(t);
    const g = groups.get(k);
    if (g) g.push(t);
    else groups.set(k, [t]);
  }
  const ordered = [...groups.values()]
    .map((g) => [...g].sort((a, b) => b.date.localeCompare(a.date)))
    .sort((a, b) => b.length - a.length || b[0]!.date.localeCompare(a[0]!.date) || a[0]!.descriptionRaw.localeCompare(b[0]!.descriptionRaw));
  const count = new Map<Id, number>();
  for (const g of ordered) for (const t of g) count.set(t.id, g.length);
  return { items: ordered.flat(), count };
}

/**
 * Does `account`'s own imported data cover `date`? Then that statement already
 * shows the money arriving or leaving (perhaps as one sum for several
 * transfers), and the app must not invent a row there (D-68). Card statements
 * do not list their repayments, and loans have no statements: they keep mirrors.
 */
export function ownStatementCovers(account: Account, date: string, transactions: readonly Transaction[]): boolean {
  if (account.type === 'card' || account.type === 'loan') return false;
  let first: string | undefined;
  let last: string | undefined;
  for (const t of transactions) {
    if (t.accountId !== account.id || t.isMirror || !t.importBatchId) continue;
    if (first === undefined || t.date < first) first = t.date;
    if (last === undefined || t.date > last) last = t.date;
  }
  return first !== undefined && last !== undefined && date >= first && date <= last;
}

/**
 * Mirrors sitting in a period the account's own statements cover are
 * duplicates (D-68). Each is replaced by the matching real row when one is
 * still open, or else dropped: the transfer then points at the account itself.
 */
export function cleanUpMirrors(view: LedgerView, clock: Clock): { changes: Changes; fixed: number } {
  const ch = emptyChanges();
  const allocated = new Set(view.allocations.map((a) => a.transactionId));
  const used = new Set<Id>();
  let fixed = 0;
  for (const m of view.transactions) {
    if (!m.isMirror || m.status === 'locked') continue;
    const account = view.accounts.find((a) => a.id === m.accountId);
    if (!account || !ownStatementCovers(account, m.date, view.transactions)) continue;
    const real = view.transactions
      .filter((x) => x.accountId === m.accountId && !x.isMirror && x.amount === m.amount && !allocated.has(x.id) && !used.has(x.id) && x.status !== 'locked' && closeDays(x.date, m.date) <= 7)
      .sort((a, b) => closeDays(a.date, m.date) - closeDays(b.date, m.date))[0];
    const pointing = view.allocations.filter((a) => a.targetType === 'transfer' && a.targetId === m.id);
    for (const a of view.allocations.filter((a) => a.transactionId === m.id)) {
      ch.deleteAllocations.push(a.id);
      // The real row takes the mirror's side of the pair.
      if (real) ch.putAllocations.push({ ...a, id: clock.newId(), transactionId: real.id, updatedAt: clock.now() });
    }
    for (const a of pointing) ch.putAllocations.push({ ...a, targetId: real ? real.id : m.accountId, updatedAt: clock.now() });
    if (real) {
      used.add(real.id);
      const { suggestion: _s, ...plain } = real;
      ch.putTransactions.push({ ...plain, status: 'reconciled', updatedAt: clock.now() });
    }
    ch.deleteTransactions.push(m.id);
    fixed++;
  }
  return { changes: ch, fixed };
}

/**
 * Pair inbox rows that are the two sides of one transfer between own accounts
 * (D-71). The other side is either still open too, or already filed as a
 * transfer to this row's account without its row (D-68): then it is linked
 * to this row. Loans are left alone: a repayment also needs a category.
 */
export function pairOpenTransfers(view: LedgerView, clock: Clock): { changes: Changes; paired: number } {
  const ch = emptyChanges();
  const allocated = new Map<Id, Allocation[]>();
  for (const a of view.allocations) allocated.set(a.transactionId, [...(allocated.get(a.transactionId) ?? []), a]);
  const loan = new Set(view.accounts.filter((a) => a.type === 'loan').map((a) => a.id));
  const eligible = view.transactions.filter((c) => !c.isMirror && !loan.has(c.accountId) && c.status !== 'locked');
  // Rows by amount: only the opposite amount can be the other side.
  const byAmount = new Map<number, Transaction[]>();
  for (const c of eligible) byAmount.set(c.amount, [...(byAmount.get(c.amount) ?? []), c]);
  const isOpen = (t: Transaction) => (t.status === 'new' || t.status === 'suggested') && !allocated.has(t.id);

  // Every possible pair, best first: the best match overall wins, not the first row by date. A top-up
  // whose text carries the exact date goes with the row of that date, not with another payment of the
  // same amount a day apart (D-81).
  const candidates: { t: Transaction; c: Transaction; gap: number; pointed: boolean }[] = [];
  for (const t of eligible) {
    if (!isOpen(t)) continue;
    const pointedId = recogniseAccount(t, view.accounts)?.id;
    for (const c of byAmount.get(-t.amount) ?? []) {
      const own = allocated.get(c.id) ?? [];
      // Still open, or filed as a transfer to t's account with no row on t's side.
      const free = own.length === 0 ? c.status === 'new' || c.status === 'suggested' : own.length === 1 && own[0]!.targetType === 'transfer' && own[0]!.targetId === t.accountId;
      if (!free) continue;
      const gap = transferGap(t, c, view.accounts);
      if (gap === undefined) continue;
      // Two open rows are found from both sides: keep one.
      if (isOpen(c) && c.id < t.id) continue;
      candidates.push({ t, c, gap, pointed: c.accountId === pointedId });
    }
  }
  candidates.sort((a, b) => Number(b.pointed) - Number(a.pointed) || a.gap - b.gap || a.t.date.localeCompare(b.t.date));

  const used = new Set<Id>();
  let paired = 0;
  for (const { t, c, gap } of candidates) {
    if (used.has(t.id) || used.has(c.id)) continue;
    const own = allocated.get(c.id) ?? [];
    const reason = `Same amount in ${view.accounts.find((a) => a.id === c.accountId)?.name ?? 'another account'}, ${gap} day(s) apart`;
    for (const a of own) ch.deleteAllocations.push(a.id);
    for (const x of [t, c]) {
      const { suggestion: _s, ...plain } = x;
      ch.putTransactions.push({ ...plain, status: 'reconciled', updatedAt: clock.now() });
    }
    const link = (from: Transaction, to: Transaction): Allocation => ({
      ...stamp(clock, 'manual'),
      transactionId: from.id,
      targetType: 'transfer',
      targetId: to.id,
      amount: from.amount,
      confidence: 1,
      decidedBy: 'rule',
      reason,
    });
    ch.putAllocations.push(link(t, c), link(c, t));
    used.add(t.id);
    used.add(c.id);
    paired++;
  }
  return { changes: ch, paired };
}

/**
 * Several transfers sent as one (D-81): 300 + 350 + 600 + 1,450 from one account arrive as a single
 * 2,700 in another, whose own export shows one purchase. The big row is filed as a transfer from that
 * account and the small ones as transfers to the other, so none stays in the inbox. The small rows are
 * open, or already filed as transfers to this account (they point at the account, not at a row).
 * Only a sum that is exact, within a week and from transfer-like texts counts; if two groups fit, the
 * closer one wins.
 */
export function settleGroupedTransfers(view: LedgerView, clock: Clock): { changes: Changes; settled: number } {
  const ch = emptyChanges();
  const allocated = new Map<Id, Allocation[]>();
  for (const a of view.allocations) allocated.set(a.transactionId, [...(allocated.get(a.transactionId) ?? []), a]);
  const loan = new Set(view.accounts.filter((a) => a.type === 'loan').map((a) => a.id));
  const rows = view.transactions.filter((t) => !t.isMirror && !loan.has(t.accountId) && t.status !== 'locked');
  const isOpen = (t: Transaction) => (t.status === 'new' || t.status === 'suggested') && !allocated.has(t.id);
  const used = new Set<Id>();
  const alloc = (from: Transaction, toAccount: Id, reason: string): Allocation => ({
    ...stamp(clock, 'manual'),
    transactionId: from.id,
    targetType: 'transfer',
    targetId: toAccount,
    amount: from.amount,
    confidence: 1,
    decidedBy: 'rule',
    reason,
  });
  let settled = 0;
  const open = rows.filter(isOpen).sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount));
  for (const big of open) {
    if (used.has(big.id)) continue;
    // Candidates by account: rows of the opposite sign that are free and look like the other side.
    const byAccount = new Map<Id, { c: Transaction; days: number }[]>();
    for (const c of rows) {
      if (c.accountId === big.accountId || used.has(c.id) || Math.sign(c.amount) === Math.sign(big.amount) || Math.abs(c.amount) >= Math.abs(big.amount)) continue;
      const own = allocated.get(c.id) ?? [];
      const free = own.length === 0 ? isOpen(c) : own.length === 1 && own[0]!.targetType === 'transfer' && own[0]!.targetId === big.accountId;
      if (!free) continue;
      const days = transferDays(big, c, view.accounts);
      if (days !== undefined) byAccount.set(c.accountId, [...(byAccount.get(c.accountId) ?? []), { c, days }]);
    }
    let best: { account: Id; members: Transaction[]; score: number } | undefined;
    for (const [account, list] of byAccount) {
      const pool = list.slice(0, 12);
      for (let mask = 1; mask < 1 << pool.length; mask++) {
        let sum = 0;
        let size = 0;
        let score = 0;
        for (let i = 0; i < pool.length; i++) if (mask & (1 << i)) { sum += pool[i]!.c.amount; size++; score += pool[i]!.days; }
        if (size < 2 || sum !== -big.amount) continue;
        if (!best || score < best.score) best = { account, members: pool.filter((_, i) => mask & (1 << i)).map((x) => x.c), score };
      }
    }
    if (!best) continue;
    const other = view.accounts.find((a) => a.id === best!.account)?.name ?? 'another account';
    const reason = `${best.members.length} transfers in ${other} add up to this amount`;
    for (const x of [big, ...best.members]) {
      for (const a of allocated.get(x.id) ?? []) ch.deleteAllocations.push(a.id);
      const { suggestion: _s, ...plain } = x;
      ch.putTransactions.push({ ...plain, status: 'reconciled', updatedAt: clock.now() });
      used.add(x.id);
    }
    ch.putAllocations.push(alloc(big, best.account, reason));
    for (const m of best.members) ch.putAllocations.push(alloc(m, big.accountId, reason));
    settled += 1;
  }
  return { changes: ch, settled };
}

/**
 * Undo pairings the app made on weak evidence (D-81), so the rows can be paired again properly:
 * - an automatic pair of own accounts that neither names the account nor has a transfer-like text on
 *   both sides (a payment to a person paired with a top-up of the same amount);
 * - a pairing with a clearly better partner waiting in the inbox (the open row's text carries the exact
 *   date of that very row, a day closer than the partner it has).
 * Both rows of a pair go back to the inbox; pairs the user made are never touched.
 */
export function repairWeakPairs(view: LedgerView, clock: Clock): { changes: Changes; reopened: number } {
  const ch = emptyChanges();
  const txById = new Map(view.transactions.map((t) => [t.id, t]));
  const done = new Set<Id>();
  let reopened = 0;
  const reopen = (a: Transaction, b: Transaction) => {
    for (const x of [a, b]) {
      for (const al of view.allocations.filter((al) => al.transactionId === x.id)) ch.deleteAllocations.push(al.id);
      const { suggestion: _s, ...plain } = x;
      ch.putTransactions.push({ ...plain, status: 'new', updatedAt: clock.now() });
      done.add(x.id);
    }
    reopened += 2;
  };
  const autoPairs: { t: Transaction; o: Transaction }[] = [];
  const seen = new Set<string>();
  for (const a of view.allocations) {
    if (a.targetType !== 'transfer' || a.decidedBy !== 'rule' || !a.reason.startsWith('Same amount in')) continue;
    const t = txById.get(a.transactionId);
    const o = txById.get(a.targetId);
    if (!t || !o || t.isMirror || o.isMirror || t.status === 'locked' || o.status === 'locked') continue;
    const key = [t.id, o.id].sort().join('|');
    if (seen.has(key)) continue;
    seen.add(key);
    autoPairs.push({ t, o });
  }
  for (const { t, o } of autoPairs) {
    const named = recogniseAccount(t, view.accounts)?.id === o.accountId || recogniseAccount(o, view.accounts)?.id === t.accountId;
    if (!named && !(looksLikeTransfer(t) && looksLikeTransfer(o))) reopen(t, o);
  }
  const gapOf = new Map<Id, { partner: Transaction; gap: number }>();
  for (const { t, o } of autoPairs) {
    if (done.has(t.id)) continue;
    const gap = transferGap(t, o, view.accounts);
    if (gap !== undefined) {
      gapOf.set(t.id, { partner: o, gap });
      gapOf.set(o.id, { partner: t, gap });
    }
  }
  const openRows = view.transactions.filter((x) => (x.status === 'new' || x.status === 'suggested') && !x.isMirror && !done.has(x.id));
  for (const x of openRows) {
    for (const c of view.transactions) {
      if (c.amount !== -x.amount || c.accountId === x.accountId) continue;
      const cur = gapOf.get(c.id);
      if (!cur || done.has(c.id) || done.has(cur.partner.id)) continue;
      const better = transferGap(x, c, view.accounts);
      if (better !== undefined && better + 1 <= cur.gap) reopen(c, cur.partner);
    }
  }
  return { changes: ch, reopened };
}

/** The view after a set of changes (for steps that build on each other). */
export function applyToView(view: LedgerView, ch: Changes): LedgerView {
  const dT = new Set(ch.deleteTransactions);
  const dA = new Set(ch.deleteAllocations);
  const pT = new Map(ch.putTransactions.map((t) => [t.id, t]));
  const pA = new Map(ch.putAllocations.map((a) => [a.id, a]));
  return {
    accounts: view.accounts,
    transactions: [...view.transactions.filter((t) => !dT.has(t.id) && !pT.has(t.id)), ...pT.values()],
    allocations: [...view.allocations.filter((a) => !dA.has(a.id) && !pA.has(a.id)), ...pA.values()],
  };
}

/**
 * File the inbox rows whose suggestion is a transfer to an own account the
 * app is sure about (a rule, the account named in the text, the monthly
 * provisions move): paired with the other side, or pointing at the account
 * (D-71). A loan payment is a transfer to the loan, counted in its own budget line if it has one (D-82).
 */
export function fileSuggestedTransfers(view: LedgerView, clock: Clock, minConfidence = 0.9): { changes: Changes; filed: number } {
  let v = view;
  const all: Changes[] = [];
  let filed = 0;
  for (const t of view.transactions) {
    const sg = t.suggestion;
    if (t.status !== 'suggested' || !sg || sg.targetType !== 'transfer' || sg.confidence < minConfidence) continue;
    const target = view.accounts.find((a) => a.id === sg.targetId);
    if (!target || target.closedAt || target.id === t.accountId) continue;
    const fresh = v.transactions.find((x) => x.id === t.id);
    if (!fresh || fresh.status !== 'suggested') continue;
    // A loan repayment counts in the loan's own budget line when it has one, else it is just a transfer (D-82).
    const how: Classification = target.type === 'loan' && t.amount < 0 && target.categoryId ? { kind: 'transfer', accountId: target.id, categoryId: target.categoryId } : { kind: 'transfer', accountId: target.id };
    const ch = classify(fresh, how, v, clock, sg.decidedBy === 'history' ? 'history' : 'rule', sg.reason);
    all.push(ch);
    v = applyToView(v, ch);
    filed++;
  }
  return { changes: mergeChanges(...all), filed };
}

function closeDays(a: string, b: string): number {
  return Math.abs(Date.parse(a) - Date.parse(b)) / 86_400_000;
}

/**
 * A payment filed straight to a loan's budget line (by hand, a rule or the
 * history) must also lower what the loan owes (D-93): the loan side is added,
 * as when the payment is filed as a transfer to the loan (D-48). A matching
 * row of the loan's own statement is used when there is one; otherwise the
 * app writes the loan side, for the capital only when the loan has an
 * interest rate. Payments before the loan is tracked are already in its
 * opening balance.
 */
export function linkLoanPayments(view: LedgerView, clock: Clock): { changes: Changes; linked: number } {
  const ch = emptyChanges();
  const loans = new Map(view.accounts.filter((a) => a.type === 'loan' && a.categoryId).map((a) => [a.categoryId!, a]));
  if (loans.size === 0) return { changes: ch, linked: 0 };
  const byId = new Map(view.transactions.map((t) => [t.id, t]));
  const loanIds = new Set(view.accounts.filter((a) => a.type === 'loan').map((a) => a.id));
  const REASON = 'Loan repayment (D-93)';
  // Payments that already have their loan side, and loan rows already linked to something.
  // Sides written here earlier are recomputed (the interest rate may have changed).
  const sided = new Set<Id>();
  const taken = new Set<Id>();
  const ours = new Map<Id, { side: Transaction; allocation: Allocation }>();
  for (const a of view.allocations) {
    if (a.targetType !== 'transfer') continue;
    taken.add(a.transactionId);
    const side = byId.get(a.transactionId);
    if (!side || !loanIds.has(side.accountId)) continue;
    if (a.reason === REASON && side.isMirror) ours.set(a.targetId, { side, allocation: a });
    else sided.add(a.targetId);
  }
  let linked = 0;
  // Oldest first, so each payment's interest is worked out on what was owed then.
  const payments = view.allocations
    .filter((a) => a.targetType === 'category' && a.amount < 0 && loans.has(a.targetId) && byId.has(a.transactionId))
    .sort((x, y) => byId.get(x.transactionId)!.date.localeCompare(byId.get(y.transactionId)!.date));
  const added: Transaction[] = [];
  const amountNow = new Map<Id, Cents>();
  /** What the loan owes just before a date (positive). */
  const owedBefore = (loan: Account, date: string) => {
    let b = loan.openingBalance;
    for (const x of [...view.transactions, ...added]) if (x.accountId === loan.id && x.date < date) b += amountNow.get(x.id) ?? x.amount;
    return Math.max(0, -b);
  };
  for (const a of payments) {
    const loan = loans.get(a.targetId)!;
    const t = byId.get(a.transactionId)!;
    if (t.accountId === loan.id || sided.has(t.id)) continue;
    if (loan.openingDate && t.date < loan.openingDate) continue;
    // Only the capital part lowers the loan: the month's interest is a cost, not repayment.
    const interest = loan.interestRate ? Math.round((owedBefore(loan, t.date) * loan.interestRate) / 1200) : 0;
    const capital = Math.max(0, -a.amount - interest);
    const mine = ours.get(t.id);
    if (mine) {
      if (mine.side.amount === capital) continue;
      amountNow.set(mine.side.id, capital);
      ch.putTransactions.push({ ...mine.side, amount: capital, updatedAt: clock.now() });
      ch.putAllocations.push({ ...mine.allocation, amount: capital, updatedAt: clock.now() });
      linked++;
      continue;
    }
    if (capital === 0) continue;
    // The loan's own statement shows the capital (or the whole payment) as one row.
    const own = view.transactions.find(
      (x) => x.accountId === loan.id && !x.isMirror && (x.amount === capital || x.amount === -a.amount) && !taken.has(x.id) && Math.abs(Date.parse(x.date) - Date.parse(t.date)) <= 7 * 86_400_000,
    );
    const from = view.accounts.find((x) => x.id === t.accountId);
    const side = own ? { ...own, status: 'reconciled' as const, updatedAt: clock.now() } : { ...makeMirror(clock, t, loan, from, 'manual'), amount: capital };
    if (own) taken.add(own.id);
    else added.push(side);
    sided.add(t.id);
    ch.putTransactions.push(side);
    ch.putAllocations.push({ ...stamp(clock, 'manual'), transactionId: side.id, targetType: 'transfer', targetId: t.id, amount: side.amount, confidence: 1, decidedBy: a.decidedBy, reason: REASON });
    linked++;
  }
  return { changes: ch, linked };
}

/** Classify one transaction. Replaces any earlier classification. */
export function classify(t: Transaction, how: Classification, view: LedgerView, clock: Clock, decidedBy: Allocation['decidedBy'] = 'user', reason = 'Reviewed in the inbox'): Changes {
  if (t.status === 'locked') throw new ReconcileError('locked');
  const ch = emptyChanges();
  const source = 'manual' as const;
  // Drop the old classification, including the far side of an old transfer
  // (found from either side: a loan repayment links only from the loan side).
  const old = view.allocations.filter((a) => a.transactionId === t.id);
  const farIds = new Set([
    ...old.filter((a) => a.targetType === 'transfer').map((a) => a.targetId),
    ...view.allocations.filter((a) => a.targetType === 'transfer' && a.targetId === t.id).map((a) => a.transactionId),
  ]);
  for (const a of old) ch.deleteAllocations.push(a.id);
  for (const id of farIds) {
    const other = view.transactions.find((x) => x.id === id);
    if (!other) continue;
    for (const b of view.allocations.filter((b) => b.transactionId === other.id)) ch.deleteAllocations.push(b.id);
    if (other.isMirror) ch.deleteTransactions.push(other.id);
    else if (other.status !== 'locked') ch.putTransactions.push({ ...other, status: 'new', updatedAt: clock.now() });
  }
  const { suggestion: _s, ...plain } = t;
  const done: Transaction = { ...plain, status: 'reconciled', updatedAt: clock.now() };
  const alloc = (targetType: Allocation['targetType'], targetId: Id, amount: Cents, tx = done, why = reason): Allocation => ({
    ...stamp(clock, source),
    transactionId: tx.id,
    targetType,
    targetId,
    amount,
    confidence: 1,
    decidedBy,
    reason: why,
  });

  if (how.kind === 'category' || how.kind === 'income') {
    const a = alloc(how.kind, how.categoryId, t.amount);
    if (how.kind === 'category' && how.subBudget) a.subBudget = how.subBudget;
    ch.putAllocations.push(a);
  } else if (how.kind === 'split') {
    const sum = how.lines.reduce((s, l) => s + l.amount, 0);
    if (sum !== t.amount || how.lines.length === 0) throw new ReconcileError('splitUnbalanced');
    const used = new Set<Id>();
    for (const l of how.lines) {
      if (l.kind !== 'transfer') {
        ch.putAllocations.push(alloc(l.kind, l.categoryId, l.amount));
        continue;
      }
      // A part moved to another own account: pair it with a matching row there, or create that side.
      const other = transferSide(t, l.accountId, l.amount, view, ch, used, clock, source);
      if (!other) {
        ch.putAllocations.push(alloc('transfer', l.accountId, l.amount)); // covered by its own statement (D-68)
        continue;
      }
      ch.putAllocations.push(alloc('transfer', other.id, l.amount));
      ch.putAllocations.push(alloc('transfer', t.id, other.amount, other));
    }
  } else {
    if (how.accountId === t.accountId) throw new ReconcileError('sameAccount');
    const target = view.accounts.find((a) => a.id === how.accountId);
    if (!target) throw new ReconcileError('unknownAccount');
    const allocatedIds = new Set(view.allocations.filter((a) => !ch.deleteAllocations.includes(a.id)).map((a) => a.transactionId));
    const counterpart = view.transactions
      .filter((x) => x.accountId === target.id && x.amount === -t.amount && !allocatedIds.has(x.id) && x.status !== 'locked')
      .sort((a, b) => closeDays(a.date, t.date) - closeDays(b.date, t.date))
      .find((x) => closeDays(x.date, t.date) <= 7);
    const from = view.accounts.find((a) => a.id === t.accountId);
    if (!counterpart && ownStatementCovers(target, t.date, view.transactions)) {
      // The other account's own statement shows this money already (D-68): point at the account.
      ch.putAllocations.push(how.categoryId ? alloc('category', how.categoryId, t.amount) : alloc('transfer', target.id, t.amount));
      ch.putTransactions.push(done);
      return ch;
    }
    const other = counterpart
      ? (() => {
          const { suggestion: _x, ...p } = counterpart;
          return { ...p, status: 'reconciled' as const, updatedAt: clock.now() };
        })()
      : makeMirror(clock, t, target, from, source);
    ch.putTransactions.push(other);
    if (how.categoryId) {
      // Loan repayment: the payment is budget activity; the loan side still points back.
      ch.putAllocations.push(alloc('category', how.categoryId, t.amount));
    } else {
      ch.putAllocations.push(alloc('transfer', other.id, t.amount));
    }
    ch.putAllocations.push(alloc('transfer', t.id, other.amount, other));
  }
  ch.putTransactions.push(done);
  return ch;
}

/** The other side of a transfer of `amount` from `t` to `accountId` (an existing open row, or a new mirror). */
function transferSide(t: Transaction, accountId: Id, amount: Cents, view: LedgerView, ch: Changes, used: Set<Id>, clock: Clock, source: Transaction['source']): Transaction | undefined {
  if (accountId === t.accountId) throw new ReconcileError('sameAccount');
  const target = view.accounts.find((a) => a.id === accountId);
  if (!target) throw new ReconcileError('unknownAccount');
  const allocatedIds = new Set(view.allocations.filter((a) => !ch.deleteAllocations.includes(a.id)).map((a) => a.transactionId));
  const counterpart = view.transactions
    .filter((x) => x.accountId === target.id && x.amount === -amount && !allocatedIds.has(x.id) && !used.has(x.id) && x.status !== 'locked')
    .sort((a, b) => closeDays(a.date, t.date) - closeDays(b.date, t.date))
    .find((x) => closeDays(x.date, t.date) <= 7);
  const from = view.accounts.find((a) => a.id === t.accountId);
  if (!counterpart && ownStatementCovers(target, t.date, view.transactions)) return undefined;
  const other = counterpart
    ? (() => {
        const { suggestion: _x, ...p } = counterpart;
        return { ...p, status: 'reconciled' as const, updatedAt: clock.now() };
      })()
    : makeMirror(clock, { ...t, amount }, target, from, source);
  used.add(other.id);
  ch.putTransactions.push(other);
  return other;
}

export function acceptSuggestion(t: Transaction, view: LedgerView, clock: Clock): Changes {
  const s = t.suggestion;
  if (!s) return emptyChanges();
  const loan = view.accounts.find((a) => a.id === s.targetId && a.type === 'loan');
  const how: Classification =
    s.targetType === 'transfer'
      ? { kind: 'transfer', accountId: s.targetId, ...(loan?.categoryId && t.amount < 0 ? { categoryId: loan.categoryId } : {}) }
    : s.targetType === 'income' ? { kind: 'income', categoryId: s.targetId }
    : { kind: 'category', categoryId: s.targetId };
  return classify(t, how, view, clock, s.decidedBy, `Accepted: ${s.reason}`);
}

/** Send a transaction back to the inbox. */
export function unclassify(t: Transaction, view: LedgerView, clock: Clock): Changes {
  const ch = classify(t, { kind: 'category', categoryId: '' }, view, clock);
  ch.putAllocations = [];
  const self = ch.putTransactions.find((x) => x.id === t.id)!;
  self.status = 'new';
  return ch;
}

export function mergeChanges(...all: Changes[]): Changes {
  const out = emptyChanges();
  for (const c of all) {
    for (const k of Object.keys(out) as (keyof Changes)[]) (out[k] as unknown[]).push(...(c[k] as unknown[]));
  }
  // Later puts of the same record win.
  const lastById = <T extends { id: Id }>(xs: T[]) => [...new Map(xs.map((x) => [x.id, x])).values()];
  out.putTransactions = lastById(out.putTransactions);
  out.putAllocations = lastById(out.putAllocations);
  out.putStatements = lastById(out.putStatements);
  return out;
}

export interface StatementCheck {
  computed: Cents;
  difference: Cents | null;
  openItems: number;
  canLock: boolean;
}

/** Balance of the account at the statement's end vs the closing balance it printed. */
export function checkStatement(s: Statement, view: LedgerView): StatementCheck {
  const computed = accountBalances(view.accounts, view.transactions, s.periodEnd).get(s.accountId) ?? 0;
  const difference = s.closingBalance === undefined ? null : computed - s.closingBalance;
  const openItems = view.transactions.filter(
    (t) => t.accountId === s.accountId && t.date >= s.periodStart && t.date <= s.periodEnd && (t.status === 'new' || t.status === 'suggested'),
  ).length;
  return { computed, difference, openItems, canLock: difference === 0 && openItems === 0 && !s.lockedAt };
}

/** Lock a period: only when the computed balance equals the statement and the inbox is clear. */
export function lockStatement(s: Statement, view: LedgerView, clock: Clock): Changes {
  const check = checkStatement(s, view);
  if (!check.canLock) throw new ReconcileError('locked');
  const ch = emptyChanges();
  for (const t of view.transactions) {
    if (t.accountId === s.accountId && t.date >= s.periodStart && t.date <= s.periodEnd && t.status !== 'locked') {
      ch.putTransactions.push({ ...t, status: 'locked', updatedAt: clock.now() });
    }
  }
  ch.putStatements.push({ ...s, lockedAt: clock.now(), updatedAt: clock.now() });
  return ch;
}

/**
 * Remove everything one import created. Transfers it paired go back to the
 * inbox on the other side; mirrors it created are removed. Refused when any
 * of its rows is locked.
 */
export function undoImport(batch: ImportBatch, view: LedgerView & { statements: readonly Statement[] }, clock: Clock): Changes {
  const ch = emptyChanges();
  const source = `import:${batch.id}`;
  const mine = view.transactions.filter((t) => t.importBatchId === batch.id || t.source === source);
  if (mine.some((t) => t.status === 'locked')) throw new ReconcileError('locked');
  const ids = new Set(mine.map((t) => t.id));
  for (const t of mine) ch.deleteTransactions.push(t.id);
  for (const a of view.allocations) {
    if (ids.has(a.transactionId)) ch.deleteAllocations.push(a.id);
    else if (a.targetType === 'transfer' && ids.has(a.targetId)) {
      ch.deleteAllocations.push(a.id);
      const other = view.transactions.find((t) => t.id === a.transactionId);
      if (other?.isMirror) ch.deleteTransactions.push(other.id);
      else if (other && other.status !== 'locked') ch.putTransactions.push({ ...other, status: 'new', updatedAt: clock.now() });
    }
  }
  for (const s of view.statements) {
    if (s.importBatchId === batch.id && !s.lockedAt) ch.deleteStatements.push(s.id);
    else if (s.settlement?.transactionId && ids.has(s.settlement.transactionId)) {
      const { transactionId: _t, ...rest } = s.settlement;
      ch.putStatements.push({ ...s, settlement: rest, updatedAt: clock.now() });
    }
  }
  ch.deleteBatches.push(batch.id);
  return ch;
}
