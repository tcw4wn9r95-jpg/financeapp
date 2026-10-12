import type { Cents, IsoDate } from '../types';
import type { ParseResult, ParsedRow, SkippedRow } from './types';
import { readCsv } from './csv';

/**
 * A neobank "flexible savings" (money-market fund) export (D-61):
 *
 *   Date,Description,"Value, EUR",Price per share,Quantity of shares
 *   "Oct 7, 2026, 12:27:40 PM",SELL EUR Class R IE000…,"-1,300",1.00,"1,300"
 *
 * - BUY: money moved in from the current account → a transfer in.
 * - SELL: money moved out to the current account → a transfer out.
 * - Return PAID (daily interest) and Service Fee (daily fee): added up into
 *   one "net return" row per month, instead of hundreds of tiny rows.
 * - Return Reinvested (−x) with the BUY of the same amount a few days later:
 *   returns turned into fund shares. They cancel out and are skipped.
 * - Return WITHDRAWN: returns paid out to the current account → a transfer out.
 *
 * The file has no balances: the account's balance is set once by the user.
 * Amounts use a dot for decimals and commas for thousands, with up to 4
 * decimals; they are summed in ten-thousandths and rounded once.
 */

export const SAVINGS_FUND_KEY = 'Flexible savings';

const HEADER = ['date', 'description', 'value, eur', 'price per share', 'quantity of shares'];

export function isSavingsFundCsv(header: readonly string[]): boolean {
  const h = header.map((x) => x.trim().toLowerCase());
  return HEADER.every((x, i) => h[i] === x);
}

const MONTHS: Record<string, string> = { jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06', jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12' };

/** "Oct 12, 2026, 2:06:56 AM" (with a narrow no-break space before AM) → "2026-10-12". */
export function fundDate(raw: string): IsoDate | null {
  const m = /^([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2}),\s*(\d{4})/.exec(raw.replace(/[  ]/g, ' ').trim());
  const mo = m ? MONTHS[m[1]!.toLowerCase()] : undefined;
  return m && mo ? `${m[3]}-${mo}-${m[2]!.padStart(2, '0')}` : null;
}

/** "-6,454.98" → -64549800 (ten-thousandths of a euro). */
function tenThousandths(raw: string): number | null {
  const v = raw.replace(/[\s,]/g, '');
  if (!/^-?\d+(\.\d+)?$/.test(v)) return null;
  const [int, dec = ''] = v.replace('-', '').split('.');
  const n = Number(int) * 10000 + Number((dec + '0000').slice(0, 4));
  return v.startsWith('-') ? -n : n;
}

const toCents = (tt: number): Cents => Math.round(tt / 100);

