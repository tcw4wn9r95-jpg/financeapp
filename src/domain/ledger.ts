import { isIsoDate } from './dates';
import { assertCents } from './money';
import type { Allocation, BaseRecord, Cents, Id, IsoDate, Source, Transaction } from './types';

/**
 * Ledger helpers for manual entry (M1). Import and reconciliation (M2) build on
 * the same shapes. Pure: ids and clock are injected so tests are deterministic.
 */

export interface Clock {
  now: () => string;
  newId: () => Id;
}

export const systemClock: Clock = {
  now: () => new Date().toISOString(),
  newId: () => crypto.randomUUID(),
};

export function stamp(clock: Clock, source: Source, id?: Id): BaseRecord {
  const now = clock.now();
  return { id: id ?? clock.newId(), createdAt: now, updatedAt: now, source };
}

/** What a manual entry is classified as. */
export type EntryTarget =
  | { kind: 'category'; categoryId: Id }
  | { kind: 'income'; categoryId: Id }
  | { kind: 'transfer'; toAccountId: Id }
  | { kind: 'none' };

export interface ManualEntry {
  accountId: Id;
  date: IsoDate;
  /** Signed cents from the point of view of `accountId` (negative = money out). */
  amount: Cents;
  description: string;
  counterparty?: string;
  note?: string;
  originalCurrency?: string;
  originalAmount?: Cents;
  target: EntryTarget;
}

export interface LedgerWrite {
  transactions: Transaction[];
  allocations: Allocation[];
}

export class LedgerError extends Error {}

/**
 * Normalise a bank description into a merchant key: upper case, card numbers,
 * dates, long digit runs and terminal ids stripped. Good enough for manual
 * entry; M4 extends it with country extraction.
 */
const BANK_PREFIXES =
  /^(?:INSTANT CREDIT TRANSFER S-NET : [\d-]+ IN FAVOUR OF|CREDIT TRANSFER (?:IN FAVOUR OF|FROM)|STANDING ORDER(?: \d{2}\.\d{2}\.\d{4})? IN FAVOUR OF|DIRECT DEBIT|DEBIT TPV|DEBIT|CARD PAYMENT|PAYMENT FROM|TRANSFER TO|TRANSFER FROM)\s+/i;

export function normaliseMerchant(description: string): string {
  return description
    .replace(BANK_PREFIXES, '')
    .toUpperCase()
    .replace(/\b[\dX*]{4}(?:[ -]?[\dX*]{2,4}){2,3}\b/g, ' ') // card numbers, masked or not
    .replace(/\b\d{1,2}[./-]\d{1,2}([./-]\d{2,4})?\b/g, ' ') // dates
    .replace(/\b(TERM|TID|REF|NR|NO)\.?\s*[:#]?\s*\w+/g, ' ')
    .replace(/\d{4,}/g, ' ')
    .replace(/[^\p{L}\p{N}&' ]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Build the transaction(s) and allocation(s) for one manual entry. */
export function buildManualEntry(entry: ManualEntry, clock: Clock): LedgerWrite {
  assertCents(entry.amount);
  if (!isIsoDate(entry.date)) throw new LedgerError('invalidDate');
  if (entry.amount === 0) throw new LedgerError('zeroAmount');
  if ((entry.originalCurrency === undefined) !== (entry.originalAmount === undefined)) {
    throw new LedgerError('foreignIncomplete');
  }

  const base = (accountId: Id, amount: Cents): Transaction => ({
    ...stamp(clock, 'manual'),
    accountId,
    date: entry.date,
    amount,
    descriptionRaw: entry.description,
    merchantNorm: normaliseMerchant(entry.description),
    counterparty: entry.counterparty ?? '',
    ...(entry.note ? { note: entry.note } : {}),
    ...(entry.originalCurrency !== undefined
      ? { originalCurrency: entry.originalCurrency, originalAmount: entry.originalAmount! }
      : {}),
    status: 'reconciled',
  });

  const allocation = (t: Transaction, targetType: Allocation['targetType'], targetId: Id): Allocation => ({
    ...stamp(clock, 'manual'),
    transactionId: t.id,
    targetType,
    targetId,
    amount: t.amount,
    confidence: 1,
    decidedBy: 'user',
    reason: 'Manual entry',
  });

  const t = base(entry.accountId, entry.amount);
  switch (entry.target.kind) {
    case 'none':
      return { transactions: [{ ...t, status: 'new' }], allocations: [] };
    case 'category':
      return { transactions: [t], allocations: [allocation(t, 'category', entry.target.categoryId)] };
    case 'income':
      return { transactions: [t], allocations: [allocation(t, 'income', entry.target.categoryId)] };
    case 'transfer': {
      if (entry.target.toAccountId === entry.accountId) throw new LedgerError('transferSameAccount');
      const other = base(entry.target.toAccountId, -entry.amount);
      return {
        transactions: [t, other],
        allocations: [allocation(t, 'transfer', other.id), allocation(other, 'transfer', t.id)],
      };
    }
  }
}

/** Splits must sum exactly to the transaction amount. Returns the difference (0 = balanced). */
export function splitRemainder(transaction: Pick<Transaction, 'amount'>, allocations: readonly Pick<Allocation, 'amount'>[]): Cents {
  return transaction.amount - allocations.reduce((s, a) => s + a.amount, 0);
}

/** For a transfer transaction, the id of its counterpart (if paired). */
export function transferCounterpartId(allocations: readonly Allocation[], transactionId: Id): Id | undefined {
  return allocations.find((a) => a.transactionId === transactionId && a.targetType === 'transfer')?.targetId;
}
