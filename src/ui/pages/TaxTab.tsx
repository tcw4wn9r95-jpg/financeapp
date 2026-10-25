import { useMemo, useRef, useState, type ChangeEvent } from 'react';
import { currentMonth, formatDate, todayIso } from '../../domain/dates';
import { formatMoney, formatMoneyInput, parseMoney } from '../../domain/money';
import { parseTaxDocument } from '../../domain/tax/documents';
import { childLines, estimateReturn, suggestSetup, type Estimate, type EstimateContext, type SalaryTrace } from '../../domain/tax/estimate';
import { withOverrides, type TaxClass, type TaxParams } from '../../domain/tax/lu';
import { computeReturn, deductionIdeas, type Figure, type FigureSource, type ReturnResult } from '../../domain/tax/return';
import type { Cents, Provision, TaxDocumentRecord, TaxLineRole, TaxProfile, TaxSetup, TaxSetupPerson } from '../../domain/types';
import { monthName, t, type MessageKey } from '../../i18n';
import { SelectField, TextField } from '../components/fields';
import { Money } from '../components/Money';
import { useToast } from '../components/Toast';
import { useSettings, useStore, useVault } from '../hooks';
import { readImportFile } from '../importActions';
import { addTaxDocument, createTaxProvision, removeTaxDocument, retargetProvision, saveTaxProfile, saveTaxSetup } from '../taxActions';
import { TAX_YEARS, taxYears } from '../taxParams';

/**
 * Luxembourg income tax (PRD F10, D-95): the year's return estimated line by
 * line from the ledger, the budget and the tax documents added, what payroll
 * withholding and the quarterly advances already cover, and the settlement
 * expected around June of the next year — which feeds a provision (to pay) or
 * the forecast (refund). A projection, not tax advice.
 */

const CLASSES: TaxClass[] = ['1', '1a', '2'];

export function TaxTab() {
  const years = taxYears();
  const thisYear = Number(currentMonth().slice(0, 4));
  const [year, setYear] = useState(years.includes(thisYear) ? thisYear : years[0]!);
  if (years.length === 0) return <p className="notice">{t('tax.noParams')}</p>;
  return (
    <>
      <p className="notice notice-warn" role="note">{t('tax.disclaimer')}</p>
      <SelectField label={t('tax.year')} value={String(year)} onChange={(e) => setYear(Number(e.target.value))}>
        {years.map((y) => <option key={y} value={y}>{y}</option>)}
      </SelectField>
      <TaxYear key={year} year={year} params={TAX_YEARS[year]!} />
    </>
  );
}

interface Model {
  profile: TaxProfile | undefined;
  setup: TaxSetup;
  regime: TaxClass;
  params: TaxParams;
  ctx: EstimateContext;
  estimate: Estimate;
  result: ReturnResult;
  documents: { profile: TaxProfile; doc: TaxDocumentRecord }[];
}

function useTaxModel(year: number, base: TaxParams): Model {
  const settings = useSettings();
  const profiles = useStore('taxProfiles');
  const accounts = useStore('accounts');
  const transactions = useStore('transactions');
  const allocations = useStore('allocations');
  const categories = useStore('categories');
  const defaults = useStore('budgetDefaults');
  const overrides = useStore('budgetOverrides');
  const provisions = useStore('provisions');
  const members = (settings.members ?? []).map((m) => m.name).join('|');
  return useMemo(() => {
    const profile = profiles.find((p) => p.year === year);
    const documents = profiles.flatMap((p) => (p.documents ?? []).map((doc) => ({ profile: p, doc }))).sort((a, b) => b.doc.year - a.doc.year || a.doc.kind.localeCompare(b.doc.kind));
    const docs = documents.map((d) => d.doc);
    // A new year starts from last year's setup (who, which lines, which loans), without its estimates.
    const before = profiles.filter((p) => p.year < year && p.setup).sort((a, b) => b.year - a.year)[0]?.setup;
    const hints = { year, members: members ? members.split('|') : [], categories, accounts, provisions, transactions, allocations, documents: docs };
    const suggested = suggestSetup(hints);
    const setup: TaxSetup =
      (profile?.setup && { ...profile.setup, lines: profile.setup.lines ?? suggested.lines ?? {} }) ??
      (before
        ? {
            persons: before.persons.map((p) => ({ name: p.name, salaryCategoryIds: p.salaryCategoryIds, ...(p.birthYear ? { birthYear: p.birthYear } : {}), ...(p.commuteKm ? { commuteKm: p.commuteKm } : {}), ...(p.payers ? { payers: p.payers } : {}) })),
            ...(before.homeLoanIds ? { homeLoanIds: before.homeLoanIds } : {}),
            lines: before.lines ?? suggested.lines ?? {},
            ...(before.homeSince ? { homeSince: before.homeSince } : {}),
            ...(before.advanceCategoryIds ? { advanceCategoryIds: before.advanceCategoryIds } : {}),
            ...(suggested.children ? { children: suggested.children } : before.children ? { children: before.children } : {}),
            ...(suggested.provisionId ? { provisionId: suggested.provisionId } : {}),
          }
        : suggested);
    const regime = (profile?.setup && ['1', '1a', '2'].includes(profile.regime) ? profile.regime : setup.persons.length >= 2 ? '2' : '1') as TaxClass;
    const params = withOverrides(base, profile?.overrides ?? {});
    const ctx: EstimateContext = {
      year,
      today: todayIso(),
      regime,
      params,
      ...(TAX_YEARS[year - 1] ? { paramsLastYear: TAX_YEARS[year - 1]! } : {}),
      setup,
      documents: docs,
      accounts,
      transactions,
      allocations,
      categories,
      defaults,
      overrides,
      provisions,
    };
    const estimate = estimateReturn(ctx);
    return { profile, setup, regime, params, ctx, estimate, result: computeReturn(estimate.input, params), documents };
  }, [year, base, profiles, accounts, transactions, allocations, categories, defaults, overrides, provisions, members]);
}

