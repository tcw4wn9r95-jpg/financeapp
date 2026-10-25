import { accountBalances, defaultFor } from '../budget';
import { addMonths, compareMonths, monthOf, monthRange } from '../dates';
import type { Account, Allocation, BudgetDefault, BudgetOverride, Category, Cents, Id, IsoDate, MonthKey, Provision, TaxDocumentRecord, TaxSetup, TaxSetupPerson, Transaction } from '../types';
import { formatMoney } from '../money';
import type { TaxClass, TaxParams } from './lu';
import type { Figure, ReturnInput, ReturnPerson } from './return';

/**
 * The year's return estimated from what the app knows (D-95), each figure
 * from the best source there is:
 * 1. this year's documents (salary certificates, loan certificates, the
 *    advances bulletin and statement);
 * 2. the ledger and the budget: net salary received so far plus what the
 *    income lines expect for the rest of the year, turned into gross pay,
 *    social contributions and withholding with last year's certificate;
 *    home-loan interest from the loans' balances and rates; advances from
 *    the lines they are paid from;
 * 3. last year's documents (premiums, complementary pension, when the home
 *    was first occupied);
 * 4. what the user typed, which always wins.
 */

export interface EstimateContext {
  year: number;
  today: IsoDate;
  regime: TaxClass;
  params: TaxParams;
  /** Last year's parameters, to carry contribution-rate changes over. */
  paramsLastYear?: TaxParams;
  setup: TaxSetup;
  /** Documents of every year (this year's and last year's are used). */
  documents: readonly TaxDocumentRecord[];
  accounts: readonly Account[];
  transactions: readonly Transaction[];
  allocations: readonly Allocation[];
  categories: readonly Category[];
  defaults: readonly BudgetDefault[];
  overrides: readonly BudgetOverride[];
  provisions: readonly Provision[];
}

export interface PayerTrace {
  key: string;
  received: Cents;
  rows: number;
  /** The last payment date. */
  last: IsoDate;
  treatment: 'taxable' | 'exempt';
  /** Received up to the end of the latest payslip's period (already in its year-to-date figures). */
  untilSlip: Cents;
  /** Months after the payslip in which this payer paid. */
  monthsAfterSlip: number;
}

export interface SalaryTrace {
  received: Cents;
  planned: Cents;
  /** Received from payers marked not taxable. */
  exempt: Cents;
  payers: PayerTrace[];
  /** Gross per euro of net pay, from the payslip or last year's certificate. */
  grossPerNet?: number;
  /** The latest payslip's year-to-date figures, when one was added. */
  payslip?: { month: number; issuer?: string; gross: Cents; withheld: Cents; received: Cents };
  /** Tax withheld from pay so far this year (payslip, then estimated on what was received since). */
  withheldSoFar?: Cents;
  /** Tax still to be withheld on the pay planned to December. */
  withheldAhead?: Cents;
}

/** Who paid: the counterparty, or the bank text's first words. */
export function payerOf(t: Pick<Transaction, 'counterparty' | 'descriptionRaw'>): string {
  const raw = (t.counterparty || t.descriptionRaw).replace(/^(?:CREDIT TRANSFER FROM|INSTANT CREDIT TRANSFER FROM|PAYMENT FROM|VIREMENT DE)\s+/i, '');
  return raw.split(/\s+[—-]\s+|\s{2,}/)[0]!.trim().toUpperCase().slice(0, 40);
}

export interface Estimate {
  input: ReturnInput;
  salaries: Record<string, SalaryTrace>;
  /** Things the estimate lacks, by key, for the screen to ask about. */
  missing: string[];
}

const words = (s: string) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').split(/[^a-z]+/).filter((w) => w.length > 1);

/** A document's person matches a household member when the member's name appears in it. */
export function sameName(docName: string | undefined, name: string): boolean {
  if (!docName) return false;
  const doc = new Set(words(docName));
  const own = words(name);
  return own.length > 0 && own.every((w) => doc.has(w) || [...doc].some((d) => d.startsWith(w) || w.startsWith(d)));
}

const fig = (amount: Cents, source: Figure['source'], note?: string): Figure => ({ amount, source, ...(note ? { note } : {}) });

/** Last year's pay as certified: from the salary certificate, or the return as filed. */
function certified(docs: readonly TaxDocumentRecord[], year: number, name: string): Record<string, number> | undefined {
  const cert = docs.find((d) => d.kind === 'salary' && d.year === year && sameName(d.subject, name));
  if (cert) return cert.values;
  const ret = docs.find((d) => d.kind === 'return' && d.year === year);
  return ret?.persons?.find((p) => sameName(p.name, name))?.values;
}