export function parseSavingsFund(text: string): ParseResult {
  const table = readCsv(text);
  const result: ParseResult = { format: 'csv-fund', label: 'Flexible savings', rows: [], skipped: [], statements: [], warnings: [] };
  type Entry = { line: number; date: IsoDate; kind: string; value: number; raw: string };
  const entries: Entry[] = [];
  table.slice(1).forEach((cells, i) => {
    if (cells.every((c) => c.trim() === '')) return;
    const line = i + 2;
    const raw = cells.join(',').slice(0, 160);
    const date = fundDate(cells[0] ?? '');
    const value = tenThousandths(cells[2] ?? '');
    const desc = (cells[1] ?? '').trim();
    if (!date || value === null) {
      result.skipped.push({ line, reason: 'unparseable', text: raw });
      return;
    }
    const kind = /^buy\b/i.test(desc) ? 'buy'
      : /^sell\b/i.test(desc) ? 'sell'
      : /^return paid/i.test(desc) ? 'return'
      : /^service fee/i.test(desc) ? 'fee'
      : /^return reinvested/i.test(desc) ? 'reinvested'
      : /^return withdrawn/i.test(desc) ? 'withdrawn'
      : 'other';
    entries.push({ line, date, kind, value, raw });
  });

  // Reinvestments: each "Return Reinvested −x" cancels the BUY of x within a week after it.
  const cancelled = new Set<Entry>();
  for (const r of entries.filter((e) => e.kind === 'reinvested')) {
    const buy = entries
      .filter((e) => e.kind === 'buy' && !cancelled.has(e) && e.value === -r.value && e.date >= r.date && daysBetween(r.date, e.date) <= 7)
      .sort((a, b) => a.date.localeCompare(b.date))[0];
    cancelled.add(r);
    if (buy) cancelled.add(buy);
    else result.warnings.push(`fundReinvestUnmatched:${r.line}`);
  }
  const skippedRows: SkippedRow[] = [];
  for (const e of cancelled) skippedRows.push({ line: e.line, reason: 'ignored', text: `${e.date} reinvested return ${toCents(Math.abs(e.value)) / 100}` });

  const rows: ParsedRow[] = [];
  const monthly = new Map<string, { returns: number; fees: number; line: number; first: IsoDate; last: IsoDate }>();
  for (const e of entries) {
    if (cancelled.has(e)) continue;
    if (e.kind === 'return' || e.kind === 'fee') {
      const m = e.date.slice(0, 7);
      const b = monthly.get(m) ?? { returns: 0, fees: 0, line: e.line, first: e.date, last: e.date };
      if (e.kind === 'return') b.returns += e.value;
      else b.fees += e.value;
      if (e.date > b.last) b.last = e.date;
      if (e.date < b.first) b.first = e.date;
      monthly.set(m, b);
      continue;
    }
    if (e.kind === 'other') {
      result.skipped.push({ line: e.line, reason: 'state', text: e.raw });
      continue;
    }
    const amount = toCents(e.value);
    if (amount === 0) {
      result.skipped.push({ line: e.line, reason: 'zero', text: e.raw });
      continue;
    }
    const description =
      e.kind === 'buy' ? 'Flexible savings: money in'
      : e.kind === 'sell' ? 'Flexible savings: money out'
      : 'Flexible savings: returns withdrawn';
    rows.push({ line: e.line, date: e.date, amount, description, accountKey: SAVINGS_FUND_KEY });
  }
  // Interest is credited daily: a month at either end of the file without its first or last
  // days is incomplete. It is left for the next export, so re-importing never counts it twice.
  const months = [...monthly.keys()].sort();
  for (const [m, b] of monthly) {
    const lastDay = new Date(Date.UTC(Number(m.slice(0, 4)), Number(m.slice(5, 7)), 0)).getUTCDate();
    const partialEnd = m === months.at(-1) && Number(b.last.slice(8)) < lastDay;
    const partialStart = m === months[0] && Number(b.first.slice(8)) > 2;
    if (partialEnd || partialStart) {
      result.warnings.push(`fundPartialMonth:${m}:${toCents(b.returns + b.fees)}`);
      continue;
    }
    const amount = toCents(b.returns + b.fees);
    if (amount === 0) continue;
    rows.push({
      line: b.line,
      date: b.last,
      amount,
      description: 'Flexible savings: interest, net of fees',
      details: `${m}: returns ${(toCents(b.returns) / 100).toFixed(2)}, fees ${(toCents(b.fees) / 100).toFixed(2)}`,
      accountKey: SAVINGS_FUND_KEY,
    });
  }
  rows.sort((a, b) => a.date.localeCompare(b.date) || a.line - b.line);
  result.rows = rows;
  result.skipped.push(...skippedRows);
  if (rows.length === 0) return result;
  result.statements.push({ accountKey: SAVINGS_FUND_KEY, periodStart: rows[0]!.date, periodEnd: rows.at(-1)!.date });
  result.warnings.push('noBalances');
  return result;
}

function daysBetween(a: IsoDate, b: IsoDate): number {
  return Math.abs(Date.parse(b) - Date.parse(a)) / 86_400_000;
}
