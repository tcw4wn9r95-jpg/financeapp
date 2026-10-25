import { taxCashItems } from './taxParams';
import { createContext, useContext, useEffect, useMemo, useSyncExternalStore } from 'react';
import { computeBudget, type BudgetInput, type BudgetMonth } from '../domain/budget';
import { compareMonths, currentMonth, todayIso } from '../domain/dates';
import { allBucketWindows, fillBuckets, type BucketsSummary } from '../domain/buckets';
import { forecast, type CashItem, type ForecastResult } from '../domain/forecast';
import type { MonthKey, ScenarioChange, Settings, StoreName, StoreRecords } from '../domain/types';
import type { Vault } from '../storage/vault';
import { getSettings } from './actions';
import { buildBudgetInput } from './budgetInput';
import { filedHistory, type FiledRow } from '../domain/learn';
import { t } from '../i18n';

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

/** Transactions already filed under one target: what inbox predictions learn from (D-80). */
export function useFiledHistory(): FiledRow[] {
  const transactions = useStore('transactions');
  const allocations = useStore('allocations');
  return useMemo(() => filedHistory(transactions, allocations), [transactions, allocations]);
}

/** Provisions and trips filled from the provisions account's balance this month (D-69). */
export function useBuckets(): BucketsSummary {
  const input = useBudgetInput();
  const settings = useSettings();
  const provisions = useStore('provisions');
  const events = useStore('events');
  return useMemo(() => {
    const month = currentMonth();
    return fillBuckets(input, month, settings.provisionsAccountId, allBucketWindows(provisions, events, month));
  }, [input, settings.provisionsAccountId, provisions, events]);
}

export function useBudgetInput(): BudgetInput {
  const settings = useSettings();
  const categories = useStore('categories');
  const defaults = useStore('budgetDefaults');
  const overrides = useStore('budgetOverrides');
  const accounts = useStore('accounts');
  const transactions = useStore('transactions');
  const allocations = useStore('allocations');
  const events = useStore('events');
  const provisions = useStore('provisions');
  // Settings is a fresh object each render: depend on the fields used.
  const { budgetStartMonth, sweepTargetCategoryId, provisionsAccountId, freeSavingsAuto, covers } = settings;
  return useMemo(
    () => buildBudgetInput({ settings, categories, defaults, overrides, accounts, transactions, allocations, events, provisions }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [budgetStartMonth, sweepTargetCategoryId, provisionsAccountId, freeSavingsAuto, covers, categories, defaults, overrides, accounts, transactions, allocations, events, provisions],
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
    document.title = `${title} · ${t('app.name')}`;
  }, [title]);
}

/** The cash forecast from today (plus optional scenario changes and extra items). */
export function useForecast(months: number, changes?: ScenarioChange[], extra?: CashItem[]): ForecastResult {
  const budget = useBudgetInput();
  const provisions = useStore('provisions');
  const events = useStore('events');
  const taxProfiles = useStore('taxProfiles');
  return useMemo(() => {
    // Expected tax refunds or payments the user chose to show (M5).
    const all = [...taxCashItems(taxProfiles), ...(extra ?? [])];
    return forecast({ today: todayIso(), months, budget, provisions, events, ...(changes ? { changes } : {}), ...(all.length ? { extra: all } : {}) });
  }, [budget, provisions, events, months, changes, extra, taxProfiles]);
}
