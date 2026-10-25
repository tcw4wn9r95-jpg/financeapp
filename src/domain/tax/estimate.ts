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

/** One payment (or the payslip's year to date, or a month planned) turned back into gross pay (D-98). */
export interface PayRow {
  /** The payment date, the last month the payslip covers, or the planned month. */
  date: IsoDate;
  payer: string;
  source: 'payslip' | 'received' | 'planned';
  net: Cents;
  gross: Cents;
  /** Health and pension contributions (deductible). */
  social: Cents;
  dependence: Cents;
  withheld: Cents;
  /** Deducted after the net: complementary pension and the like. */
  after: Cents;
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
  payslip?: { month: number; issuer?: string; gross: Cents; exempt: Cents; withheld: Cents; received: Cents };
  /** Tax withheld from pay so far this year (payslip, then estimated on what was received since). */
  withheldSoFar?: Cents;
  /** Tax still to be withheld on the pay planned to December. */
  withheldAhead?: Cents;
  /** Every payment and planned month, gross to net. */
  rows?: PayRow[];
  /** The payslip used as the model of a month's pay, and its rates. */
  model?: { year: number; month: number; issuer?: string; health: number; pension: number; dependence: number; taxRate: number; allowances: Cents; after: Cents };
  /** Taxable payments and planned months, net. */
  items: { date: IsoDate; payer: string; net: Cents; planned: boolean }[];
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
  const rows: SalaryTrace['items'] = [];
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
    rows.push({ date: t.date, payer: key, net: a.amount, planned: false });
    paidMonths.add(`${monthOf(t.date)}|${a.targetId}`);
  }
  for (const p of payers.values()) p.treatment = treatments[p.key] ?? (p.received >= 100_000 ? 'taxable' : 'exempt');
  let planned = 0;
  const plannedRows: SalaryTrace['items'] = [];
  const current = monthOf(ctx.today);
  const first = compareMonths(current, `${ctx.year}-01`) > 0 ? current : `${ctx.year}-01`;
  if (compareMonths(first, `${ctx.year}-12`) <= 0) {
    for (const m of monthRange(first, `${ctx.year}-12`)) {
      for (const id of ids) {
        if (paidMonths.has(`${m}|${id}`)) continue;
        // A salary paid at the end of a month for the next one is budgeted in the next month.
        const c = ctx.categories.find((x) => x.id === id);
        const forNext = c?.nextMonthFromDay && (!c.nextMonthStart || compareMonths(m, c.nextMonthStart) >= 0);
        const amount = expected(ctx, id, forNext ? addMonths(m, 1) : m);
        planned += amount;
        if (amount) plannedRows.push({ date: `${m}-28`, payer: '', net: amount, planned: true });
      }
    }
  }
  const list = [...payers.values()].sort((a, b) => b.received - a.received);
  const taxable = list.filter((p) => p.treatment === 'taxable').reduce((s, p) => s + p.received, 0);
  const exempt = list.filter((p) => p.treatment === 'exempt').reduce((s, p) => s + p.received, 0);
  // Planned pay is counted with the payer that paid last.
  const kept = rows.filter((r) => payers.get(r.payer)?.treatment === 'taxable').sort((a, b) => a.date.localeCompare(b.date));
  const lastPayer = kept.at(-1)?.payer ?? '';
  const items = [...kept, ...plannedRows.map((r) => ({ ...r, payer: lastPayer }))];
  return { received: taxable, planned, exempt, payers: list, items };
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

const EMPLOYER_NOISE = ['sarl', 'eu', 'sa', 'ltd', 'gmbh', 'luxembourg', 'scs', 'sca', 'succursale', 'branch'];
const employerWords = (s?: string) => (s ? words(s).filter((w) => w.length >= 3 && !EMPLOYER_NOISE.includes(w)) : []);
const paidBy = (payer: string, employer: readonly string[]) => employer.some((w) => words(payer).includes(w));
const monthEnd = (year: number, month: number) => `${year}-${String(month).padStart(2, '0')}-31`;

type Gross = Pick<PayRow, 'gross' | 'social' | 'dependence' | 'withheld' | 'after'>;

