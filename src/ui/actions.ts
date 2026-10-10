import { buildManualEntry, stamp, systemClock, type ManualEntry } from '../domain/ledger';
import { compareMonths, currentMonth, monthDiff } from '../domain/dates';
import { DEMO_ANCHOR_MONTH, shiftSnapshotMonths } from '../domain/demo';
import type {
  Account,
  BudgetDefault,
  BudgetOverride,
  Category,
  CategoryGroup,
  Cents,
  Id,
  Member,
  MonthKey,
  RolloverMode,
  Settings,
  StoreSnapshot,
} from '../domain/types';
import { readPlainExport } from '../storage/backup';
import { t } from '../i18n';
import type { Vault, WriteOp } from '../storage/vault';

/**
 * Write operations used by the UI. Each one turns a user intent into an
 * atomic batch of vault writes; the maths lives in /src/domain.
 */

export function defaultSettings(now = new Date()): Settings {
  // January of this year, so earlier statements of the year can be imported (D-32).
  return { id: 'settings', budgetStartMonth: `${now.getFullYear()}-01`, autoLockMinutes: 15, updatedAt: now.toISOString() };
}

export function getSettings(vault: Vault): Settings {
  return vault.get('settings', 'settings') ?? defaultSettings();
}

export async function saveSettings(vault: Vault, patch: Partial<Omit<Settings, 'id'>>): Promise<void> {
  const next: Settings = { ...getSettings(vault), ...patch, updatedAt: new Date().toISOString() };
  await vault.put('settings', next);
}

// ---------------------------------------------------------------- accounts

export type AccountDraft = Pick<Account, 'name' | 'type' | 'institution' | 'ibanLast4' | 'openingBalance'> & {
  settlementAccountId?: Id;
  closed?: boolean;
  owner?: Id;
  matchHints?: string[];
};

/** Create or update an account; returns its id. */
export async function saveAccount(vault: Vault, draft: AccountDraft, existing?: Account): Promise<Id> {
  const base = existing ?? (stamp(systemClock, 'manual') as Account);
  const { closed, settlementAccountId, owner, matchHints, ...fields } = draft;
  const record: Account = {
    ...base,
    ...fields,
    updatedAt: new Date().toISOString(),
  };
  if (draft.type === 'card' && settlementAccountId) record.settlementAccountId = settlementAccountId;
  else delete record.settlementAccountId;
  // A typed opening balance is the user's: later statements no longer replace it.
  if (existing && draft.openingBalance !== existing.openingBalance) delete record.openingFromStatement;
  if (closed) record.closedAt = existing?.closedAt ?? new Date().toISOString();
  else delete record.closedAt;
  if (owner) record.owner = owner;
  else delete record.owner;
  const hints = (matchHints ?? []).map((h) => h.trim()).filter((h) => h.length >= 3);
  if (hints.length) record.matchHints = hints;
  else delete record.matchHints;
  await vault.put('accounts', record);
  return record.id;
}

// ----------------------------------------------------------------- members

export async function saveMembers(vault: Vault, members: Member[]): Promise<void> {
  await saveSettings(vault, { members: members.filter((m) => m.name.trim()).map((m) => ({ ...m, name: m.name.trim() })) });
}

export function ownerName(vault: Vault, owner: Id | undefined): string | undefined {
  if (!owner) return undefined;
  if (owner === 'joint') return t('accounts.joint');
  return getSettings(vault).members?.find((m) => m.id === owner)?.name;
}

export function accountInUse(vault: Vault, id: Id): boolean {
  return vault.list('transactions').some((t) => t.accountId === id) ||
    vault.list('accounts').some((a) => a.settlementAccountId === id);
}

export async function deleteAccount(vault: Vault, id: Id): Promise<void> {
  if (accountInUse(vault, id)) throw new Error('accountInUse');
  await vault.remove('accounts', id);
}

// -------------------------------------------------------------- categories

export interface CategoryDraft {
  name: string;
  groupId: CategoryGroup;
  rolloverMode: RolloverMode;
  isIncome: boolean;
  /** Monthly default (expense) or expected monthly income (income) from `fromMonth` on. */
  monthlyDefault?: Cents;
  fromMonth?: MonthKey;
}

/** The month a new default should start: this month, but never before the budget starts. */
export function defaultStartMonth(vault: Vault): MonthKey {
  const start = getSettings(vault).budgetStartMonth;
  const now = currentMonth();
  return compareMonths(now, start) < 0 ? start : now;
}