/** What an income line expects in a budget month. */
function expected(ctx: EstimateContext, id: Id, month: MonthKey): Cents {
  return ctx.overrides.find((o) => o.categoryId === id && o.month === month)?.amount ?? defaultFor(ctx.defaults, id, month)?.monthlyAmount ?? 0;
}

/**
 * Net pay received in the calendar year so far, by payer, and what the income
 * lines still expect (counted with the payer that paid last).
 */
export function salaryForYear(ctx: EstimateContext, categoryIds: readonly Id[], treatments: Record<string, 'taxable' | 'exempt'> = {}, slipEnd?: IsoDate): SalaryTrace {
  const ids = new Set(categoryIds);
  const byId = new Map(ctx.transactions.map((t) => [t.id, t]));
  const paidMonths = new Set<string>();
  const payers = new Map<string, PayerTrace>();
  const afterSlip = new Map<string, Set<MonthKey>>();
  for (const a of ctx.allocations) {
    if (a.targetType !== 'income' || !ids.has(a.targetId)) continue;
    const t = byId.get(a.transactionId);
    if (!t || !t.date.startsWith(String(ctx.year)) || t.date > ctx.today) continue;
    const key = payerOf(t);
    const p = payers.get(key) ?? { key, received: 0, rows: 0, last: t.date, treatment: 'taxable' as const, untilSlip: 0, monthsAfterSlip: 0 };
    p.received += a.amount;
    if (slipEnd && t.date <= slipEnd) p.untilSlip += a.amount;
    else if (slipEnd && !(afterSlip.get(key) ?? new Set()).has(monthOf(t.date))) {
      afterSlip.set(key, (afterSlip.get(key) ?? new Set()).add(monthOf(t.date)));
      p.monthsAfterSlip++;
    }
    p.rows++;
    if (t.date > p.last) p.last = t.date;
    payers.set(key, p);
    paidMonths.add(`${monthOf(t.date)}|${a.targetId}`);
  }
  for (const p of payers.values()) p.treatment = treatments[p.key] ?? (p.received >= 100_000 ? 'taxable' : 'exempt');
  let planned = 0;
  const current = monthOf(ctx.today);
  const first = compareMonths(current, `${ctx.year}-01`) > 0 ? current : `${ctx.year}-01`;
  if (compareMonths(first, `${ctx.year}-12`) <= 0) {
    for (const m of monthRange(first, `${ctx.year}-12`)) {
      for (const id of ids) {
        if (paidMonths.has(`${m}|${id}`)) continue;
        // A salary paid at the end of a month for the next one is budgeted in the next month.
        const c = ctx.categories.find((x) => x.id === id);
        const forNext = c?.nextMonthFromDay && (!c.nextMonthStart || compareMonths(m, c.nextMonthStart) >= 0);
        planned += expected(ctx, id, forNext ? addMonths(m, 1) : m);
      }
    }
  }
  const list = [...payers.values()].sort((a, b) => b.received - a.received);
  const taxable = list.filter((p) => p.treatment === 'taxable').reduce((s, p) => s + p.received, 0);
  const exempt = list.filter((p) => p.treatment === 'exempt').reduce((s, p) => s + p.received, 0);
  return { received: taxable, planned, exempt, payers: list };
}

/** Interest a loan charges over the year: balances from the ledger, then the payments ahead. */
function loanInterest(ctx: EstimateContext, loan: Account, rate: number): Cents {
  const current = monthOf(ctx.today);
  let interest = 0;
  let owed = 0;
  for (const m of monthRange(`${ctx.year}-01`, `${ctx.year}-12`)) {
    if (compareMonths(m, current) <= 0) {
      const day = `${addMonths(m, -1)}-31`;
      owed = -(accountBalances([loan], ctx.transactions, day).get(loan.id) ?? 0);
    } else if (loan.monthlyPayment) {
      // Ahead: what the payment leaves after the month's interest.
      owed = Math.max(0, owed - Math.max(0, loan.monthlyPayment - Math.round((owed * rate) / 1200)));
    }
    interest += Math.round((Math.max(0, owed) * rate) / 1200);
  }
  return interest;
}

