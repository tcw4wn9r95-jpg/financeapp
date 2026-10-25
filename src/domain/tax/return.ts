import type { Cents } from '../types';
import { classTax, marginal, socialContributions, stepCredit, type TaxClass, type TaxParams } from './lu';

/**
 * The Luxembourg return for a household of employees, line by line as on the
 * declaration (modèle 100) and the assessment (bulletin d'impôt) (D-95):
 * salaries less social contributions and work expenses, own-home loan
 * interest within its ceiling, special expenses (lump sum or insurance
 * premiums, social contributions, complementary pension, pension and home
 * savings, donations), the allowance for two earning spouses, the scale,
 * the employment-fund surcharge, then what payroll withholding and the
 * quarterly advances already cover. A projection, not tax advice.
 */

/** Where a figure comes from, shown next to it. */
export type FigureSource = 'document' | 'ledger' | 'lastYear' | 'estimate' | 'rule' | 'model';

export interface Figure {
  amount: Cents;
  source: FigureSource;
  /** Short note: which document, which lines, the assumption. */
  note?: string;
}

export interface ReturnPerson {
  name: string;
  gross: Figure;
  /** Deductible social contributions (pension, health, dependence). */
  social: Figure;
  /** Employee contributions to a complementary pension scheme (LRCP). */
  lrcp: Figure;
  withheld: Figure;
  /** Commuting deduction (frais de déplacement), already within its ceiling. */
  travel?: Figure;
  /** Old-age pension savings (art. 111bis). */
  pensionSavings?: Figure;
  /** Home-savings contributions (épargne-logement). */
  homeSavings?: Figure;
  /** Aged 40 or less at the start of the year: higher home-savings ceiling. */
  young?: boolean;
}

export interface ReturnInput {
  year: number;
  class: TaxClass;
  persons: ReturnPerson[];
  /** Household members for the per-member ceilings (spouses + children). */
  householdMembers: number;
  /** Interest on the loans for the main residence, before the ceiling. */
  homeInterest: Figure;
  /** Year the rental value was fixed (first occupation): sets the ceiling. */
  homeSince?: number;
  /** Insurance premiums and consumer-loan interest (art. 111). */
  insurance: Figure;
  donations?: Figure;
  /** Domestic help, care and childcare costs (art. 127): a flat deduction up to its ceiling. */
  childcare?: Figure;
  /** Other net income (positive) or loss (negative). */
  otherIncome?: Figure;
  /** Quarterly advances paid for the year. */
  advances: Figure;
}

export interface ReturnLine {
  key: string;
  amount: Cents;
  source?: FigureSource;
  note?: string;
}

export interface ReturnResult {
  year: number;
  salaries: ReturnLine[];
  netSalaries: Cents;
  home: ReturnLine;
  totalNetIncome: Cents;
  special: ReturnLine[];
  specialTotal: Cents;
  /** The childcare deduction (extraordinary charges), when there is one. */
  childcare: ReturnLine | null;
  taxableIncome: Cents;
  allowance: Cents;
  /** Adjusted taxable income rounded down as the scale takes it. */
  scaleIncome: Cents;
  incomeTax: Cents;
  employmentFund: Cents;
  credits: ReturnLine[];
  totalDue: Cents;
  withheld: Cents;
  /** Due after withholding (the assessment's "montant restant"). */
  afterWithholding: Cents;
  advances: Cents;
  /** Positive: still to pay when the assessment comes. Negative: refund. */
  settlement: Cents;
  marginalRate: number;
  /** Home interest before the ceiling, and the ceiling for the household. */
  homeInterestDeclared: Cents;
  homeCeiling: Cents | null;
}

const eur = (c: number) => c / 100;
const ct = (e: number) => Math.round(e * 100);

/** The annual ceiling per household member for own-home interest, or null when fully deductible. */
export function homeCeilingPerMember(year: number, since: number | undefined, p: TaxParams): number | null {
  const h = p.household?.homeInterest;
  if (!h) return null;
  if (since === undefined) return h.ceilings.at(-1)?.amount ?? null;
  const n = year - since;
  if (n < h.fullYears) return null;
  let amount: number | null = null;
  for (const c of h.ceilings) if (n >= c.fromYear) amount = c.amount;
  return amount;
}

