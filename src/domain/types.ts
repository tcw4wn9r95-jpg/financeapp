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
  /** Balance on the budget start month (or on `openingDate`), in cents. Cards and loans are negative when owing. */
  openingBalance: Cents;
  /**
   * The day the account starts to count (a loan taken out, an account opened
   * or tracked later). The opening balance applies from this day; for an
   * on-budget account it joins Ready to assign in this month (D-47).
   */
  openingDate?: IsoDate;
  /**
   * Loans: the monthly instalment. It keeps a linked Fixed budget category
   * (`categoryId`) with this amount, and repayments are filed there (D-48).
   */
  monthlyPayment?: Cents;
  /**
   * Loans: yearly interest rate in percent (D-93). Of each payment only the
   * part beyond the month's interest lowers what is owed; the whole payment
   * still counts in the loan's budget line.
   */
  interestRate?: number;
  /** Loans: month of the last instalment; the budgeted amount stops after it. */
  lastPaymentMonth?: MonthKey;
  /** Loans: the budget category the repayments count in. */
  categoryId?: Id;
  /** Card accounts: the current account that pays the monthly statement. */
  settlementAccountId?: Id;
  closedAt?: string;
  /** 'joint' or a household member id (Settings.members). */
  owner?: Id;
  /** True while the opening balance comes from the earliest imported statement (not typed by hand). */
  openingFromStatement?: boolean;
  /**
   * Text that identifies this account in other accounts' statements, e.g.
   * "Compte flexible". Used to recognise transfers (DECISIONS.md D-22).
   */
  matchHints?: string[];
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
  /** Last 4 characters of the other party's IBAN, when the statement shows it. */
  counterpartyIbanLast4?: string;
  /**
   * Created by Kassa as the other side of a transfer into an account whose own
   * statements are not imported (e.g. a savings pocket). Replaced by the real
   * row if that account's statement is imported later (D-23).
   */
  isMirror?: boolean;
  /**
   * A move into the provisions account: the parts allocated to provisions
   * and trips (their category ids). The rest stays plain savings (D-65).
   */
  earmarks?: { categoryId: Id; amount: Cents }[];
  /** Legacy single pin (D-64): the whole move for one bucket. Read as `earmarks`. */
  earmarkCategoryId?: Id;
  /** A proposed classification waiting in the inbox (status 'suggested'). */
  suggestion?: Suggestion;
  /**
   * A balance adjustment typed by hand (D-88). Without allocations it is a
   * correction kept out of the budget lines: it changes the balance and Ready
   * to assign, never spending or the inbox.
   */
  adjustment?: boolean;
}

export interface Suggestion {
  targetType: TargetType;
  /** category/income: category id; transfer: the other account's id. */
  targetId: Id;
  confidence: number;
  decidedBy: DecidedBy;
  reason: string;
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
  /** Event spending: which sub-budget (flights, lodging…) it belongs to. */
  subBudget?: string;
}

// -------------------------------------------------------------- categories

export type CategoryGroup = 'fixed' | 'variable' | 'savings' | 'investments' | 'provisions' | 'events';
export const CATEGORY_GROUPS: readonly CategoryGroup[] = [
  'fixed',
  'variable',
  'savings',
  'investments',
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
  /**
   * Income paid at the end of a month for the next one (a salary): received
   * on or after this day of the month, it counts in the next month (D-74).
   */
  nextMonthFromDay?: number;
  /**
   * The first month whose late payment counts in the next month (D-92): the
   * month the household got a month ahead. Earlier payments count in the
   * month they arrive. Unset: from the budget start.
   */
  nextMonthStart?: MonthKey;
  /** Hidden from the budget once its event is closed and nothing is left in it. */
  archivedAt?: string;
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
  /** Target amount, needed by the target (due) date. */
  amount: Cents;
  /** Target date: the (first) due date. */
  dueDate: IsoDate;
  /** When saving starts; nothing is budgeted before it (D-49). */
  startDate?: IsoDate;
  /** RFC 5545 RRULE subset: "FREQ=MONTHLY;INTERVAL=n" or "FREQ=YEARLY;INTERVAL=n". Empty = one-off. */
  recurrence: string;
  /**
   * A recurring bill whose amount changes (e.g. tax advances): from the bill
   * due on `fromDue` on, each bill is `amount` (D-70). Sorted by date.
   */
  amountChanges?: { fromDue: IsoDate; amount: Cents }[];
  /** Cached for display; the truth is the linked category's available amount. */
  fundedBalance: Cents;
  monthlyContribution: Cents;
  /** The budget category (group Provisions) that holds the money set aside (D-33). */
  categoryId: Id;
}

export interface SubBudget {
  name: string;
  amount: Cents;
  /** When this part is needed (e.g. tickets bought in June for a December trip). Default: the trip date (D-54). */
  dueDate?: IsoDate;
  /** Marked paid: no more saving for this part after this month. */
  paidMonth?: MonthKey;
}

