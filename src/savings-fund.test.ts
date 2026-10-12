import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { detectAndParse } from './domain/import/detect';
import { subAccounts } from './domain/import/plan';
import { fundDate, parseSavingsFund, SAVINGS_FUND_KEY } from './domain/import/savingsFund';
import type { Account } from './domain/types';

const text = readFileSync(join(process.cwd(), 'fixtures/import/flexible-savings-sample.csv'), 'utf8');

describe('flexible savings (money-market fund) export (D-61)', () => {
  it('reads US dates with a narrow no-break space', () => {
    expect(fundDate('Oct 12, 2026, 2:06:56 AM')).toBe('2026-10-12');
    expect(fundDate('Jan 2, 2026, 12:56:39 PM')).toBe('2026-01-02');
  });

  it('keeps purchases and sales, sums interest net of fees per month, drops reinvestments', () => {
    const r = parseSavingsFund(text);
    expect(r.format).toBe('csv-fund');
    expect(r.rows.map((x) => [x.date, x.amount, x.description])).toEqual([
      ['2026-03-03', 300000, 'Flexible savings: money in'],
      ['2026-03-20', -125050, 'Flexible savings: money out'],
      ['2026-03-31', 310, 'Flexible savings: interest, net of fees'], // 31 × (0,15 − 0,05)
      ['2026-04-28', -227, 'Flexible savings: returns withdrawn'],
      ['2026-04-30', 300, 'Flexible savings: interest, net of fees'],
    ]);
    // The reinvested return and its purchase cancel out.
    expect(r.skipped.filter((s) => s.reason === 'ignored')).toHaveLength(2);
    // May is incomplete: held back for the next export, with what it holds so far.
    expect(r.warnings).toEqual(['fundPartialMonth:2026-05:30', 'noBalances']);
    expect(r.statements).toEqual([{ accountKey: SAVINGS_FUND_KEY, periodStart: '2026-03-03', periodEnd: '2026-04-30' }]);
    expect(r.rows.every((x) => x.accountKey === SAVINGS_FUND_KEY)).toBe(true);
  });

  it('is detected by its header and offered to the account named like it', () => {
    const d = detectAndParse({ kind: 'text', name: 'export.csv', text }, [], () => {
      throw new Error('no xml');
    });
    expect(d.kind === 'parsed' && d.result.format).toBe('csv-fund');
    const base = { createdAt: '', updatedAt: '', source: 'manual' as const, institution: '', ibanLast4: '', openingBalance: 0 };
    const accounts: Account[] = [
      { ...base, id: 'cur', name: 'Revolut', type: 'current' },
      { ...base, id: 'flex', name: 'Compte flexible', type: 'savings' },
    ];
    expect(subAccounts(parseSavingsFund(text), accounts)).toEqual([{ key: SAVINGS_FUND_KEY, rows: 5, accountId: 'flex' }]);
  });
});
