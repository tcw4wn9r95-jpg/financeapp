/**
 * Kassa data model. Mirrors the PRD "Data model" section: twelve stores.
 *
 * Conventions
 * - Money is integer cents (EUR). Never a float.
 * - Calendar dates are ISO strings "YYYY-MM-DD" (local, no time zone).
 * - Months are "YYYY-MM".
 * - Timestamps (createdAt, updatedAt) are ISO 8601 instants.
 * - Every record has a random UUID `id` so the encrypted store reveals nothing
 *   through its keys (see DECISIONS.md, D-03).
 */

export type Cents = number;
export type IsoDate = string; // YYYY-MM-DD
export type MonthKey = string; // YYYY-MM
export type Id = string;

/** Where a record came from: manual entry, an import batch id, a rule id, or the AI. */
export type Source = 'manual' | 'demo' | 'ai' | `import:${string}` | `rule:${string}`;

export interface BaseRecord {
  id: Id;
  createdAt: string;
  updatedAt: string;
  source: Source;
}

// ---------------------------------------------------------------- accounts

export type AccountType = 'current' | 'savings' | 'card' | 'cash' | 'loan';

export interface Account extends BaseRecord {
  name: string;
  type: AccountType;
  institution: string;
  ibanLast4: string;
  /** Balance on the budget start month, in cents. Cards and loans are negative when owing. */
  openingBalance: Cents;
  /** Card accounts: the current account that pays the monthly statement. */
  settlementAccountId?: Id;
  closedAt?: string;
}

// ------------------------------------------------------------ transactions

export type TransactionStatus = 'new' | 'suggested' | 'reconciled' | 'locked';

export interface Transaction extends BaseRecord {
  accountId: Id;
  date: IsoDate;
  valueDate?: IsoDate;
  /** EUR cents. Negative = money out of the account. */
  amount: Cents;
  /** Foreign transactions keep what the bank showed in the original currency. */
  originalCurrency?: string; // ISO 4217, e.g. "GBP"
  originalAmount?: Cents; // in minor units of originalCurrency
  descriptionRaw: string;
  merchantNorm: string;
  counterparty: string;
  note?: string;
  importBatchId?: Id;
  dedupeHash?: string;
  status: TransactionStatus;
}

// ------------------------------------------------------------- allocations

export type TargetType = 'category' | 'provision' | 'event' | 'transfer' | 'income';
export type DecidedBy = 'rule' | 'history' | 'ai' | 'user';

/**
 * How a transaction is classified. Several allocations on one transaction are
 * a split; they must sum to the transaction amount.
 *
 * targetId by targetType:
 * - category:  an expense category id
 * - income:    an income category id (category.isIncome = true)
 * - transfer:  the counterpart transaction id
 * - provision / event: their ids (M3)
 */
export interface Allocation extends BaseRecord {
  transactionId: Id;
  targetType: TargetType;
  targetId: Id;
  amount: Cents;
  confidence: number;
  decidedBy: DecidedBy;
  reason: string;
}

// -------------------------------------------------------------- categories

export type CategoryGroup = 'fixed' | 'variable' | 'savings' | 'provisions' | 'events';
export const CATEGORY_GROUPS: readonly CategoryGroup[] = [
  'fixed',
  'variable',
  'savings',
  'provisions',
  'events',
];

export type RolloverMode = 'roll' | 'reset' | 'sweep';

export interface Category extends BaseRecord {
  /** One of the five fixed groups. Ignored for income categories. */
  groupId: CategoryGroup;
  name: string;
  rolloverMode: RolloverMode;
  isIncome: boolean;
  /** Display order inside its group. */
  sortOrder: number;
}

// ------------------------------------------------------------------ budget

export interface BudgetDefault extends BaseRecord {
  categoryId: Id;
  monthlyAmount: Cents;
  /** First month this amount applies. Later rows win from their month on; history is kept. */
  effectiveFrom: MonthKey;
}

export interface BudgetOverride extends BaseRecord {
  categoryId: Id;
  month: MonthKey;
  amount: Cents;
  note: string;
}

// ------------------------------------------------- plan stores (M3 to M5)

export interface Provision extends BaseRecord {
  name: string;
  amount: Cents;
  dueDate: IsoDate;
  /** RFC 5545 RRULE, e.g. "FREQ=YEARLY". Empty = one-off. */
  recurrence: string;
  fundedBalance: Cents;
  monthlyContribution: Cents;
}

export interface SubBudget {
  name: string;
  amount: Cents;
}

export type EventStatus = 'saving' | 'active' | 'closed';

export interface EventFund extends BaseRecord {
  name: string;
  targetAmount: Cents;
  targetDate: IsoDate;
  subBudgets: SubBudget[];
  fundedBalance: Cents;
  status: EventStatus;
  closeDisposition?: { targetType: TargetType; targetId: Id; amount: Cents };
}

export interface RuleConditions {
  merchantRegex?: string;
  amountMin?: Cents;
  amountMax?: Cents;
  accountId?: Id;
  country?: string;
}

export interface Rule extends BaseRecord {
  priority: number;
  conditions: RuleConditions;
  action: { targetType: TargetType; targetId: Id };
  hits: number;
  createdFrom: 'user' | 'hardened';
}

export interface TrainingExample extends BaseRecord {
  merchantNorm: string;
  amountBucket: string;
  accountId: Id;
  country: string;
  chosenTarget: { targetType: TargetType; targetId: Id };
  timestamp: string;
}

export interface ScenarioChange {
  type: string;
  start: MonthKey;
  end?: MonthKey;
  amount: Cents;
  target?: { targetType: TargetType; targetId: Id };
}

export interface Scenario extends BaseRecord {
  name: string;
  baseScenarioId?: Id;
  changes: ScenarioChange[];
}

export type TaxRegime = '1' | '1a' | '2' | 'U' | 'T';

export interface TaxProfile extends BaseRecord {
  year: number;
  regime: TaxRegime;
  persons: unknown[];
  incomes: unknown[];
  deductions: unknown[];
  withholdingYtd: Cents;
  paramsVersion: string;
}

// ---------------------------------------------------------------- settings

/** Household settings: one record, stored encrypted like the rest (DECISIONS.md D-05). */
export interface Settings {
  id: 'settings';
  budgetStartMonth: MonthKey;
  /** Category that receives unspent money from categories in "sweep" mode. */
  sweepTargetCategoryId?: Id;
  autoLockMinutes: number;
  lastBackupAt?: string;
  updatedAt: string;
}

// ------------------------------------------------------------------ stores

export interface StoreRecords {
  accounts: Account;
  transactions: Transaction;
  allocations: Allocation;
  categories: Category;
  budgetDefaults: BudgetDefault;
  budgetOverrides: BudgetOverride;
  provisions: Provision;
  events: EventFund;
  rules: Rule;
  trainingExamples: TrainingExample;
  scenarios: Scenario;
  taxProfiles: TaxProfile;
  settings: Settings;
}

export type StoreName = keyof StoreRecords;

/** The twelve PRD stores plus the single settings record. */
export const STORE_NAMES: readonly StoreName[] = [
  'accounts',
  'transactions',
  'allocations',
  'categories',
  'budgetDefaults',
  'budgetOverrides',
  'provisions',
  'events',
  'rules',
  'trainingExamples',
  'scenarios',
  'taxProfiles',
  'settings',
];

export type StoreSnapshot = { [K in StoreName]: StoreRecords[K][] };
