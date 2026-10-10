// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { describe, expect, it } from 'vitest';
import { detectAndParse, type FileContent } from './domain/import/detect';
import { REVOLUT_MAPPING, guessColumns, readCsv, type MappingSpec } from './domain/import/csv';
import type { ParseResult } from './domain/import/types';
import { pdfToLines, type PdfJsLike } from './infra/pdf';

const dir = join(process.cwd(), 'fixtures/import');
const parseXml = (xml: string) => new DOMParser().parseFromString(xml, 'application/xml');

async function load(name: string): Promise<FileContent> {
  const bytes = readFileSync(join(dir, name));
  if (name.endsWith('.pdf')) return { kind: 'pdf', name, lines: await pdfToLines(pdfjs as unknown as PdfJsLike, new Uint8Array(bytes)) };
  return { kind: 'text', name, text: bytes.toString('utf8') };
}

const JANE_CARD: MappingSpec = {
  name: 'Jane card (FR)',
  headers: ['Date opération', 'Date valeur', 'Libellé', 'Débit', 'Crédit'],
  delimiter: ';',
  columns: { date: 'Date opération', valueDate: 'Date valeur', description: 'Libellé', debit: 'Débit', credit: 'Crédit' },
  dateFormat: 'dmy',
  decimal: 'comma',
  okStates: [],
};

async function parse(name: string, mappings: MappingSpec[] = [REVOLUT_MAPPING, JANE_CARD]): Promise<ParseResult> {
  const d = detectAndParse(await load(name), mappings, parseXml);
  if (d.kind !== 'parsed') throw new Error('not parsed');
  return d.result;
}

const sum = (r: ParseResult, key?: string) => r.rows.filter((x) => !key || x.accountKey === key).reduce((s, x) => s + x.amount, 0);

describe('Spuerkeess PDF statement', () => {
  it('reads every booking across pages and balances to the closing balance', async () => {
    const r = await parse('spuerkeess-joint-2026-09.pdf');
    expect(r.format).toBe('pdf-spuerkeess');
    expect(r.rows).toHaveLength(14);
    expect(r.skipped).toEqual([]);
    expect(r.warnings).toEqual([]);
    const s = r.statements[0]!;
    expect(s).toMatchObject({ last4: '1234', periodStart: '2026-09-01', periodEnd: '2026-09-30', openingBalance: 1250000 });
    expect(s.openingBalance! + sum(r)).toBe(s.closingBalance);
  });

  it('keeps counterparty, communication and IBAN last 4, and masks card numbers', async () => {
    const r = await parse('spuerkeess-joint-2026-09.pdf');
    const toJane = r.rows.find((x) => x.amount === -50000)!;
    expect(toJane).toMatchObject({ counterparty: 'JANE DOE', counterpartyIbanLast4: '9876', details: 'Savings', date: '2026-09-22' });
    const visa = r.rows.find((x) => x.amount === -61240)!;
    expect(visa.description).toBe('DIRECT DEBIT ••4321 CARTE VISA');
    const salary = r.rows.find((x) => x.amount === 340000)!;
    expect(salary).toMatchObject({ date: '2026-09-28', valueDate: '2026-09-26', details: 'SALAIRE SEPTEMBRE' });
    const cae = r.rows.find((x) => x.amount === 31504)!;
    expect(cae.details).toContain('PRESTATIONS FAMILIALES');
    expect(JSON.stringify(r.rows)).not.toMatch(/LU28 0019|4999000000004321/);
  });
});

describe('Worldline Visa PDF statement', () => {
  it('reads card lines, foreign amounts, total and settlement', async () => {
    const r = await parse('visa-john-2026-09.pdf');
    expect(r.format).toBe('pdf-worldline');
    expect(r.rows).toHaveLength(5);
    expect(r.warnings).toEqual([]);
    expect(sum(r)).toBe(-21344);
    expect(r.statements[0]).toMatchObject({ accountKey: '4321', last4: '4321', periodEnd: '2026-09-29', closingBalance: -21344, settlement: { amount: 21344, date: '2026-10-07', fromLast4: '1234' } });
    const gbp = r.rows.find((x) => x.originalCurrency === 'GBP')!;
    expect(gbp).toMatchObject({ amount: -2963, originalAmount: -2500, date: '2026-09-21', valueDate: '2026-09-20' });
  });
});

describe('Revolut CSV', () => {
  it('maps products to sub-accounts, nets fees, skips reverted and pending rows', async () => {
    const r = await parse('revolut-john-2026-09.csv');
    expect(r.label).toBe('Revolut');
    expect(r.skipped.map((s) => s.reason).sort()).toEqual(['pending', 'reverted']);
    expect(r.warnings).toEqual([]);
    const current = r.statements.find((s) => s.accountKey === 'Current')!;
    expect(current.openingBalance).toBe(41250);
    expect(current.openingBalance! + sum(r, 'Current')).toBe(current.closingBalance);
    expect(r.rows.find((x) => x.description === 'Online shop')!.amount).toBe(-17162);
    expect(r.rows.filter((x) => x.accountKey === 'Deposit')).toHaveLength(1);
    expect(r.rows.find((x) => x.description.startsWith('Payment from'))!.counterparty).toBe('DOE JANE+JOHN');
  });

  it('rejects a changed layout instead of guessing', () => {
    expect(() => detectAndParse({ kind: 'text', name: 'x.csv', text: 'Type,Product,Started Date,Description,Amount\n' }, [{ ...REVOLUT_MAPPING }], parseXml)).not.toThrow();
    const d = detectAndParse({ kind: 'text', name: 'x.csv', text: 'Type,Product,Started Date,Description,Amount\nA,B,2026-01-01,x,1.00\n' }, [REVOLUT_MAPPING], parseXml);
    expect(d.kind).toBe('needsMapping');
  });
});

describe('second CSV layout (French headers, debit/credit columns)', () => {
  it('guesses the columns and parses with a saved mapping', async () => {
    const file = await load('card-jane-2026-09.csv');
    const header = readCsv((file as { text: string }).text)[0]!;
    expect(guessColumns(header)).toMatchObject({ date: 'Date opération', valueDate: 'Date valeur', description: 'Libellé', debit: 'Débit', credit: 'Crédit' });
    const r = await parse('card-jane-2026-09.csv');
    expect(r.rows).toHaveLength(6);
    expect(r.rows.find((x) => x.description.startsWith('CACTUS'))!.amount).toBe(-106432);
    expect(r.rows.find((x) => x.description.startsWith('PAIEMENT'))!.amount).toBe(14320);
  });

  it('asks for a mapping when none is saved', async () => {
    const d = detectAndParse(await load('card-jane-2026-09.csv'), [REVOLUT_MAPPING], parseXml);
    expect(d.kind).toBe('needsMapping');
  });
});

describe('CAMT.053', () => {
  it('reads balances, booked entries and counterparties; skips pending', async () => {
    const r = await parse('camt053-jane-savings-2026-09.xml');
    expect(r.format).toBe('camt053');
    expect(r.rows).toHaveLength(3);
    expect(r.skipped.map((s) => s.reason)).toEqual(['pending']);
    expect(r.warnings).toEqual([]);
    expect(r.statements[0]).toMatchObject({ last4: '9876', openingBalance: 800000, closingBalance: 847812, periodStart: '2026-09-01', periodEnd: '2026-09-30' });
    expect(r.rows[0]).toMatchObject({ amount: 50000, counterparty: 'DOE JANE+JOHN', counterpartyIbanLast4: '1234', details: 'Savings' });
  });
});
