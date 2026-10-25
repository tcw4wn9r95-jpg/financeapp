import { describe, expect, it } from 'vitest';
import p2025 from '../../../tax/lu/2025.json';
import p2026 from '../../../tax/lu/2026.json';
import { classTax, type TaxParams } from './lu';
import { parseTaxDocument } from './documents';
import { estimateReturn, payerOf, sameName, suggestSetup, type EstimateContext } from './estimate';
import { computeReturn, deductionIdeas, homeCeilingPerMember, type ReturnInput } from './return';
import type { Account, Allocation, BudgetDefault, Category, Provision, TaxDocumentRecord, Transaction } from '../types';

/** The full return (D-95), on a made-up household. */

const P25 = p2025 as TaxParams;
const P26 = p2026 as TaxParams;
const e = (n: number) => Math.round(n * 100);
const f = (amount: number, source: 'document' | 'ledger' = 'document') => ({ amount: e(amount), source });

const couple: ReturnInput = {
  year: 2025,
  class: '2',
  persons: [
    { name: 'Alex', gross: f(120_000), social: f(13_000), lrcp: f(1_200), withheld: f(20_000) },
    { name: 'Sam', gross: f(80_000), social: f(9_000), lrcp: f(0), withheld: f(9_000) },
  ],
  householdMembers: 2,
  homeInterest: f(10_000),
  homeSince: 2022,
  insurance: f(400),
  advances: f(8_000),
};

describe('computeReturn', () => {
  const r = computeReturn(couple, P25);
  it('takes the professional lump sum per employee', () => {
    expect(r.netSalaries).toBe(e(200_000 - 2 * 540));
  });
  it('caps home-loan interest at 4,000 € per household member from the third year', () => {
    expect(homeCeilingPerMember(2025, 2022, P25)).toBe(4_000);
    expect(homeCeilingPerMember(2023, 2022, P25)).toBeNull();
    expect(homeCeilingPerMember(2028, 2022, P25)).toBe(3_000);
    expect(homeCeilingPerMember(2033, 2022, P25)).toBe(2_000);
    expect(r.home.amount).toBe(-e(8_000));
  });
  it('uses the 480 € lump sum per taxpayer when premiums are lower, plus contributions and LRCP', () => {
    expect(r.special.map((l) => l.key)).toEqual(['specialLump', 'social:Alex', 'social:Sam', 'lrcp:Alex']);
    expect(r.specialTotal).toBe(e(960 + 13_000 + 9_000 + 1_200));
    expect(r.taxableIncome).toBe(e(198_920 - 8_000 - 24_160));
  });
  it('gives the extra-professional allowance and rounds down to 50 € for the scale', () => {
    expect(r.allowance).toBe(e(4_500));
    expect(r.scaleIncome).toBe(e(162_250));
    expect(r.incomeTax).toBe(e(Math.floor(classTax(162_250, '2', P25))));
  });
  it('drops the cents of what is left after withholding, then takes off the advances', () => {
    expect(r.withheld).toBe(e(29_000));
    expect(r.afterWithholding).toBe(r.totalDue - e(29_000));
    expect(r.settlement).toBe(Math.trunc(r.afterWithholding / 100) * 100 - e(8_000));
  });
  it('lists premiums when they beat the lump sum, and caps them per member', () => {
    const x = computeReturn({ ...couple, insurance: f(3_000) }, P25);
    expect(x.special[0]).toMatchObject({ key: 'insurance', amount: e(2 * 672) });
  });
  it('suggests unused deductions with what they save', () => {
    const ideas = deductionIdeas(couple, P25);
    const pension = ideas.find((i) => i.kind === 'pensionSavings' && i.person === 'Alex')!;
    expect(pension.max).toBe(e(P25.deductions.pensionSavings));
    // At a ~40 % marginal rate the full amount saves well over a third of it.
    expect(pension.saving).toBeGreaterThan(pension.max! * 0.35);
    expect(ideas.find((i) => i.kind === 'insurance')!.max).toBe(e(2 * 672));
  });
});

