import type { CashItem } from '../domain/forecast';
import { computeTax, withOverrides, type TaxClass, type TaxInput, type TaxParams, type TaxResult } from '../domain/tax/lu';
import type { TaxProfile } from '../domain/types';

/** Every /tax/lu/YYYY.json in the repository, bundled at build time. */
const FILES = import.meta.glob<TaxParams>('../../tax/lu/*.json', { eager: true, import: 'default' });

export const TAX_YEARS: Record<number, TaxParams> = Object.fromEntries(Object.values(FILES).map((p) => [p.year, p]));

export function taxYears(): number[] {
  return Object.keys(TAX_YEARS).map(Number).sort((a, b) => b - a);
}

export function inputOf(profile: TaxProfile): TaxInput {
  return {
    class: (['1', '1a', '2'].includes(profile.regime) ? profile.regime : '1') as TaxClass,
    ...(profile.singleParent ? { singleParent: true } : {}),
    persons: profile.persons,
    householdMembers: profile.householdMembers,
    insurance: profile.insurance,
    otherDeductions: profile.otherDeductions,
    otherIncome: profile.otherIncome,
  };
}

export function paramsFor(profile: TaxProfile): TaxParams | undefined {
  const base = TAX_YEARS[Number(profile.paramsVersion)] ?? TAX_YEARS[profile.year];
  return base && withOverrides(base, profile.overrides ?? {});
}

export function projectTax(profile: TaxProfile): TaxResult | undefined {
  const p = paramsFor(profile);
  return p ? computeTax(inputOf(profile), p) : undefined;
}

/** Refunds and amounts due posted into the forecast (on the 15th of the chosen month). */
export function taxCashItems(profiles: readonly TaxProfile[]): CashItem[] {
  const out: CashItem[] = [];
  for (const profile of profiles) {
    if (!profile.inForecast || !profile.settleMonth) continue;
    const r = projectTax(profile);
    if (!r || r.balance === 0) continue;
    out.push({ date: `${profile.settleMonth}-15`, amount: r.balance, label: `Tax ${profile.year}`, kind: 'tax' });
  }
  return out;
}
