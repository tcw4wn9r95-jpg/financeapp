import { accountBalances } from './budget';
import { stamp, type Clock } from './ledger';
import { makeMirror } from './import/plan';
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
  | { kind: 'split'; lines: { kind: 'category' | 'income'; categoryId: Id; amount: Cents }[] };

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

/** Open inbox items with the same merchant and direction (for "apply to all similar"). */
export function similar(t: Transaction, transactions: readonly Transaction[]): Transaction[] {
  return inbox(transactions).filter((x) => x.id !== t.id && x.merchantNorm === t.merchantNorm && x.merchantNorm !== '' && Math.sign(x.amount) === Math.sign(t.amount));
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
    for (const l of how.lines) ch.putAllocations.push(alloc(l.kind, l.categoryId, l.amount));
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
