import { describe, expect, it } from 'vitest';
import p2025 from '../../../tax/lu/2025.json';
import p2026 from '../../../tax/lu/2026.json';
import { class1aTax, classTax, computeTax, scaleTax, socialContributions, stepCredit, withOverrides, type TaxParams } from './lu';

/**
 * Test vectors. Expected values were worked out by hand (or with a separate
 * script) from the official LIR text, not taken from the ACD simulator,
 * which was not used: treat them as a check of the formulas, not as proof
 * of agreement with the administration's own computation.
 */

const P25 = p2025 as TaxParams;
const P26 = p2026 as TaxParams;
const eur = (n: number) => Math.round(n * 100);

describe('Luxembourg tariff (art. 118 LIR)', () => {
  it('1. nothing is due up to 13,230 €', () => {
    expect(scaleTax(13230, P26.scale)).toBe(0);
  });
  it('2. 20,000 €: 8/9/10% on three full 2,205 € bands and 11% on 155 € = 612,40 €', () => {
    expect(scaleTax(20000, P26.scale)).toBeCloseTo(612.4, 6);
  });
  it('3. 60,000 € in class 1 → 11,164,50 €', () => {
    expect(classTax(60000, '1', P26)).toBeCloseTo(11164.5, 6);
  });
  it('4. 100,000 € in class 1 → 26,764,50 € (39% band above 54,090 €)', () => {
    expect(classTax(100000, '1', P26)).toBeCloseTo(11164.5 + 40000 * 0.39, 6);
  });
  it('5. class 2 splits: 120,000 € joint = 2 × tax(60,000 €) = 22,329 €', () => {
    expect(classTax(120000, '2', P26)).toBeCloseTo(22329, 6);
  });
  it('6. 2025 and 2026 use the same (2025-indexed) scale', () => {
    expect(P25.scale).toEqual(P26.scale);
  });
});

describe('class 1a (art. 120bis)', () => {
  it('7. tax-free up to 26,460 €', () => {
    expect(class1aTax(26460, P26)).toBe(0);
    expect(class1aTax(26510, P26)).toBeGreaterThan(0);
  });
  it('8. 40,000 €: the scale on 40,000 − ¼ × 39,380 = 30,155 € → 2,026,80 €', () => {
    expect(class1aTax(40000, P26)).toBeCloseTo(2026.8, 6);
  });
  it('9. above 51,804 € the marginal rate is capped at 39%', () => {
    expect(class1aTax(100000, P26) - class1aTax(90000, P26)).toBeCloseTo(3900, 6);
    expect(class1aTax(100000, P26)).toBeCloseTo(24443.04, 2);
  });
});

describe('credits and contributions', () => {
  it('10. employee credit 2026 incl. CO2: phase-in, plateau 816 €, phase-out to 0 at 80,000 €', () => {
    expect(stepCredit(5000, P26.credits.employee)).toBeCloseTo(516 + 0.029 * 4064, 6);
    expect(stepCredit(30000, P26.credits.employee)).toBe(816);
    expect(stepCredit(60000, P26.credits.employee)).toBeCloseTo(408, 6);
    expect(stepCredit(79999, P26.credits.employee)).toBeCloseTo(0.0204, 4);
    expect(stepCredit(500, P26.credits.employee)).toBe(0);
  });
  it('11. 2025 employee credit plateau is 600 + 192 = 792 €', () => {
    expect(stepCredit(30000, P25.credits.employee)).toBe(792);
    expect(stepCredit(60000, P25.credits.employee)).toBeCloseTo(792 - 0.0198 * 20000, 6);
  });
  it('12. single-parent credit by taxable income: 3,504 € → 2,280 € at 80,000 € → 750 € from 105,000 €', () => {
    expect(stepCredit(50000, P26.credits.singleParent)).toBe(3504);
    expect(stepCredit(80000, P26.credits.singleParent)).toBeCloseTo(2280, 6);
    expect(stepCredit(105000, P26.credits.singleParent)).toBeCloseTo(750, 6);
    expect(stepCredit(150000, P26.credits.singleParent)).toBe(750);
  });
  it('13. social contributions 2026 on 70,000 €: 11.55% capped part + 1.4% dependence after the allowance', () => {
    expect(socialContributions(70000, P26)).toBeCloseTo(70000 * 0.1155 + (70000 - 8229.46) * 0.014, 6);
    expect(socialContributions(200000, P26)).toBeCloseTo(164589.81 * 0.1155 + (200000 - 8229.46) * 0.014, 6);
  });
});

