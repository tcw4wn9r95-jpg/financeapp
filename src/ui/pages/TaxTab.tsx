import { useMemo, useState, type FormEvent } from 'react';
import { addMonths, currentMonth, formatDate } from '../../domain/dates';
import { stamp, systemClock } from '../../domain/ledger';
import { formatMoneyInput, parseMoney } from '../../domain/money';
import { computeTax, withOverrides, type TaxClass, type TaxParams } from '../../domain/tax/lu';
import type { Cents, TaxProfile, TaxProfilePerson } from '../../domain/types';
import { monthName, t } from '../../i18n';
import { SelectField, TextField } from '../components/fields';
import { Money } from '../components/Money';
import { useToast } from '../components/Toast';
import { useSettings, useStore, useVault } from '../hooks';
import { inputOf, TAX_YEARS, taxYears } from '../taxParams';

/**
 * Luxembourg tax projection (PRD F10): what the year's tax should be, what
 * payroll withholding covers, and the refund or payment to expect — which
 * can be posted into the forecast. A projection, not tax advice.
 */

const CLASSES: TaxClass[] = ['1', '1a', '2'];

interface Draft {
  regime: TaxClass;
  persons: { name: string; grossSalary: string; withheld: string; travel: string; pensionSavings: string }[];
  householdMembers: string;
  insurance: string;
  otherDeductions: string;
  otherIncome: string;
  settleMonth: string;
  inForecast: boolean;
  overrides: Record<string, string>;
}

const money = (c: Cents | undefined) => (c ? formatMoneyInput(c) : '');
const cents = (s: string) => (s.trim() ? parseMoney(s) : 0);

function draftOf(p: TaxProfile | undefined, names: string[], year: number): Draft {
  const persons: TaxProfilePerson[] = p?.persons ?? names.slice(0, 2).map((name) => ({ name, grossSalary: 0, withheld: 0 }));
  return {
    regime: (p?.regime as TaxClass) ?? (names.length >= 2 ? '2' : '1'),
    persons: (persons.length ? persons : [{ name: t('tax.you'), grossSalary: 0, withheld: 0 }]).map((x) => ({
      name: x.name,
      grossSalary: money(x.grossSalary),
      withheld: money(x.withheld),
      travel: money(x.travel),
      pensionSavings: money(x.pensionSavings),
    })),
    householdMembers: String(p?.householdMembers ?? Math.max(1, names.length)),
    insurance: money(p?.insurance),
    otherDeductions: money(p?.otherDeductions),
    otherIncome: money(p?.otherIncome),
    settleMonth: p?.settleMonth ?? `${year + 1}-06`,
    inForecast: p?.inForecast ?? false,
    overrides: Object.fromEntries(Object.entries(p?.overrides ?? {}).map(([k, v]) => [k, String(v)])),
  };
}

function profileOf(d: Draft, year: number, existing: TaxProfile | undefined): TaxProfile | null {
  const persons: TaxProfilePerson[] = [];
  for (const x of d.persons) {
    const gross = cents(x.grossSalary);
    const withheld = cents(x.withheld);
    const travel = cents(x.travel);
    const pension = cents(x.pensionSavings);
    if (gross === null || withheld === null || travel === null || pension === null) return null;
    persons.push({ name: x.name, grossSalary: Math.abs(gross), withheld: Math.abs(withheld), ...(travel ? { travel: Math.abs(travel) } : {}), ...(pension ? { pensionSavings: Math.abs(pension) } : {}) });
  }
  const [insurance, otherDeductions, otherIncome] = [cents(d.insurance), cents(d.otherDeductions), cents(d.otherIncome)];
  if (insurance === null || otherDeductions === null || otherIncome === null) return null;
  const overrides: Record<string, number> = {};
  for (const [k, v] of Object.entries(d.overrides)) {
    const n = Number(v.replace(',', '.'));
    if (v.trim() !== '' && Number.isFinite(n)) overrides[k] = n;
  }
  return {
    ...(existing ?? stamp(systemClock, 'manual')),
    updatedAt: new Date().toISOString(),
    year,
    regime: d.regime,
    persons,
    householdMembers: Math.max(1, Number(d.householdMembers) || 1),
    insurance: Math.abs(insurance),
    otherDeductions: Math.abs(otherDeductions),
    otherIncome,
    withholdingYtd: persons.reduce((s, x) => s + x.withheld, 0),
    paramsVersion: String(year),
    overrides,
    settleMonth: d.settleMonth,
    inForecast: d.inForecast,
  };
}