/**
 * While setting up (no amounts saved after the budget start yet), new amounts
 * apply from the budget start so past months are budgeted too (D-32).
 */
export function suggestedFromMonth(vault: Vault): MonthKey {
  const start = getSettings(vault).budgetStartMonth;
  const settingUp = vault.list('budgetDefaults').every((d) => d.effectiveFrom === start);
  return settingUp ? start : defaultStartMonth(vault);
}

export async function saveCategory(vault: Vault, draft: CategoryDraft, existing?: Category): Promise<void> {
  const { monthlyDefault, fromMonth, ...fields } = draft;
  const sortOrder = existing?.sortOrder ?? Math.max(-1, ...vault.list('categories').map((c) => c.sortOrder)) + 1;
  const record: Category = {
    ...(existing ?? (stamp(systemClock, 'manual') as Category)),
    ...fields,
    sortOrder,
    updatedAt: new Date().toISOString(),
  };
  const ops: WriteOp[] = [{ type: 'put', store: 'categories', record }];
  if (monthlyDefault !== undefined) {
    ops.push(...defaultOps(vault, record.id, monthlyDefault, fromMonth ?? defaultStartMonth(vault)));
  }
  await vault.write(ops);
}

export function categoryInUse(vault: Vault, id: Id): boolean {
  return vault.list('allocations').some((a) => a.targetId === id) || getSettings(vault).sweepTargetCategoryId === id;
}

export async function deleteCategory(vault: Vault, id: Id): Promise<void> {
  if (categoryInUse(vault, id)) throw new Error('categoryInUse');
  const ops: WriteOp[] = [{ type: 'delete', store: 'categories', id }];
  for (const d of vault.list('budgetDefaults')) if (d.categoryId === id) ops.push({ type: 'delete', store: 'budgetDefaults', id: d.id });
  for (const o of vault.list('budgetOverrides')) if (o.categoryId === id) ops.push({ type: 'delete', store: 'budgetOverrides', id: o.id });
  await vault.write(ops);
}

const SUGGESTED: [string, CategoryGroup, RolloverMode, boolean][] = [
  ['Salary', 'fixed', 'reset', true],
  ['Other income', 'fixed', 'reset', true],
  ['Rent or mortgage', 'fixed', 'reset', false],
  ['Energy', 'fixed', 'roll', false],
  ['Phone & internet', 'fixed', 'reset', false],
  ['Insurance', 'fixed', 'roll', false],
  ['Loan repayments', 'fixed', 'reset', false],
  ['Groceries', 'variable', 'roll', false],
  ['Eating out', 'variable', 'roll', false],
  ['Transport', 'variable', 'roll', false],
  ['Health', 'variable', 'roll', false],
  ['Clothing', 'variable', 'roll', false],
  ['Fun money', 'variable', 'sweep', false],
  ['Emergency fund', 'savings', 'roll', false],
  ['Retirement savings', 'savings', 'roll', false],
  ['Annual bills', 'provisions', 'roll', false],
  ['Holidays', 'events', 'roll', false],
];

export async function addSuggestedCategories(vault: Vault): Promise<void> {
  const existing = new Set(vault.list('categories').map((c) => c.name.toLowerCase()));
  let order = vault.list('categories').length;
  const ops: WriteOp[] = [];
  let emergencyId: Id | undefined;
  for (const [name, groupId, rolloverMode, isIncome] of SUGGESTED) {
    if (existing.has(name.toLowerCase())) continue;
    const record: Category = { ...(stamp(systemClock, 'manual') as Category), name, groupId, rolloverMode, isIncome, sortOrder: order++ };
    if (name === 'Emergency fund') emergencyId = record.id;
    ops.push({ type: 'put', store: 'categories', record });
  }
  const settings = getSettings(vault);
  if (emergencyId && !settings.sweepTargetCategoryId) {
    ops.push({ type: 'put', store: 'settings', record: { ...settings, sweepTargetCategoryId: emergencyId, updatedAt: new Date().toISOString() } });
  }
  await vault.write(ops);
}

// ------------------------------------------------------------------ budget

