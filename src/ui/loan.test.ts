import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { budgetForMonth } from '../domain/budget';
import { systemClock } from '../domain/ledger';
import { acceptSuggestion } from '../domain/reconcile';
import type { Transaction } from '../domain/types';
import { Vault } from '../storage/vault';
import { applyChanges, ledgerView } from './importActions';
import { categoryInUse, saveAccount, saveCategory, saveMonthPlan, saveSettings } from './actions';

async function vault() {
  const v = new Vault({ dbName: `loan-${Math.random()}`, iterations: 1000 });
  await v.init();
  await v.create('correct horse battery');
  await saveSettings(v, { budgetStartMonth: '2026-01' });
  return v;
}

const input = (v: Vault) => ({
  startMonth: '2026-01',
  categories: v.list('categories'),
  defaults: v.list('budgetDefaults'),
  overrides: v.list('budgetOverrides'),
  accounts: v.list('accounts'),
  transactions: v.list('transactions'),
  allocations: v.list('allocations'),
});

describe('loan with a monthly payment (D-48)', () => {
  it('keeps a Fixed category budgeted at the instalment from the loan start to the last payment', async () => {
    const v = await vault();
    const id = await saveAccount(v, { name: 'Car loan', type: 'loan', institution: '', ibanLast4: '', openingBalance: -1800000, openingDate: '2026-03-15', monthlyPayment: 35000, lastPaymentMonth: '2027-02' });
    const loan = v.get('accounts', id)!;
    const cat = v.get('categories', loan.categoryId!)!;
    expect(cat).toMatchObject({ name: 'Car loan', groupId: 'fixed', rolloverMode: 'reset' });
    const assigned = (m: string) => budgetForMonth(input(v), m)!.categories.get(cat.id)!.assigned;
    expect([assigned('2026-02'), assigned('2026-03'), assigned('2027-02'), assigned('2027-03')]).toEqual([0, 35000, 35000, 0]);
    expect(categoryInUse(v, cat.id)).toBe(true);

    // Renaming the loan renames the category; extending the end moves the stop.
    await saveAccount(v, { name: 'Golf loan', type: 'loan', institution: '', ibanLast4: '', openingBalance: -1800000, openingDate: '2026-03-15', monthlyPayment: 35000, lastPaymentMonth: '2027-06' }, loan);
    expect(v.get('categories', cat.id)!.name).toBe('Golf loan');
    expect([assigned('2027-03'), assigned('2027-06'), assigned('2027-07')]).toEqual([35000, 35000, 0]);
  });

  it('a repayment accepted from the inbox counts in the loan category and lowers the loan', async () => {
    const v = await vault();
    const bankId = await saveAccount(v, { name: 'Joint', type: 'current', institution: '', ibanLast4: '', openingBalance: 500000 });
    const loanId = await saveAccount(v, { name: 'Car loan', type: 'loan', institution: '', ibanLast4: '', openingBalance: -1800000, monthlyPayment: 35000 });
    const loan = v.get('accounts', loanId)!;
    const tx: Transaction = {
      id: 't1', createdAt: '', updatedAt: '', source: 'manual',
      accountId: bankId, date: '2026-04-05', amount: -35000, descriptionRaw: 'DIRECT DEBIT CAR LOAN', merchantNorm: 'CAR LOAN', counterparty: '',
      status: 'suggested', suggestion: { targetType: 'transfer', targetId: loanId, confidence: 0.9, decidedBy: 'rule', reason: 'Repayment of Car loan' },
    };
    await v.put('transactions', tx);
    await applyChanges(v, acceptSuggestion(tx, ledgerView(v), systemClock));
    const month = budgetForMonth(input(v), '2026-04')!.categories.get(loan.categoryId!)!;
    expect(month).toMatchObject({ assigned: 35000, activity: -35000, available: 0 });
    const loanSide = v.list('transactions').find((t) => t.accountId === loanId)!;
    expect(loanSide.amount).toBe(35000);
  });
});

describe('planning a budget line month by month (D-77)', () => {
  it('only months that differ from the usual amount get their own amount', async () => {
    const v = await vault();
    await saveCategory(v, { name: 'Salary', groupId: 'fixed', rolloverMode: 'reset', isIncome: true, monthlyDefault: 500000, fromMonth: '2026-01' });
    const id = v.list('categories')[0]!.id;
    const plan = new Map<string, number>(Array.from({ length: 12 }, (_, i) => [`2026-${String(i + 1).padStart(2, '0')}`, 500000]));
    plan.set('2026-12', 1000000); // 13th month
    plan.set('2026-07', 750000);
    expect(await saveMonthPlan(v, id, plan)).toBe(2);
    expect(v.list('budgetOverrides').map((o) => [o.month, o.amount]).sort()).toEqual([['2026-07', 750000], ['2026-12', 1000000]]);
    plan.set('2026-07', 500000); // back to the usual amount: its own amount goes
    await saveMonthPlan(v, id, plan);
    expect(v.list('budgetOverrides').map((o) => o.month)).toEqual(['2026-12']);
  });
});
