import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { Vault } from '../storage/vault';
import { deleteAllTransactions, loadDemo, saveAccount } from './actions';

async function vault() {
  const v = new Vault({ dbName: `clear-${Math.random()}`, iterations: 1000 });
  await v.init();
  await v.create('correct horse battery');
  return v;
}

describe('delete all transactions (D-62)', () => {
  it('removes transactions and imports, keeps the budget, provisions, trips and rules', async () => {
    const v = await vault();
    await loadDemo(v);
    const kept = ['accounts', 'categories', 'budgetDefaults', 'budgetOverrides', 'provisions', 'events', 'rules', 'trainingExamples', 'settings'] as const;
    const before = Object.fromEntries(kept.map((s) => [s, v.list(s).length]));
    const n = v.list('transactions').length;
    expect(n).toBeGreaterThan(0);

    expect(await deleteAllTransactions(v)).toBe(n);
    for (const s of ['transactions', 'allocations', 'statements', 'importBatches'] as const) expect(v.list(s)).toHaveLength(0);
    expect(Object.fromEntries(kept.map((s) => [s, v.list(s).length]))).toEqual(before);
  });

  it('resets opening balances taken from a statement, keeps typed ones, and can forget learning', async () => {
    const v = await vault();
    const typed = await saveAccount(v, { name: 'Joint', type: 'current', institution: '', ibanLast4: '', openingBalance: 500000 });
    const fromStatement = await saveAccount(v, { name: 'Savings', type: 'savings', institution: '', ibanLast4: '', openingBalance: 120000 });
    await v.put('accounts', { ...v.get('accounts', fromStatement)!, openingFromStatement: true });
    await v.put('trainingExamples', { id: 'x1', createdAt: '', updatedAt: '', source: 'manual' } as never);

    await deleteAllTransactions(v, { forgetLearning: true });
    expect(v.get('accounts', typed)!.openingBalance).toBe(500000);
    expect(v.get('accounts', fromStatement)).toMatchObject({ openingBalance: 0 });
    expect(v.get('accounts', fromStatement)!.openingFromStatement).toBeUndefined();
    expect(v.list('trainingExamples')).toHaveLength(0);
  });
});
