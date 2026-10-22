import { monthOf } from '../dates';
import { normaliseMerchant, stamp, type Clock } from '../ledger';
import type {
  Account,
  Allocation,
  Cents,
  Id,
  ImportBatch,
  ImportFormat,
  ImportReport,
  IsoDate,
  MonthKey,
  Statement,
  Transaction,
} from '../types';
import type { ParsedRow, SkippedRow, StatementInfo } from './types';

/**
 * Import engine (PRD F5, F6, F7). Turns parsed rows into ledger changes:
 *
 * 1. Deduplicate: hash of account + date + amount + normalised description,
 *    with an occurrence number so two identical rows on one day stay two rows
 *    and overlapping files never create duplicates.
 * 2. Replace mirrors: a row that matches a transfer side Kassa created
 *    earlier (D-23) takes its place.
 * 3. Link card statements to their settlement debit (a transfer, never spending).
 * 4. Pair internal transfers: opposite amounts in two own accounts within 4
 *    days, where at least one side reads like a transfer.
 * 5. Recognise own accounts by IBAN, card number or text hints; create the
 *    other side when that account has no imported statements, else suggest.
 */

export interface PlannedRow extends ParsedRow {
  accountId: Id;
}

export interface PlannedStatement extends StatementInfo {
  accountId: Id;
}

export interface Ledger {
  accounts: readonly Account[];
  transactions: readonly Transaction[];
  allocations: readonly Allocation[];
  statements: readonly Statement[];
}

export interface ImportInput {
  fileName: string;
  format: ImportFormat;
  mappingId?: Id;
  rows: readonly PlannedRow[];
  skipped: readonly SkippedRow[];
  statements: readonly PlannedStatement[];
  warnings: readonly string[];
  budgetStartMonth: MonthKey;
}

export interface LedgerChanges {
  transactions: Transaction[];
  allocations: Allocation[];
  deleteAllocations: Id[];
  statements: Statement[];
  accounts: Account[];
  batch: ImportBatch;
}

const PAIR_WINDOW_DAYS = 4;
const SETTLEMENT_WINDOW_DAYS = 5;

/** 64-bit FNV-1a as 16 hex characters. Not cryptographic; only for matching. */
export function fnv64(text: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x050c5d1f;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ c, 0x01000193) >>> 0;
  }
  return h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0');
}

export function dedupeKey(accountId: Id, date: IsoDate, amount: Cents, description: string): string {
  return `${accountId}|${date}|${amount}|${normaliseMerchant(description)}`;
}

function dayDiff(a: IsoDate, b: IsoDate): number {
  return Math.abs(Date.UTC(+a.slice(0, 4), +a.slice(5, 7) - 1, +a.slice(8, 10)) - Date.UTC(+b.slice(0, 4), +b.slice(5, 7) - 1, +b.slice(8, 10))) / 86_400_000;
}

/** Smallest distance between the booking/value dates of two transactions. */
function closeness(a: Pick<Transaction, 'date' | 'valueDate'>, b: Pick<Transaction, 'date' | 'valueDate'>): number {
  const da = [a.date, a.valueDate].filter(Boolean) as string[];
  const db = [b.date, b.valueDate].filter(Boolean) as string[];
  return Math.min(...da.flatMap((x) => db.map((y) => dayDiff(x, y))));
}

/** A day and month written in the description ("DEBIT REVOLUT**3501* 29.01"): when a card top-up was made, booked days later. */
export function embeddedDate(t: Pick<Transaction, 'date' | 'descriptionRaw'>): IsoDate | undefined {
  const m = /(?:^|\D)(\d{2})[./](\d{2})(?:\D*$)/.exec(t.descriptionRaw);
  if (!m) return undefined;
  const day = Number(m[1]);
  const month = Number(m[2]);
  if (day < 1 || day > 31 || month < 1 || month > 12) return undefined;
  let year = Number(t.date.slice(0, 4));
  if (month > Number(t.date.slice(5, 7))) year--; // "29.12" on a January statement
  const d = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  // Only a date shortly before the booking counts; anything else is not a date.
  return d <= t.date && dayDiff(d, t.date) <= 10 ? d : undefined;
}