export function computeReturn(r: ReturnInput, p: TaxParams): ReturnResult {
  const hh = p.household;
  const salaries: ReturnLine[] = [];
  let netSalaries = 0;
  let earners = 0;
  for (const person of r.persons) {
    if (person.gross.amount <= 0) continue;
    earners++;
    const professional = ct(p.deductions.professionalLump);
    const travel = person.travel?.amount ?? 0;
    // Work expenses: the lump sum, or the commuting deduction when larger is added to it (art. 105bis).
    const net = person.gross.amount - professional - Math.min(travel, ct(p.deductions.travelMax));
    netSalaries += net;
    salaries.push({ key: `gross:${person.name}`, amount: person.gross.amount, source: person.gross.source, ...(person.gross.note ? { note: person.gross.note } : {}) });
    salaries.push({ key: `professional:${person.name}`, amount: -professional, source: 'rule' });
    if (travel) salaries.push({ key: `travel:${person.name}`, amount: -Math.min(travel, ct(p.deductions.travelMax)), source: person.travel!.source });
  }

  // Own home: interest is a negative rental income, within the ceiling per household member.
  const perMember = homeCeilingPerMember(r.year, r.homeSince, p);
  const homeCeiling = perMember === null ? null : ct(perMember * r.householdMembers);
  const homeAllowed = homeCeiling === null ? r.homeInterest.amount : Math.min(r.homeInterest.amount, homeCeiling);
  const home: ReturnLine = { key: 'home', amount: -homeAllowed, source: r.homeInterest.source, ...(r.homeInterest.note ? { note: r.homeInterest.note } : {}) };
  const totalNetIncome = netSalaries - homeAllowed + (r.otherIncome?.amount ?? 0);

  // Special expenses.
  const special: ReturnLine[] = [];
  const taxpayers = r.class === '2' ? 2 : 1;
  const insuranceCap = ct(p.deductions.insurancePerPerson * Math.max(1, r.householdMembers));
  const insurance = Math.min(r.insurance.amount, insuranceCap);
  const donations = r.donations && r.donations.amount >= ct(hh?.donations.min ?? 120) ? Math.min(r.donations.amount, Math.round(totalNetIncome * (hh?.donations.maxShareOfIncome ?? 0.2))) : 0;
  const lump = ct(p.deductions.specialLump * taxpayers);
  // The lump sum stands in for premiums, interest and donations when they are lower.
  if (insurance + donations > lump) {
    if (insurance) special.push({ key: 'insurance', amount: insurance, source: r.insurance.source });
    if (donations) special.push({ key: 'donations', amount: donations, source: r.donations!.source });
  } else special.push({ key: 'specialLump', amount: lump, source: 'rule' });
  for (const person of r.persons) {
    if (person.gross.amount <= 0) continue;
    special.push({ key: `social:${person.name}`, amount: person.social.amount, source: person.social.source });
  }
  for (const person of r.persons) {
    const l = Math.min(person.lrcp.amount, ct(hh?.lrcpMax ?? 1200));
    if (l > 0) special.push({ key: `lrcp:${person.name}`, amount: l, source: person.lrcp.source });
  }
  for (const person of r.persons) {
    const ps = Math.min(person.pensionSavings?.amount ?? 0, ct(p.deductions.pensionSavings));
    if (ps > 0) special.push({ key: `pensionSavings:${person.name}`, amount: ps, source: person.pensionSavings!.source });
  }
  const homeSavingsCap = (young: boolean | undefined) => ct((young ? hh?.homeSavings.young : hh?.homeSavings.other) ?? 672);
  for (const person of r.persons) {
    const hs = Math.min(person.homeSavings?.amount ?? 0, homeSavingsCap(person.young));
    if (hs > 0) special.push({ key: `homeSavings:${person.name}`, amount: hs, source: person.homeSavings!.source });
  }
  const specialTotal = special.reduce((s, l) => s + l.amount, 0);
  const care = hh?.childcare && r.childcare && r.childcare.amount > 0 ? Math.min(r.childcare.amount, ct(hh.childcare.max)) : 0;
  const childcare: ReturnLine | null = care ? { key: 'childcare', amount: care, source: r.childcare!.source } : null;
  const taxableIncome = Math.max(0, totalNetIncome - specialTotal - care);
  // Two jointly taxed spouses who both earn get the extra-professional allowance (art. 129b).
  const allowance = r.class === '2' && earners >= 2 ? ct(hh?.extraProfessional ?? 0) : 0;
  const adjusted = Math.max(0, taxableIncome - allowance);
  const scaleIncomeEur = Math.floor(eur(adjusted) / p.roundTaxableTo) * p.roundTaxableTo;
  const incomeTaxEur = Math.floor(classTax(scaleIncomeEur, r.class, p));
  const threshold = p.employmentFund.threshold[r.class];
  const above = scaleIncomeEur > threshold ? classTax(scaleIncomeEur, r.class, p) - classTax(threshold, r.class, p) : 0;
  const fundEur = Math.floor(incomeTaxEur * p.employmentFund.rate + above * (p.employmentFund.highRate - p.employmentFund.rate));

  const credits: ReturnLine[] = [];
  for (const person of r.persons) {
    const g = eur(person.gross.amount);
    if (g > 0 && g < p.credits.employeeMaxSalary) {
      const c = stepCredit(g, p.credits.employee);
      if (c > 0) credits.push({ key: `employee:${person.name}`, amount: ct(c), source: 'rule' });
    }
  }
  const creditTotal = credits.reduce((s, c) => s + c.amount, 0);
  const totalDue = Math.max(0, ct(incomeTaxEur + fundEur) - creditTotal);
  const withheld = r.persons.reduce((s, x) => s + x.withheld.amount, 0);
  const afterWithholding = totalDue - withheld;
  const fund = scaleIncomeEur > threshold ? p.employmentFund.highRate : p.employmentFund.rate;
  const effective = r.class === '2' ? scaleIncomeEur / 2 : scaleIncomeEur;
  return {
    year: r.year,
    salaries,
    netSalaries,
    home,
    totalNetIncome,
    special,
    specialTotal,
    childcare,
    taxableIncome,
    allowance,
    scaleIncome: ct(scaleIncomeEur),
    incomeTax: ct(incomeTaxEur),
    employmentFund: ct(fundEur),
    credits,
    totalDue,
    withheld,
    afterWithholding,
    advances: r.advances.amount,
    // The assessment drops the cents of what is left after withholding, then takes off the advances.
    settlement: Math.trunc(afterWithholding / 100) * 100 - r.advances.amount,
    marginalRate: marginal(effective, p.scale) * (1 + fund),
    homeInterestDeclared: r.homeInterest.amount,
    homeCeiling,
  };
}