export type EventStatus = 'saving' | 'active' | 'closed';

export interface EventFund extends BaseRecord {
  name: string;
  targetAmount: Cents;
  targetDate: IsoDate;
  /** When saving starts (D-54). Default: the month the trip was created. */
  startDate?: IsoDate;
  subBudgets: SubBudget[];
  fundedBalance: Cents;
  status: EventStatus;
  closeDisposition?: { targetType: TargetType; targetId: Id; amount: Cents };
  /** The budget category (group Events) that saves for and pays the event (D-34). */
  categoryId: Id;
  closedAt?: string;
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
  /** 'expense' | 'income' | 'oneOff', or 'line': a change to one budget line (D-79). */
  type: string;
  start: MonthKey;
  end?: MonthKey;
  /** Signed for 'line' with mode 'adjust' and for 'oneOff'; otherwise positive. */
  amount: Cents;
  target?: { targetType: TargetType; targetId: Id };
  /** 'line' only: add `amount` (plus or minus) to the line's monthly amount, or set it to `amount` (0 = it stops). */
  mode?: 'adjust' | 'set';
}

export interface Scenario extends BaseRecord {
  name: string;
  baseScenarioId?: Id;
  changes: ScenarioChange[];
}

export type TaxRegime = '1' | '1a' | '2' | 'U' | 'T';

export interface TaxProfilePerson {
  name: string;
  grossSalary: Cents;
  withheld: Cents;
  travel?: Cents;
  pensionSavings?: Cents;
}

/** One tax year's inputs for the Luxembourg projection (M5, D-41). */
export interface TaxProfile extends BaseRecord {
  year: number;
  regime: TaxRegime;
  persons: TaxProfilePerson[];
  householdMembers: number;
  insurance: Cents;
  otherDeductions: Cents;
  otherIncome: Cents;
  /** Kept from the PRD model; the projection uses the per-person withheld amounts. */
  withholdingYtd: Cents;
  /** The parameter file used, e.g. "2026". */
  paramsVersion: string;
  /** Per-value overrides of the parameter file ("scale.3.rate" → 0.1). */
  overrides?: Record<string, number>;
  /** When the refund or payment is expected (for the forecast). */
  settleMonth?: MonthKey;
  inForecast?: boolean;
  /** Class 1a with a child in the household (single-parent credit). */
  singleParent?: boolean;
  /** How the full return is estimated from the ledger and the budget (D-95). */
  setup?: TaxSetup;
  /** Figures read from this year's tax documents (D-95); the files are not kept. */
  documents?: TaxDocumentRecord[];
}

/** One person on the return and where the app finds their salary (D-95). */
export interface TaxSetupPerson {
  name: string;
  /** Income lines that receive this person's net salary. */
  salaryCategoryIds: Id[];
  /** Taxable pay not received in the accounts (stock vesting, benefits), estimated. */
  extraGross?: Cents;
  /** Pay received that is exempt (the legal part of a severance), estimated, net. */
  exemptPay?: Cents;
  /** Per payer (from the rows on the salary lines): taxable or not. Default: taxable from 1,000 € a year. */
  payers?: Record<string, 'taxable' | 'exempt'>;
  birthYear?: number;
  /** Distance home–work in km (commuting deduction). */
  commuteKm?: number;
  pensionSavings?: Cents;
  homeSavings?: Cents;
}

export interface TaxSetup {
  persons: TaxSetupPerson[];
  /** Children in the household during the year (born in it included): they raise the per-member ceilings. */
  children?: number;
  /** Loans for the main residence (interest deductible within a ceiling). */
  homeLoanIds?: Id[];
  /** Year the rental value was fixed (first occupation). */
  homeSince?: number;
  /** Budget lines the quarterly advances are paid from. */
  advanceCategoryIds?: Id[];
  insurance?: Cents;
  donations?: Cents;
  /** Figures typed over the estimate, by key (e.g. "gross:Alex"). */
  overrides?: Record<string, Cents>;
  /** The provision the expected settlement feeds. */
  provisionId?: Id;
  /** The settlement last put into the plan (positive: to pay; negative: refund). */
  planned?: Cents;
}

/** A tax document as read (D-95): kind, year and figures only. */
export interface TaxDocumentRecord {
  id: Id;
  fileName: string;
  addedAt: string;
  kind: 'salary' | 'loan' | 'return' | 'assessment' | 'advances' | 'statement';
  year: number;
  subject?: string;
  values: Record<string, number>;
  schedule?: Record<string, Cents>;
  persons?: { name: string; values: Record<string, number> }[];
}

// ------------------------------------------------- import and reconcile

export type ImportFormat = 'csv' | 'csv-fund' | 'camt053' | 'ofx' | 'pdf-spuerkeess' | 'pdf-worldline';