/** A longer gap is allowed when the text says where the money went (top-ups are booked days later). */
const PAIR_WINDOW_NAMED_DAYS = 7;

/**
 * Days between two rows that look like the two sides of one transfer between
 * own accounts, or undefined. Same amount with opposite signs, different
 * accounts, a transfer-like text on either side, and within 4 days, or 7 when
 * either text names the other account; a date written in the text counts too (D-71).
 */
export function transferGap(t: Transaction, c: Transaction, accounts: readonly Account[]): number | undefined {
  if (c.id === t.id || c.accountId === t.accountId || c.amount !== -t.amount || t.amount === 0) return undefined;
  const pointed = recogniseAccount(t, accounts)?.id === c.accountId || recogniseAccount(c, accounts)?.id === t.accountId;
  if (!pointed && !looksLikeTransfer(t) && !looksLikeTransfer(c)) return undefined;
  const dates = (x: Transaction) => [x.date, x.valueDate, embeddedDate(x)].filter(Boolean) as string[];
  const days = Math.min(...dates(t).flatMap((a) => dates(c).map((b) => dayDiff(a, b))));
  return days <= (pointed || embeddedDate(t) || embeddedDate(c) ? PAIR_WINDOW_NAMED_DAYS : PAIR_WINDOW_DAYS) ? days : undefined;
}

const TRANSFER_WORDS =
  /transfer|virement|[üu]berweisung|standing order|ordre permanent|payment from|payment received|paiement re[çc]u|^to |^from |top.?up|revolut|compte|savings|[ée]pargne|in favour of|••\d{4}|own account/i;

export function looksLikeTransfer(t: Pick<Transaction, 'descriptionRaw' | 'counterpartyIbanLast4'>): boolean {
  return TRANSFER_WORDS.test(t.descriptionRaw) || !!t.counterpartyIbanLast4;
}

/** The own account a transaction text points at, if any (never its own account). */
export function recogniseAccount(t: Transaction, accounts: readonly Account[]): Account | undefined {
  const text = `${t.descriptionRaw} ${t.counterparty}`.toLowerCase();
  return accounts.find((a) => {
    if (a.id === t.accountId || a.closedAt) return false;
    if (t.counterpartyIbanLast4 && a.ibanLast4 && t.counterpartyIbanLast4 === a.ibanLast4 && a.type !== 'card') return true;
    if (a.type === 'card' && a.ibanLast4 && text.includes(`••${a.ibanLast4}`)) return true;
    return (a.matchHints ?? []).some((h) => h.trim().length >= 3 && text.includes(h.trim().toLowerCase()));
  });
}

function transferAllocation(clock: Clock, source: Transaction['source'], t: Transaction, other: Transaction, reason: string, decidedBy: Allocation['decidedBy'] = 'rule'): Allocation {
  return {
    ...stamp(clock, source),
    transactionId: t.id,
    targetType: 'transfer',
    targetId: other.id,
    amount: t.amount,
    confidence: 1,
    decidedBy,
    reason,
  };
}

/** Build the other side of a transfer into an account without imported statements. */
export function makeMirror(clock: Clock, t: Transaction, target: Account, from: Account | undefined, source: Transaction['source']): Transaction {
  const label = from ? (t.amount < 0 ? `Transfer from ${from.name}` : `Transfer to ${from.name}`) : 'Transfer';
  return {
    ...stamp(clock, source),
    accountId: target.id,
    date: t.valueDate ?? t.date,
    amount: -t.amount,
    descriptionRaw: label,
    merchantNorm: normaliseMerchant(label),
    counterparty: from?.name ?? '',
    status: 'reconciled',
    isMirror: true,
  };
}

