import { describe, expect, it } from 'vitest';
import demo from '../fixtures/demo-household.json';
import { accountBalances, budgetForMonth, computeBudget, type BudgetInput } from './domain/budget';
import { DEMO_ANCHOR_MONTH, shiftSnapshotMonths } from './domain/demo';
import type { StoreSnapshot } from './domain/types';
import { readPlainExport } from './storage/backup';

async function load(): Promise<StoreSnapshot> {
  return (await readPlainExport(demo)).stores;
}

function input(s: StoreSnapshot): BudgetInput {
  const settings = s.settings[0]!;
  return {
    startMonth: settings.budgetStartMonth,
    categories: s.categories,
    defaults: s.budgetDefaults,
    overrides: s.budgetOverrides,
    accounts: s.accounts,
    transactions: s.transactions,
    allocations: s.allocations,
    ...(settings.sweepTargetCategoryId ? { sweepTargetCategoryId: settings.sweepTargetCategoryId } : {}),
  };
}

describe('demo household fixture', () => {
  it('has a valid hash and six full months of transactions', async () => {
    const s = await load();
    const months = new Set(s.transactions.map((t) => t.date.slice(0, 7)));
    for (const m of ['2026-04', '2026-05', '2026-06', '2026-07', '2026-08', '2026-09']) expect(months.has(m)).toBe(true);
    expect(s.categories.filter((c) => !c.isIncome).length).toBeGreaterThanOrEqual(12);
    // Every amount is integer cents and every allocation set sums to its transaction.
    for (const t of s.transactions) {
      expect(Number.isSafeInteger(t.amount)).toBe(true);
      const allocs = s.allocations.filter((a) => a.transactionId === t.id);
      if (allocs.length) expect(allocs.reduce((x, a) => x + a.amount, 0)).toBe(t.amount);
    }
  });

  it('M1 gate: categorising the one open October item brings Ready to assign to exactly 0.00', async () => {
    const s = await load();
    expect(budgetForMonth(input(s), DEMO_ANCHOR_MONTH)!.readyToAssign).toBe(-2499);
    const open = s.transactions.filter((t) => t.status === 'new');
    expect(open).toHaveLength(1);
    const fun = s.categories.find((c) => c.name === 'Fun money')!;
    s.allocations.push({
      ...open[0]!, id: 'x', transactionId: open[0]!.id, targetType: 'category', targetId: fun.id,
      amount: open[0]!.amount, confidence: 1, decidedBy: 'user', reason: 'test',
    } as never);
    expect(budgetForMonth(input(s), DEMO_ANCHOR_MONTH)!.readyToAssign).toBe(0);
  });

  it('card spending is counted once; settlements are transfers', async () => {
    const s = await load();
    const card = s.accounts.find((a) => a.type === 'card')!;
    const balances = accountBalances(s.accounts, s.transactions, '2026-09-30');
    // September's card bill is settled on 5 October, so the card owes September's spending.
    const septCard = s.transactions.filter((t) => t.accountId === card.id && t.date.startsWith('2026-09') && t.amount < 0);
    expect(balances.get(card.id)).toBe(septCard.reduce((x, t) => x + t.amount, 0));
  });

  it('shifts to the current month when loaded later', async () => {
    const s = shiftSnapshotMonths(await load(), 3);
    expect(s.settings[0]!.budgetStartMonth).toBe('2026-07');
    expect(s.budgetOverrides.some((o) => o.month === '2027-03' && o.amount === 90000)).toBe(true);
    const months = computeBudget(input(s), '2027-01');
    expect(months.at(-1)!.readyToAssign).toBe(-2499);
    // 31 August shifted by 3 months clamps to 30 November.
    expect(shiftSnapshotMonths({ ...(await load()), transactions: [{ ...s.transactions[0]!, date: '2026-08-31' }] }, 3).transactions[0]!.date).toBe('2026-11-30');
  });
});
