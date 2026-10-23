import { backdateDefaults, defaultFor } from '../domain/budget';
import { buildManualEntry, stamp, systemClock, type ManualEntry } from '../domain/ledger';
import { addMonths, compareMonths, currentMonth, monthDiff, monthOf } from '../domain/dates';
import { provisionSchedule, type CloseEventPlan } from '../domain/plan';
import { DEMO_ANCHOR_MONTH, shiftSnapshotMonths } from '../domain/demo';
import type {
  Account,
  BudgetDefault,
  BudgetOverride,
  Category,
  CategoryGroup,
  Cents,
  Id,
  IsoDate,
  Member,
  MonthKey,
  Provision,
  EventFund,
  RolloverMode,
  Settings,
  StoreName,
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

/**
 * Move the first budget month. Moving it earlier carries each category's
 * first monthly amount back with it, so the new months are budgeted (D-45).
 * Returns how many categories were carried back.
 */
export async function changeBudgetStart(vault: Vault, month: MonthKey): Promise<number> {
  const settings = getSettings(vault);
  const moved = backdateDefaults(vault.list('budgetDefaults'), month);
  await vault.write([
    { type: 'put', store: 'settings', record: { ...settings, budgetStartMonth: month, updatedAt: new Date().toISOString() } },
    ...moved.map((record): WriteOp => ({ type: 'put', store: 'budgetDefaults', record: { ...record, updatedAt: new Date().toISOString() } })),
  ]);
  return moved.length;
}

/** Carry monthly amounts that start after the budget start back to it. */
export async function backdateToStart(vault: Vault): Promise<number> {
  return changeBudgetStart(vault, getSettings(vault).budgetStartMonth);
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
  /** Day the account starts to count; empty = from the budget start (D-47). */
  openingDate?: IsoDate;
  /** Loans: monthly instalment and last instalment month (D-48). */
  monthlyPayment?: Cents;
  lastPaymentMonth?: MonthKey;
};

/** Create or update an account; returns its id. */
export async function saveAccount(vault: Vault, draft: AccountDraft, existing?: Account): Promise<Id> {
  const base = existing ?? (stamp(systemClock, 'manual') as Account);
  const { closed, settlementAccountId, owner, matchHints, openingDate, monthlyPayment, lastPaymentMonth, ...fields } = draft;
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
  if (openingDate) record.openingDate = openingDate;
  else delete record.openingDate;
  const hints = (matchHints ?? []).map((h) => h.trim()).filter((h) => h.length >= 3);
  if (hints.length) record.matchHints = hints;
  else delete record.matchHints;
  const ops: WriteOp[] = [];
  if (draft.type === 'loan') ops.push(...loanBudgetOps(vault, record, monthlyPayment, lastPaymentMonth, existing));
  else {
    delete record.monthlyPayment;
    delete record.lastPaymentMonth;
  }
  ops.push({ type: 'put', store: 'accounts', record });
  await vault.write(ops);
  return record.id;
}

/**
 * A loan with a monthly payment keeps a linked Fixed category named after it,
 * budgeted at the instalment from the loan start (or the budget start) to the
 * last payment. Mutates `record` (payment fields and link) (D-48).
 */
function loanBudgetOps(vault: Vault, record: Account, payment: Cents | undefined, lastMonth: MonthKey | undefined, existing?: Account): WriteOp[] {
  const ops: WriteOp[] = [];
  const now = new Date().toISOString();
  const pay = payment && payment > 0 ? payment : 0;
  let cat = record.categoryId ? vault.get('categories', record.categoryId) : undefined;
  if (!pay && !cat) {
    delete record.monthlyPayment;
    delete record.lastPaymentMonth;
    return ops;
  }
  if (!cat) {
    cat = {
      ...(stamp(systemClock, 'manual') as Category),
      name: record.name,
      groupId: 'fixed',
      rolloverMode: 'reset',
      isIncome: false,
      sortOrder: vault.list('categories').length,
    };
    ops.push({ type: 'put', store: 'categories', record: cat });
  } else if (cat.name !== record.name || cat.archivedAt) {
    const { archivedAt: _a, ...rest } = cat;
    ops.push({ type: 'put', store: 'categories', record: { ...rest, name: record.name, updatedAt: now } });
  }
  record.categoryId = cat.id;
  if (pay) record.monthlyPayment = pay;
  else delete record.monthlyPayment;
  if (lastMonth) record.lastPaymentMonth = lastMonth;
  else delete record.lastPaymentMonth;

  const start = getSettings(vault).budgetStartMonth;
  const loanStart = record.openingDate && compareMonths(record.openingDate.slice(0, 7), start) > 0 ? record.openingDate.slice(0, 7) : start;
  const defaults = vault.list('budgetDefaults').filter((d) => d.categoryId === cat!.id);
  const deleted = new Set<Id>();
  const drop = (id: Id) => {
    if (!deleted.has(id)) ops.push({ type: 'delete', store: 'budgetDefaults', id });
    deleted.add(id);
  };
  const firstTime = !existing?.monthlyPayment || defaults.every((d) => d.monthlyAmount === 0);
  if (firstTime || record.openingDate !== existing?.openingDate) {
    // The instalment applies from the loan start; nothing is budgeted before it.
    for (const d of defaults) if (d.effectiveFrom !== loanStart) drop(d.id);
    ops.push(...defaultOps(vault, cat.id, pay, loanStart));
  } else if (pay !== existing.monthlyPayment) {
    // A new instalment applies from this month on; earlier months keep theirs.
    const from = compareMonths(defaultStartMonth(vault), loanStart) < 0 ? loanStart : defaultStartMonth(vault);
    ops.push(...defaultOps(vault, cat.id, pay, from));
  }
  // The end: nothing after the last instalment.
  if (existing?.lastPaymentMonth && existing.lastPaymentMonth !== lastMonth) {
    const old = defaults.find((d) => d.effectiveFrom === addMonths(existing.lastPaymentMonth!, 1) && d.monthlyAmount === 0);
    if (old) drop(old.id);
  }
  if (lastMonth) {
    const marker = addMonths(lastMonth, 1);
    const same = defaults.find((d) => d.effectiveFrom === marker && !deleted.has(d.id));
    ops.push({
      type: 'put',
      store: 'budgetDefaults',
      record: same ? { ...same, monthlyAmount: 0, updatedAt: now } : { ...(stamp(systemClock, 'manual') as BudgetDefault), categoryId: cat.id, monthlyAmount: 0, effectiveFrom: marker },
    });
  }
  return ops;
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
  /** Last month of this amount; from the month after, the category gets nothing (D-47). */
  untilMonth?: MonthKey;
  /** Income paid for the next month from this day (D-74); absent turns it off. */
  nextMonthFromDay?: number;
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
  const { monthlyDefault, fromMonth, untilMonth, ...fields } = draft;
  const sortOrder = existing?.sortOrder ?? Math.max(-1, ...vault.list('categories').map((c) => c.sortOrder)) + 1;
  const { nextMonthFromDay: _n, ...before } = existing ?? (stamp(systemClock, 'manual') as Category);
  const record: Category = {
    ...before,
    ...fields,
    sortOrder,
    updatedAt: new Date().toISOString(),
  };
  const ops: WriteOp[] = [{ type: 'put', store: 'categories', record }];
  if (monthlyDefault !== undefined) {
    ops.push(...defaultOps(vault, record.id, monthlyDefault, fromMonth ?? defaultStartMonth(vault)));
  }
  if (untilMonth) ops.push(...defaultOps(vault, record.id, 0, addMonths(untilMonth, 1)));
  await vault.write(ops);
}

export function categoryInUse(vault: Vault, id: Id): boolean {
  return (
    vault.list('allocations').some((a) => a.targetId === id) ||
    getSettings(vault).sweepTargetCategoryId === id ||
    vault.list('accounts').some((a) => a.categoryId === id)
  );
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
  ['Investments', 'investments', 'reset', false],
  ['Annual bills', 'provisions', 'roll', false],
  ['Holidays', 'events', 'roll', false],
];

/**
 * Create the Investments category once (D-57), for vaults set up before it
 * existed. If it is deleted later it is not created again.
 */
export async function ensureInvestments(vault: Vault): Promise<void> {
  const settings = getSettings(vault);
  // A vault still being set up gets it with the suggested categories instead.
  if (settings.investmentsSetUp || vault.list('categories').length === 0) return;
  const ops: WriteOp[] = [];
  if (!vault.list('categories').some((c) => c.groupId === 'investments')) {
    const record: Category = {
      ...(stamp(systemClock, 'manual') as Category),
      name: t('invest.name'),
      groupId: 'investments',
      rolloverMode: 'reset',
      isIncome: false,
      sortOrder: vault.list('categories').length,
    };
    ops.push({ type: 'put', store: 'categories', record });
  }
  ops.push({ type: 'put', store: 'settings', record: { ...settings, investmentsSetUp: true, updatedAt: new Date().toISOString() } });
  await vault.write(ops);
}

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

/**
 * Save a month-by-month plan for a budget line (D-77). A month whose amount is
 * the usual monthly amount needs nothing; any other month gets its own amount
 * (an override), and an override equal to the usual amount is removed.
 */
export async function saveMonthPlan(vault: Vault, categoryId: Id, plan: ReadonlyMap<MonthKey, Cents>): Promise<number> {
  const defaults = vault.list('budgetDefaults');
  const overrides = vault.list('budgetOverrides');
  const ops: WriteOp[] = [];
  let special = 0;
  for (const [month, amount] of plan) {
    const usual = defaultFor(defaults, categoryId, month)?.monthlyAmount ?? 0;
    const same = overrides.find((o) => o.categoryId === categoryId && o.month === month);
    if (amount === usual) {
      if (same) ops.push({ type: 'delete', store: 'budgetOverrides', id: same.id });
      continue;
    }
    special++;
    const record: BudgetOverride = same
      ? { ...same, amount, updatedAt: new Date().toISOString() }
      : { ...(stamp(systemClock, 'manual') as BudgetOverride), categoryId, month, amount, note: '' };
    ops.push({ type: 'put', store: 'budgetOverrides', record });
  }
  if (ops.length) await vault.write(ops);
  return special;
}

/** Remove one planned change of a usual monthly amount (D-78). */
export async function removeDefault(vault: Vault, id: Id): Promise<void> {
  await vault.write([{ type: 'delete', store: 'budgetDefaults', id }]);
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

/**
 * Delete every transaction and what hangs off it (splits and transfer links,
 * statements, import history), keeping accounts, categories, the budget,
 * provisions, trips, rules and settings (D-62). Opening balances that came
 * from a statement go back to 0, so the next import sets them again; typed
 * ones stay. `forgetLearning` also drops the examples learned from past choices.
 */
export async function deleteAllTransactions(vault: Vault, opts: { forgetLearning?: boolean } = {}): Promise<number> {
  const stores: StoreName[] = ['transactions', 'allocations', 'statements', 'importBatches', ...(opts.forgetLearning ? (['trainingExamples'] as const) : [])];
  const ops: WriteOp[] = stores.flatMap((store) => vault.list(store).map((r): WriteOp => ({ type: 'delete', store, id: r.id })));
  const now = new Date().toISOString();
  for (const a of vault.list('accounts')) {
    if (!a.openingFromStatement) continue;
    const { openingFromStatement: _, ...rest } = a;
    ops.push({ type: 'put', store: 'accounts', record: { ...rest, openingBalance: 0, updatedAt: now } });
  }
  const count = vault.list('transactions').length;
  if (ops.length) await vault.write(ops);
  return count;
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

/** Can this device hand a file to the system share sheet (Files, AirDrop, mail…)? */
export function canShareFiles(): boolean {
  try {
    return typeof navigator.canShare === 'function' && navigator.canShare({ files: [new File(['x'], 'x.json', { type: 'application/json' })] });
  } catch {
    return false;
  }
}

/** Share a file through the system sheet. Returns false when the user cancelled. */
export async function shareFile(filename: string, text: string, title: string): Promise<boolean> {
  const file = new File([text], filename, { type: 'application/json' });
  try {
    await navigator.share({ files: [file], title });
    return true;
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') return false;
    throw e;
  }
}

// -------------------------------------------------------- provisions and events

/** Create or update a provision and its budget category (group Provisions). */
export async function saveProvision(
  vault: Vault,
  draft: Pick<Provision, 'name' | 'amount' | 'dueDate' | 'recurrence' | 'amountChanges'> & { startDate: IsoDate },
  existing?: Provision,
): Promise<void> {
  const ops: WriteOp[] = [];
  let categoryId = existing?.categoryId;
  const now = new Date().toISOString();
  if (!categoryId || !vault.get('categories', categoryId)) {
    const cat: Category = {
      ...(stamp(systemClock, 'manual') as Category),
      name: draft.name,
      groupId: 'provisions',
      rolloverMode: 'roll',
      isIncome: false,
      sortOrder: vault.list('categories').length,
    };
    categoryId = cat.id;
    ops.push({ type: 'put', store: 'categories', record: cat });
  } else {
    const cat = vault.get('categories', categoryId)!;
    if (cat.name !== draft.name) ops.push({ type: 'put', store: 'categories', record: { ...cat, name: draft.name, updatedAt: now } });
  }
  // The budgeted amounts follow from start, target date and target amount (D-49).
  const schedule = provisionSchedule(draft, monthOf(draft.startDate));
  const { amountChanges, ...rest } = draft;
  const base = existing ? (({ amountChanges: _c, ...e }) => e)(existing) : (stamp(systemClock, 'manual') as Provision);
  const record: Provision = {
    ...base,
    ...rest,
    ...(amountChanges?.length ? { amountChanges } : {}),
    categoryId,
    monthlyContribution: schedule[0]!.amount,
    fundedBalance: existing?.fundedBalance ?? 0,
    updatedAt: now,
  };
  ops.push({ type: 'put', store: 'provisions', record });
  for (const d of vault.list('budgetDefaults')) if (d.categoryId === categoryId) ops.push({ type: 'delete', store: 'budgetDefaults', id: d.id });
  for (const step of schedule) {
    ops.push({ type: 'put', store: 'budgetDefaults', record: { ...(stamp(systemClock, 'manual') as BudgetDefault), categoryId, monthlyAmount: step.amount, effectiveFrom: step.from } });
  }
  await vault.write(ops);
}

export async function deleteProvision(vault: Vault, p: Provision): Promise<void> {
  const ops: WriteOp[] = [{ type: 'delete', store: 'provisions', id: p.id }];
  // The category stays if money or transactions are in it; otherwise it goes too.
  if (!categoryInUse(vault, p.categoryId)) {
    ops.push({ type: 'delete', store: 'categories', id: p.categoryId });
    for (const d of vault.list('budgetDefaults')) if (d.categoryId === p.categoryId) ops.push({ type: 'delete', store: 'budgetDefaults', id: d.id });
  }
  await vault.write(ops);
}

export async function saveEvent(
  vault: Vault,
  draft: Pick<EventFund, 'name' | 'targetAmount' | 'targetDate' | 'subBudgets'> & { startDate: IsoDate },
  existing?: EventFund,
): Promise<void> {
  const ops: WriteOp[] = [];
  let categoryId = existing?.categoryId;
  const now = new Date().toISOString();
  if (!categoryId || !vault.get('categories', categoryId)) {
    const cat: Category = {
      ...(stamp(systemClock, 'manual') as Category),
      name: draft.name,
      groupId: 'events',
      rolloverMode: 'roll',
      isIncome: false,
      sortOrder: vault.list('categories').length,
    };
    categoryId = cat.id;
    ops.push({ type: 'put', store: 'categories', record: cat });
  } else {
    const cat = vault.get('categories', categoryId)!;
    if (cat.name !== draft.name) ops.push({ type: 'put', store: 'categories', record: { ...cat, name: draft.name, updatedAt: now } });
  }
  const record: EventFund = {
    ...(existing ?? (stamp(systemClock, 'manual') as EventFund)),
    ...draft,
    categoryId,
    fundedBalance: existing?.fundedBalance ?? 0,
    status: existing?.status ?? 'saving',
    updatedAt: now,
  };
  ops.push({ type: 'put', store: 'events', record });
  // The trip's dated parts budget it now (D-54): monthly defaults no longer apply.
  for (const d of vault.list('budgetDefaults')) if (d.categoryId === categoryId) ops.push({ type: 'delete', store: 'budgetDefaults', id: d.id });
  await vault.write(ops);
}

/** Close an event: move what is left to (or cover a deficit from) another category, stop contributions. */
export async function closeEvent(vault: Vault, e: EventFund, plan: CloseEventPlan, targetCategoryId: Id, month: MonthKey): Promise<void> {
  const ops: WriteOp[] = [];
  const now = new Date().toISOString();
  for (const o of plan.overrides) {
    const same = vault.list('budgetOverrides').find((x) => x.categoryId === o.categoryId && x.month === o.month);
    const record: BudgetOverride = same
      ? { ...same, amount: o.amount, note: o.note, updatedAt: now }
      : { ...(stamp(systemClock, 'manual') as BudgetOverride), categoryId: o.categoryId, month: o.month, amount: o.amount, note: o.note };
    ops.push({ type: 'put', store: 'budgetOverrides', record });
  }
  ops.push(...defaultOps(vault, e.categoryId, 0, addMonths(month, 1)));
  ops.push({
    type: 'put',
    store: 'events',
    record: { ...e, status: 'closed', closedAt: now, closeDisposition: { targetType: 'category', targetId: targetCategoryId, amount: plan.moved }, updatedAt: now },
  });
  const cat = vault.get('categories', e.categoryId);
  if (cat) ops.push({ type: 'put', store: 'categories', record: { ...cat, archivedAt: now, updatedAt: now } });
  await vault.write(ops);
}

export async function deleteEvent(vault: Vault, e: EventFund): Promise<void> {
  const ops: WriteOp[] = [{ type: 'delete', store: 'events', id: e.id }];
  if (!categoryInUse(vault, e.categoryId)) {
    ops.push({ type: 'delete', store: 'categories', id: e.categoryId });
    for (const d of vault.list('budgetDefaults')) if (d.categoryId === e.categoryId) ops.push({ type: 'delete', store: 'budgetDefaults', id: d.id });
  }
  await vault.write(ops);
}
