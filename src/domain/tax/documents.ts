import type { Cents } from '../types';

/**
 * Reading Luxembourg tax documents from their text (D-95): the salary
 * certificate (modèle 160), the bank's loan-interest certificate, the return
 * as filed (modèle 100), the assessment (bulletin d'impôt), the advances
 * bulletin and the statement of account (décompte). Only the figures are
 * kept; the file itself is not stored. A document that is not recognised is
 * reported as such, never guessed.
 */

export type TaxDocKind = 'salary' | 'loan' | 'return' | 'assessment' | 'advances' | 'statement';

export interface ParsedTaxDocument {
  kind: TaxDocKind;
  /** The tax year the figures belong to. */
  year: number;
  /** Who or what it is about: the employee's name, the loan's IBAN end. */
  subject?: string;
  /** Figures in cents (rates in hundredths of a percent). */
  values: Record<string, number>;
  /** Dated amounts: advances due, by month (YYYY-MM). */
  schedule?: Record<string, Cents>;
  /** For a return as filed: one set of figures per person, by name. */
  persons?: { name: string; values: Record<string, number> }[];
}

/** "91 500,00", "22.165,00", "-8 000,00" → cents. */
export function luAmount(s: string): Cents | null {
  const m = s.match(/-?\d{1,3}(?:[ .  ]\d{3})*,\d{2}/);
  if (!m) return null;
  const neg = m[0].startsWith('-');
  const digits = m[0].replace(/[^\d,]/g, '').replace(',', '');
  const v = Number(digits);
  return Number.isFinite(v) ? (neg ? -v : v) : null;
}

/** The last amount on a line (the value column). */
function lastAmount(line: string): Cents | null {
  const all = [...line.matchAll(/-?\d{1,3}(?:[ .  ]\d{3})*,\d{2}/g)];
  const last = all.at(-1);
  return last ? luAmount(last[0]) : null;
}

/** The amount on the first line matching `label`, or on the line after it. */
function amountAfter(lines: readonly string[], label: RegExp, from = 0): { value: Cents; index: number } | null {
  for (let i = from; i < lines.length; i++) {
    if (!label.test(lines[i]!)) continue;
    const here = lastAmount(lines[i]!.replace(label, ''));
    if (here !== null) return { value: here, index: i };
    const next = lines[i + 1] ? lastAmount(lines[i + 1]!) : null;
    if (next !== null) return { value: next, index: i };
  }
  return null;
}

function allAmountsAfter(lines: readonly string[], label: RegExp): Cents[] {
  const out: Cents[] = [];
  let from = 0;
  for (;;) {
    const hit = amountAfter(lines, label, from);
    if (!hit) return out;
    out.push(hit.value);
    from = hit.index + 1;
  }
}

const has = (lines: readonly string[], re: RegExp) => lines.some((l) => re.test(l));

function salaryCertificate(lines: readonly string[]): ParsedTaxDocument | null {
  if (!has(lines, /modèle\s*160/i) || !has(lines, /rémunérations brutes/i)) return null;
  const year = Number(lines.join(' ').match(/année\s*:\s*(\d{4})/i)?.[1]);
  const name = lines.find((l) => /salarié\(e\)\s*:/i.test(l))?.replace(/.*salarié\(e\)\s*:\s*/i, '').split(/\s+/).filter((w, i, all) => w && all.indexOf(w) === i).join(' ');
  const gross = amountAfter(lines, /sous-total\s*:/i)?.value;
  const social = amountAfter(lines, /cotisations sociales déductibles/i)?.value;
  const withheld = amountAfter(lines, /impôt retenu/i)?.value;
  // The LRCP amount sits on the line after its label.
  const lrcpAt = lines.findIndex((l) => /^\s*26\s+LRCP/i.test(l));
  const lrcp = lrcpAt >= 0 ? (lastAmount(lines[lrcpAt]!) ?? lastAmount(lines[lrcpAt + 1] ?? '')) : null;
  const dependence = amountAfter(lines, /cotisation dépendance/i)?.value;
  if (!year || gross === undefined) return null;
  return {
    kind: 'salary',
    year,
    ...(name ? { subject: name } : {}),
    values: { gross, ...(social !== undefined ? { social } : {}), ...(withheld !== undefined ? { withheld } : {}), ...(lrcp !== null ? { lrcp } : {}), ...(dependence !== undefined ? { dependence } : {}) },
  };
}

