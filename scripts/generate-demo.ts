/**
 * Generates fixtures/demo-household.json: an anonymised Luxembourg household
 * with six full months (April to September 2026) plus the first ten days of
 * October. Deterministic: same output on every run.
 *
 *   npm run demo:generate
 *
 * Design (see README "Demo data"):
 * - The household is one month ahead: the salary that lands on the 25th funds
 *   next month, so the current month's Ready to assign is 0.00 before payday.
 * - October holds one uncategorised direct debit, so the demo opens with
 *   Ready to assign at −24,99 € and one item to categorise. Categorise it and
 *   Ready to assign reaches 0.00 (the M1 exit gate).
 */
import { writeFileSync } from 'node:fs';
import { budgetForMonth } from '../src/domain/budget';
import { buildManualEntry, type Clock, type EntryTarget } from '../src/domain/ledger';
import type { Account, BudgetDefault, BudgetOverride, Category, CategoryGroup, Cents, RolloverMode, Settings } from '../src/domain/types';
import { emptySnapshot, toPlainExport } from '../src/storage/backup';

let seed = 20261010;
const rand = () => {
  seed = (seed * 1664525 + 1013904223) % 2 ** 32;
  return seed / 2 ** 32;
};
const between = (lo: number, hi: number): Cents => Math.round((lo + rand() * (hi - lo)) * 100);
const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)]!;

let idn = 0;
const hex = () => Math.floor(rand() * 16).toString(16);
const uuid = () => `${'xxxxxxxx-xxxx-4xxx-8xxx-xxxxxxxxxxxx'.replace(/x/g, hex)}`;
const STAMP = '2026-10-10T08:00:00.000Z';
const clock: Clock = { now: () => STAMP, newId: () => (idn++, uuid()) };
const meta = () => ({ id: uuid(), createdAt: STAMP, updatedAt: STAMP, source: 'demo' as const });

const snap = emptySnapshot();

// ---------------------------------------------------------------- accounts
// Two people, like a typical Luxembourg couple: a joint current account,
// one credit card each (paid from the joint account), one Revolut each, and a
// Revolut "Compte flexible" that holds the savings and provisions money.
const ALEX = uuid();
const SAM = uuid();
const acc = (name: string, type: Account['type'], institution: string, last4: string, opening: Cents, owner: string, extra: Partial<Account> = {}): string => {
  const a: Account = { ...meta(), name, type, institution, ibanLast4: last4, openingBalance: opening, owner, ...extra };
  snap.accounts.push(a);
  return a.id;
};
const current = acc('Joint current account', 'current', 'Spuerkeess', '0421', 745000, 'joint');
const alexRevolut = acc('Alex Revolut', 'current', 'Revolut', '7731', 12000, ALEX);
const savings = acc('Compte flexible', 'savings', 'Revolut', '', 1500000, ALEX, { matchHints: ['Compte flexible'] });
const card = acc('Alex Visa', 'card', 'Spuerkeess (Worldline)', '7710', 0, ALEX, { settlementAccountId: current });
const samCard = acc('Sam Visa', 'card', 'Spuerkeess (Worldline)', '5502', 0, SAM, { settlementAccountId: current });
const cash = acc('Sam Revolut', 'current', 'Revolut', '3388', 0, SAM);

// -------------------------------------------------------------- categories
let order = 0;
const cat = (name: string, groupId: CategoryGroup, rolloverMode: RolloverMode, isIncome = false): string => {
  const c: Category = { ...meta(), name, groupId, rolloverMode, isIncome, sortOrder: order++ };
  snap.categories.push(c);
  return c.id;
};
const salaryA = cat('Salary (Alex)', 'fixed', 'reset', true);
const salaryB = cat('Salary (Sam)', 'fixed', 'reset', true);
const otherIncome = cat('Other income', 'fixed', 'reset', true);
const C = {
  rent: cat('Rent', 'fixed', 'reset'),
  energy: cat('Energy', 'fixed', 'roll'),
  phone: cat('Phone & internet', 'fixed', 'reset'),
  groceries: cat('Groceries', 'variable', 'roll'),
  eatingOut: cat('Eating out', 'variable', 'roll'),
  fuel: cat('Fuel & parking', 'variable', 'roll'),
  health: cat('Health', 'variable', 'roll'),
  clothing: cat('Clothing', 'variable', 'roll'),
  fun: cat('Fun money', 'variable', 'sweep'),
  emergency: cat('Emergency fund', 'savings', 'roll'),
  pension: cat('Pension plan (111bis)', 'savings', 'roll'),
  carInsurance: cat('Car insurance', 'provisions', 'roll'),
  trip: cat('Summer trip', 'events', 'roll'),
};