/** One statement period of one account, as read from a file (PRD F5, F7). */
export interface Statement extends BaseRecord {
  accountId: Id;
  periodStart: IsoDate;
  periodEnd: IsoDate;
  openingBalance?: Cents;
  closingBalance?: Cents;
  importBatchId?: Id;
  /** Card statements: the amount the bank account will be debited, and when. */
  settlement?: { amount: Cents; date: IsoDate; fromAccountId?: Id; transactionId?: Id };
  lockedAt?: string;
}

export interface ImportReport {
  newCount: number;
  duplicateCount: number;
  skipped: { line: number; reason: string; text: string }[];
  transfersPaired: number;
  mirrorsCreated: number;
  mirrorsReplaced: number;
  suggestions: number;
  cardSettlementsLinked: number;
  /** Classified on import by a rule or by history (M4). */
  autoApplied?: number;
  warnings: string[];
}

export interface ImportBatch extends BaseRecord {
  fileName: string;
  format: ImportFormat;
  mappingId?: Id;
  accountIds: Id[];
  importedAt: string;
  report: ImportReport;
}

/** Saved CSV column mapping for one bank or card export layout (PRD F5). */
export interface BankMapping extends BaseRecord {
  name: string;
  /** Header row the layout must have; checked on every import. */
  headers: string[];
  delimiter: string; // '' = detect
  columns: {
    date: string;
    valueDate?: string;
    description: string;
    amount?: string;
    debit?: string;
    credit?: string;
    fee?: string;
    currency?: string;
    state?: string;
    balance?: string;
    accountKey?: string;
    counterparty?: string;
  };
  dateFormat: 'auto' | 'dmy' | 'ymd' | 'mdy';
  decimal: 'comma' | 'dot';
  /** Rows whose state column holds another value are skipped and reported. */
  okStates: string[];
  /** Account chosen last time for each sub-account key (e.g. Revolut "Product"). */
  lastAccounts: Record<string, Id>;
  builtIn?: boolean;
}

// ---------------------------------------------------------------- settings

export interface Member {
  id: Id;
  name: string;
}

/** Household settings: one record, stored encrypted like the rest (DECISIONS.md D-05). */
export interface Settings {
  id: 'settings';
  budgetStartMonth: MonthKey;
  /** Category that receives unspent money from categories in "sweep" mode. */
  sweepTargetCategoryId?: Id;
  autoLockMinutes: number;
  lastBackupAt?: string;
  /** People in the household; accounts can belong to one of them or be joint. */
  members?: Member[];
  /** Forecast: warn about the first month the cash total falls below this. */
  minimumBuffer?: Cents;
  /** History matches at or above this confidence are applied without review (default 0.92). */
  autoApplyThreshold?: number;
  /** Savings account where the money for provisions and trips is kept (D-55). */
  provisionsAccountId?: Id;
  /** The Investments category was created once (D-57); not recreated if deleted. */
  investmentsSetUp?: boolean;
  /** "Keep as is" on the hint about monthly amounts starting after the budget start. */
  lateAmountsKept?: boolean;
  /** False: the Emergency fund is not filled automatically with free savings (D-75). Default on. */
  freeSavingsAuto?: boolean;
  /** Insights dismissed on the Insights page (D-88), by key. */
  dismissedInsights?: string[];
  /** Overspending covered from an account, newest last (D-88). */
  covers?: Cover[];
  /** Covers are kept as their own amounts, not in the budget (D-94): migration done. */
  coversOwn?: boolean;
  /** Months closed, with the lines whose gap was left for the next month (D-89). */
  closedMonths?: { month: MonthKey; left: Id[] }[];
  /** Merchants whose rule proposal was dismissed. */
  dismissedRuleProposals?: string[];
  /** Optional Claude fallback for transactions nothing else recognises (opt-in, D-37). */
  ai?: { enabled: boolean; apiKey: string };
  updatedAt: string;
}

/**
 * Overspending in a budget line covered this month, with the account the
 * money comes from (D-88): the budget line gets the amount from Ready to
 * assign, and the transfers out of that account from then on are shown with it.
 */
export interface Cover {
  id: Id;
  categoryId: Id;
  month: MonthKey;
  amount: Cents;
  /** The account the money comes from; none when it simply comes from Ready to assign. */
  fromAccountId?: Id;
  /** Another budget line that gave the money (D-89); none: Ready to assign. */
  fromCategoryId?: Id;
  note?: string;
  at: string;
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
  statements: Statement;
  importBatches: ImportBatch;
  bankMappings: BankMapping;
  settings: Settings;
}

export type StoreName = keyof StoreRecords;

/** The twelve PRD stores, three import stores (D-20) and the settings record. */
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
  'statements',
  'importBatches',
  'bankMappings',
  'settings',
];

export type StoreSnapshot = { [K in StoreName]: StoreRecords[K][] };
