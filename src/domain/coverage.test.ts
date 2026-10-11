import { describe, expect, it } from 'vitest';
import { coverage } from './coverage';
import type { Account, Statement, Transaction } from './types';

const base = { createdAt: '', updatedAt: '', source: 'manual' as const };
const acct = (id: string, type: Account['type'] = 'current'): Account => ({ ...base, id, name: id, type, institution: '', ibanLast4: '', openingBalance: 0 });
const st = (accountId: string, periodStart: string, periodEnd: string): Statement => ({ ...base, id: `${accountId}${periodStart}`, accountId, periodStart, periodEnd }) as Statement;
const tx = (accountId: string, date: string, extra: Partial<Transaction> = {}): Transaction =>
  ({ ...base, id: `${accountId}${date}`, accountId, date, amount: -100, descriptionRaw: '', merchantNorm: '', counterparty: '', status: 'new', importBatchId: 'b', ...extra }) as Transaction;

describe('backfill coverage (D-45)', () => {
  it('marks months covered by a statement, by imported rows only, or missing', () => {
    const c = coverage(
      [acct('joint'), acct('loan', 'loan'), acct('rev')],
      [st('joint', '2026-01-01', '2026-01-31'), st('joint', '2026-02-15', '2026-03-14')],
      [tx('rev', '2026-02-10'), tx('rev', '2026-03-03', { isMirror: true }), tx('rev', '2026-01-05', { importBatchId: undefined })],
      '2026-01',
      '2026-04',
    );
    expect(c.map((a) => a.accountId)).toEqual(['joint', 'rev']);
    expect(c[0]!.months.map((m) => m.status)).toEqual(['statement', 'statement', 'statement', 'none']);
    expect(c[1]!.months.map((m) => m.status)).toEqual(['none', 'rows', 'none', 'none']);
    expect(c.map((a) => a.missing)).toEqual([1, 3]);
  });
});
