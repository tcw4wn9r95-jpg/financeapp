import { describe, expect, it } from 'vitest';
import { buildManualEntry, LedgerError, normaliseMerchant, splitRemainder, transferCounterpartId } from './ledger';
import { testClock } from './testkit';

describe('buildManualEntry', () => {
  it('creates one reconciled transaction with a category allocation', () => {
    const w = buildManualEntry(
      { accountId: 'bank', date: '2026-10-03', amount: -4523, description: 'CACTUS BERELDANGE 03/10', target: { kind: 'category', categoryId: 'groceries' } },
      testClock(),
    );
    expect(w.transactions).toHaveLength(1);
    expect(w.transactions[0]).toMatchObject({ amount: -4523, status: 'reconciled', merchantNorm: 'CACTUS BERELDANGE', source: 'manual' });
    expect(w.allocations).toEqual([
      expect.objectContaining({ transactionId: w.transactions[0]!.id, targetType: 'category', targetId: 'groceries', amount: -4523, decidedBy: 'user', confidence: 1 }),
    ]);
  });

  it('creates a paired transfer with opposite amounts', () => {
    const w = buildManualEntry({ accountId: 'bank', date: '2026-10-05', amount: -184217, description: 'Card settlement', target: { kind: 'transfer', toAccountId: 'card' } }, testClock());
    const [a, b] = w.transactions;
    expect(a!.amount).toBe(-184217);
    expect(b!.amount).toBe(184217);
    expect(b!.accountId).toBe('card');
    expect(transferCounterpartId(w.allocations, a!.id)).toBe(b!.id);
    expect(transferCounterpartId(w.allocations, b!.id)).toBe(a!.id);
  });

  it('keeps original currency and amount for foreign transactions', () => {
    const w = buildManualEntry(
      { accountId: 'card', date: '2026-08-12', amount: -5890, originalCurrency: 'GBP', originalAmount: -5020, description: 'PRET A MANGER LONDON', target: { kind: 'category', categoryId: 'trip' } },
      testClock(),
    );
    expect(w.transactions[0]).toMatchObject({ amount: -5890, originalCurrency: 'GBP', originalAmount: -5020 });
  });

  it('leaves an unclassified entry as new with no allocation', () => {
    const w = buildManualEntry({ accountId: 'bank', date: '2026-10-03', amount: -100, description: 'x', target: { kind: 'none' } }, testClock());
    expect(w.transactions[0]!.status).toBe('new');
    expect(w.allocations).toEqual([]);
  });

  it.each([
    [{ amount: 0 }, 'zeroAmount'],
    [{ date: '31/02/2026' }, 'invalidDate'],
    [{ target: { kind: 'transfer', toAccountId: 'bank' } }, 'transferSameAccount'],
    [{ originalCurrency: 'USD' }, 'foreignIncomplete'],
  ] as const)('rejects %j', (patch, code) => {
    const entry = { accountId: 'bank', date: '2026-10-03', amount: -100, description: 'x', target: { kind: 'none' as const }, ...patch };
    expect(() => buildManualEntry(entry as never, testClock())).toThrow(new LedgerError(code));
  });

  it('refuses float amounts', () => {
    expect(() => buildManualEntry({ accountId: 'b', date: '2026-10-03', amount: -1.5, description: '', target: { kind: 'none' } }, testClock())).toThrow();
  });
});

describe('normaliseMerchant', () => {
  it.each([
    ['CACTUS BERELDANGE 03/10', 'CACTUS BERELDANGE'],
    ['VISA 4974 XXXX XXXX 1234 DELHAIZE LU', 'VISA DELHAIZE LU'],
    ['Payconiq*Boulangerie Fischer TERM 00451', 'PAYCONIQ BOULANGERIE FISCHER'],
    ['  amazon.de   Mktp  ', 'AMAZON DE MKTP'],
  ])('%s → %s', (raw, norm) => {
    expect(normaliseMerchant(raw)).toBe(norm);
  });
});

describe('splitRemainder', () => {
  it('is zero when splits sum to the amount', () => {
    expect(splitRemainder({ amount: -10000 }, [{ amount: -6000 }, { amount: -4000 }])).toBe(0);
    expect(splitRemainder({ amount: -10000 }, [{ amount: -6000 }])).toBe(-4000);
  });
});