/** Upsert the default that starts in `fromMonth`; earlier history stays untouched. */
function defaultOps(vault: Vault, categoryId: Id, amount: Cents, fromMonth: MonthKey): WriteOp[] {
  const same = vault.list('budgetDefaults').find((d) => d.categoryId === categoryId && d.effectiveFrom === fromMonth);
  const record: BudgetDefault = same
    ? { ...same, monthlyAmount: amount, updatedAt: new Date().toISOString() }
    : { ...(stamp(systemClock, 'manual') as BudgetDefault), categoryId, monthlyAmount: amount, effectiveFrom: fromMonth };
  return [{ type: 'put', store: 'budgetDefaults', record }];
}

export async function setDefaultFrom(vault: Vault, categoryId: Id, amount: Cents, fromMonth: MonthKey): Promise<void> {
  // A new default from this month on also clears this month's override, which it replaces.
  const ops = defaultOps(vault, categoryId, amount, fromMonth);
  const ovr = vault.list('budgetOverrides').find((o) => o.categoryId === categoryId && o.month === fromMonth);
  if (ovr) ops.push({ type: 'delete', store: 'budgetOverrides', id: ovr.id });
  await vault.write(ops);
}

export async function setOverride(vault: Vault, categoryId: Id, month: MonthKey, amount: Cents, note: string): Promise<void> {
  const same = vault.list('budgetOverrides').find((o) => o.categoryId === categoryId && o.month === month);
  const record: BudgetOverride = same
    ? { ...same, amount, note, updatedAt: new Date().toISOString() }
    : { ...(stamp(systemClock, 'manual') as BudgetOverride), categoryId, month, amount, note };
  await vault.put('budgetOverrides', record);
}

export async function resetOverride(vault: Vault, overrideId: Id): Promise<void> {
  await vault.remove('budgetOverrides', overrideId);
}

// ------------------------------------------------------------ transactions

/** Ids of a transaction plus its transfer counterpart, and all their allocations. */
function relatedDeletes(vault: Vault, transactionId: Id): WriteOp[] {
  const ids = new Set([transactionId]);
  for (const a of vault.list('allocations')) {
    if (a.transactionId === transactionId && a.targetType === 'transfer') ids.add(a.targetId);
  }
  const ops: WriteOp[] = [];
  for (const id of ids) {
    if (vault.get('transactions', id)) ops.push({ type: 'delete', store: 'transactions', id });
  }
  for (const a of vault.list('allocations')) {
    if (ids.has(a.transactionId)) ops.push({ type: 'delete', store: 'allocations', id: a.id });
  }
  return ops;
}

export async function saveEntry(vault: Vault, entry: ManualEntry, existingId?: Id): Promise<void> {
  const write = buildManualEntry(entry, systemClock);
  const ops: WriteOp[] = [];
  if (existingId) {
    const old = vault.get('transactions', existingId);
    if (old?.status === 'locked') throw new Error('locked');
    ops.push(...relatedDeletes(vault, existingId));
    // Keep the original id and creation time of the edited transaction.
    const first = write.transactions[0]!;
    const oldId = first.id;
    first.id = existingId;
    if (old) first.createdAt = old.createdAt;
    for (const a of write.allocations) {
      if (a.transactionId === oldId) a.transactionId = existingId;
      if (a.targetType === 'transfer' && a.targetId === oldId) a.targetId = existingId;
    }
  }
  for (const t of write.transactions) ops.push({ type: 'put', store: 'transactions', record: t });
  for (const a of write.allocations) ops.push({ type: 'put', store: 'allocations', record: a });
  await vault.write(ops);
}

export async function deleteEntry(vault: Vault, transactionId: Id): Promise<void> {
  const t = vault.get('transactions', transactionId);
  if (t?.status === 'locked') throw new Error('locked');
  await vault.write(relatedDeletes(vault, transactionId));
}

// -------------------------------------------------------------- whole data

export async function restoreSnapshot(vault: Vault, snapshot: StoreSnapshot): Promise<void> {
  await vault.replaceAll(snapshot);
}

/** Load the anonymised demo household, shifted so its last month is this month. */
export async function loadDemo(vault: Vault): Promise<void> {
  const mod = await import('../../fixtures/demo-household.json');
  const plain = await readPlainExport(mod.default);
  const shifted = shiftSnapshotMonths(plain.stores, monthDiff(DEMO_ANCHOR_MONTH, currentMonth()));
  // Keep the existing backup reminder state.
  const lastBackupAt = getSettings(vault).lastBackupAt;
  for (const s of shifted.settings) if (lastBackupAt) s.lastBackupAt = lastBackupAt;
  await vault.replaceAll(shifted);
}

export function download(filename: string, text: string, type = 'application/json'): void {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
