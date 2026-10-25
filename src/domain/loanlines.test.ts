import { describe, expect, it } from 'vitest';
import { payeeKey, suggestLoanLines } from './loanlines';
import type { Account, Allocation, Transaction } from './types';

/** A loan paid every month but filed elsewhere (D-101), on made-up data. */

const stamp = { createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', source: 'manual' };
const acc = (id: string, type: Account['type'], openingBalance: number, extra: Partial<Account> = {}) => ({ ...stamp, id, name: id, type, openingBalance, ...extra }) as unknown as Account;
const tx = (id: string, accountId: string, date: string, amount: number, descriptionRaw: string) => ({ ...stamp, id, accountId, date, amount, descriptionRaw, status: 'reconciled' }) as unknown as Transaction;
const al = (id: string, transactionId: string, targetType: Allocation['targetType'], targetId: string, amount: number) => ({ ...stamp, id, transactionId, targetType, targetId, amount, reason: '', decidedBy: 'user' }) as unknown as Allocation;

describe('loans without a budget line', () => {
  const accounts = [acc('bank', 'current', 100_000), acc('Sofa loan', 'loan', -30_000, { openingDate: '2026-01-01' }), acc('Mortgage', 'loan', -1_000_000, { categoryId: 'mort' })];
  const transactions = [
    ...[1, 2, 3].map((m) => tx(`p${m}`, 'bank', `2026-0${m}-07`, -10_000, `DIRECT DEBIT SHOPCREDIT SA 07/0${m}/26`)),
    tx('other', 'bank', '2026-02-10', -10_000, 'CARD PAYMENT GROCER 10/02'),
    tx('side3', 'Sofa loan', '2026-03-07', 10_000, 'Transfer from bank'),
  ];
  const allocations = [al('a1', 'p1', 'category', 'home', -10_000), al('a2', 'p2', 'category', 'home', -10_000), al('a3', 'p3', 'category', 'home', -10_000), al('a4', 'other', 'category', 'food', -10_000), al('a5', 'side3', 'transfer', 'p3', 10_000)];

  it('reads the bank text without its dates and numbers', () => {
    expect(payeeKey('DIRECT DEBIT SHOPCREDIT SA 07/03/26')).toBe('direct debit shopcredit sa');
  });
  it('finds every payment like the one known to have paid the loan, wherever it was filed', () => {
    const [s, ...rest] = suggestLoanLines({ accounts, transactions, allocations });
    expect(rest).toHaveLength(0);
    expect(s).toMatchObject({ loanId: 'Sofa loan', amount: 10_000, rows: ['p1', 'p2', 'p3'], filedTo: { home: 3 }, firstMonth: '2026-01', lastMonth: '2026-03' });
  });
  it('leaves loans that already have a line, or with no known payment', () => {
    const none = suggestLoanLines({ accounts, transactions: transactions.filter((t) => t.id !== 'side3'), allocations: allocations.filter((a) => a.id !== 'a5') });
    expect(none).toEqual([]);
  });
});