/**
 * A person's pay for the year, payment by payment (D-98). Each net amount that
 * reached the accounts, and each month still planned, is turned back into gross
 * pay, contributions and tax with a model of a month's pay:
 * - a regular payslip (this year's, else last year's) as the template: its
 *   contribution rates, its tax as a share of taxable pay, the allowances the
 *   tax card takes off before tax and what is deducted after the net, the fixed
 *   parts once a month for that employer's pay only;
 * - else last year's salary certificate: gross per euro of net.
 * One payslip is enough. When a later payslip has been added anyway, its
 * year-to-date figures replace that employer's payments up to its month, with
 * tax-free pay (AE less the complementary pension) left out of gross.
 */
function salaryEstimate(ctx: EstimateContext, sp: TaxSetupPerson, last: Record<string, number> | undefined): { gross: Figure; social: Figure; withheld: Figure; lrcp: Figure; trace: SalaryTrace; modelled: boolean; unusual: boolean } {
  const { year } = ctx;
  const slipsOf = (y: number) => ctx.documents.filter((d) => d.kind === 'payslip' && d.year === y && sameName(d.subject, sp.name)).sort((a, b) => (b.values.month ?? 0) - (a.values.month ?? 0));
  const slips = slipsOf(year);
  const ytd = slips[0];
  const template = [...slips, ...slipsOf(year - 1)].find((d) => d.values.mGross);
  const slipEnd = ytd ? monthEnd(year, ytd.values.month ?? 12) : undefined;
  const trace = salaryForYear(ctx, sp.salaryCategoryIds, sp.payers, slipEnd);
  const lrcpPerMonth = [...slips, ...(template ? [template] : [])].find((d) => d.values.lrcpMonth !== undefined)?.values.lrcpMonth ?? (last?.lrcp ? last.lrcp / 12 : 0);

  let toGross: (net: Cents, fixed: boolean) => Gross;
  let modelled = true;
  if (template) {
    const v = template.values;
    const g0 = v.mGross!;
    const h = (v.mHealth ?? 0) / g0;
    const p = (v.mPension ?? 0) / g0;
    const d = (v.mDependence ?? 0) / g0;
    const rate = v.mTaxable ? (v.mTax ?? 0) / v.mTaxable : 0;
    const allowances = Math.max(0, g0 - (v.mHealth ?? 0) - (v.mPension ?? 0) - (v.mTaxable ?? g0));
    const after = Math.max(0, (v.mNet ?? 0) - (v.mPayable ?? v.mNet ?? 0));
    const k = 1 - h - p - d - rate * (1 - h - p);
    // net = gross − contributions − dependence − tax − after, with tax = rate × (gross − contributions − allowances).
    toGross = (net, fixed) => {
      const D = fixed ? allowances : 0;
      const F = fixed ? after : 0;
      const gross = Math.max(0, Math.round((net + F - rate * D) / k));
      return { gross, social: Math.round(gross * (h + p)), dependence: Math.round(gross * d), withheld: Math.max(0, Math.round(rate * (gross * (1 - h - p) - D))), after: F };
    };
    trace.grossPerNet = 1 / k;
    trace.model = { year: template.year, month: v.month ?? 0, ...(template.issuer ? { issuer: template.issuer } : {}), health: h, pension: p, dependence: d, taxRate: rate, allowances, after };
  } else if (last?.gross) {
    // Contribution rates may change from one year to the next.
    const rates = (x?: TaxParams) => (x ? x.social.pension + x.social.health : 1);
    const rateChange = ctx.paramsLastYear ? rates(ctx.params) / rates(ctx.paramsLastYear) : 1;
    const sh = (last.social ?? 0) / last.gross;
    const dd = (last.dependence ?? 0) / last.gross;
    const w = (last.withheld ?? 0) / last.gross;
    const l = (last.lrcp ?? 0) / last.gross;
    const k = 1 - sh - dd - w - l;
    toGross = (net) => {
      const gross = Math.max(0, Math.round(net / k));
      return { gross, social: Math.round(gross * sh * rateChange), dependence: Math.round(gross * dd), withheld: Math.round(gross * w), after: Math.round(gross * l) };
    };
    trace.grossPerNet = 1 / k;
  } else {
    modelled = false;
    toGross = (net) => ({ gross: net, social: 0, dependence: 0, withheld: 0, after: 0 });
  }

  // Payments from the payslip's employer up to its month are in its year-to-date figures.
  const taxable = trace.payers.filter((p) => p.treatment === 'taxable');
  const ytdEmployer = employerWords(ytd?.issuer);
  const fromEmployer = taxable.filter((p) => paidBy(p.key, ytdEmployer));
  const inSlip = new Set((ytd ? (fromEmployer.length ? fromEmployer : taxable) : []).map((p) => p.key));
  for (const p of trace.payers) if (!inSlip.has(p.key)) p.untilSlip = 0;
  const rows: PayRow[] = [];
  let lrcpTotal = 0;
  if (ytd) {
    const v = ytd.values;
    const lrcpSoFar = v.ae !== undefined ? Math.min(v.ae, Math.round(lrcpPerMonth * (v.month ?? 12))) : (v.lrcp ?? 0);
    const exempt = v.ae !== undefined ? v.ae - lrcpSoFar : 0;
    const received = taxable.filter((p) => inSlip.has(p.key)).reduce((s, p) => s + p.untilSlip, 0);
    rows.push({ date: slipEnd!, payer: ytd.issuer ?? '', source: 'payslip', net: received, gross: (v.gross ?? 0) - exempt, social: v.social ?? 0, dependence: v.dependence ?? 0, withheld: v.withheld ?? 0, after: lrcpSoFar });
    lrcpTotal += lrcpSoFar;
    trace.payslip = { month: v.month ?? 0, ...(ytd.issuer ? { issuer: ytd.issuer } : {}), gross: (v.gross ?? 0) - exempt, exempt, withheld: v.withheld ?? 0, received };
  }
  // Exempt pay typed by the user (the legal part of a severance) comes off the largest payment.
  const open = trace.items.filter((it) => !(ytd && !it.planned && it.date <= slipEnd! && inSlip.has(it.payer)));
  const largest = open.filter((it) => !it.planned).sort((a, b) => b.net - a.net)[0];
  const templateEmployer = employerWords(template?.issuer);
  const fixedMonths = new Set<MonthKey>();
  for (const it of open) {
    const net = it === largest ? Math.max(0, it.net - (sp.exemptPay ?? 0)) : it.net;
    const m = monthOf(it.date);
    const fixed = !!template && paidBy(it.payer, templateEmployer) && !fixedMonths.has(m);
    if (fixed) fixedMonths.add(m);
    const r = toGross(net, fixed);
    rows.push({ date: it.date, payer: it.payer, source: it.planned ? 'planned' : 'received', net: it.net, ...r });
    if (!template) lrcpTotal += r.after;
  }
  // Ahead, the complementary pension is what the template payslip deducts (none when it shows none).
  if (template) lrcpTotal += Math.round((template.values.lrcpMonth ?? 0) * fixedMonths.size);
  // A payment over twice the usual one (a bonus, a severance) may be partly tax free: worth its payslip.
  const received = open.filter((it) => !it.planned).map((it) => it.net).sort((a, b) => a - b);
  const usual = template?.values.mPayable ?? received[Math.floor(received.length / 2)] ?? 0;
  const unusual = usual > 0 && open.some((it) => !it.planned && it.net > 2 * usual);
  trace.rows = rows;
  const sum = (k: keyof Gross, only?: (r: PayRow) => boolean) => rows.filter((r) => !only || only(r)).reduce((s, r) => s + r[k], 0);
  trace.withheldSoFar = sum('withheld', (r) => r.source !== 'planned');
  trace.withheldAhead = sum('withheld', (r) => r.source === 'planned');
  const src: Figure['source'] = !modelled ? 'model' : template || ytd ? 'ledger' : 'lastYear';
  const how = template ? 'each payment turned back into gross with your payslip' : modelled ? 'net received and planned, grossed up with last year’s certificate' : 'net pay only: add last year’s salary certificate or a payslip';
  return {
    gross: fig(sum('gross') + (sp.extraGross ?? 0), modelled ? 'ledger' : 'model', how),
    social: fig(sum('social'), src),
    withheld: fig(sum('withheld'), src),
    lrcp: fig(lrcpTotal, slips.length || template ? 'document' : modelled ? 'lastYear' : 'model'),
    trace,
    modelled,
    unusual,
  };
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
      const est = salaryEstimate(ctx, sp, last);
      salaries[sp.name] = est.trace;
      if (!est.modelled) missing.push(`certificate:${sp.name}`);
      if (est.unusual && !sp.exemptPay) missing.push(`unusual:${sp.name}`);
      ({ gross, social, withheld, lrcp } = est);
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