describe('parseTaxDocument', () => {
  it('reads a salary certificate (modèle 160)', () => {
    const d = parseTaxDocument([
      'modèle 160   année :2025   page :',
      'salarié(e): Example   Alex',
      '2   A) rémunérations brutes   3)   S   100 000,00',
      '10   sous-total:   101 000,50',
      '18   cotisations sociales déductibles(ligne 10-(11-12-13-24))   11 000,25',
      '26   LRCP   L)',
      '1 200,00   nombre de jours imposables',
      '40   E) impôt retenu   15 500,40',
      'Cotisation dépendance : 1 400,00',
    ]);
    expect(d).toEqual({ kind: 'salary', year: 2025, subject: 'Example Alex', values: { gross: 10_100_050, social: 1_100_025, withheld: 1_550_040, lrcp: 120_000, dependence: 140_000 } });
  });
  it('reads a loan interest certificate', () => {
    const d = parseTaxDocument(['IBAN LU12 3456 7890 1234 5678', 'Outstanding balance on 31.12.2025   :   190.000,00 EUR', 'Outstanding balance on 01.01.2025   :   200.000,00 EUR', 'Interest due 2025 in our favour   :   7.750,10 EUR', 'Interest rate   :   3,90 % p.a.']);
    expect(d).toEqual({ kind: 'loan', year: 2025, subject: '••5678', values: { interest: 775_010, balanceEnd: 19_000_000, balanceStart: 20_000_000, rate: 390 } });
  });
  it('reads an assessment', () => {
    const d = parseTaxDocument([
      "Bulletin de l'impôt sur le revenu",
      '2 0 2 5',
      'Revenu imposable - Einkommen   150.000,00',
      "Le contribuable est rangé dans la classe d'impôt 2",
      'Impôt dû - Steuerschuld   30.000,00',
      'Contribution au fonds pour l’emploi   2.100,00',
      'Retenue sur salaires et pensions   25.000,00',
      'Montant restant - Verbleibender Betrag   7.100,00',
    ]);
    expect(d?.kind).toBe('assessment');
    expect(d?.year).toBe(2025);
    expect(d?.values).toMatchObject({ taxable: 15_000_000, tax: 3_000_000, withheld: 2_500_000, remaining: 710_000, class: 20 });
  });
  it('reads the statement of account and the advances it fixes', () => {
    const d = parseTaxDocument(["Décompte à la suite des bulletins d'impôt du   01/06/2026", '*   2025   7.100,00   8.000,00   900,00   0,00 *', '*   10/03   2.000,00   2.000,00   0,00   0,00 *', '*   10/06   2.000,00   0,00   0,00   2.000,00 *']);
    expect(d).toEqual({ kind: 'statement', year: 2025, values: { fixed: 710_000, paid: 800_000, refund: 90_000, due: 0 }, schedule: { '2026-03': 200_000, '2026-06': 200_000 } });
  });
  it('reads an advances bulletin', () => {
    const d = parseTaxDocument(["Fixation des avances trimestrielles de l'impôt sur le revenu.", "- pour l'année 2026 à partir de l'échéance du 10/09/2026 par trimestre à   1.500,00 EUR", '- à partir du 10/03/2027 par trimestre à   1.800,00 EUR']);
    expect(d?.schedule).toEqual({ '2026-09': 150_000, '2026-12': 150_000, '2027-03': 180_000, '2027-06': 180_000, '2027-09': 180_000, '2027-12': 180_000 });
  });
  it('does not guess', () => {
    expect(parseTaxDocument(['Monthly statement', 'Balance 1.000,00'])).toBeNull();
  });
});