export function TaxTab() {
  const years = taxYears();
  const thisYear = Number(currentMonth().slice(0, 4));
  const [year, setYear] = useState(years.includes(thisYear) ? thisYear : years[0]!);
  const profiles = useStore('taxProfiles');
  const existing = profiles.find((p) => p.year === year);
  if (years.length === 0) return <p className="notice">{t('tax.noParams')}</p>;
  return (
    <>
      <p className="notice notice-warn" role="note">{t('tax.disclaimer')}</p>
      <SelectField label={t('tax.year')} value={String(year)} onChange={(e) => setYear(Number(e.target.value))}>
        {years.map((y) => <option key={y} value={y}>{y}</option>)}
      </SelectField>
      <TaxForm key={`${year}:${existing?.id ?? 'new'}`} year={year} params={TAX_YEARS[year]!} existing={existing} />
    </>
  );
}

function TaxForm({ year, params, existing }: { year: number; params: TaxParams; existing: TaxProfile | undefined }) {
  const vault = useVault();
  const notify = useToast();
  const settings = useSettings();
  const names = (settings.members ?? []).map((m) => m.name);
  const [d, setD] = useState<Draft>(() => draftOf(existing, names, year));
  const profile = useMemo(() => profileOf(d, year, existing), [d, year, existing]);
  const effective = useMemo(() => (profile ? withOverrides(params, profile.overrides ?? {}) : params), [params, profile]);
  const result = useMemo(() => (profile ? computeTax(inputOf(profile), effective) : undefined), [profile, effective]);
  const set = (patch: Partial<Draft>) => setD({ ...d, ...patch });
  const setPerson = (i: number, patch: Partial<Draft['persons'][number]>) => set({ persons: d.persons.map((x, j) => (j === i ? { ...x, ...patch } : x)) });
  const months = Array.from({ length: 24 }, (_, i) => addMonths(currentMonth(), i));
  if (!months.includes(d.settleMonth)) months.unshift(d.settleMonth);

  async function save(e: FormEvent) {
    e.preventDefault();
    if (!profile) return notify(t('tax.invalid'), 'error');
    await vault.put('taxProfiles', profile);
    notify(t('tax.saved'));
  }

  const label = (l: string) => {
    const [kind, who] = l.split(':');
    return who ? t(`tax.line.${kind}` as 'tax.line.social', { name: who }) : t(`tax.line.${kind}` as 'tax.line.other');
  };

  return (
    <form onSubmit={save} className="form">
      {params.status === 'draft' && <p className="notice" role="note">{t('tax.draft')} {params.note}</p>}
      <SelectField label={t('tax.class')} value={d.regime} onChange={(e) => set({ regime: e.target.value as TaxClass, persons: e.target.value === '2' || d.persons.length < 2 ? d.persons : d.persons.slice(0, 1) })} hint={t('tax.classHint')}>
        {CLASSES.map((c) => <option key={c} value={c}>{t(`tax.class.${c}` as 'tax.class.1')}</option>)}
      </SelectField>
      {d.persons.map((x, i) => (
        <fieldset key={i} className="card">
          <legend>{x.name}</legend>
          <TextField label={t('tax.gross')} hint={t('tax.grossHint')} inputMode="decimal" value={x.grossSalary} onChange={(e) => setPerson(i, { grossSalary: e.target.value })} />
          <TextField label={t('tax.withheld')} hint={t('tax.withheldHint')} inputMode="decimal" value={x.withheld} onChange={(e) => setPerson(i, { withheld: e.target.value })} />
          <details>
            <summary>{t('tax.more')}</summary>
            <TextField label={t('tax.travel')} hint={t('tax.travelHint', { min: params.deductions.travelMin })} inputMode="decimal" value={x.travel} onChange={(e) => setPerson(i, { travel: e.target.value })} />
            <TextField label={t('tax.pension')} hint={t('tax.pensionHint', { max: params.deductions.pensionSavings })} inputMode="decimal" value={x.pensionSavings} onChange={(e) => setPerson(i, { pensionSavings: e.target.value })} />
          </details>
        </fieldset>
      ))}
      {d.regime === '2' && d.persons.length < 2 && (
        <button type="button" className="button button-quiet" onClick={() => set({ persons: [...d.persons, { name: names[d.persons.length] ?? t('tax.partner'), grossSalary: '', withheld: '', travel: '', pensionSavings: '' }] })}>
          + {t('tax.addPartner')}
        </button>
      )}
      <details className="card">
        <summary>{t('tax.household')}</summary>
        <TextField label={t('tax.members')} hint={t('tax.membersHint')} inputMode="numeric" value={d.householdMembers} onChange={(e) => set({ householdMembers: e.target.value.replace(/\D/g, '') })} />
        <TextField label={t('tax.insurance')} hint={t('tax.insuranceHint', { max: params.deductions.insurancePerPerson })} inputMode="decimal" value={d.insurance} onChange={(e) => set({ insurance: e.target.value })} />
        <TextField label={t('tax.otherDeductions')} hint={t('tax.otherDeductionsHint')} inputMode="decimal" value={d.otherDeductions} onChange={(e) => set({ otherDeductions: e.target.value })} />
        <TextField label={t('tax.otherIncome')} hint={t('tax.otherIncomeHint')} inputMode="decimal" value={d.otherIncome} onChange={(e) => set({ otherIncome: e.target.value })} />
      </details>

      {result ? (
        <section className="card" aria-labelledby="tax-result">
          <h2 id="tax-result">{t('tax.result', { year })}</h2>
          <div className="headline">
            <span className="muted">{result.balance >= 0 ? t('tax.refund') : t('tax.due')}</span>
            <span className={`big-number ${result.balance >= 0 ? 'ok' : 'bad'}`}><Money cents={Math.abs(result.balance)} /></span>
          </div>
          <ul className="plain-list">
            <li className="split-row"><span>{t('tax.netIncome')}</span><Money cents={result.netIncome} /></li>
            {result.deductions.filter((x) => !x.label.startsWith('social') && !x.label.startsWith('professional') && !x.label.startsWith('travel')).map((x) => (
              <li key={x.label} className="split-row"><span>{label(x.label)}</span><Money cents={-x.amount} /></li>
            ))}
            <li className="split-row"><strong>{t('tax.taxable')}</strong><strong><Money cents={result.taxable} /></strong></li>
            <li className="split-row"><span>{t('tax.incomeTax')}</span><Money cents={result.incomeTax} /></li>
            <li className="split-row"><span>{t('tax.surcharge')}</span><Money cents={result.surcharge} /></li>
            {result.credits.map((x) => (
              <li key={x.label} className="split-row"><span>{label(x.label)}</span><Money cents={-x.amount} /></li>
            ))}
            <li className="split-row"><strong>{t('tax.liability')}</strong><strong><Money cents={result.liability} /></strong></li>
            <li className="split-row"><span>{t('tax.withheldTotal')}</span><Money cents={result.withheld} /></li>
            <li className="split-row"><span>{t('tax.marginal')}</span><span>{(result.marginalRate * 100).toFixed(1).replace('.', ',')} %</span></li>
          </ul>
          <details>
            <summary>{t('tax.how')}</summary>
            <ul className="plain-list">
              {result.deductions.filter((x) => /^(social|professional|travel):/.test(x.label)).map((x) => (
                <li key={x.label} className="split-row"><span>{label(x.label)}</span><Money cents={-x.amount} /></li>
              ))}
            </ul>
            <p className="hint">{t('tax.howHint')}</p>
          </details>
        </section>
      ) : (
        <p className="field-error" role="alert">{t('tax.invalid')}</p>
      )}

      <label className="check">
        <input type="checkbox" checked={d.inForecast} onChange={(e) => set({ inForecast: e.target.checked })} />
        {t('tax.inForecast')}
      </label>
      {d.inForecast && (
        <SelectField label={t('tax.settleMonth')} value={d.settleMonth} onChange={(e) => set({ settleMonth: e.target.value })} hint={t('tax.settleHint')}>
          {months.map((m) => <option key={m} value={m}>{monthName(m)}</option>)}
        </SelectField>
      )}

      <Overrides params={params} values={d.overrides} onChange={(overrides) => set({ overrides })} />
      <button className="button button-primary button-block">{t('common.save')}</button>
      <Sources params={params} />
    </form>
  );
}

