import type { ParseResult, ParsedRow, StatementInfo } from './types';
import { ImportParseError } from './types';
import { ibanLast4, parseAmount, parseBankDate, squash } from './text';

/**
 * Credit-card statement issued by Worldline for Luxembourg banks (Visa
 * Premier and similar), after PDF text extraction:
 *
 *   OPERATIONS WITH CARD VISA NUMBER 4999 0000 0000 4321
 *   20/09/2026   21/09/2026   BOOKSHOP EXAMPLE   LONDON   -25,00 GBP   -29,63
 *   TOTAL CARD TRANSACTIONS   -213,44
 *   NEW BALANCE TOTAL   -213,44
 *   The amount of 213,44 EUR will be debited from the account … IBAN … on 07/10/2026.
 *
 * Amounts are from the card's point of view: purchases negative.
 * One statement can list several cards; each card is its own sub-account.
 */

const ROW = /^(\d{2}\/\d{2}\/\d{4})\s+(\d{2}\/\d{2}\/\d{4})\s+(.+?)\s+(-?[\d.]+,\d{2})$/;
const CARD = /OPERATIONS WITH CARD .*?NUMBER\s+([\d X*]{12,})/i;

export function isWorldlineStatement(lines: readonly string[]): boolean {
  const text = lines.join('\n');
  return /Worldline/i.test(text) && CARD.test(text);
}

export function parseWorldline(lines: readonly string[]): ParseResult {
  const result: ParseResult = { format: 'pdf-worldline', label: 'Worldline card', rows: [], skipped: [], statements: [], warnings: [] };
  let card: string | undefined;
  let statementDate: string | undefined;
  let opening: number | undefined;
  let closing: number | undefined;
  let settlement: StatementInfo['settlement'];
  const totals = new Map<string, number>();
  const cards: string[] = [];

  lines.forEach((raw, index) => {
    const line = raw.trim();
    if (!line) return;
    const sd = /Statement dated\s+(\d{2}\/\d{2}\/\d{4})/i.exec(line);
    if (sd) statementDate = parseBankDate(sd[1]!, 'dmy') ?? undefined;
    const c = CARD.exec(line);
    if (c) {
      card = c[1]!.replace(/\D/g, '').slice(-4);
      if (!cards.includes(card)) cards.push(card);
      return;
    }
    const prev = /^(?:PREVIOUS|OLD) BALANCE(?: TOTAL)?\s+(-?[\d.]+,\d{2})$/i.exec(line);
    if (prev) opening = parseAmount(prev[1]!, 'comma') ?? undefined;
    const nb = /^NEW BALANCE(?: TOTAL)?\s+(-?[\d.]+,\d{2})$/i.exec(line);
    if (nb) closing = parseAmount(nb[1]!, 'comma') ?? undefined;
    const tot = /^TOTAL CARD TRANSACTIONS\s+(-?[\d.]+,\d{2})$/i.exec(line);
    if (tot && card) totals.set(card, parseAmount(tot[1]!, 'comma') ?? 0);
    const debit = /amount of\s+([\d.]+,\d{2})\s*EUR will be debited from the account.*?on\s+(\d{2}\/\d{2}\/\d{4})/i.exec(line);
    if (debit) {
      const date = parseBankDate(debit[2]!, 'dmy');
      const amount = parseAmount(debit[1]!, 'comma');
      const from = ibanLast4(line);
      if (date && amount !== null) settlement = { amount, date, ...(from ? { fromLast4: from } : {}) };
    }
    const m = ROW.exec(line);
    if (!m) return;
    if (!card) {
      result.skipped.push({ line: index + 1, reason: 'unparseable', text: line });
      return;
    }
    const txDate = parseBankDate(m[1]!, 'dmy');
    const bookDate = parseBankDate(m[2]!, 'dmy');
    const amount = parseAmount(m[4]!, 'comma');
    if (!txDate || !bookDate || amount === null) {
      result.skipped.push({ line: index + 1, reason: 'unparseable', text: line });
      return;
    }
    // Middle part: "Description   Place   [-86,96 USD]"
    let middle = m[3]!;
    let originalCurrency: string | undefined;
    let originalAmount: number | undefined;
    const fx = /\s+(-?[\d.]+,\d{2})\s+([A-Z]{3})$/.exec(middle);
    if (fx) {
      originalAmount = parseAmount(fx[1]!, 'comma') ?? undefined;
      originalCurrency = fx[2]!;
      middle = middle.slice(0, fx.index);
    }
    const parts = middle.split(/\s{2,}/).map(squash).filter(Boolean);
    const description = parts[0] ?? middle;
    const place = parts.slice(1).join(' ');
    const row: ParsedRow = {
      line: index + 1,
      date: bookDate,
      ...(txDate !== bookDate ? { valueDate: txDate } : {}),
      amount,
      description: place ? `${description} · ${place}` : description,
      counterparty: description,
      accountKey: card,
      ...(originalCurrency && originalAmount !== undefined && originalCurrency !== 'EUR' ? { originalCurrency, originalAmount } : {}),
    };
    result.rows.push(row);
  });

  if (cards.length === 0) throw new ImportParseError('noRows');
  for (const key of cards) {
    const rows = result.rows.filter((r) => r.accountKey === key);
    const dates = rows.map((r) => r.date).sort();
    const single = cards.length === 1;
    const info: StatementInfo = {
      accountKey: key,
      last4: key,
      ...(dates[0] ? { periodStart: dates[0] } : {}),
      ...(statementDate ? { periodEnd: statementDate } : dates.length ? { periodEnd: dates.at(-1)! } : {}),
      // Balances and the settlement are per statement; with one card they belong to it.
      ...(single && closing !== undefined ? { closingBalance: closing } : {}),
      ...(single && opening !== undefined ? { openingBalance: opening } : {}),
      ...(single && settlement ? { settlement } : {}),
    };
    result.statements.push(info);
    const total = totals.get(key);
    const sum = rows.reduce((s, r) => s + r.amount, 0);
    if (total !== undefined && total !== sum) result.warnings.push(`totalMismatch:${key}`);
    if (single && closing !== undefined && (opening ?? 0) + sum !== closing) {
      result.warnings.push(`balanceMismatch:${key}`);
    }
  }
  return result;
}
