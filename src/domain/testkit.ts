/**
 * Small builders for domain tests. Not shipped in the app bundle.
 */
import { buildManualEntry, type Clock, type EntryTarget } from './ledger';
import type {
  Account,
  AccountType,
  Allocation,
  BudgetDefault,
  BudgetOverride,
  Category,
  CategoryGroup,
  Cents,
  MonthKey,
  RolloverMode,
  Transaction,
} from './types';

export function testClock(prefix = 'id'): Clock {
  let n = 0;
  return { now: () => '2026-10-10T12:00:00.000Z', newId: () => `${prefix}-${++n}` };
}

const base = { createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', source: 'manual' as const };

export class World {
  accounts: Account[] = [];
  categories: Category[] = [];
  defaults: BudgetDefault[] = [];
  overrides: BudgetOverride[] = [];
  transactions: Transaction[] = [];
  allocations: Allocation[] = [];
  clock = testClock();

  constructor(public startMonth: MonthKey = '2026-01') {}

  account(id: string, type: AccountType = 'current', openingBalance: Cents = 0): string {
    this.accounts.push({ ...base, id, name: id, type, institution: '', ibanLast4: '', openingBalance });
    return id;
  }

  category(id: string, group: CategoryGroup = 'variable', rolloverMode: RolloverMode = 'roll', isIncome = false): string {
    this.categories.push({ ...base, id, name: id, groupId: group, rolloverMode, isIncome, sortOrder: this.categories.length });
    return id;
  }

  income(id: string): string {
    return this.category(id, 'fixed', 'reset', true);
  }

  setDefault(categoryId: string, monthlyAmount: Cents, effectiveFrom: MonthKey = this.startMonth): void {
    this.defaults.push({ ...base, id: `d-${this.defaults.length}`, categoryId, monthlyAmount, effectiveFrom });
  }

  override(categoryId: string, month: MonthKey, amount: Cents): void {
    this.overrides.push({ ...base, id: `o-${this.overrides.length}`, categoryId, month, amount, note: '' });
  }

  entry(accountId: string, date: string, amount: Cents, target: EntryTarget): void {
    const w = buildManualEntry({ accountId, date, amount, description: 'test', target }, this.clock);
    this.transactions.push(...w.transactions);
    this.allocations.push(...w.allocations);
  }

  spend(accountId: string, date: string, amount: Cents, categoryId: string): void {
    this.entry(accountId, date, -Math.abs(amount), { kind: 'category', categoryId });
  }

  earn(accountId: string, date: string, amount: Cents, categoryId: string): void {
    this.entry(accountId, date, Math.abs(amount), { kind: 'income', categoryId });
  }

  input(sweepTargetCategoryId?: string) {
    return {
      startMonth: this.startMonth,
      categories: this.categories,
      defaults: this.defaults,
      overrides: this.overrides,
      accounts: this.accounts,
      transactions: this.transactions,
      allocations: this.allocations,
      ...(sweepTargetCategoryId ? { sweepTargetCategoryId } : {}),
    };
  }
}