/** The parameters the projection uses; any value can be overridden for this year. */
function Overrides({ params, values, onChange }: { params: TaxParams; values: Record<string, string>; onChange: (v: Record<string, string>) => void }) {
  const rows: [string, string, number][] = [
    ...params.scale.map((b, i): [string, string, number] => [`scale.${i}.rate`, t('tax.p.bracket', { from: b.from.toLocaleString('fr-LU') }), b.rate]),
    ['employmentFund.rate', t('tax.p.fund'), params.employmentFund.rate],
    ['employmentFund.highRate', t('tax.p.fundHigh'), params.employmentFund.highRate],
    ['deductions.professionalLump', t('tax.p.professional'), params.deductions.professionalLump],
    ['deductions.travelMin', t('tax.p.travel'), params.deductions.travelMin],
    ['deductions.specialLump', t('tax.p.special'), params.deductions.specialLump],
    ['deductions.insurancePerPerson', t('tax.p.insurance'), params.deductions.insurancePerPerson],
    ['deductions.pensionSavings', t('tax.p.pension'), params.deductions.pensionSavings],
    ['social.ceiling', t('tax.p.ceiling'), params.social.ceiling],
  ];
  const changed = Object.values(values).filter((v) => v.trim() !== '').length;
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
          value={values[key] ?? ''}
          onChange={(e) => onChange({ ...values, [key]: e.target.value })}
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
          <li key={s.url}>
            <a href={s.url} target="_blank" rel="noreferrer noopener">{s.title}</a>
            <span className="muted"> · {t('tax.verified', { date: formatDate(s.verifiedOn) })}</span>
          </li>
        ))}
      </ul>
    </details>
  );
}