export function planImport(input: ImportInput, ledger: Ledger, clock: Clock): LedgerChanges {
  const batchId = clock.newId();
  const source = `import:${batchId}` as const;
  const report: ImportReport = {
    newCount: 0,
    duplicateCount: 0,
    skipped: input.skipped.map((s) => ({ line: s.line, reason: s.reason, text: s.text })),
    transfersPaired: 0,
    mirrorsCreated: 0,
    mirrorsReplaced: 0,
    suggestions: 0,
    cardSettlementsLinked: 0,
    warnings: [...input.warnings],
  };
  const accountsById = new Map(ledger.accounts.map((a) => [a.id, a]));

  // Working copies: everything this import writes goes through these maps.
  const txns = new Map<Id, Transaction>(ledger.transactions.map((t) => [t.id, t]));
  const changedTxns = new Map<Id, Transaction>();
  const putTxn = (t: Transaction) => {
    txns.set(t.id, t);
    changedTxns.set(t.id, t);
  };
  const allocated = new Set(ledger.allocations.map((a) => a.transactionId));
  const newAllocations: Allocation[] = [];
  const addAllocation = (a: Allocation) => {
    newAllocations.push(a);
    allocated.add(a.transactionId);
  };
  const isOpen = (t: Transaction) => !allocated.has(t.id) && t.status !== 'locked';

  const existingHashes = new Map<string, Transaction>();
  for (const t of ledger.transactions) if (t.dedupeHash) existingHashes.set(`${t.accountId}|${t.dedupeHash}`, t);
  const lockedStatements = ledger.statements.filter((s) => s.lockedAt);
  const inLockedPeriod = (accountId: Id, date: IsoDate) =>
    lockedStatements.some((s) => s.accountId === accountId && date >= s.periodStart && date <= s.periodEnd);
  const hasImports = (accountId: Id) =>
    [...txns.values()].some((t) => t.accountId === accountId && t.importBatchId !== undefined && !t.isMirror);

  // ---------------------------------------------------------------- rows
  const occurrences = new Map<string, number>();
  const created: Transaction[] = [];
  const consumedMirrors = new Set<Id>();
  let beforeStart = 0;
  for (const row of input.rows) {
    const description = row.details ? `${row.description} — ${row.details}` : row.description;
    const key = dedupeKey(row.accountId, row.date, row.amount, row.description);
    const n = (occurrences.get(key) ?? 0) + 1;
    occurrences.set(key, n);
    const hash = fnv64(`${key}#${n}`);
    if (existingHashes.has(`${row.accountId}|${hash}`)) {
      report.duplicateCount++;
      continue;
    }
    if (inLockedPeriod(row.accountId, row.date)) {
      report.skipped.push({ line: row.line, reason: 'locked', text: `${row.date} ${row.description} ${row.amount}` });
      continue;
    }
    if (monthOf(row.date) < input.budgetStartMonth) beforeStart++;
    const fields = {
      accountId: row.accountId,
      date: row.date,
      ...(row.valueDate ? { valueDate: row.valueDate } : {}),
      amount: row.amount,
      descriptionRaw: description,
      merchantNorm: normaliseMerchant(row.counterparty || row.description),
      counterparty: row.counterparty ?? '',
      ...(row.counterpartyIbanLast4 ? { counterpartyIbanLast4: row.counterpartyIbanLast4 } : {}),
      ...(row.originalCurrency && row.originalAmount !== undefined ? { originalCurrency: row.originalCurrency, originalAmount: row.originalAmount } : {}),
      importBatchId: batchId,
      dedupeHash: hash,
    };
    // A mirror Kassa created for this account earlier is replaced by the real row.
    const mirror = [...txns.values()].find(
      (t) => t.isMirror && !consumedMirrors.has(t.id) && t.accountId === row.accountId && t.amount === row.amount && t.status !== 'locked' && closeness(t, row) <= PAIR_WINDOW_DAYS,
    );
    if (mirror) {
      consumedMirrors.add(mirror.id);
      const { isMirror: _m, ...rest } = mirror;
      putTxn({ ...rest, ...fields, source, updatedAt: clock.now() });
      report.mirrorsReplaced++;
      continue;
    }
    const t: Transaction = { ...stamp(clock, source), ...fields, status: 'new' };
    putTxn(t);
    created.push(t);
    report.newCount++;
  }
  if (beforeStart > 0) report.warnings.push(`beforeStart:${beforeStart}`);

  // ----------------------------------------------------------- statements
  const statements: Statement[] = [];
  const accountsOut: Account[] = [];
  for (const info of input.statements) {
    const account = accountsById.get(info.accountId);
    if (!account) continue;
    const rows = input.rows.filter((r) => r.accountId === info.accountId);
    const dates = rows.map((r) => r.date).sort();
    const periodStart = info.periodStart ?? dates[0];
    const periodEnd = info.periodEnd ?? dates.at(-1);
    if (!periodStart || !periodEnd) continue;
    const existing = ledger.statements.find((s) => s.accountId === info.accountId && s.periodStart === periodStart && s.periodEnd === periodEnd);
    const fromAccount = info.settlement?.fromLast4
      ? ledger.accounts.find((a) => a.ibanLast4 === info.settlement!.fromLast4 && a.type !== 'card')
      : account.settlementAccountId ? accountsById.get(account.settlementAccountId) : undefined;
    const statement: Statement = {
      ...(existing ?? stamp(clock, source)),
      updatedAt: clock.now(),
      accountId: info.accountId,
      periodStart,
      periodEnd,
      ...(info.openingBalance !== undefined ? { openingBalance: info.openingBalance } : {}),
      ...(info.closingBalance !== undefined ? { closingBalance: info.closingBalance } : {}),
      importBatchId: batchId,
      ...(info.settlement
        ? { settlement: { amount: info.settlement.amount, date: info.settlement.date, ...(fromAccount ? { fromAccountId: fromAccount.id } : {}), ...(existing?.settlement?.transactionId ? { transactionId: existing.settlement.transactionId } : {}) } }
        : {}),
    };
    statements.push(statement);

    // The opening balance comes from the earliest statement: on the first import,
    // and again when an older statement is imported later (retroactive upload),
    // unless the user typed the opening balance by hand (D-32).
    const own = ledger.transactions.filter((t) => t.accountId === account.id && !t.isMirror);
    const earliest = own.reduce<string | undefined>((m, t) => (m === undefined || t.date < m ? t.date : m), undefined);
    const current = accountsOut.find((a) => a.id === account.id) ?? account;
    const first = own.length === 0 && current.openingBalance === 0;
    const older = current.openingFromStatement === true && earliest !== undefined && periodStart <= earliest;
    if (info.openingBalance !== undefined && (first || older) && info.openingBalance !== current.openingBalance) {
      const updated: Account = { ...current, openingBalance: info.openingBalance, openingFromStatement: true, updatedAt: clock.now() };
      // The statement's opening balance is the balance on its first day (D-47).
      if (current.openingDate && periodStart < current.openingDate) updated.openingDate = periodStart;
      const i = accountsOut.findIndex((a) => a.id === account.id);
      if (i >= 0) accountsOut[i] = updated;
      else accountsOut.push(updated);
      report.warnings.push(`openingSet:${account.id}:${info.openingBalance}`);
    } else if (
      info.openingBalance !== undefined &&
      current.openingFromStatement !== true &&
      own.length > 0 &&
      earliest !== undefined &&
      periodStart <= earliest &&
      info.openingBalance !== current.openingBalance
    ) {
      // An older statement than anything imported, but the opening balance was typed by hand: ask (D-45).
      report.warnings.push(`openingDiffers:${account.id}:${info.openingBalance}`);
    }
  }

  // ------------------------------------------------ card settlement links
  const pending = [...statements, ...ledger.statements.filter((s) => !statements.some((x) => x.id === s.id))].filter(
    (s) => s.settlement && s.settlement.fromAccountId && !s.settlement.transactionId,
  );
  for (const s of pending) {
    const st = s.settlement!;
    const card = accountsById.get(s.accountId);
    if (!card) continue;
    const debit = [...txns.values()]
      .filter((t) => t.accountId === st.fromAccountId && t.amount === -st.amount && (isOpen(t) || t.status === 'suggested') && dayDiff(t.date, st.date) <= SETTLEMENT_WINDOW_DAYS)
      .sort((a, b) => dayDiff(a.date, st.date) - dayDiff(b.date, st.date))[0];
    if (!debit) continue;
    // Prefer a payment row the card statement itself lists; otherwise create the card side.
    const listed = [...txns.values()].find((t) => t.accountId === card.id && t.amount === st.amount && isOpen(t) && closeness(t, debit) <= SETTLEMENT_WINDOW_DAYS);
    const other = listed ?? makeMirror(clock, debit, card, accountsById.get(debit.accountId), source);
    if (!listed) {
      putTxn(other);
      report.mirrorsCreated++;
    }
    const { suggestion: _s, ...plainDebit } = debit;
    putTxn({ ...plainDebit, status: 'reconciled', updatedAt: clock.now() });
    putTxn({ ...other, status: 'reconciled' });
    addAllocation(transferAllocation(clock, source, debit, other, `Card statement ${s.periodEnd} settlement`));
    addAllocation(transferAllocation(clock, source, other, debit, `Card statement ${s.periodEnd} settlement`));
    const updated: Statement = { ...s, settlement: { ...st, transactionId: debit.id }, updatedAt: clock.now() };
    const i = statements.findIndex((x) => x.id === s.id);
    if (i >= 0) statements[i] = updated;
    else statements.push(updated);
    report.cardSettlementsLinked++;
  }

  // ---------------------------------------------------- transfer pairing
  const ownAccounts = new Set(ledger.accounts.map((a) => a.id));
  for (const t0 of created) {
    const t = txns.get(t0.id)!;
    if (!isOpen(t)) continue;
    const gap = (c: Transaction) => (ownAccounts.has(c.accountId) && isOpen(c) && !c.isMirror ? transferGap(t, c, ledger.accounts) : undefined);
    const candidates = [...txns.values()].filter((c) => gap(c) !== undefined);
    if (candidates.length === 0) continue;
    // Prefer the account the text points at, then the closest date.
    const pointed = recogniseAccount(t, ledger.accounts);
    candidates.sort((a, b) => Number(b.accountId === pointed?.id) - Number(a.accountId === pointed?.id) || gap(a)! - gap(b)!);
    const c = candidates[0]!;
    const days = gap(c)!;
    const reason = `Same amount in ${accountsById.get(c.accountId)?.name ?? 'another account'}, ${days} day(s) apart`;
    for (const x of [t, c]) {
      const { suggestion: _s, ...plain } = x;
      putTxn({ ...plain, status: 'reconciled', updatedAt: clock.now() });
    }
    addAllocation(transferAllocation(clock, source, t, c, reason));
    addAllocation(transferAllocation(clock, source, c, t, reason));
    report.transfersPaired++;
  }

  // ------------------------------------------- recognise own accounts
  for (const t0 of created) {
    const t = txns.get(t0.id)!;
    if (!isOpen(t)) continue;
    const target = recogniseAccount(t, ledger.accounts);
    if (!target) continue;
    if (target.type === 'loan') {
      // A loan repayment also needs a budget category, so the user confirms it (D-29).
      putTxn({
        ...t,
        status: 'suggested',
        suggestion: { targetType: 'transfer', targetId: target.id, confidence: 0.9, decidedBy: 'rule', reason: `Repayment of ${target.name}` },
        updatedAt: clock.now(),
      });
      report.suggestions++;
    } else if (!hasImports(target.id)) {
      const mirror = makeMirror(clock, t, target, accountsById.get(t.accountId), source);
      putTxn(mirror);
      putTxn({ ...t, status: 'reconciled', updatedAt: clock.now() });
      const reason = `Transfer ${t.amount < 0 ? 'to' : 'from'} ${target.name} (recognised in the description)`;
      addAllocation(transferAllocation(clock, source, t, mirror, reason));
      addAllocation(transferAllocation(clock, source, mirror, t, reason));
      report.mirrorsCreated++;
    } else {
      putTxn({
        ...t,
        status: 'suggested',
        suggestion: { targetType: 'transfer', targetId: target.id, confidence: 0.9, decidedBy: 'rule', reason: `Mentions ${target.name}` },
        updatedAt: clock.now(),
      });
      report.suggestions++;
    }
  }

  const batch: ImportBatch = {
    ...stamp(clock, source),
    id: batchId,
    fileName: input.fileName,
    format: input.format,
    ...(input.mappingId ? { mappingId: input.mappingId } : {}),
    accountIds: [...new Set(input.rows.map((r) => r.accountId))],
    importedAt: clock.now(),
    report,
  };
  return { transactions: [...changedTxns.values()], allocations: newAllocations, deleteAllocations: [], statements, accounts: accountsOut, batch };
}