const START = '2026-04';
const def = (categoryId: string, amount: Cents) => {
  const d: BudgetDefault = { ...meta(), categoryId, monthlyAmount: amount, effectiveFrom: START };
  snap.budgetDefaults.push(d);
};
const plan: [string, Cents][] = [
  [C.rent, 195000], [C.energy, 18000], [C.phone, 8990],
  [C.groceries, 65000], [C.eatingOut, 25000], [C.fuel, 20000], [C.health, 8000], [C.clothing, 12000], [C.fun, 15000],
  [C.pension, 30000], [C.carInsurance, 10000], [C.trip, 50000],
];
const INCOME = 360000 + 235000;
const planned = plan.reduce((s, [, a]) => s + a, 0);
plan.push([C.emergency, INCOME - planned]);
for (const [id, a] of plan) def(id, a);

const ovr = (categoryId: string, month: string, amount: Cents, note: string) => {
  const o: BudgetOverride = { ...meta(), categoryId, month, amount, note };
  snap.budgetOverrides.push(o);
};
ovr(C.groceries, '2026-12', 90000, 'Christmas');
ovr(C.clothing, '2026-09', 27000, 'Back to school');
ovr(C.fun, '2026-09', 0, 'Paused for back to school');
// April also assigns the opening balances (except one month of income kept ahead).
ovr(C.carInsurance, '2026-04', 90000, 'Already saved before using Kassa');

const settings: Settings = {
  id: 'settings',
  budgetStartMonth: START,
  sweepTargetCategoryId: C.emergency,
  autoLockMinutes: 15,
  members: [{ id: ALEX, name: 'Alex' }, { id: SAM, name: 'Sam' }],
  updatedAt: STAMP,
};
snap.settings.push(settings);

// ------------------------------------------------------------ transactions
const add = (accountId: string, date: string, amount: Cents, description: string, target: EntryTarget, extra: { originalCurrency?: string; originalAmount?: Cents; counterparty?: string } = {}) => {
  const w = buildManualEntry({ accountId, date, amount, description, target, ...extra }, clock);
  for (const t of w.transactions) t.source = 'demo';
  for (const a of w.allocations) a.source = 'demo';
  snap.transactions.push(...w.transactions);
  snap.allocations.push(...w.allocations);
  return w.transactions[0]!;
};
const spend = (accountId: string, date: string, amount: Cents, description: string, categoryId: string, extra = {}) =>
  add(accountId, date, -amount, description, { kind: 'category', categoryId }, extra);
const d = (month: string, day: number) => `${month}-${day.toString().padStart(2, '0')}`;

const groceryShops = ['CACTUS BERELDANGE', 'DELHAIZE LUXEMBOURG GARE', 'LIDL STRASSEN', 'AUCHAN KIRCHBERG', 'ALDI HOWALD'];
const restaurants = ['BRASSERIE GUILLAUME', 'BOULANGERIE FISCHER', 'CAFE DES ARTISTES', 'PIZZERIA ROMA', 'SUSHI SHOP CLAUSEN'];
const fuel = ['ARAL BERCHEM', 'SHELL GASPERICH', 'Q8 MERSCH', 'PARKING GLACIS'];
const fun = ['KINEPOLIS KIRCHBERG', 'LIBRAIRIE ERNSTER', 'PHILHARMONIE LUXEMBOURG', 'STEAM GAMES'];
const months = ['2026-04', '2026-05', '2026-06', '2026-07', '2026-08', '2026-09'];
const cardTotals = new Map<string, Cents>();
const onCard = (month: string, amount: Cents) => cardTotals.set(month, (cardTotals.get(month) ?? 0) + amount);
const samCardTotals = new Map<string, Cents>();

