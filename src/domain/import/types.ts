import type { Cents, ImportFormat, IsoDate } from '../types';

/** A transaction as read from a file, before it is matched to the ledger. */
export interface ParsedRow {
  /** 1-based line or row number in the source, for the import report. */
  line: number;
  /** Booking date. */
  date: IsoDate;
  valueDate?: IsoDate;
  /** Signed EUR cents from the account's point of view (negative = out). */
  amount: Cents;
  description: string;
  /** Communication / remittance text, appended to the description. */
  details?: string;
  counterparty?: string;
  counterpartyIbanLast4?: string;
  originalCurrency?: string;
  originalAmount?: Cents;
  /** Sub-account inside one file (Revolut "Product", card number). */
  accountKey: string;
  balanceAfter?: Cents;
}

export type SkipReason = 'reverted' | 'pending' | 'declined' | 'state' | 'currency' | 'unparseable' | 'zero' | 'locked' | 'ignored';

export interface SkippedRow {
  line: number;
  reason: SkipReason;
  text: string;
}

/** Balance information for one sub-account found in a file. */
export interface StatementInfo {
  accountKey: string;
  /** Last 4 characters of the IBAN or card number, used to pick the account. */
  last4?: string;
  periodStart?: IsoDate;
  periodEnd?: IsoDate;
  openingBalance?: Cents;
  closingBalance?: Cents;
  settlement?: { amount: Cents; date: IsoDate; fromLast4?: string };
}

export interface ParseResult {
  format: ImportFormat;
  /** Bank or layout name shown to the user. */
  label: string;
  rows: ParsedRow[];
  skipped: SkippedRow[];
  statements: StatementInfo[];
  /** Codes such as 'balanceMismatch:<key>'. */
  warnings: string[];
}

export class ImportParseError extends Error {
  constructor(public readonly code: 'unknownFormat' | 'headersChanged' | 'noRows' | 'badXml' | 'missingColumn', public readonly detail = '') {
    super(code);
  }
}
