import type { Cents } from '../types';

/**
 * Luxembourg income tax projection (PRD F10). A projection, not tax advice.
 *
 * All rates and thresholds come from a per-year parameter file
 * (/tax/lu/YYYY.json); nothing is hard-coded here. Amounts in the
 * parameter files are in euros; the engine works in cents and rounds the
 * way the administration does (taxable income down to a multiple of 50 €,
 * tax down to the euro).
 */

export type TaxClass = '1' | '1a' | '2';

export interface Bracket {
  /** Lower bound of the bracket in euros. */
  from: number;
  /** Marginal rate, e.g. 0.08. */
  rate: number;
}

export interface CreditStep {
  /** Gross annual salary from which this step applies, in euros. */
  from: number;
  /** Credit in euros: fixed, or a linear formula base + slope × (salary − from). */
  base: number;
  slope?: number;
}

export interface TaxSource {
  title: string;
  url: string;
  verifiedOn: string;
}

export interface TaxParams {
  year: number;
  /** "law" when published in the Mémorial; "draft" when taken from a bill not yet voted. */
  status: 'law' | 'draft';
  note?: string;
  scale: Bracket[];
  /**
   * Class 1a (art. 120bis LIR): the scale is applied to R − factor × (base − R);
   * from `capFrom` the marginal rate is limited by `capBrackets`.
   */
  class1a: { base: number; factor: number; capFrom: number; capBrackets: Bracket[] };
  roundTaxableTo: number;
  /** Employment fund surcharge: `rate` of the tax; `highRate` on the tax for income above the threshold (D-41). */
  employmentFund: { rate: number; highRate: number; threshold: Record<TaxClass, number> };
  social: {
    /** Employee rates on gross salary, capped at `ceiling` (except dependence). */
    pension: number;
    health: number;
    dependence: number;
    /** Annual contribution ceiling in euros (5 × social minimum wage). */
    ceiling: number;
    /** Dependence insurance is charged on salary minus this allowance (a quarter of the social minimum wage, annual). */
    dependenceAllowance: number;
  };
  deductions: {
    /** Lump sum for professional expenses (frais d'obtention), per employee. */
    professionalLump: number;
    /** Ceiling of the commuting deduction (frais de déplacement), per employee. */
    travelMax: number;
    /** Lump sum for special expenses when no more is claimed, per taxpayer. */
    specialLump: number;
    /** Ceiling for insurance premiums and personal loan interest, per household member. */
    insurancePerPerson: number;
    /** Old-age pension savings (art. 111bis), ceiling per taxpayer. */
    pensionSavings: number;
  };
  credits: {
    /** Crédit d'impôt salarié plus the CO2 credit, by gross salary; 0 below the first step. */
    employee: CreditStep[];
    /** No employee credit from this gross salary. */
    employeeMaxSalary: number;
    /** Crédit d'impôt monoparental, by adjusted taxable income (class 1a with a child). */
    singleParent: CreditStep[];
  };
  /** Household rules used by the full return (D-95). */
  household?: {
    homeInterest: { fullYears: number; ceilings: { fromYear: number; amount: number }[] };
    lrcpMax: number;
    extraProfessional: number;
    homeSavings: { young: number; other: number; youngUntilAge: number };
    donations: { min: number; maxShareOfIncome: number };
    travel: { perUnit: number; freeUnits: number };
  };
  sources: TaxSource[];
}

export interface TaxPerson {
  name: string;
  /** Gross employment income for the year, cents. */
  grossSalary: Cents;
  /** Tax withheld (or expected to be withheld) on this salary for the year, cents. */
  withheld: Cents;
  /** Commuting deduction (99 € per distance unit beyond the first 4), cents. */
  travel?: Cents;
  /** Old-age pension savings contract premiums paid, cents. */
  pensionSavings?: Cents;
}

export interface TaxInput {
  class: TaxClass;
  /** Class 1a because of a child in the household (single-parent credit). */
  singleParent?: boolean;
  persons: TaxPerson[];
  /** Household members counted for the insurance ceiling (taxpayers + children). */
  householdMembers: number;
  /** Insurance premiums and personal-loan interest paid, cents. */
  insurance: Cents;
  /** Other deductions the user knows (home-loan interest within its ceiling, donations…), cents. */
  otherDeductions: Cents;
  /** Other taxable net income (rental, etc.), cents. */
  otherIncome: Cents;
}

export interface TaxLine {
  label: string;
  amount: Cents;
}

export interface TaxResult {
  year: number;
  class: TaxClass;
  netIncome: Cents;
  deductions: TaxLine[];
  taxable: Cents;
  incomeTax: Cents;
  surcharge: Cents;
  credits: TaxLine[];
  liability: Cents;
  withheld: Cents;
  /** Positive: refund expected. Negative: tax still to pay. */
  balance: Cents;
  marginalRate: number;
}

const euro = (cents: number) => cents / 100;
const cents = (eur: number) => Math.round(eur * 100);

/** Tax in euros on an amount in euros under a bracket scale (no rounding). */
export function scaleTax(income: number, brackets: readonly Bracket[]): number {
  let tax = 0;
  for (let i = 0; i < brackets.length; i++) {
    const b = brackets[i]!;
    const next = brackets[i + 1]?.from ?? Infinity;
    if (income <= b.from) break;
    tax += (Math.min(income, next) - b.from) * b.rate;
  }
  return tax;
}

export function marginal(income: number, brackets: readonly Bracket[]): number {
  let rate = 0;
  for (const b of brackets) if (income > b.from) rate = b.rate;
  return rate;
}

/** Income tax in euros (before the employment-fund surcharge) for a class. */
export function classTax(taxable: number, cls: TaxClass, p: TaxParams): number {
  if (cls === '2') return 2 * scaleTax(taxable / 2, p.scale); // splitting
  if (cls === '1a') return class1aTax(taxable, p);
  return scaleTax(taxable, p.scale);
}

