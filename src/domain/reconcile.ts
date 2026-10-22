import { accountBalances } from './budget';
import { stamp, type Clock } from './ledger';
import { makeMirror, recogniseAccount, transferGap } from './import/plan';
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
  const used = new Set<Id>();
  let paired = 0;
  const open = view.transactions.filter((t) => (t.status === 'new' || t.status === 'suggested') && !t.isMirror && !loan.has(t.accountId) && !allocated.has(t.id));
  for (const t of [...open].sort((a, b) => a.date.localeCompare(b.date))) {
    if (used.has(t.id)) continue;
    const pointed = recogniseAccount(t, view.accounts)?.id;
    const candidates = view.transactions
      .filter((c) => !used.has(c.id) && !c.isMirror && !loan.has(c.accountId) && c.status !== 'locked')
      .map((c) => {
        const own = allocated.get(c.id) ?? [];
        // Still open, or filed as a transfer to t's account with no row on t's side.
        const free = own.length === 0 ? (c.status === 'new' || c.status === 'suggested') : own.length === 1 && own[0]!.targetType === 'transfer' && own[0]!.targetId === t.accountId;
        const gap = free ? transferGap(t, c, view.accounts) : undefined;
        return { c, gap, own };
      })
      .filter((x) => x.gap !== undefined)
      .sort((a, b) => Number(b.c.accountId === pointed) - Number(a.c.accountId === pointed) || a.gap! - b.gap!);
    const best = candidates[0];
    if (!best) continue;
    const { c, own } = best;
    const reason = `Same amount in ${view.accounts.find((a) => a.id === c.accountId)?.name ?? 'another account'}, ${best.gap} day(s) apart`;
    for (const a of own) ch.deleteAllocations.push(a.id);
    for (const x of [t, c]) {
      const { suggestion: _s, ...plain } = x;
      ch.putTransactions.push({ ...plain, status: x.status === 'locked' ? 'locked' : 'reconciled', updatedAt: clock.now() });
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
 * (D-71). A loan payment is filed only when the loan has its own budget line.
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
    if (target.type === 'loan' && !target.categoryId) continue;
    const fresh = v.transactions.find((x) => x.id === t.id);
    if (!fresh || fresh.status !== 'suggested') continue;
    const how: Classification = target.type === 'loan' && t.amount < 0 ? { kind: 'transfer', accountId: target.id, categoryId: target.categoryId! } : { kind: 'transfer', accountId: target.id };
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
