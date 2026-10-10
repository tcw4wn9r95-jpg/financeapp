import Papa from 'papaparse';
import type { BankMapping } from '../types';
import { ImportParseError, type ParseResult, type ParsedRow, type SkipReason, type StatementInfo } from './types';
import { parseAmount, parseBankDate, squash } from './text';

/**
 * CSV import through a saved column mapping (PRD F5). The mapping names the
 * columns; the header row is checked on every import so a changed bank
 * layout fails loudly instead of importing garbage.
 */

export type MappingSpec = Pick<BankMapping, 'name' | 'headers' | 'delimiter' | 'columns' | 'dateFormat' | 'decimal' | 'okStates'>;

/** Revolut account statement export (English), as of 2026. */
export const REVOLUT_MAPPING: MappingSpec = {
  name: 'Revolut',
  headers: ['Type', 'Product', 'Started Date', 'Completed Date', 'Description', 'Amount', 'Fee', 'Currency', 'State', 'Balance'],
  delimiter: ',',
  columns: {
    date: 'Completed Date',
    valueDate: 'Started Date',
    description: 'Description',
    amount: 'Amount',
    fee: 'Fee',
    currency: 'Currency',
    state: 'State',
    balance: 'Balance',
    accountKey: 'Product',
  },
  dateFormat: 'ymd',
  decimal: 'dot',
  okStates: ['COMPLETED'],
};

export const BUILT_IN_MAPPINGS: readonly MappingSpec[] = [REVOLUT_MAPPING];

export function readCsv(text: string, delimiter = ''): string[][] {
  const res = Papa.parse<string[]>(text.replace(/^﻿/, ''), { delimiter, skipEmptyLines: 'greedy' });
  return res.data.map((r) => r.map((c) => (c ?? '').trim()));
}

const norm = (h: string) => h.trim().toLowerCase();

/** Headers the mapping expects but the file lacks (empty = layout matches). */
export function missingHeaders(header: readonly string[], spec: Pick<MappingSpec, 'headers'>): string[] {
  const have = new Set(header.map(norm));
  return spec.headers.filter((h) => !have.has(norm(h)));
}

/** First mapping whose headers all appear in the file. */
export function findMapping<T extends Pick<MappingSpec, 'headers'>>(header: readonly string[], mappings: readonly T[]): T | undefined {
  return mappings.find((m) => m.headers.length > 0 && missingHeaders(header, m).length === 0);
}

/** Guess a mapping for an unknown layout from common header names (EN/FR/DE). */
export function guessColumns(header: readonly string[]): Partial<MappingSpec['columns']> {
  const find = (...res: RegExp[]) => header.find((h) => res.some((re) => re.test(h.trim())));
  const out: Partial<MappingSpec['columns']> = {};
  const set = (k: keyof MappingSpec['columns'], v: string | undefined) => {
    if (v) out[k] = v;
  };
  set('date', find(/^(booking |transaction |operation )?date$/i, /^date (d'|de l')?(op[ée]ration|comptable|transaction)/i, /^buchungs?(tag|datum)/i, /^datum$/i, /^completed date$/i));
  set('valueDate', find(/^value date$/i, /^date (de )?valeur$/i, /^valuta/i));
  set('description', find(/^description$/i, /^libell[ée]/i, /^communication$/i, /^details?$/i, /^verwendungszweck/i, /^narrative$/i));
  set('amount', find(/^amount( in eur)?$/i, /^montant/i, /^betrag/i));
  set('debit', find(/^debit$/i, /^d[ée]bit$/i, /^soll$/i, /^withdrawals?$/i));
  set('credit', find(/^credit$/i, /^cr[ée]dit$/i, /^haben$/i, /^deposits?$/i));
  set('balance', find(/^balance$/i, /^solde$/i, /^saldo$/i));
  set('currency', find(/^currency$/i, /^devise$/i, /^w[äa]hrung$/i));
  set('counterparty', find(/^(counterparty|payee|beneficiary|b[ée]n[ée]ficiaire|empf[äa]nger)$/i));
  return out;
}

function stateReason(state: string): SkipReason {
  const s = state.toUpperCase();
  if (s.includes('REVERT')) return 'reverted';
  if (s.includes('PENDING')) return 'pending';
  if (s.includes('DECLIN') || s.includes('FAIL')) return 'declined';
  return 'state';
}