function loanCertificate(lines: readonly string[]): ParsedTaxDocument | null {
  const text = lines.join('\n');
  const interest = text.match(/Interest due (\d{4})[^:]*:\s*([\d .,]+)/i) ?? text.match(/Intérêts? (?:débiteurs? )?(?:échus|dus)?\s*(\d{4})[^:]*:\s*([\d .,]+)/i);
  if (!interest) return null;
  const year = Number(interest[1]);
  const end = text.match(/Outstanding balance on 31\.12\.\d{4}\s*:\s*([\d .,]+)/i)?.[1];
  const start = text.match(/Outstanding balance on 01\.01\.\d{4}\s*:\s*([\d .,]+)/i)?.[1];
  const rate = text.match(/Interest rate\s*:\s*([\d,]+)\s*%/i)?.[1];
  const iban = text.match(/IBAN\s+(LU[\d ]+)/i)?.[1]?.replace(/\s/g, '');
  return {
    kind: 'loan',
    year,
    ...(iban ? { subject: `••${iban.slice(-4)}` } : {}),
    values: {
      interest: luAmount(interest[2]!) ?? 0,
      ...(end ? { balanceEnd: luAmount(end) ?? 0 } : {}),
      ...(start ? { balanceStart: luAmount(start) ?? 0 } : {}),
      ...(rate ? { rate: Math.round(Number(rate.replace(',', '.')) * 100) } : {}),
    },
  };
}