function TaxYear({ year, params: base }: { year: number; params: TaxParams }) {
  const vault = useVault();
  const m = useTaxModel(year, base);
  const save = (setup: TaxSetup) => saveTaxSetup(vault, year, setup);
  const setOverride = (key: string, value: Cents | undefined) => {
    const next = { ...(m.setup.overrides ?? {}) };
    if (value === undefined) delete next[key];
    else next[key] = value;
    return save({ ...m.setup, overrides: next });
  };
  return (
    <>
      {base.status === 'draft' && <p className="notice" role="note">{t('tax.draft')} {base.note}</p>}
      <Summary m={m} year={year} />
      <Missing m={m} />
      <Documents m={m} year={year} />
      <Breakdown m={m} setOverride={setOverride} save={save} />
      <BudgetLines m={m} save={save} />
      <Ideas m={m} save={save} />
      <Compare m={m} year={year} />
      <Setup m={m} year={year} save={save} />
      <Overrides params={base} values={m.profile?.overrides ?? {}} onChange={(overrides) => saveTaxProfile(vault, year, { overrides })} />
      <Sources params={base} />
    </>
  );
}

// ------------------------------------------------------------- summary

const settleDue = (year: number) => `${year + 1}-06-30`;

function Summary({ m, year }: { m: Model; year: number }) {
  const vault = useVault();
  const notify = useToast();
  const provisions = useStore('provisions');
  const r = m.result;
  const pay = r.settlement > 0;
  const provision = provisions.find((p) => p.id === m.setup.provisionId);
  const due = settleDue(year);
  const target = Math.max(0, Math.ceil(r.settlement / 10_000) * 10_000);
  const inPlan = provision ? provision.amount === target && provision.dueDate === due : !pay && m.profile?.inForecast && m.setup.planned === r.settlement;
  const [busy, setBusy] = useState(false);

  async function plan() {
    setBusy(true);
    try {
      let provisionId = provision?.id;
      if (provision) await retargetProvision(vault, provision, target, due);
      else if (pay) provisionId = await createTaxProvision(vault, t('tax.provisionName', { year }), target, due, todayIso());
      await saveTaxSetup(vault, year, { ...m.setup, ...(provisionId ? { provisionId } : {}), planned: r.settlement });
      await saveTaxProfile(vault, year, { inForecast: !pay, settleMonth: `${year + 1}-06`, regime: m.regime });
      notify(pay ? t('tax.planned', { amount: formatMoney(target) }) : t('tax.plannedRefund'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card" aria-labelledby="tax-result">
      <h2 id="tax-result">{t('tax.result', { year })}</h2>
      <div className="headline">
        <span className="muted">{pay ? t('tax.dueAround', { month: monthName(`${year + 1}-06`) }) : t('tax.refundAround', { month: monthName(`${year + 1}-06`) })}</span>
        <span className={`big-number ${pay ? 'bad' : 'ok'}`}><Money cents={-r.settlement} /></span>
      </div>
      <ul className="plain-list">
        <li className="split-row"><span>{t('tax.liability')}</span><Money cents={r.totalDue} /></li>
        <li className="split-row"><span>{t('tax.withheldTotal')}</span><Money cents={-r.withheld} /></li>
        <li className="split-row"><span>{t('tax.advances')} <SourceBadge source={m.estimate.input.advances.source} /></span><Money cents={-r.advances} /></li>
        <li className="split-row"><strong>{pay ? t('tax.toPay') : t('tax.toGetBack')}</strong><strong><Money cents={-r.settlement} /></strong></li>
        <li className="split-row"><span>{t('tax.marginal')}</span><span>{(r.marginalRate * 100).toFixed(1).replace('.', ',')} %</span></li>
      </ul>
      <p className="hint">{t('tax.settleHint')}</p>
      {provision && (
        <p className="hint">
          {t('tax.inPlanProvision', { name: provision.name, amount: formatMoney(provision.amount), date: formatDate(provision.dueDate) })}
        </p>
      )}
      {!inPlan && (pay || provision || r.settlement < 0) && (
        <button type="button" className="button button-primary button-block" disabled={busy} onClick={plan}>
          {provision && !pay ? t('tax.provisionToRefund', { name: provision.name, amount: formatMoney(-r.settlement) }) : provision ? t('tax.updateProvision', { amount: formatMoney(target), date: formatDate(due) }) : pay ? t('tax.createProvision', { amount: formatMoney(target), date: formatDate(due) }) : t('tax.refundToForecast')}
        </button>
      )}
      {inPlan && <p className="hint">✓ {t('tax.planUpToDate')}</p>}
      {provision && !pay && <p className="hint">{t('tax.refundKeepsSaved', { name: provision.name })}</p>}
    </section>
  );
}

function Missing({ m }: { m: Model }) {
  const accounts = useStore('accounts');
  if (!m.estimate.missing.length) return null;
  return (
    <div className="notice" role="note">
      <ul className="plain-list">
        {m.estimate.missing.map((k) => {
          const [kind, what] = k.split(':');
          const name = kind === 'rate' ? (accounts.find((a) => a.id === what)?.name ?? '') : (what ?? '');
          return <li key={k}>{t(`tax.missing.${kind}` as MessageKey, { name })}</li>;
        })}
      </ul>
    </div>
  );
}

// ------------------------------------------------------------- documents

const KINDS = ['salary', 'payslip', 'loan', 'return', 'assessment', 'advances', 'statement'] as const;

function docSummary(d: TaxDocumentRecord): string {
  const e = (c: number | undefined) => (c === undefined ? '' : formatMoney(c));
  switch (d.kind) {
    case 'salary':
      return t('tax.doc.salaryLine', { gross: e(d.values.gross), withheld: e(d.values.withheld) });
    case 'payslip':
      return t('tax.doc.payslipLine', { month: monthName(`${d.year}-${String(d.values.month).padStart(2, '0')}`), gross: e(d.values.gross), withheld: e(d.values.withheld) });
    case 'loan':
      return t('tax.doc.loanLine', { interest: e(d.values.interest), rate: d.values.rate ? (d.values.rate / 100).toFixed(2).replace('.', ',') : '–' });
    case 'return':
      return t('tax.doc.returnLine', { n: d.persons?.length ?? 0 });
    case 'assessment':
      return t('tax.doc.assessmentLine', { tax: e(d.values.tax), remaining: e(d.values.remaining) });
    case 'statement':
      return d.values.refund ? t('tax.doc.refundLine', { amount: e(d.values.refund) }) : t('tax.doc.dueLine', { amount: e(d.values.due) });
    case 'advances':
      return Object.entries(d.schedule ?? {}).sort().map(([mo, v]) => `${mo}: ${e(v)}`).join(' · ');
  }
}

function Documents({ m, year }: { m: Model; year: number }) {
  const vault = useVault();
  const notify = useToast();
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  // This year's documents and last year's (which the estimate learns from).
  const shown = m.documents.filter((d) => d.doc.year >= year - 1);
  const older = m.documents.length - shown.length;

  async function add(e: ChangeEvent<HTMLInputElement>) {
    const files = [...(e.target.files ?? [])];
    e.target.value = '';
    if (!files.length) return;
    setBusy(true);
    const added: string[] = [];
    const unknown: string[] = [];
    for (const file of files) {
      try {
        const content = await readImportFile(file);
        const lines = content.kind === 'pdf' ? content.lines : content.text.split(/\r?\n/);
        const doc = parseTaxDocument(lines);
        if (!doc) unknown.push(file.name);
        else {
          await addTaxDocument(vault, doc, file.name);
          added.push(`${t(`tax.kind.${doc.kind}` as MessageKey)} ${doc.year}`);
        }
      } catch {
        unknown.push(file.name);
      }
    }
    setBusy(false);
    if (added.length) notify(t('tax.docsAdded', { n: added.length }));
    if (unknown.length) notify(t('tax.docsUnknown', { list: unknown.join(', ') }), 'error');
  }

  return (
    <section className="card" aria-labelledby="tax-docs">
      <h2 id="tax-docs">{t('tax.docs')}</h2>
      <p className="hint">{t('tax.docsHint', { year, last: year - 1 })}</p>
      {shown.length > 0 && (
        <ul className="plain-list">
          {shown.map(({ profile, doc }) => (
            <li key={doc.id} className="split-row">
              <span>
                <strong>{t(`tax.kind.${doc.kind}` as MessageKey)} {doc.year}</strong>
                {doc.subject && <span className="muted"> · {doc.subject}</span>}
                <br />
                <span className="muted">{docSummary(doc)}</span>
              </span>
              <button type="button" className="button button-quiet button-small" aria-label={t('tax.removeDoc', { name: doc.fileName })} onClick={() => removeTaxDocument(vault, profile.id, doc.id)}>
                {t('common.delete')}
              </button>
            </li>
          ))}
        </ul>
      )}
      {older > 0 && <p className="hint">{t('tax.olderDocs', { n: older })}</p>}
      <input ref={input} type="file" accept="application/pdf,.pdf,.txt" multiple hidden onChange={add} />
      <button type="button" className="button button-block" disabled={busy} onClick={() => input.current?.click()}>
        {busy ? t('tax.reading') : `+ ${t('tax.addDocs')}`}
      </button>
      <p className="hint">{t('tax.docsKinds', { list: KINDS.map((k) => t(`tax.kind.${k}` as MessageKey)).join(', ') })}</p>
    </section>
  );
}

// ------------------------------------------------------------- breakdown

function SourceBadge({ source }: { source: FigureSource | undefined }) {
  if (!source) return null;
  return <span className={`badge ${source === 'model' || source === 'estimate' ? 'badge-warn' : ''}`}>{t(`tax.src.${source}` as MessageKey)}</span>;
}

/** A line of the return; figures that come from an estimate can be typed over. */
function FigureRow({ label, figure, okey, overridden, onSet, sign = 1 }: { label: string; figure: Figure | { amount: Cents; source?: FigureSource; note?: string }; okey?: string; overridden?: boolean; onSet?: (key: string, v: Cents | undefined) => void; sign?: 1 | -1 }) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState('');
  const commit = () => {
    const c = parseMoney(text);
    if (c !== null && okey && onSet) onSet(okey, Math.abs(c));
    setEditing(false);
  };
  return (
    <li>
      <div className="split-row">
        <span>
          {label} <SourceBadge source={overridden ? 'estimate' : figure.source} />
        </span>
        <span className="row-end">
          <Money cents={sign * figure.amount} />
          {okey && onSet && !editing && (
            <button type="button" className="button button-quiet button-small" aria-label={t('tax.editFigure', { name: label })} onClick={() => { setText(formatMoneyInput(figure.amount)); setEditing(true); }}>
              ✎
            </button>
          )}
        </span>
      </div>
      {figure.note && !overridden && <p className="hint">{figure.note}</p>}
      {editing && (
        <div className="tax-edit">
          <TextField label={t('tax.typeFigure')} inputMode="decimal" value={text} onChange={(e) => setText(e.target.value)} autoFocus />
          <button type="button" className="button button-primary button-small" onClick={commit}>{t('common.save')}</button>
          {overridden && <button type="button" className="button button-quiet button-small" onClick={() => { onSet!(okey!, undefined); setEditing(false); }}>{t('tax.useEstimate')}</button>}
          <button type="button" className="button button-quiet button-small" onClick={() => setEditing(false)}>{t('common.cancel')}</button>
        </div>
      )}
    </li>
  );
}

function lineLabel(key: string): string {
  const [kind, who] = key.split(':');
  return t(`tax.line.${kind}` as MessageKey, { name: who ?? '' });
}

function Breakdown({ m, setOverride, save }: { m: Model; setOverride: (k: string, v: Cents | undefined) => void; save: (s: TaxSetup) => void }) {
  const r = m.result;
  const ov = m.setup.overrides ?? {};
  const row = (key: string, figure: Figure, sign: 1 | -1 = 1) => <FigureRow key={key} label={lineLabel(key)} figure={figure} okey={key} overridden={ov[key] !== undefined} onSet={setOverride} sign={sign} />;
  return (
    <details className="card" open>
      <summary><strong>{t('tax.breakdown')}</strong></summary>
      <p className="hint">{t('tax.breakdownHint')}</p>
      {m.estimate.input.persons.map((p, i) => (
        <section key={p.name}>
          <h3>{p.name}</h3>
          <ul className="plain-list">
            {row(`gross:${p.name}`, p.gross)}
            {m.estimate.salaries[p.name]?.rows && ov[`gross:${p.name}`] === undefined && <IncomeParts trace={m.estimate.salaries[p.name]!} />}
            <FigureRow label={lineLabel(`professional:${p.name}`)} figure={{ amount: m.params.deductions.professionalLump * 100, source: 'rule' }} sign={-1} />
            {p.travel && <FigureRow label={lineLabel(`travel:${p.name}`)} figure={p.travel} sign={-1} />}
            {row(`social:${p.name}`, p.social, -1)}
            {row(`lrcp:${p.name}`, p.lrcp, -1)}
            {row(`withheld:${p.name}`, p.withheld)}
            {m.estimate.salaries[p.name]?.withheldSoFar !== undefined && ov[`withheld:${p.name}`] === undefined && (
              <li className="hint">
                {t('tax.withheldSplit', { soFar: formatMoney(m.estimate.salaries[p.name]!.withheldSoFar!), ahead: formatMoney(m.estimate.salaries[p.name]!.withheldAhead ?? 0) })}
                {m.estimate.salaries[p.name]!.payslip && ` ${t('tax.withheldSlip', { month: monthName(`${m.ctx.year}-${String(m.estimate.salaries[p.name]!.payslip!.month).padStart(2, '0')}`), amount: formatMoney(m.estimate.salaries[p.name]!.payslip!.withheld) })}`}
                {(m.estimate.salaries[p.name]!.payslip?.exempt ?? 0) > 0 && ` ${t('tax.slipExempt', { amount: formatMoney(m.estimate.salaries[p.name]!.payslip!.exempt) })}`}
              </li>
            )}
          </ul>
          {m.estimate.salaries[p.name] && <Payers trace={m.estimate.salaries[p.name]!} person={m.setup.persons[i]!} onChange={(person) => save({ ...m.setup, persons: m.setup.persons.map((x, j) => (j === i ? person : x)) })} />}
        </section>
      ))}
      <h3>{t('tax.homeTitle')}</h3>
      <ul className="plain-list">
        {row('homeInterest', m.estimate.input.homeInterest)}
        <li className="split-row">
          <span>{r.homeCeiling === null ? t('tax.homeFull') : t('tax.homeCeiling', { members: m.estimate.input.householdMembers })}</span>
          <span>{r.homeCeiling === null ? '—' : <Money cents={r.homeCeiling} />}</span>
        </li>
        <li className="split-row"><strong>{t('tax.homeDeducted')}</strong><strong><Money cents={r.home.amount} /></strong></li>
      </ul>
      <h3>{t('tax.specialTitle')}</h3>
      <ul className="plain-list">
        {r.special.map((l) => (
          <li key={l.key} className="split-row"><span>{lineLabel(l.key)} <SourceBadge source={l.source} /></span><Money cents={-l.amount} /></li>
        ))}
      </ul>
      <h3>{t('tax.computeTitle')}</h3>
      <ul className="plain-list">
        <li className="split-row"><span>{t('tax.netSalaries')}</span><Money cents={r.netSalaries} /></li>
        {m.estimate.input.otherIncome && <li className="split-row"><span>{t('tax.line.otherIncome')} <SourceBadge source={m.estimate.input.otherIncome.source} /></span><Money cents={m.estimate.input.otherIncome.amount} /></li>}
        <li className="split-row"><span>{t('tax.totalNet')}</span><Money cents={r.totalNetIncome} /></li>
        <li className="split-row"><span>{t('tax.specialTotal')}</span><Money cents={-r.specialTotal} /></li>
        {r.childcare && <li className="split-row"><span>{t('tax.line.childcare')} <SourceBadge source={r.childcare.source} /></span><Money cents={-r.childcare.amount} /></li>}
        <li className="split-row"><strong>{t('tax.taxableIncome')}</strong><strong><Money cents={r.taxableIncome} /></strong></li>
        {r.allowance > 0 && <li className="split-row"><span>{t('tax.allowance')}</span><Money cents={-r.allowance} /></li>}
        <li className="split-row"><span>{t('tax.taxable')}</span><Money cents={r.scaleIncome} /></li>
        <li className="split-row"><span>{t('tax.incomeTax')} ({t(`tax.class.${m.regime}` as MessageKey)})</span><Money cents={r.incomeTax} /></li>
        <li className="split-row"><span>{t('tax.surcharge')}</span><Money cents={r.employmentFund} /></li>
        {r.credits.map((c) => <li key={c.key} className="split-row"><span>{lineLabel(c.key)}</span><Money cents={-c.amount} /></li>)}
        <li className="split-row"><strong>{t('tax.liability')}</strong><strong><Money cents={r.totalDue} /></strong></li>
        <li className="split-row"><span>{t('tax.withheldTotal')}</span><Money cents={-r.withheld} /></li>
        <li className="split-row"><span>{t('tax.afterWithholding')}</span><Money cents={r.afterWithholding} /></li>
        {row('advances', m.estimate.input.advances, -1)}
        <li className="split-row"><strong>{r.settlement > 0 ? t('tax.toPay') : t('tax.toGetBack')}</strong><strong><Money cents={-r.settlement} /></strong></li>
      </ul>
    </details>
  );
}

/** Public payers named for what they pay. */
function payerLabel(key: string): string {
  if (/TR[ÉE]SORERIE DE L.[ÉE]TAT|\bADEM\b/i.test(key)) return t('tax.payerAdem', { name: key });
  if (/\bCNS\b|CAISSE NATIONALE DE SANT/i.test(key)) return t('tax.payerCns', { name: key });
  return key;
}

/** Where a person's gross pay for the year comes from: the payslip, each payer since, and the months planned. */
function IncomeParts({ trace }: { trace: SalaryTrace }) {
  const groups = new Map<string, { label: string; months: string[]; net: Cents; gross: Cents }>();
  for (const r of trace.rows ?? []) {
    const key = r.source === 'payslip' ? 'payslip' : r.source === 'planned' ? 'planned' : `paid:${r.payer}`;
    const g = groups.get(key) ?? { label: r.source === 'planned' ? t('tax.partPlanned') : payerLabel(r.payer), months: [], net: 0, gross: 0 };
    g.months.push(r.date.slice(0, 7));
    g.net += r.net;
    g.gross += r.gross;
    groups.set(key, g);
  }
  const span = (months: string[]) => {
    const sorted = [...months].sort();
    const a = monthName(sorted[0]!);
    const b = monthName(sorted.at(-1)!);
    return a === b ? a : `${a.split(' ')[0]} – ${b}`;
  };
  return (
    <li>
      <ul className="plain-list tax-parts">
        {[...groups.entries()].map(([key, g]) => (
          <li key={key} className="split-row">
            <span>
              {key === 'payslip' ? t('tax.partPayslip', { issuer: g.label, month: monthName(g.months[0]!) }) : g.label}
              <br />
              <span className="muted">
                {key === 'payslip' ? (trace.payslip?.exempt ? t('tax.partExempt', { amount: formatMoney(trace.payslip.exempt) }) : t('tax.partFromPayslip')) : t('tax.partNet', { span: span(g.months), net: formatMoney(g.net) })}
              </span>
            </span>
            <Money cents={g.gross} />
          </li>
        ))}
      </ul>
    </li>
  );
}

/** Who paid into the salary lines this year, and which of it is taxable pay. */
function Payers({ trace, person, onChange }: { trace: SalaryTrace; person: TaxSetupPerson; onChange: (p: TaxSetupPerson) => void }) {
  return (
    <details>
      <summary>{t('tax.payersTitle', { received: formatMoney(trace.received), planned: formatMoney(trace.planned) })}</summary>
      <p className="hint">{t('tax.payersHint')}{trace.grossPerNet && !trace.model ? ` ${t('tax.grossPerNet', { ratio: trace.grossPerNet.toFixed(2).replace('.', ',') })}` : ''}</p>
      {trace.model && (
        <p className="hint">
          {t('tax.modelLine', {
            month: monthName(`${trace.model.year}-${String(trace.model.month).padStart(2, '0')}`),
            issuer: trace.model.issuer ?? '',
            health: pct(trace.model.health),
            pension: pct(trace.model.pension),
            dependence: pct(trace.model.dependence),
            tax: pct(trace.model.taxRate),
            allowances: formatMoney(trace.model.allowances),
            after: formatMoney(trace.model.after),
          })}
        </p>
      )}
      {trace.rows && trace.rows.length > 0 && (
        <div className="tax-compare-wrap">
          <table className="tax-compare">
            <thead>
              <tr><th>{t('tax.colMonth')}</th><th>{t('tax.colNet')}</th><th>{t('tax.colGross')}</th><th>{t('tax.colSocial')}</th><th>{t('tax.colTax')}</th></tr>
            </thead>
            <tbody>
              {trace.rows.map((r, i) => (
                <tr key={i} className={r.source === 'planned' ? 'muted' : undefined}>
                  <th scope="row">
                    {r.source === 'payslip' ? t('tax.rowPayslip', { month: monthName(r.date.slice(0, 7)) }) : monthName(r.date.slice(0, 7))}
                    <br />
                    <span className="muted">{r.source === 'planned' ? t('tax.rowPlanned') : r.payer}</span>
                  </th>
                  <td><Money cents={r.net} /></td>
                  <td><Money cents={r.gross} /></td>
                  <td><Money cents={r.social + r.dependence} /></td>
                  <td><Money cents={r.withheld} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <ul className="plain-list">
        {trace.payers.map((p) => (
          <li key={p.key} className="split-row">
            <span>
              {p.key}
              <br />
              <span className="muted">{t('tax.payerMeta', { n: p.rows, date: formatDate(p.last) })}{trace.payslip && p.untilSlip > 0 && p.treatment === 'taxable' ? ` · ${t('tax.inPayslip', { amount: formatMoney(p.untilSlip) })}` : ''}</span>
            </span>
            <span className="row-end">
              <Money cents={p.received} />
              <select aria-label={t('tax.payerTreatment', { name: p.key })} value={p.treatment} onChange={(e) => onChange({ ...person, payers: { ...(person.payers ?? {}), [p.key]: e.target.value as 'taxable' | 'exempt' } })}>
                <option value="taxable">{t('tax.taxablePay')}</option>
                <option value="exempt">{t('tax.notPay')}</option>
              </select>
            </span>
          </li>
        ))}
      </ul>
      <MoneyCommit label={t('tax.exemptPay')} hint={t('tax.exemptPayHint')} value={person.exemptPay} onCommit={(v) => onChange({ ...person, ...(v ? { exemptPay: v } : { exemptPay: undefined }) })} />
      <MoneyCommit label={t('tax.extraGross')} hint={t('tax.extraGrossHint')} value={person.extraGross} onCommit={(v) => onChange({ ...person, ...(v ? { extraGross: v } : { extraGross: undefined }) })} />
    </details>
  );
}

const pct = (x: number) => (x * 100).toFixed(2).replace('.', ',');

/** A money box saved when it loses focus. */
function MoneyCommit({ label, hint, value, onCommit }: { label: string; hint?: string; value: Cents | undefined; onCommit: (v: Cents | undefined) => void }) {
  const [text, setText] = useState(value ? formatMoneyInput(value) : '');
  const parsed = text.trim() ? parseMoney(text) : null;
  return (
    <TextField
      label={label}
      {...(hint ? { hint } : {})}
      inputMode="decimal"
      value={text}
      {...(text.trim() && parsed === null ? { error: t('field.moneyInvalid') } : {})}
      onChange={(e) => setText(e.target.value)}
      onBlur={() => {
        if (text.trim() && parsed === null) return;
        const v = parsed === null ? undefined : Math.abs(parsed);
        if (v !== value) onCommit(v);
      }}
    />
  );
}

function NumberCommit({ label, hint, value, onCommit }: { label: string; hint?: string; value: number | undefined; onCommit: (v: number | undefined) => void }) {
  const [text, setText] = useState(value === undefined ? '' : String(value));
  return (
    <TextField
      label={label}
      {...(hint ? { hint } : {})}
      inputMode="numeric"
      value={text}
      onChange={(e) => setText(e.target.value.replace(/\D/g, ''))}
      onBlur={() => {
        const v = text ? Number(text) : undefined;
        if (v !== value) onCommit(v);
      }}
    />
  );
}

// ------------------------------------------------------------- budget lines

const ROLES: TaxLineRole[] = ['insurance', 'pensionSavings', 'homeSavings', 'donations', 'childcare', 'otherIncome'];
const PER_PERSON: TaxLineRole[] = ['pensionSavings', 'homeSavings'];

/** Budget lines whose year (spent so far + budgeted to December) counts on the return (D-99). */
function BudgetLines({ m, save }: { m: Model; save: (s: TaxSetup) => void }) {
  const categories = useStore('categories');
  const [adding, setAdding] = useState('');
  const [role, setRole] = useState<TaxLineRole>('insurance');
  const lines = m.setup.lines ?? {};
  const setLine = (id: string, v: { role: TaxLineRole; person?: string } | undefined) => {
    const next = { ...lines };
    if (v) next[id] = v;
    else delete next[id];
    save({ ...m.setup, lines: next });
  };
  const free = categories.filter((c) => !c.archivedAt && !lines[c.id] && !m.setup.persons.some((p) => p.salaryCategoryIds.includes(c.id)));
  const total = m.estimate.lines.reduce((s, l) => s + l.actual + l.planned, 0);
  return (
    <details className="card">
      <summary><strong>{t('tax.lines')}</strong>{m.estimate.lines.length > 0 && <span className="badge">{formatMoney(total)}</span>}</summary>
      <p className="hint">{t('tax.linesHint')}</p>
      <ul className="plain-list">
        {m.estimate.lines.map((l) => (
          <li key={l.categoryId}>
            <div className="split-row">
              <strong>{l.name}</strong>
              <Money cents={l.actual + l.planned} />
            </div>
            <p className="hint">{t('tax.lineYear', { actual: formatMoney(l.actual), planned: formatMoney(l.planned) })}</p>
            <div className="tax-edit">
              <SelectField label={t('tax.lineRole')} value={l.role} onChange={(e) => setLine(l.categoryId, { role: e.target.value as TaxLineRole, ...(PER_PERSON.includes(e.target.value as TaxLineRole) ? { person: l.person ?? '*' } : {}) })}>
                {ROLES.map((r) => <option key={r} value={r}>{t(`tax.role.${r}` as MessageKey)}</option>)}
              </SelectField>
              {PER_PERSON.includes(l.role) && (
                <SelectField label={t('tax.linePerson')} value={l.person ?? '*'} onChange={(e) => setLine(l.categoryId, { role: l.role, person: e.target.value })}>
                  <option value="*">{t('tax.shared')}</option>
                  {m.setup.persons.map((p) => <option key={p.name} value={p.name}>{p.name}</option>)}
                </SelectField>
              )}
              <button type="button" className="button button-quiet button-small" onClick={() => setLine(l.categoryId, undefined)}>{t('common.delete')}</button>
            </div>
          </li>
        ))}
        {m.estimate.consumerLoans.map((l) => (
          <li key={l.accountId} className="split-row">
            <span>{l.name} <SourceBadge source={l.source} /><br /><span className="muted">{t('tax.loanInterest', { rate: String(l.rate).replace('.', ',') })}</span></span>
            <Money cents={l.interest} />
          </li>
        ))}
      </ul>
      <div className="tax-edit">
        <SelectField label={t('tax.addLine')} value={adding} onChange={(e) => setAdding(e.target.value)}>
          <option value="">{t('tax.chooseLine')}</option>
          {free.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </SelectField>
        <SelectField label={t('tax.lineRole')} value={role} onChange={(e) => setRole(e.target.value as TaxLineRole)}>
          {ROLES.map((r) => <option key={r} value={r}>{t(`tax.role.${r}` as MessageKey)}</option>)}
        </SelectField>
        <button type="button" className="button button-small" disabled={!adding} onClick={() => { setLine(adding, { role, ...(PER_PERSON.includes(role) ? { person: '*' } : {}) }); setAdding(''); }}>{t('tax.add')}</button>
      </div>
      <p className="hint">{t('tax.rolesHint')}</p>
    </details>
  );
}

// ------------------------------------------------------------- deductions you may be missing

function Ideas({ m, save }: { m: Model; save: (s: TaxSetup) => void }) {
  const ideas = useMemo(() => deductionIdeas(m.estimate.input, m.params), [m]);
  const categories = useStore('categories');
  const transactions = useStore('transactions');
  const allocations = useStore('allocations');
  const children = useMemo(() => childLines({ year: m.ctx.year, members: [], categories, accounts: [], provisions: [], transactions, allocations, documents: [] }), [m.ctx.year, categories, transactions, allocations]);
  const setPerson = (name: string, patch: Partial<TaxSetupPerson>) => save({ ...m.setup, persons: m.setup.persons.map((p) => (p.name === name ? { ...p, ...patch } : p)) });
  const person = (name: string | undefined) => m.setup.persons.find((p) => p.name === name);
  return (
    <details className="card">
      <summary><strong>{t('tax.ideas')}</strong>{ideas.length > 0 && <span className="badge">{ideas.filter((i) => i.kind !== 'donations').length}</span>}</summary>
      <p className="hint">{t('tax.ideasHint', { rate: (m.result.marginalRate * 100).toFixed(1).replace('.', ',') })}</p>
      <ul className="plain-list">
        <li>
          <NumberCommit
            label={t('tax.children')}
            hint={children.length ? t('tax.childrenFound', { lines: children.map((c) => c.name).join(', ') }) : t('tax.childrenHint')}
            value={m.setup.children}
            onCommit={(v) => save({ ...m.setup, ...(v ? { children: v } : { children: undefined }) })}
          />
        </li>
        {ideas.map((i) => {
          const key = `${i.kind}:${i.person ?? ''}`;
          const p = person(i.person);
          const vars = { name: i.person ?? '', max: i.max === null ? '' : formatMoney(i.max), saving: formatMoney(i.saving) };
          return (
            <li key={key}>
              <p>
                <strong>{t(`tax.idea.${i.kind}` as MessageKey, vars)}</strong>
                <br />
                <span className="muted">{t(`tax.idea.${i.kind}Hint` as MessageKey, vars)}</span>
              </p>
              {i.kind === 'pensionSavings' && p && <MoneyCommit label={t('tax.paidThisYear')} value={p.pensionSavings} onCommit={(v) => setPerson(p.name, { pensionSavings: v })} />}
              {i.kind === 'homeSavings' && p && <MoneyCommit label={t('tax.paidThisYear')} value={p.homeSavings} onCommit={(v) => setPerson(p.name, { homeSavings: v })} />}
              {i.kind === 'travel' && p && <NumberCommit label={t('tax.commuteKm')} value={p.commuteKm} onCommit={(v) => setPerson(p.name, { commuteKm: v })} />}
              {i.kind === 'insurance' && <MoneyCommit label={t('tax.insurancePaid')} value={m.setup.insurance} onCommit={(v) => save({ ...m.setup, ...(v !== undefined ? { insurance: v } : { insurance: undefined }) })} />}
              {i.kind === 'donations' && <MoneyCommit label={t('tax.donationsPaid')} value={m.setup.donations} onCommit={(v) => save({ ...m.setup, ...(v ? { donations: v } : { donations: undefined }) })} />}
            </li>
          );
        })}
      </ul>
    </details>
  );
}

// ------------------------------------------------------------- last year

function Compare({ m, year }: { m: Model; year: number }) {
  const lastParams = TAX_YEARS[year - 1];
  const docs = m.ctx.documents;
  const assessment = docs.find((d) => d.kind === 'assessment' && d.year === year - 1);
  const rebuilt = useMemo(() => {
    if (!lastParams || !assessment) return undefined;
    // The same engine on last year's documents only: a check that it reads them as the administration did.
    const setup: TaxSetup = { persons: m.setup.persons.map((p) => ({ name: p.name, salaryCategoryIds: p.salaryCategoryIds })), ...(m.setup.homeSince ? { homeSince: m.setup.homeSince } : {}) };
    const { paramsLastYear: _last, ...ctx } = m.ctx;
    const est = estimateReturn({ ...ctx, year: year - 1, params: lastParams, setup, documents: docs.filter((d) => d.year === year - 1 || d.kind === 'statement') });
    return computeReturn(est.input, lastParams);
  }, [m, year, lastParams, assessment, docs]);
  if (!assessment || !rebuilt) return null;
  const statement = docs.find((d) => d.kind === 'statement' && d.year === year - 1);
  const official = statement ? (statement.values.due ?? 0) - (statement.values.refund ?? 0) : undefined;
  const rows: [string, Cents | undefined, Cents, Cents][] = [
    [t('tax.taxableIncome'), assessment.values.taxable, rebuilt.taxableIncome, m.result.taxableIncome],
    [t('tax.incomeTax'), assessment.values.tax, rebuilt.incomeTax, m.result.incomeTax],
    [t('tax.surcharge'), assessment.values.fund, rebuilt.employmentFund, m.result.employmentFund],
    [t('tax.withheldTotal'), assessment.values.withheld, rebuilt.withheld, m.result.withheld],
    [t('tax.settlementShort'), official, rebuilt.settlement, m.result.settlement],
  ];
  const ok = Math.abs((assessment.values.tax ?? 0) - rebuilt.incomeTax) < 100 && (official === undefined || Math.abs(official - rebuilt.settlement) < 100);
  return (
    <details className="card">
      <summary><strong>{t('tax.compare', { last: year - 1 })}</strong> {ok ? <span className="badge">✓ {t('tax.matches')}</span> : <span className="badge badge-warn">{t('tax.differs')}</span>}</summary>
      <p className="hint">{t('tax.compareHint', { last: year - 1 })}</p>
      <div className="tax-compare-wrap">
      <table className="tax-compare">
        <thead>
          <tr><th></th><th>{t('tax.colAssessment', { last: year - 1 })}</th><th>{t('tax.colRebuilt')}</th><th>{year}</th></tr>
        </thead>
        <tbody>
          {rows.map(([label, a, b, c]) => (
            <tr key={label}><th scope="row">{label}</th><td>{a === undefined ? '—' : <Money cents={a} />}</td><td><Money cents={b} /></td><td><Money cents={c} /></td></tr>
          ))}
        </tbody>
      </table>
      </div>
    </details>
  );
}

// ------------------------------------------------------------- setup

function Setup({ m, year, save }: { m: Model; year: number; save: (s: TaxSetup) => void }) {
  const vault = useVault();
  const categories = useStore('categories');
  const accounts = useStore('accounts');
  const provisions = useStore('provisions');
  const income = categories.filter((c) => c.isIncome && !c.archivedAt);
  const loans = accounts.filter((a) => a.type === 'loan' && !a.closedAt);
  const spending = categories.filter((c) => !c.isIncome && !c.archivedAt && (c.groupId === 'provisions' || /tax|imp[oô]t|avance|advance/i.test(c.name)));
  const toggle = (list: readonly string[] | undefined, id: string, on: boolean) => (on ? [...new Set([...(list ?? []), id])] : (list ?? []).filter((x) => x !== id));
  const setPerson = (i: number, patch: Partial<TaxSetupPerson>) => save({ ...m.setup, persons: m.setup.persons.map((p, j) => (j === i ? { ...p, ...patch } : p)) });
  const taxProvisions: Provision[] = provisions.filter((p) => !/advance|avance/i.test(p.name));
  return (
    <details className="card">
      <summary><strong>{t('tax.setup')}</strong></summary>
      <SelectField label={t('tax.class')} value={m.regime} hint={t('tax.classHint')} onChange={(e) => saveTaxProfile(vault, year, { regime: e.target.value as TaxClass, setup: m.setup })}>
        {CLASSES.map((c) => <option key={c} value={c}>{t(`tax.class.${c}` as MessageKey)}</option>)}
      </SelectField>
      {m.setup.persons.map((p, i) => (
        <fieldset key={i} className="card">
          <legend>{p.name}</legend>
          <TextField label={t('tax.personName')} defaultValue={p.name} onBlur={(e) => e.target.value.trim() && e.target.value.trim() !== p.name && setPerson(i, { name: e.target.value.trim() })} />
          <p className="field-label">{t('tax.salaryLines')}</p>
          {income.map((c) => (
            <label key={c.id} className="check">
              <input type="checkbox" checked={p.salaryCategoryIds.includes(c.id)} onChange={(e) => setPerson(i, { salaryCategoryIds: toggle(p.salaryCategoryIds, c.id, e.target.checked) })} />
              {c.name}
            </label>
          ))}
          <NumberCommit label={t('tax.birthYear')} hint={t('tax.birthYearHint')} value={p.birthYear} onCommit={(v) => setPerson(i, { birthYear: v })} />
          <button type="button" className="button button-quiet button-small" onClick={() => save({ ...m.setup, persons: m.setup.persons.filter((_, j) => j !== i) })}>{t('tax.removePerson')}</button>
        </fieldset>
      ))}
      {m.setup.persons.length < 2 && (
        <button type="button" className="button button-quiet" onClick={() => save({ ...m.setup, persons: [...m.setup.persons, { name: t('tax.partner'), salaryCategoryIds: [] }] })}>+ {t('tax.addPerson')}</button>
      )}
      <p className="field-label">{t('tax.homeLoans')}</p>
      {loans.map((a) => (
        <label key={a.id} className="check">
          <input type="checkbox" checked={(m.setup.homeLoanIds ?? []).includes(a.id)} onChange={(e) => save({ ...m.setup, homeLoanIds: toggle(m.setup.homeLoanIds, a.id, e.target.checked) })} />
          {a.name}
          {a.interestRate ? <span className="muted"> · {String(a.interestRate).replace('.', ',')} %</span> : null}
        </label>
      ))}
      <NumberCommit label={t('tax.homeSince')} hint={t('tax.homeSinceHint')} value={m.setup.homeSince ?? m.estimate.input.homeSince} onCommit={(v) => save({ ...m.setup, ...(v ? { homeSince: v } : { homeSince: undefined }) })} />
      <p className="field-label">{t('tax.advanceLines')}</p>
      {spending.map((c) => (
        <label key={c.id} className="check">
          <input type="checkbox" checked={(m.setup.advanceCategoryIds ?? []).includes(c.id)} onChange={(e) => save({ ...m.setup, advanceCategoryIds: toggle(m.setup.advanceCategoryIds, c.id, e.target.checked) })} />
          {c.name}
        </label>
      ))}
      <SelectField label={t('tax.provision')} hint={t('tax.provisionHint')} value={m.setup.provisionId ?? ''} onChange={(e) => save({ ...m.setup, ...(e.target.value ? { provisionId: e.target.value } : { provisionId: undefined }) })}>
        <option value="">{t('tax.newProvision')}</option>
        {taxProvisions.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
      </SelectField>
    </details>
  );
}

/** The parameters the projection uses; any value can be overridden for this year. */
function Overrides({ params, values, onChange }: { params: TaxParams; values: Record<string, number>; onChange: (v: Record<string, number>) => void }) {
  const rows: [string, string, number][] = [
    ...params.scale.map((b, i): [string, string, number] => [`scale.${i}.rate`, t('tax.p.bracket', { from: b.from.toLocaleString('fr-LU') }), b.rate]),
    ['employmentFund.rate', t('tax.p.fund'), params.employmentFund.rate],
    ['employmentFund.highRate', t('tax.p.fundHigh'), params.employmentFund.highRate],
    ['deductions.professionalLump', t('tax.p.professional'), params.deductions.professionalLump],
    ['deductions.travelMax', t('tax.p.travel'), params.deductions.travelMax],
    ['deductions.specialLump', t('tax.p.special'), params.deductions.specialLump],
    ['deductions.insurancePerPerson', t('tax.p.insurance'), params.deductions.insurancePerPerson],
    ['deductions.pensionSavings', t('tax.p.pension'), params.deductions.pensionSavings],
    ['social.ceiling', t('tax.p.ceiling'), params.social.ceiling],
  ];
  const changed = Object.keys(values).length;
  return (
    <details className="card">
      <summary>{t('tax.params')}{changed > 0 && ` · ${t('tax.overridden', { n: changed })}`}</summary>
      <p className="hint">{t('tax.paramsHint')}</p>
      {rows.map(([key, name, value]) => (
        <TextField
          key={key}
          label={name}
          hint={t('tax.official', { v: String(value).replace('.', ',') })}
          inputMode="decimal"
          placeholder={String(value).replace('.', ',')}
          defaultValue={values[key] === undefined ? '' : String(values[key]).replace('.', ',')}
          onBlur={(e) => {
            const v = e.target.value.trim();
            const n = Number(v.replace(',', '.'));
            const next = { ...values };
            if (!v) delete next[key];
            else if (Number.isFinite(n)) next[key] = n;
            else return;
            if (next[key] !== values[key]) onChange(next);
          }}
        />
      ))}
      {changed > 0 && <button type="button" className="button button-quiet" onClick={() => onChange({})}>{t('tax.resetParams')}</button>}
    </details>
  );
}

function Sources({ params }: { params: TaxParams }) {
  return (
    <details className="card">
      <summary>{t('tax.sources', { year: params.year })}</summary>
      <ul className="plain-list">
        {params.sources.map((s) => (
          <li key={s.title}>
            <a href={s.url} target="_blank" rel="noreferrer noopener">{s.title}</a>
            <span className="muted"> · {t('tax.verified', { date: formatDate(s.verifiedOn) })}</span>
          </li>
        ))}
      </ul>
    </details>
  );
}