export function estimateReturn(ctx: EstimateContext): Estimate {
  const { year, setup, documents: docs } = ctx;
  const ov = setup.overrides ?? {};
  const missing: string[] = [];
  const salaries: Record<string, SalaryTrace> = {};
  const withOverride = (key: string, f: Figure): Figure => (ov[key] !== undefined ? fig(ov[key]!, 'estimate', 'typed') : f);

  const persons: ReturnPerson[] = setup.persons.map((sp) => {
    const doc = certified(docs, year, sp.name);
    const last = certified(docs, year - 1, sp.name);
    let gross: Figure;
    let social: Figure;
    let withheld: Figure;
    let lrcp: Figure;
    if (doc?.gross !== undefined) {
      gross = fig(doc.gross, 'document');
      social = fig(doc.social ?? 0, 'document');
      withheld = fig(doc.withheld ?? 0, 'document');
      lrcp = fig(doc.lrcp ?? 0, 'document');
    } else {
      // The latest payslip of the year gives gross, contributions and tax to its month end.
      const slip = docs.filter((d) => d.kind === 'payslip' && d.year === year && sameName(d.subject, sp.name)).sort((a, b) => (b.values.month ?? 0) - (a.values.month ?? 0))[0];
      const slipEnd = slip ? `${year}-${String(slip.values.month).padStart(2, '0')}-31` : undefined;
      const trace = salaryForYear(ctx, sp.salaryCategoryIds, sp.payers, slipEnd);
      salaries[sp.name] = trace;
      // Pay from the payslip's employer up to its month end is in its figures already.
      const employer = slip?.issuer ? words(slip.issuer).filter((w) => w.length >= 3 && !['sarl', 'sàrl', 'eu', 'sa', 'ltd', 'gmbh', 'luxembourg'].includes(w)) : [];
      const taxable = trace.payers.filter((p) => p.treatment === 'taxable');
      const fromEmployer = taxable.filter((p) => employer.some((w) => words(p.key).includes(w)));
      const slipPayers = slip ? (fromEmployer.length ? fromEmployer : taxable) : [];
      const inSlip = slipPayers.reduce((s, p) => s + p.untilSlip, 0);
      const receivedAfter = trace.received - inSlip;
      // Exempt pay (the legal part of a severance) is not grossed up.
      const restNet = Math.max(0, receivedAfter + trace.planned - (sp.exemptPay ?? 0));
      const ref = slip?.values ?? last;
      if (ref?.gross) {
        // Net pay = gross − social − dependence − withholding − complementary pension.
        const refNet = ref.gross - (ref.social ?? 0) - (ref.dependence ?? 0) - (ref.withheld ?? 0) - (ref.lrcp ?? 0);
        const ratio = refNet > 0 ? ref.gross / refNet : 1;
        trace.grossPerNet = ratio;
        const restGross = Math.round(restNet * ratio) + (sp.extraGross ?? 0);
        // Contribution rates may change from one year to the next (a payslip is this year's already).
        const rates = (p?: TaxParams) => (p ? p.social.pension + p.social.health : 1);
        const rateChange = !slip && ctx.paramsLastYear ? rates(ctx.params) / rates(ctx.paramsLastYear) : 1;
        const share = (k: string) => (ref[k] ?? 0) / ref.gross!;
        const withheldOn = (netPay: number) => Math.round(Math.max(0, netPay) * ratio * share('withheld'));
        const s0 = slip?.values;
        const g = (s0?.gross ?? 0) + restGross;
        const srcRest: Figure['source'] = slip ? 'ledger' : 'lastYear';
        gross = fig(g, 'ledger', slip ? `payslip to ${monthOf(slipEnd!)}, then net received and planned grossed up with its ratio` : 'net received and planned, grossed up with last year’s certificate');
        social = fig((s0?.social ?? 0) + Math.round(restGross * share('social') * rateChange), srcRest);
        withheld = fig((s0?.withheld ?? 0) + Math.round(restGross * share('withheld')), srcRest);
        const lrcpMonth = slip ? (s0!.lrcp ?? 0) / (s0!.month ?? 12) : 0;
        lrcp = slip ? fig(Math.round((s0!.lrcp ?? 0) + lrcpMonth * Math.max(0, ...slipPayers.map((p) => p.monthsAfterSlip))), 'document') : fig(last?.lrcp ?? 0, 'lastYear');
        if (slip) trace.payslip = { month: s0!.month ?? 0, ...(slip.issuer ? { issuer: slip.issuer } : {}), gross: s0!.gross ?? 0, withheld: s0!.withheld ?? 0, received: inSlip };
        trace.withheldSoFar = (s0?.withheld ?? 0) + withheldOn(receivedAfter - (sp.exemptPay ?? 0));
        trace.withheldAhead = withheld.amount - trace.withheldSoFar;
      } else {
        missing.push(`certificate:${sp.name}`);
        gross = fig(restNet + (sp.extraGross ?? 0), 'ledger', 'net pay only: add last year’s salary certificate');
        social = fig(0, 'model');
        withheld = fig(0, 'model');
        lrcp = fig(0, 'model');
      }
    }
    const young = sp.birthYear ? year - sp.birthYear - 1 <= (ctx.params.household?.homeSavings.youngUntilAge ?? 40) : undefined;
    const t = ctx.params.household?.travel;
    const travelAmount = sp.commuteKm && t ? Math.round(Math.max(0, sp.commuteKm - t.freeUnits) * t.perUnit * 100) : 0;
    return {
      name: sp.name,
      gross: withOverride(`gross:${sp.name}`, gross),
      social: withOverride(`social:${sp.name}`, social),
      lrcp: withOverride(`lrcp:${sp.name}`, lrcp),
      withheld: withOverride(`withheld:${sp.name}`, withheld),
      ...(travelAmount ? { travel: fig(travelAmount, 'estimate', `${sp.commuteKm} km`) } : {}),
      ...(sp.pensionSavings ? { pensionSavings: fig(sp.pensionSavings, 'estimate') } : {}),
      ...(sp.homeSavings ? { homeSavings: fig(sp.homeSavings, 'estimate') } : {}),
      ...(young !== undefined ? { young } : {}),
    };
  });

  // Own-home loan interest.
  const loanDocs = docs.filter((d) => d.kind === 'loan');
  const homeLoans = ctx.accounts.filter((a) => (setup.homeLoanIds ?? []).includes(a.id));
  const isHomeDoc = (d: TaxDocumentRecord) => {
    const end = d.values.balanceEnd ?? 0;
    const match = ctx.accounts
      .filter((a) => a.type === 'loan')
      .map((a) => ({ a, gap: Math.abs(-(accountBalances([a], ctx.transactions, `${d.year}-12-31`).get(a.id) ?? 0) - end) }))
      .sort((x, y) => x.gap - y.gap)[0];
    if (match && match.gap <= end * 0.02) return homeLoans.some((h) => h.id === match.a.id);
    return end >= 5_000_000; // a large loan is the home
  };
  const thisYearLoans = loanDocs.filter((d) => d.year === year && isHomeDoc(d));
  let homeInterest: Figure;
  if (thisYearLoans.length) {
    homeInterest = fig(thisYearLoans.reduce((s, d) => s + (d.values.interest ?? 0), 0), 'document', `${thisYearLoans.length} loan certificates`);
  } else if (homeLoans.length) {
    let sum = 0;
    for (const loan of homeLoans) {
      const lastDoc = loanDocs
        .filter((d) => d.year === year - 1)
        .map((d) => ({ d, gap: Math.abs((d.values.balanceEnd ?? 0) + (accountBalances([loan], ctx.transactions, `${year - 1}-12-31`).get(loan.id) ?? 0)) }))
        .sort((x, y) => x.gap - y.gap)[0]?.d;
      const rate = loan.interestRate ?? (lastDoc?.values.rate !== undefined ? lastDoc.values.rate / 100 : undefined);
      if (rate) sum += loanInterest(ctx, loan, rate);
      else missing.push(`rate:${loan.id}`);
    }
    homeInterest = fig(sum, 'ledger', 'loan balances × rate, month by month');
  } else {
    const lastYear = loanDocs.filter((d) => d.year === year - 1 && isHomeDoc(d)).reduce((s, d) => s + (d.values.interest ?? 0), 0);
    homeInterest = fig(lastYear, lastYear ? 'lastYear' : 'model');
    if (!lastYear) missing.push('homeLoans');
  }
  const lastReturn = docs.find((d) => d.kind === 'return' && d.year === year - 1) ?? docs.filter((d) => d.kind === 'return').sort((a, b) => b.year - a.year)[0];
  const homeSince = setup.homeSince ?? lastReturn?.values.homeSince;

  // Insurance premiums and consumer-loan interest (art. 111): last year's premiums unless typed.
  const insurance: Figure = setup.insurance !== undefined ? fig(setup.insurance, 'estimate') : lastReturn?.values.insurance !== undefined ? fig(lastReturn.values.insurance, 'lastYear') : fig(0, 'model');

  // Quarterly advances due for the year: from the documents that fix them, else from the lines they are paid from.
  const schedule: Record<MonthKey, Cents> = {};
  for (const d of [...docs].filter((d) => d.schedule).sort((a, b) => a.addedAt.localeCompare(b.addedAt))) {
    for (const [m, v] of Object.entries(d.schedule!)) if (m.startsWith(String(year))) schedule[m] = v;
  }
  let advances: Figure;
  const settled = docs.find((d) => d.kind === 'statement' && d.year === year);
  if (settled?.values.paid !== undefined) {
    advances = fig(settled.values.paid, 'document', 'paid, as on the statement of account');
  } else if (Object.keys(schedule).length) {
    advances = fig(Object.values(schedule).reduce((s, v) => s + v, 0), 'document', Object.entries(schedule).sort().map(([m, v]) => `${m}: ${formatMoney(v)}`).join(', '));
  } else {
    const ids = new Set(setup.advanceCategoryIds ?? []);
    const byId = new Map(ctx.transactions.map((t) => [t.id, t]));
    let paid = 0;
    for (const a of ctx.allocations) if (a.targetType === 'category' && ids.has(a.targetId) && byId.get(a.transactionId)?.date.startsWith(String(year))) paid -= a.amount;
    const ahead = ctx.provisions.filter((p) => ids.has(p.categoryId) && p.dueDate.startsWith(String(year)) && p.dueDate > ctx.today).reduce((s, p) => s + p.amount, 0);
    advances = fig(paid + ahead, 'ledger', 'paid from the advance lines, and the ones still due');
  }

  return {
    input: {
      year,
      class: ctx.regime,
      persons,
      householdMembers: Math.max(1, setup.persons.length + (setup.children ?? 0)),
      homeInterest: withOverride('homeInterest', homeInterest),
      ...(homeSince ? { homeSince } : {}),
      insurance: withOverride('insurance', insurance),
      ...(setup.donations ? { donations: fig(setup.donations, 'estimate') } : {}),
      advances: withOverride('advances', advances),
    },
    salaries,
    missing,
  };
}