/** Spend `total` across several shops with random weights; the parts sum exactly to `total`. */
function spread(month: string, categoryId: string, total: Cents, count: number, shops: string[], cardShare = 0.5, other = current) {
  const weights = Array.from({ length: count }, () => 0.5 + rand());
  const sum = weights.reduce((a, b) => a + b, 0);
  let left = total;
  for (let i = 0; i < count; i++) {
    const amount = i === count - 1 ? left : Math.round((total * weights[i]!) / sum);
    left -= amount;
    if (amount <= 0) continue;
    const useCard = rand() < cardShare;
    spend(useCard ? card : other, d(month, 2 + Math.floor((26 * i) / count)), amount, pick(shops), categoryId);
    if (useCard) onCard(month, amount);
  }
}

for (const [i, month] of months.entries()) {
  spend(current, d(month, 1), 195000, 'SEPA TRANSFER RENT LANDLORD', C.rent);
  spend(current, d(month, 2), 30000, 'SEPA DD PENSION PLAN INSURER', C.pension);
  spend(current, d(month, 6), between(150, 200), 'SEPA DD ENERGY SUPPLIER', C.energy);
  spend(current, d(month, 10), 8990, 'SEPA DD TELECOM OPERATOR', C.phone);
  add(current, d(month, 3), -(INCOME - planned), 'STANDING ORDER IN FAVOUR OF ALEX — Provisions', { kind: 'transfer', toAccountId: alexRevolut });
  add(alexRevolut, d(month, 3), -(INCOME - planned), 'To EUR Compte flexible', { kind: 'transfer', toAccountId: savings });
  spread(month, C.groceries, between(590, 660), 9, groceryShops);
  spread(month, C.eatingOut, between(200, 290), 4, restaurants, 0.7);
  spread(month, C.fuel, between(170, 230), 3, fuel, 0.3);
  if (month !== '2026-09') spread(month, C.fun, between(90, 150), 2, fun, 0, alexRevolut);
  spend(current, d(month, 14), between(5, 30), 'MEDI-MARKET', C.health);
  if (i % 2 === 1 || month === '2026-09') spread(month, C.clothing, month === '2026-09' ? 25000 : between(150, 260), 2, ['ZARA ROYAL HAMILTON', 'DECATHLON BERTRANGE', 'C&A CLOCHE D OR'], 0.8);
  // Pocket money to each Revolut; small spending happens there.
  add(current, d(month, 2), -15000, 'STANDING ORDER IN FAVOUR OF ALEX', { kind: 'transfer', toAccountId: alexRevolut });
  add(current, d(month, 12), -10000, 'STANDING ORDER IN FAVOUR OF SAM', { kind: 'transfer', toAccountId: cash });
  spend(cash, d(month, 13), between(25, 60), 'Marché Glacis', C.groceries);
  spend(samCard, d(month, 16), between(30, 70), 'PHARMACIE DU CENTRE', C.health);
  samCardTotals.set(month, (samCardTotals.get(month) ?? 0) + (snap.transactions.at(-1)!.amount * -1));
  // Salaries: one month ahead, they fund next month's budget.
  add(current, d(month, 25), 360000, 'SALARY EMPLOYER A', { kind: 'income', categoryId: salaryA });
  add(current, d(month, 26), 235000, 'SALARY EMPLOYER B', { kind: 'income', categoryId: salaryB });
}

// June: car insurance paid from the savings built up in its category.
spend(current, '2026-06-15', 120000, 'SEPA DD CAR INSURER ANNUAL PREMIUM', C.carInsurance);
// A refund counted as other income.
add(current, '2026-07-18', 4250, 'REFUND ONLINE SHOP', { kind: 'income', categoryId: otherIncome });

