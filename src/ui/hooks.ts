import { createContext, useContext, useEffect, useMemo, useSyncExternalStore } from 'react';
import { computeBudget, type BudgetInput, type BudgetMonth } from '../domain/budget';
import { compareMonths } from '../domain/dates';
import type { MonthKey, Settings, StoreName, StoreRecords } from '../domain/types';
import type { Vault } from '../storage/vault';
import { getSettings } from './actions';

export const VaultContext = createContext<Vault | null>(null);

export function useVault(): Vault {
  const v = useContext(VaultContext);
  if (!v) throw new Error('VaultContext missing');
  return v;
}

/** Re-render whenever the vault changes (status or data). */
export function useVaultVersion(): number {
  const vault = useVault();
  return useSyncExternalStore(vault.subscribe, vault.getVersion);
}

export function useStore<S extends StoreName>(store: S): readonly StoreRecords[S][] {
  const vault = useVault();
  return useSyncExternalStore(vault.subscribe, () => vault.list(store));
}

export function useSettings(): Settings {
  const vault = useVault();
  useStore('settings');
  return getSettings(vault);
}

export function useBudgetInput(): BudgetInput {
  const settings = useSettings();
  const categories = useStore('categories');
  const defaults = useStore('budgetDefaults');
  const overrides = useStore('budgetOverrides');
  const accounts = useStore('accounts');
  const transactions = useStore('transactions');
  const allocations = useStore('allocations');
  return useMemo(
    () => ({
      startMonth: settings.budgetStartMonth,
      categories,
      defaults,
      overrides,
      accounts,
      transactions,
      allocations,
      ...(settings.sweepTargetCategoryId ? { sweepTargetCategoryId: settings.sweepTargetCategoryId } : {}),
    }),
    [settings.budgetStartMonth, settings.sweepTargetCategoryId, categories, defaults, overrides, accounts, transactions, allocations],
  );
}

/** Budget for one month, or undefined before the budget start. */
export function useBudgetMonth(month: MonthKey): BudgetMonth | undefined {
  const input = useBudgetInput();
  return useMemo(
    () => (compareMonths(month, input.startMonth) < 0 ? undefined : computeBudget(input, month).at(-1)),
    [input, month],
  );
}

export function useDocumentTitle(title: string): void {
  useEffect(() => {
    document.title = `${title} · Kassa`;
  }, [title]);
}