export function class1aTax(taxable: number, p: TaxParams): number {
  const a = p.class1a;
  const reduced = (r: number) => scaleTax(Math.max(0, r - a.factor * (a.base - r)), p.scale);
  if (taxable <= a.capFrom) return reduced(taxable);
  return reduced(a.capFrom) + scaleTax(taxable, a.capBrackets) - scaleTax(a.capFrom, a.capBrackets);
}

function class1aMarginal(taxable: number, p: TaxParams): number {
  const a = p.class1a;
  if (taxable > a.capFrom) return marginal(taxable, a.capBrackets);
  return marginal(Math.max(0, taxable - a.factor * (a.base - taxable)), p.scale) * (1 + a.factor);
}

export function stepCredit(salary: number, steps: readonly CreditStep[]): number {
  let found: CreditStep | undefined;
  for (const s of steps) if (salary >= s.from) found = s;
  if (!found) return 0;
  return Math.max(0, found.base + (found.slope ?? 0) * (salary - found.from));
}

export function socialContributions(gross: number, p: TaxParams): number {
  const capped = Math.min(gross, p.social.ceiling);
  return capped * (p.social.pension + p.social.health) + Math.max(0, gross - p.social.dependenceAllowance) * p.social.dependence;
}

export function computeTax(input: TaxInput, p: TaxParams): TaxResult {
  const deductions: TaxLine[] = [];
  let net = euro(input.otherIncome);
  for (const person of input.persons) {
    const gross = euro(person.grossSalary);
    if (gross <= 0) continue;
    const social = socialContributions(gross, p);
    const travel = Math.min(p.deductions.travelMax, euro(person.travel ?? 0));
    net += gross - social - p.deductions.professionalLump - travel;
    deductions.push({ label: `social:${person.name}`, amount: cents(social) });
    deductions.push({ label: `professional:${person.name}`, amount: cents(p.deductions.professionalLump) });
    if (travel > 0) deductions.push({ label: `travel:${person.name}`, amount: cents(travel) });
  }
  const taxpayers = input.class === '2' ? 2 : 1;
  const insurance = Math.min(euro(input.insurance), p.deductions.insurancePerPerson * Math.max(1, input.householdMembers));
  const special = Math.max(insurance, p.deductions.specialLump * taxpayers);
  deductions.push({ label: insurance > p.deductions.specialLump * taxpayers ? 'insurance' : 'specialLump', amount: cents(special) });
  const pension = input.persons.reduce((s, x) => s + Math.min(euro(x.pensionSavings ?? 0), p.deductions.pensionSavings), 0);
  if (pension > 0) deductions.push({ label: 'pensionSavings', amount: cents(pension) });
  if (input.otherDeductions > 0) deductions.push({ label: 'other', amount: input.otherDeductions });

  const before = net - special - pension - euro(input.otherDeductions);
  const taxable = Math.max(0, Math.floor(before / p.roundTaxableTo) * p.roundTaxableTo);
  const incomeTax = Math.floor(classTax(taxable, input.class, p));
  // The higher rate applies to the tax on the part of income above the threshold.
  const threshold = p.employmentFund.threshold[input.class];
  const fund = taxable > threshold ? p.employmentFund.highRate : p.employmentFund.rate;
  const above = taxable > threshold ? classTax(taxable, input.class, p) - classTax(threshold, input.class, p) : 0;
  const surcharge = Math.floor(incomeTax * p.employmentFund.rate + above * (p.employmentFund.highRate - p.employmentFund.rate));

  const credits: TaxLine[] = [];
  for (const person of input.persons) {
    const gross = euro(person.grossSalary);
    if (gross > 0 && gross < p.credits.employeeMaxSalary) {
      const c = stepCredit(gross, p.credits.employee);
      if (c > 0) credits.push({ label: `employee:${person.name}`, amount: cents(c) });
    }
  }
  if (input.class === '1a' && input.singleParent) {
    const c = stepCredit(taxable, p.credits.singleParent);
    if (c > 0) credits.push({ label: 'singleParent', amount: cents(c) });
  }
  const creditTotal = credits.reduce((s, c) => s + c.amount, 0);
  const liability = Math.max(0, cents(incomeTax + surcharge) - creditTotal);
  const withheld = input.persons.reduce((s, x) => s + x.withheld, 0);
  const effectiveIncome = input.class === '2' ? taxable / 2 : taxable;
  return {
    year: p.year,
    class: input.class,
    netIncome: cents(net),
    deductions,
    taxable: cents(taxable),
    incomeTax: cents(incomeTax),
    surcharge: cents(surcharge),
    credits,
    liability,
    withheld,
    balance: withheld - liability,
    marginalRate: (input.class === '1a' ? class1aMarginal(taxable, p) : marginal(effectiveIncome, p.scale)) * (1 + fund),
  };
}

/** Per-value overrides the user typed ("path.to.value" → number). */
export function withOverrides(p: TaxParams, overrides: Record<string, number>): TaxParams {
  const copy = JSON.parse(JSON.stringify(p)) as TaxParams;
  for (const [path, value] of Object.entries(overrides)) {
    const keys = path.split('.');
    let obj: Record<string, unknown> = copy as unknown as Record<string, unknown>;
    for (const k of keys.slice(0, -1)) {
      const next = obj[k];
      if (typeof next !== 'object' || next === null) {
        obj = {};
        break;
      }
      obj = next as Record<string, unknown>;
    }
    const last = keys.at(-1)!;
    if (typeof obj[last] === 'number' && Number.isFinite(value)) obj[last] = value;
  }
  return copy;
}