// August: the summer trip, mostly on the card, some in GBP.
const trip: [number, number, string, string?, number?][] = [
  [2, 41200, 'LUXAIR FLIGHTS'], [3, 12890, 'AIRBNB LISBON'], [4, 6420, 'PASTEIS DE BELEM'], [5, 3870, 'UBER LISBON'],
  [6, 9210, 'TIME OUT MARKET LISBON'], [7, 5600, 'OCEANARIO LISBOA'], [8, 15880, 'TAP AIR PORTUGAL'],
  [9, 21340, 'HOTEL LONDON BRIDGE', 'GBP', 18400], [10, 5890, 'PRET A MANGER LONDON', 'GBP', 5020],
  [10, 4320, 'TFL TRAVEL CHARGE', 'GBP', 3700], [11, 7600, 'BRITISH MUSEUM SHOP', 'GBP', 6510],
  [11, 11850, 'DISHOOM SHOREDITCH', 'GBP', 10150], [12, 3260, 'HEATHROW EXPRESS', 'GBP', 2800], [12, 2900, 'WHSMITH HEATHROW', 'GBP', 2480],
];
for (const [day, amount, desc, ccy, orig] of trip) {
  spend(card, d('2026-08', day), amount, desc, C.trip, ccy ? { originalCurrency: ccy, originalAmount: -orig! } : {});
  onCard('2026-08', amount);
}

// Card settlement on the 5th: a transfer from the current account, never spending.
for (const month of months) {
  const total = cardTotals.get(month) ?? 0;
  const next = month === '2026-09' ? '2026-10' : months[months.indexOf(month) + 1]!;
  if (total > 0) add(current, d(next, 7), -total, 'DIRECT DEBIT ••7710 CARTE VISA', { kind: 'transfer', toAccountId: card });
  const samTotal = samCardTotals.get(month) ?? 0;
  if (samTotal > 0) add(current, d(next, 7), -samTotal, 'DIRECT DEBIT ••5502 CARTE VISA', { kind: 'transfer', toAccountId: samCard });
}

// October 1 to 10: the month in progress.
spend(current, '2026-10-01', 195000, 'SEPA TRANSFER RENT LANDLORD', C.rent);
spend(current, '2026-10-02', 30000, 'SEPA DD PENSION PLAN INSURER', C.pension);
add(current, '2026-10-03', -(INCOME - planned), 'STANDING ORDER IN FAVOUR OF ALEX — Provisions', { kind: 'transfer', toAccountId: alexRevolut });
add(alexRevolut, '2026-10-03', -(INCOME - planned), 'To EUR Compte flexible', { kind: 'transfer', toAccountId: savings });
spend(current, '2026-10-06', 17640, 'SEPA DD ENERGY SUPPLIER', C.energy);
spend(card, '2026-10-04', 8735, 'CACTUS BERELDANGE', C.groceries);
spend(card, '2026-10-08', 6212, 'DELHAIZE LUXEMBOURG GARE', C.groceries);
spend(current, '2026-10-07', 4380, 'BRASSERIE GUILLAUME', C.eatingOut);
spend(current, '2026-10-09', 6890, 'ARAL BERCHEM', C.fuel);
add(current, '2026-10-08', -2499, 'SEPA DD 0042 STREAMING SERVICE', { kind: 'none' });

// ------------------------------------------------------- April assignment
// Assign the opening balances so April starts one month ahead: Ready to assign
// at the end of April equals April's income, which funds May.
const input = () => ({
  startMonth: START, categories: snap.categories, defaults: snap.budgetDefaults, overrides: snap.budgetOverrides,
  accounts: snap.accounts, transactions: snap.transactions, allocations: snap.allocations, sweepTargetCategoryId: C.emergency,
});
const aprilBefore = budgetForMonth(input(), '2026-04')!.readyToAssign;
const emergencyDefault = INCOME - planned;
ovr(C.emergency, '2026-07', emergencyDefault + 4250, 'Refund saved');
ovr(C.emergency, '2026-04', emergencyDefault + aprilBefore - INCOME, 'Opening savings assigned');

const check = (month: string) => budgetForMonth(input(), month)!.readyToAssign;
for (const m of months) if (check(m) !== INCOME) throw new Error(`${m}: Ready to assign ${check(m)} ≠ ${INCOME}`);
if (check('2026-10') !== -2499) throw new Error(`October Ready to assign ${check('2026-10')}`);

const out = await toPlainExport(snap, new Date(STAMP));
writeFileSync(new URL('../fixtures/demo-household.json', import.meta.url), JSON.stringify(out, null, 1) + '\n');
console.log(`Wrote ${snap.transactions.length} transactions, ${snap.categories.length} categories, hash ${out.hash.slice(0, 16)}`);