describe('estimateReturn', () => {
  const stamp = { createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', source: 'manual' };
  const salary = { ...stamp, id: 'sal', name: 'Salary Alex', groupId: 'income', isIncome: true, rolloverMode: 'reset', sortOrder: 0 } as unknown as Category;
  const allowance = { ...stamp, id: 'fam', name: 'Allocation Kid', groupId: 'income', isIncome: true, rolloverMode: 'reset', sortOrder: 1 } as unknown as Category;
  const advance = { ...stamp, id: 'adv', name: 'Tax advance', groupId: 'provisions', isIncome: false, rolloverMode: 'roll', sortOrder: 2 } as unknown as Category;
  const settle = { ...stamp, id: 'prov', name: '2026 Taxes', groupId: 'provisions', isIncome: false, rolloverMode: 'roll', sortOrder: 3 } as unknown as Category;
  const txs: Transaction[] = [];
  const allocs: Allocation[] = [];
  const add = (id: string, date: string, amount: number, target: string, who: string, type: 'income' | 'category' = 'income') => {
    txs.push({ ...stamp, id, accountId: 'cur', date, amount: e(amount), descriptionRaw: who, counterparty: who } as unknown as Transaction);
    allocs.push({ ...stamp, id: `a-${id}`, transactionId: id, targetType: type, targetId: target, amount: e(amount) } as unknown as Allocation);
  };
  for (let m = 1; m <= 10; m++) add(`s${m}`, `2026-${String(m).padStart(2, '0')}-25`, 3_000, 'sal', 'ACME SARL');
  add('friend', '2026-05-02', 80, 'sal', 'A FRIEND');
  add('kid', '2026-09-14', 300, 'fam', 'CAE');
  add('q1', '2026-03-10', -1_000, 'adv', 'ACD', 'category');
  const defaults: BudgetDefault[] = [{ ...stamp, id: 'd1', categoryId: 'sal', monthlyAmount: e(3_000), effectiveFrom: '2026-01' } as unknown as BudgetDefault];
  const provisions: Provision[] = [{ ...stamp, id: 'p1', name: 'Q4 advance', amount: e(1_000), dueDate: '2026-12-10', recurrence: '', fundedBalance: 0, monthlyContribution: 0, categoryId: 'adv' } as unknown as Provision];
  const lastYear: TaxDocumentRecord = { id: 'c25', fileName: 'c.pdf', addedAt: '2026-01-01', kind: 'salary', year: 2025, subject: 'Example Alex', values: { gross: e(60_000), social: e(7_000), dependence: e(700), withheld: e(8_000), lrcp: 0 } };
  const ctx: EstimateContext = {
    year: 2026,
    today: '2026-10-26',
    regime: '1',
    params: P26,
    paramsLastYear: P25,
    setup: { persons: [{ name: 'Alex', salaryCategoryIds: ['sal'] }], advanceCategoryIds: ['adv'] },
    documents: [lastYear],
    accounts: [{ ...stamp, id: 'cur', name: 'Current', type: 'current' } as unknown as Account],
    transactions: txs,
    allocations: allocs,
    categories: [salary, allowance, advance, settle],
    defaults,
    overrides: [],
    provisions,
  };

  it('matches people to documents by name', () => {
    expect(sameName('EXAMPLE Alex Jordan', 'Alex')).toBe(true);
    expect(sameName('Example Sam', 'Alex')).toBe(false);
    expect(payerOf({ counterparty: '', descriptionRaw: 'CREDIT TRANSFER FROM ACME SARL  ref 12' })).toBe('ACME SARL');
  });
  it('grosses net pay received and planned up with last year’s certificate; small payers are not pay', () => {
    const est = estimateReturn(ctx);
    const trace = est.salaries.Alex!;
    expect(trace.received).toBe(e(30_000));
    expect(trace.planned).toBe(e(6_000));
    expect(trace.exempt).toBe(e(80));
    const p = est.input.persons[0]!;
    expect(p.gross.source).toBe('ledger');
    expect(p.gross.amount).toBe(Math.round(e(36_000) * (60_000 / 44_300)));
    expect(p.withheld.amount).toBe(Math.round((p.gross.amount * 8_000) / 60_000));
    expect(est.input.advances.amount).toBe(e(2_000));
  });
  it('uses this year’s certificate as it is once added, and typed figures win', () => {
    const cert: TaxDocumentRecord = { ...lastYear, id: 'c26', year: 2026, values: { gross: e(50_000), social: e(6_000), withheld: e(7_000), lrcp: 0 } };
    const est = estimateReturn({ ...ctx, documents: [lastYear, cert], setup: { ...ctx.setup, overrides: { 'withheld:Alex': e(7_500) } } });
    expect(est.input.persons[0]!.gross).toMatchObject({ amount: e(50_000), source: 'document' });
    expect(est.input.persons[0]!.withheld.amount).toBe(e(7_500));
  });
  it('asks for last year’s certificate when there is none', () => {
    expect(estimateReturn({ ...ctx, documents: [] }).missing).toContain('certificate:Alex');
  });
  it('suggests a setup: salary lines, children, advance lines and the settlement provision', () => {
    const s = suggestSetup({ year: 2026, members: ['Alex'], categories: ctx.categories, accounts: [], provisions: [{ ...provisions[0]!, id: 'p2', name: '2026 Taxes', categoryId: 'prov' }], transactions: txs, allocations: allocs, documents: [] });
    expect(s).toMatchObject({ persons: [{ name: 'Alex', salaryCategoryIds: ['sal'] }], children: 1, advanceCategoryIds: ['adv'], provisionId: 'p2' });
  });
});