/** Deductible social contributions modelled from gross salary, when no certificate gives them. */
export function modelledSocial(gross: Cents, p: TaxParams): Cents {
  return ct(socialContributions(eur(gross), p));
}

export interface DeductionIdea {
  /** pensionSavings | homeSavings | insurance | travel | donations | children */
  kind: 'pensionSavings' | 'homeSavings' | 'insurance' | 'travel' | 'donations';
  person?: string;
  /** What the estimate already counts. */
  current: Cents;
  /** The most that can be deducted, or null when there is no fixed ceiling. */
  max: Cents | null;
  /** Tax saved by going from `current` to `max` (or by 1,000 € more without a ceiling). */
  saving: Cents;
}

/** Deductions not used to the full, and what using them would save on this year's tax. */
export function deductionIdeas(r: ReturnInput, p: TaxParams): DeductionIdea[] {
  const base = computeReturn(r, p).totalDue;
  const hh = p.household;
  const saved = (changed: ReturnInput) => Math.max(0, base - computeReturn(changed, p).totalDue);
  const withPerson = (name: string, patch: Partial<ReturnPerson>): ReturnInput => ({ ...r, persons: r.persons.map((x) => (x.name === name ? { ...x, ...patch } : x)) });
  const out: DeductionIdea[] = [];
  for (const x of r.persons) {
    const ps = ct(p.deductions.pensionSavings);
    const curPs = Math.min(x.pensionSavings?.amount ?? 0, ps);
    if (curPs < ps) out.push({ kind: 'pensionSavings', person: x.name, current: curPs, max: ps, saving: saved(withPerson(x.name, { pensionSavings: { amount: ps, source: 'estimate' } })) });
    const hs = ct((x.young ? hh?.homeSavings.young : hh?.homeSavings.other) ?? 672);
    const curHs = Math.min(x.homeSavings?.amount ?? 0, hs);
    if (curHs < hs) out.push({ kind: 'homeSavings', person: x.name, current: curHs, max: hs, saving: saved(withPerson(x.name, { homeSavings: { amount: hs, source: 'estimate' } })) });
    if (x.gross.amount > 0 && !x.travel) {
      // Typical: 20 km from home to work.
      const t = hh?.travel;
      const sample = t ? ct(Math.max(0, 20 - t.freeUnits) * t.perUnit) : 0;
      if (sample) out.push({ kind: 'travel', person: x.name, current: 0, max: ct(p.deductions.travelMax), saving: saved(withPerson(x.name, { travel: { amount: sample, source: 'estimate' } })) });
    }
  }
  const insCap = ct(p.deductions.insurancePerPerson * Math.max(1, r.householdMembers));
  if (r.insurance.amount < insCap) out.push({ kind: 'insurance', current: r.insurance.amount, max: insCap, saving: saved({ ...r, insurance: { amount: insCap, source: 'estimate' } }) });
  const don = r.donations?.amount ?? 0;
  out.push({ kind: 'donations', current: don, max: null, saving: saved({ ...r, donations: { amount: don + 100_000, source: 'estimate' } }) });
  return out.filter((i) => i.saving > 0 || i.kind === 'donations');
}
