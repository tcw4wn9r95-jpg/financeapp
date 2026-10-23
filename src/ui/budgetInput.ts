import type { BudgetInput } from '../domain/budget';
import { freeSavingsByMonth } from '../domain/buckets';
import { currentMonth } from '../domain/dates';
import { eventPlans } from '../domain/plan';
import type { Account, Allocation, BudgetDefault, BudgetOverride, Category, EventFund, Provision, Settings, Transaction } from '../domain/types';

export interface BudgetSources {
  settings: Settings;
  categories: readonly Category[];
  defaults: readonly BudgetDefault[];
  overrides: readonly BudgetOverride[];
  accounts: readonly Account[];
  transactions: readonly Transaction[];
  allocations: readonly Allocation[];
  events: readonly EventFund[];
  provisions: readonly Provision[];
}

/**
 * The budget input from the stored data. When provisions are kept in a
 * savings account and a savings category collects leftovers (the Emergency
 * fund), that category holds whatever the account has beyond what provisions
 * and trips need (D-75), so Ready to assign shows only money free to spend.
 */
export function buildBudgetInput(s: BudgetSources): BudgetInput {
  const base: BudgetInput = {
    startMonth: s.settings.budgetStartMonth,
    // Trips are budgeted by their dated parts (D-54).
    plans: eventPlans(s.events),
    categories: s.categories,
    defaults: s.defaults,
    overrides: s.overrides,
    accounts: s.accounts,
    transactions: s.transactions,
    allocations: s.allocations,
    ...(s.settings.sweepTargetCategoryId ? { sweepTargetCategoryId: s.settings.sweepTargetCategoryId } : {}),
  };
  const savingsId = s.settings.sweepTargetCategoryId;
  const accountId = s.settings.provisionsAccountId;
  if (!accountId || !savingsId || s.settings.freeSavingsAuto === false) return base;
  if (!s.categories.some((c) => c.id === savingsId && !c.isIncome && !c.archivedAt)) return base;
  const free = freeSavingsByMonth(base, s.provisions, s.events, accountId, currentMonth());
  return { ...base, availableTargets: new Map([[savingsId, free]]) };
}