function filedReturn(lines: readonly string[]): ParsedTaxDocument | null {
  const title = lines.join(' ').match(/(?:Income tax return for the year|Déclaration pour l'impôt sur le revenu de l'année|année d'imposition)\s*(\d{4})/i);
  if (!title || !has(lines, /Form 100|modèle 100|ACD \(/i)) return null;
  const year = Number(title[1]);
  const gross = allAmountsAfter(lines, /Total gross remuneration|Total des rémunérations brutes/i);
  const social = allAmountsAfter(lines, /^Deductible social security contributions|^Cotisations sociales déductibles/i);
  const lrcp = allAmountsAfter(lines, /^Complementary pension contributions \(LRCP/i);
  const withheld = allAmountsAfter(lines, /Withholding tax at source on salaries|Retenue d'impôt sur salaires/i);
  const travel = allAmountsAfter(lines, /^Income-related expenses on non-exempt income/i);
  // Taxpayer first, then the spouse: their names head every page.
  const names = [...new Set(lines.filter((l) => /\.\.\.\s*$/.test(l)).map((l) => l.replace(/\s*\.\.\.\s*$/, '').trim()))].slice(0, 2);
  const persons = names.map((name, i): { name: string; values: Record<string, number> } => ({
    name,
    values: {
      ...(gross[i] !== undefined ? { gross: gross[i]! } : {}),
      ...(social[i] !== undefined ? { social: social[i]! } : {}),
      ...(lrcp[i] !== undefined ? { lrcp: lrcp[i]! } : {}),
      ...(withheld[i] !== undefined ? { withheld: withheld[i]! } : {}),
      ...(travel[i] !== undefined ? { workExpenses: travel[i]! } : {}),
    },
  }));
  // Birth years from the national identification numbers (only the year is kept).
  const births = [...lines.join('\n').matchAll(/National identification\s+(\d{4})\s?\d{4}/gi)].map((m) => Number(m[1]));
  births.forEach((b, i) => {
    if (persons[i]) persons[i]!.values.birthYear = b;
  });
  const since = lines.join('\n').match(/Available since\s+\d{2}\/\d{2}\/(\d{4})/i)?.[1];
  const homeInterest = [...allAmountsAfter(lines, /^By the taxpayer/i), ...allAmountsAfter(lines, /^By the spouse\/partner/i)].reduce((s, x) => s + x, 0);
  const premiums = allAmountsAfter(lines, /^Premium paid \((?:Taxpayer|Spouse\/partner)\)/i).reduce((s, x) => s + x, 0);
  return {
    kind: 'return',
    year,
    persons,
    values: { ...(since ? { homeSince: Number(since) } : {}), ...(homeInterest ? { homeInterest } : {}), insurance: premiums },
  };
}

function assessment(lines: readonly string[]): ParsedTaxDocument | null {
  if (!has(lines, /Bulletin de l'impôt sur le revenu/i) || !has(lines, /Impôt dû/i)) return null;
  const at = lines.findIndex((l) => /Bulletin de l'impôt sur le revenu/i.test(l));
  const yearText = lines.slice(at, at + 3).join(' ').match(/(\d)\s?(\d)\s?(\d)\s?(\d)/);
  const year = yearText ? Number(yearText.slice(1).join('')) : NaN;
  const get = (re: RegExp) => amountAfter(lines, re)?.value;
  const values: Record<string, number> = {};
  const put = (k: string, v: number | undefined) => {
    if (v !== undefined) values[k] = v;
  };
  put('netSalaries', get(/Revenu net d'une occupation salariée/i));
  put('home', get(/Revenu net de la location de biens/i));
  put('taxable', get(/^Revenu imposable - Einkommen/i));
  put('adjusted', get(/^Revenu imposable ajusté/i));
  put('scaleIncome', get(/^Revenu à imposer suivant le barème/i));
  put('tax', get(/^Impôt dû/i));
  put('fund', get(/fonds pour l'emploi/i));
  put('withheld', get(/^Retenue sur salaires/i));
  put('remaining', get(/^Montant restant/i));
  const cls = lines.join(' ').match(/classe d'impôt\s+(1a|1|2)/i)?.[1];
  if (cls) values.class = cls === '1a' ? 15 : Number(cls) * 10;
  if (!Number.isFinite(year) || values.tax === undefined) return null;
  return { kind: 'assessment', year, values };
}

function advancesBulletin(lines: readonly string[]): ParsedTaxDocument | null {
  if (!has(lines, /avances trimestrielles|Fixation des avances/i)) return null;
  const schedule: Record<string, Cents> = {};
  let year = 0;
  for (const l of lines) {
    const thisYear = l.match(/pour l'année (\d{4}) à partir de l'échéance du (\d{2})\/(\d{2})\/(\d{4}) par trimestre à\s*([\d .,]+)/i);
    if (thisYear) {
      year = Number(thisYear[1]);
      const amount = luAmount(thisYear[5]!) ?? 0;
      for (const m of [3, 6, 9, 12]) if (m >= Number(thisYear[3])) schedule[`${thisYear[1]}-${String(m).padStart(2, '0')}`] = amount;
    }
    const later = l.match(/à partir du (\d{2})\/(\d{2})\/(\d{4}) par trimestre à\s*([\d .,]+)/i);
    if (later && !thisYear) {
      const amount = luAmount(later[4]!) ?? 0;
      for (const m of [3, 6, 9, 12]) schedule[`${later[3]}-${String(m).padStart(2, '0')}`] = amount;
    }
  }
  if (!Object.keys(schedule).length) return null;
  return { kind: 'advances', year: year || Number(Object.keys(schedule)[0]!.slice(0, 4)), values: {}, schedule };
}

function statementOfAccount(lines: readonly string[]): ParsedTaxDocument | null {
  if (!has(lines, /Décompte à la suite des bulletins/i)) return null;
  const settled = lines.map((l) => l.match(/\*\s*(\d{4})\s+(-?[\d .]+,\d{2})\s+(-?[\d .]+,\d{2})\s+(-?[\d .]+,\d{2})\s+(-?[\d .]+,\d{2})/)).find(Boolean);
  if (!settled) return null;
  const year = Number(settled[1]);
  const fixed = luAmount(settled[2]!) ?? 0;
  const paid = luAmount(settled[3]!) ?? 0;
  const refund = luAmount(settled[4]!) ?? 0;
  const due = luAmount(settled[5]!) ?? 0;
  // Advances fixed for the next year: "10/03   6.500,00 ..." rows.
  const schedule: Record<string, Cents> = {};
  for (const l of lines) {
    const row = l.match(/\*\s*(\d{2})\/(\d{2})\s+([\d .]+,\d{2})\s+([\d .]+,\d{2})/);
    if (row) schedule[`${year + 1}-${row[2]}`] = luAmount(row[3]!) ?? 0;
  }
  return { kind: 'statement', year, values: { fixed, paid, refund, due }, ...(Object.keys(schedule).length ? { schedule } : {}) };
}

/** Recognise a tax document from its text lines, or null. */
export function parseTaxDocument(lines: readonly string[]): ParsedTaxDocument | null {
  for (const parse of [salaryCertificate, loanCertificate, filedReturn, statementOfAccount, assessment, advancesBulletin]) {
    const doc = parse(lines);
    if (doc) return doc;
  }
  return null;
}