export interface SetupHints {
  year: number;
  members: readonly string[];
  categories: readonly Category[];
  accounts: readonly Account[];
  provisions: readonly Provision[];
  transactions: readonly Transaction[];
  allocations: readonly Allocation[];
  documents: readonly TaxDocumentRecord[];
}

/** Children: income lines for family allowances that received money in the year. */
export function childLines(h: SetupHints): Category[] {
  const byId = new Map(h.transactions.map((t) => [t.id, t]));
  const paid = new Set(h.allocations.filter((a) => a.targetType === 'income' && byId.get(a.transactionId)?.date.startsWith(String(h.year))).map((a) => a.targetId));
  return h.categories.filter((c) => c.isIncome && !c.archivedAt && /allocation|famil|kinder|child|zukunft|cae\b/i.test(c.name) && paid.has(c.id));
}

/** A first setup from what the app holds: names, salary lines, home loans, advance lines, the provision. */
export function suggestSetup(h: SetupHints): TaxSetup {
  const lastReturn = h.documents.filter((d) => d.kind === 'return').sort((a, b) => b.year - a.year)[0];
  const names = h.members.length ? h.members : (lastReturn?.persons ?? []).map((p) => p.name.split(/\s+/)[0]!);
  const income = h.categories.filter((c) => c.isIncome && !c.archivedAt);
  const persons: TaxSetupPerson[] = names.slice(0, 2).map((name) => {
    const own = income.filter((c) => sameName(c.name, name) && /salar|salaire|pay|lohn|wage/i.test(c.name));
    const birth = lastReturn?.persons?.find((p) => sameName(p.name, name))?.values.birthYear;
    return { name, salaryCategoryIds: own.map((c) => c.id), ...(birth ? { birthYear: birth } : {}) };
  });
  const homeLoanIds = h.accounts.filter((a) => a.type === 'loan' && !a.closedAt && /mort|home|house|immo|logement|hypoth|housing|maison/i.test(a.name)).map((a) => a.id);
  const advanceCategoryIds = h.categories.filter((c) => !c.isIncome && /advance|avance|vorauszahl/i.test(c.name)).map((c) => c.id);
  const provision = h.provisions.find((p) => new RegExp(`\\b${h.year}\\b`).test(p.name) && /tax|imp[oô]t|steuer/i.test(p.name) && !/advance|avance/i.test(p.name));
  const children = childLines(h).length;
  return {
    persons,
    ...(children ? { children } : {}),
    homeLoanIds,
    advanceCategoryIds,
    ...(provision ? { provisionId: provision.id } : {}),
  };
}