describe('full projection', () => {
  it('14. couple in class 2, 2026, salaries 70,000 € and 50,000 €, withholding 14,000 €', () => {
    const r = computeTax(
      {
        class: '2',
        persons: [
          { name: 'A', grossSalary: eur(70000), withheld: eur(9000) },
          { name: 'B', grossSalary: eur(50000), withheld: eur(5000) },
        ],
        householdMembers: 2,
        insurance: 0,
        otherDeductions: 0,
        otherIncome: 0,
      },
      P26,
    );
    // Net 103,610.42 − special-expenses lump 960 → 102,650.42 → rounded down to 102,650.
    expect(r.taxable).toBe(eur(102650));
    expect(r.incomeTax).toBe(eur(15636));
    expect(r.surcharge).toBe(eur(1094));
    expect(r.credits.reduce((s, c) => s + c.amount, 0)).toBe(eur(816)); // 204 + 612
    expect(r.liability).toBe(eur(15914));
    expect(r.balance).toBe(eur(14000 - 15914));
  });
  it('15. employment fund: 9% only on the tax for income above 150,000 € (class 1)', () => {
    const r = computeTax({ class: '1', persons: [], householdMembers: 1, insurance: 0, otherDeductions: 0, otherIncome: eur(200480) }, P26);
    expect(r.taxable).toBe(eur(200000));
    const tax = Math.floor(scaleTax(200000, P26.scale));
    const above = scaleTax(200000, P26.scale) - scaleTax(150000, P26.scale);
    expect(r.surcharge).toBe(eur(Math.floor(tax * 0.07 + above * 0.02)));
    expect(r.surcharge).toBe(eur(5082));
  });
  it('16. insurance premiums count up to 672 € per household member, above the lump sum', () => {
    const base = { class: '2' as const, persons: [], householdMembers: 4, otherDeductions: 0, otherIncome: eur(80000) };
    const r = computeTax({ ...base, insurance: eur(5000) }, P26);
    expect(r.deductions.find((d) => d.label === 'insurance')!.amount).toBe(eur(2688));
    const lump = computeTax({ ...base, insurance: eur(500) }, P26);
    expect(lump.deductions.find((d) => d.label === 'specialLump')!.amount).toBe(eur(960));
  });
  it('17. pension savings ceiling is 3,200 € in 2025 and 4,500 € in 2026', () => {
    const input = { class: '1' as const, persons: [{ name: 'A', grossSalary: eur(60000), withheld: 0, pensionSavings: eur(6000) }], householdMembers: 1, insurance: 0, otherDeductions: 0, otherIncome: 0 };
    expect(computeTax(input, P25).deductions.find((d) => d.label === 'pensionSavings')!.amount).toBe(eur(3200));
    expect(computeTax(input, P26).deductions.find((d) => d.label === 'pensionSavings')!.amount).toBe(eur(4500));
  });
  it('18. a per-value override changes only that value', () => {
    const o = withOverrides(P26, { 'scale.19.rate': 0.4, 'deductions.specialLump': 600, 'nope.x': 1 });
    expect(o.scale[19]!.rate).toBe(0.4);
    expect(o.deductions.specialLump).toBe(600);
    expect(P26.scale[19]!.rate).toBe(0.39);
    expect(classTax(100000, '1', o)).toBeGreaterThan(classTax(100000, '1', P26));
  });
  it('19. every parameter file names its sources', () => {
    for (const p of [P25, P26]) {
      expect(p.sources.length).toBeGreaterThan(0);
      for (const s of p.sources) expect(s.url).toMatch(/^https:\/\//);
    }
  });
});