/** Sub-accounts in a parsed file (Revolut products, cards, IBANs) and the account each one suggests. */
export function subAccounts(result: { rows: readonly ParsedRow[]; statements: readonly StatementInfo[] }, accounts: readonly Account[], remembered: Record<string, Id> = {}): { key: string; last4?: string; rows: number; accountId?: Id }[] {
  const keys = [...new Set([...result.statements.map((s) => s.accountKey), ...result.rows.map((r) => r.accountKey)])];
  return keys.map((key) => {
    const info = result.statements.find((s) => s.accountKey === key);
    const byLast4 = info?.last4 ? accounts.find((a) => !a.closedAt && a.ibanLast4 === info.last4) : undefined;
    const rememberedId = remembered[key] && accounts.some((a) => a.id === remembered[key]) ? remembered[key] : undefined;
    // Otherwise an account whose name or hints share a word with the part's name ("Flexible savings" → "Compte flexible").
    const words = key.toLowerCase().split(/\W+/).filter((w) => w.length >= 5);
    const byName = words.length
      ? accounts.find((a) => !a.closedAt && a.type !== 'loan' && [a.name, ...(a.matchHints ?? [])].some((n) => words.some((w) => n.toLowerCase().includes(w))))
      : undefined;
    const accountId = byLast4?.id ?? rememberedId ?? byName?.id;
    return { key, ...(info?.last4 ? { last4: info.last4 } : {}), rows: result.rows.filter((r) => r.accountKey === key).length, ...(accountId ? { accountId } : {}) };
  });
}

/** Attach account ids to parsed rows; sub-accounts mapped to '' are skipped as "ignored". */
export function assignAccounts(
  result: { rows: readonly ParsedRow[]; statements: readonly StatementInfo[]; skipped: readonly SkippedRow[] },
  choice: Record<string, Id>,
): { rows: PlannedRow[]; statements: PlannedStatement[]; skipped: SkippedRow[] } {
  const rows: PlannedRow[] = [];
  const skipped = [...result.skipped];
  for (const r of result.rows) {
    const accountId = choice[r.accountKey];
    if (accountId) rows.push({ ...r, accountId });
    else skipped.push({ line: r.line, reason: 'ignored', text: `${r.date} ${r.description} ${r.amount}` });
  }
  const statements = result.statements.filter((s) => choice[s.accountKey]).map((s) => ({ ...s, accountId: choice[s.accountKey]! }));
  return { rows, statements, skipped };
}
