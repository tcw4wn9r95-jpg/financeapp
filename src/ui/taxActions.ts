import { defaultFor } from '../domain/budget';
import { addMonths, compareMonths, currentMonth, monthDiff, monthOf, monthRange } from '../domain/dates';
import { stamp, systemClock } from '../domain/ledger';
import type { ParsedTaxDocument } from '../domain/tax/documents';
import type { BudgetDefault, Cents, Id, IsoDate, Provision, TaxDocumentRecord, TaxProfile, TaxSetup } from '../domain/types';
import type { Vault, WriteOp } from '../storage/vault';
import { saveProvision } from './actions';

/** Write operations of the tax module (D-95). */

export function blankTaxProfile(year: number): TaxProfile {
  return {
    ...(stamp(systemClock, 'manual') as TaxProfile),
    year,
    regime: '2',
    persons: [],
    householdMembers: 2,
    insurance: 0,
    otherDeductions: 0,
    otherIncome: 0,
    withholdingYtd: 0,
    paramsVersion: String(year),
    overrides: {},
  };
}

function profileFor(vault: Vault, year: number): TaxProfile {
  return vault.list('taxProfiles').find((p) => p.year === year) ?? blankTaxProfile(year);
}

export async function saveTaxProfile(vault: Vault, year: number, patch: Partial<Omit<TaxProfile, 'id' | 'year'>>): Promise<void> {
  const p = profileFor(vault, year);
  await vault.put('taxProfiles', { ...p, ...patch, updatedAt: new Date().toISOString() });
}

export async function saveTaxSetup(vault: Vault, year: number, setup: TaxSetup): Promise<void> {
  await saveTaxProfile(vault, year, { setup, householdMembers: Math.max(1, setup.persons.length + (setup.children ?? 0)) });
}

/**
 * Keep a document's figures with its tax year.
 */
export async function addTaxDocument(vault: Vault, doc: ParsedTaxDocument, fileName: string): Promise<TaxDocumentRecord> {
  const p = profileFor(vault, doc.year);
  const record: TaxDocumentRecord = { id: systemClock.newId(), fileName, addedAt: new Date().toISOString(), ...doc };
  // Payslips are kept month by month; other documents replace the one of the same kind, year and subject.
  const same = (d: TaxDocumentRecord) => d.kind === doc.kind && d.year === doc.year && (d.subject ?? '') === (doc.subject ?? '') && (doc.kind !== 'payslip' || d.values.month === doc.values.month);
  const kept = (p.documents ?? []).filter((d) => !same(d));
  await vault.put('taxProfiles', { ...p, documents: [...kept, record], updatedAt: new Date().toISOString() });
  return record;
}

export async function removeTaxDocument(vault: Vault, profileId: Id, docId: Id): Promise<void> {
  const p = vault.get('taxProfiles', profileId);
  if (!p) return;
  await vault.put('taxProfiles', { ...p, documents: (p.documents ?? []).filter((d) => d.id !== docId), updatedAt: new Date().toISOString() });
}

/**
 * Point a provision at a new amount and date without changing what earlier
 * months already set aside: from this month on, the rest is spread evenly up
 * to the due month.
 */
export async function retargetProvision(vault: Vault, p: Provision, amount: Cents, dueDate: IsoDate): Promise<void> {
  const now = currentMonth();
  const defaults = vault.list('budgetDefaults').filter((d) => d.categoryId === p.categoryId);
  const first = defaults.map((d) => d.effectiveFrom).sort()[0] ?? now;
  let setAside = 0;
  if (compareMonths(first, now) < 0) for (const m of monthRange(first, addMonths(now, -1))) setAside += defaultFor(defaults, p.categoryId, m)?.monthlyAmount ?? 0;
  const due = monthOf(dueDate);
  const months = Math.max(1, monthDiff(now, due) + 1);
  const monthly = Math.max(0, Math.ceil((amount - setAside) / months));
  const ops: WriteOp[] = [];
  for (const d of defaults) if (compareMonths(d.effectiveFrom, now) >= 0) ops.push({ type: 'delete', store: 'budgetDefaults', id: d.id });
  const step = (from: string, monthlyAmount: Cents): WriteOp => ({ type: 'put', store: 'budgetDefaults', record: { ...(stamp(systemClock, 'manual') as BudgetDefault), categoryId: p.categoryId, monthlyAmount, effectiveFrom: from } });
  ops.push(step(now, monthly), step(addMonths(due, 1), 0));
  ops.push({ type: 'put', store: 'provisions', record: { ...p, amount, dueDate, recurrence: '', monthlyContribution: monthly, startDate: p.startDate ?? `${first}-01`, updatedAt: new Date().toISOString() } });
  await vault.write(ops);
}

/** A new one-off provision for the settlement, saved for from today. */
export async function createTaxProvision(vault: Vault, name: string, amount: Cents, dueDate: IsoDate, today: IsoDate): Promise<Id | undefined> {
  await saveProvision(vault, { name, amount, dueDate, recurrence: '', startDate: today });
  return vault.list('provisions').find((x) => x.name === name && x.dueDate === dueDate)?.id;
}