export function parseCsv(text: string, spec: MappingSpec): ParseResult {
  const table = readCsv(text, spec.delimiter);
  const headerIndex = table.findIndex((r) => r.some((c) => c !== ''));
  if (headerIndex < 0) throw new ImportParseError('noRows');
  const header = table[headerIndex]!;
  const missing = missingHeaders(header, spec);
  if (missing.length) throw new ImportParseError('headersChanged', missing.join(', '));
  const col = new Map(header.map((h, i) => [norm(h), i]));
  const get = (row: string[], name?: string) => (name ? row[col.get(norm(name)) ?? -1] ?? '' : '');
  const has = (name?: string) => !!name && col.has(norm(name));
  for (const k of ['date', 'description'] as const) if (!has(spec.columns[k])) throw new ImportParseError('missingColumn', k);
  if (!has(spec.columns.amount) && !has(spec.columns.debit) && !has(spec.columns.credit)) throw new ImportParseError('missingColumn', 'amount');

  const result: ParseResult = { format: 'csv', label: spec.name, rows: [], skipped: [], statements: [], warnings: [] };
  table.slice(headerIndex + 1).forEach((row, i) => {
    const line = headerIndex + i + 2;
    const text = row.join(spec.delimiter || ',');
    const skip = (reason: SkipReason) => result.skipped.push({ line, reason, text });
    const c = spec.columns;
    if (c.state && spec.okStates.length) {
      const state = get(row, c.state);
      if (!spec.okStates.some((s) => norm(s) === norm(state))) return skip(stateReason(state));
    }
    const currency = get(row, c.currency);
    if (currency && currency.toUpperCase() !== 'EUR') return skip('currency');
    const date = parseBankDate(get(row, c.date), spec.dateFormat);
    if (!date) return skip('unparseable');
    let amount: number | null;
    if (has(c.amount)) amount = parseAmount(get(row, c.amount), spec.decimal);
    else {
      const debit = get(row, c.debit) ? parseAmount(get(row, c.debit), spec.decimal) : 0;
      const credit = get(row, c.credit) ? parseAmount(get(row, c.credit), spec.decimal) : 0;
      amount = debit === null || credit === null ? null : Math.abs(credit) - Math.abs(debit);
    }
    if (amount === null) return skip('unparseable');
    const fee = get(row, c.fee) ? parseAmount(get(row, c.fee), spec.decimal) : 0;
    if (fee === null) return skip('unparseable');
    amount -= Math.abs(fee);
    if (amount === 0) return skip('zero');
    const description = squash(get(row, c.description));
    const valueDate = c.valueDate ? parseBankDate(get(row, c.valueDate), spec.dateFormat) : null;
    const balance = get(row, c.balance) ? parseAmount(get(row, c.balance), spec.decimal) : null;
    const party = get(row, c.counterparty) || /^(?:Payment from|Transfer (?:to|from)|To|From)\s+(.+)$/i.exec(description)?.[1] || '';
    const parsed: ParsedRow = {
      line,
      date,
      ...(valueDate && valueDate !== date ? { valueDate } : {}),
      amount,
      description,
      ...(party ? { counterparty: squash(party) } : {}),
      accountKey: get(row, c.accountKey) || 'main',
      ...(balance !== null ? { balanceAfter: balance } : {}),
    };
    result.rows.push(parsed);
  });

  // Running balances give each sub-account an opening and closing balance.
  for (const key of [...new Set(result.rows.map((r) => r.accountKey))]) {
    const rows = result.rows.filter((r) => r.accountKey === key);
    const dates = rows.map((r) => r.date).sort();
    const info: StatementInfo = { accountKey: key, periodStart: dates[0]!, periodEnd: dates.at(-1)! };
    if (rows.every((r) => r.balanceAfter !== undefined)) {
      info.openingBalance = rows[0]!.balanceAfter! - rows[0]!.amount;
      info.closingBalance = rows.at(-1)!.balanceAfter!;
      for (let i = 1; i < rows.length; i++) {
        if (rows[i - 1]!.balanceAfter! + rows[i]!.amount !== rows[i]!.balanceAfter!) {
          result.warnings.push(`balanceGap:${key}:${rows[i]!.line}`);
          break;
        }
      }
    }
    result.statements.push(info);
  }
  if (result.rows.length === 0 && result.skipped.length === 0) throw new ImportParseError('noRows');
  return result;
}
