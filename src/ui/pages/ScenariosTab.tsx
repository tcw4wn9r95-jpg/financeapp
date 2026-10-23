import { useMemo, useState, type FormEvent } from 'react';
import { addMonths, currentMonth } from '../../domain/dates';
import { firstBelow } from '../../domain/forecast';
import { stamp, systemClock } from '../../domain/ledger';
import { formatMoneyInput, parseMoney } from '../../domain/money';
import type { Scenario, ScenarioChange } from '../../domain/types';
import { monthName, t, type MessageKey } from '../../i18n';
import { Dialog } from '../components/Dialog';
import { SelectField, TextField } from '../components/fields';
import { Money } from '../components/Money';
import { useToast } from '../components/Toast';
import { useForecast, useSettings, useStore, useVault } from '../hooks';
import { href, useRoute } from '../router';
import { ForecastView } from './PlanPage';

/**
 * What-if scenarios (PRD F9): a named list of changes (a raise, a bigger
 * rent, a one-off purchase) drawn against the baseline forecast.
 */

const HORIZON = 24;
const TYPES: [ScenarioChange['type'], MessageKey][] = [
  ['line', 'scenario.type.line'],
  ['expense', 'scenario.type.expense'],
  ['income', 'scenario.type.income'],
  ['oneOff', 'scenario.type.oneOff'],
];

export function ScenariosTab() {
  const scenarios = useStore('scenarios');
  const route = useRoute();
  const selected = scenarios.find((s) => s.id === route.query.get('id')) ?? scenarios[0];
  const [editing, setEditing] = useState<Scenario | 'new' | null>(null);
  return (
    <>
      <p className="hint">{t('scenario.intro')}</p>
      {scenarios.length > 0 && (
        <div className="chips" role="list">
          {scenarios.map((s) => (
            <a key={s.id} role="listitem" className="chip" href={href('plan', { tab: 'scenarios', id: s.id })} aria-current={s.id === selected?.id ? 'true' : undefined}>{s.name}</a>
          ))}
        </div>
      )}
      <div className="row">
        <button type="button" className="button button-primary" onClick={() => setEditing('new')}>+ {t('scenario.add')}</button>
        {selected && <button type="button" className="button" onClick={() => setEditing(selected)}>{t('scenario.edit')}</button>}
      </div>
      {selected ? <Compare scenario={selected} /> : <p className="notice">{t('scenario.none')}</p>}
      {editing && <ScenarioDialog existing={editing === 'new' ? undefined : editing} onClose={() => setEditing(null)} />}
    </>
  );
}

function Compare({ scenario }: { scenario: Scenario }) {
  const settings = useSettings();
  const categories = useStore('categories');
  const lineName = (c: ScenarioChange) => categories.find((x) => x.id === c.target?.targetId)?.name ?? '?';
  const baseline = useForecast(HORIZON);
  const changes = useMemo(() => scenario.changes, [scenario]);
  const result = useForecast(HORIZON, changes);
  const buffer = settings.minimumBuffer ?? 0;
  const diff = result.months.at(-1)!.end - baseline.months.at(-1)!.end;
  const b = buffer > 0 ? firstBelow(baseline.months, buffer) : undefined;
  const s = buffer > 0 ? firstBelow(result.months, buffer) : undefined;
  return (
    <>
      <ul className="card plain-list">
        {scenario.changes.map((c, i) => (
          <li key={i} className="split-row">
            <span>
              {c.type === 'line' ? lineName(c) : t(TYPES.find(([k]) => k === c.type)?.[1] ?? 'scenario.type.expense')} · {monthName(c.start)}
              {c.type !== 'oneOff' && (c.end ? ` – ${monthName(c.end)}` : ` ${t('scenario.onwards')}`)}
            </span>
            {c.type === 'line' && c.mode === 'set' ? (
              <span>{c.amount === 0 ? t('scenario.stops') : <>{t('scenario.setTo')} <Money cents={c.amount} /></>}</span>
            ) : (
              <Money cents={c.type === 'income' ? Math.abs(c.amount) : c.type === 'expense' ? -Math.abs(c.amount) : c.amount} plusSign />
            )}
          </li>
        ))}
        <li className="split-row">
          <strong>{t('scenario.diff', { months: HORIZON })}</strong>
          <strong><Money cents={diff} plusSign /></strong>
        </li>
        {buffer > 0 && (
          <li className="split-row">
            <span>{t('scenario.belowBuffer')}</span>
            <span>
              {s ? monthName(s.month) : t('scenario.never')}
              <span className="muted"> ({t('scenario.baselineWas', { v: b ? monthName(b.month) : t('scenario.never') })})</span>
            </span>
          </li>
        )}
      </ul>
      <ForecastView result={baseline} compare={result} compareName={scenario.name} />
    </>
  );
}

interface Line {
  type: ScenarioChange['type'];
  start: string;
  end: string;
  amount: string;
  /** One-off only: money coming in (a bonus, a sale) rather than going out. */
  inflow: boolean;
  /** Budget line changes (D-79): which line, and more by, less by or set to. */
  categoryId: string;
  how: 'plus' | 'minus' | 'set';
}

function ScenarioDialog({ existing, onClose }: { existing: Scenario | undefined; onClose: () => void }) {
  const vault = useVault();
  const notify = useToast();
  const [name, setName] = useState(existing?.name ?? '');
  const first = addMonths(currentMonth(), 1);
  const blank = (): Line => ({ type: 'line', start: first, end: '', amount: '', inflow: false, categoryId: '', how: 'minus' });
  const months = Array.from({ length: HORIZON }, (_, i) => addMonths(currentMonth(), i));
  const [lines, setLines] = useState<Line[]>(
    existing?.changes.map((c) => ({
      type: c.type,
      start: c.start,
      end: c.end ?? '',
      amount: formatMoneyInput(Math.abs(c.amount)),
      inflow: c.type === 'oneOff' && c.amount > 0,
      categoryId: c.target?.targetId ?? '',
      how: c.mode === 'set' ? 'set' : c.amount < 0 ? 'minus' : 'plus',
    })) ?? [blank()],
  );
  const [error, setError] = useState('');
  const categories = useStore('categories');
  // Lines the forecast plans from their monthly amounts: income, fixed, variable, investments.
  const lineOptions = categories
    .filter((c) => !c.archivedAt && (c.isIncome || c.groupId === 'fixed' || c.groupId === 'variable' || c.groupId === 'investments'))
    .sort((a, b) => Number(b.isIncome) - Number(a.isIncome) || a.groupId.localeCompare(b.groupId) || a.sortOrder - b.sortOrder);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const parsed = lines.map((l) => ({ ...l, cents: parseCents(l.amount) }));
    if (!name.trim()) return setError(t('scenario.needName'));
    if (parsed.some((l) => l.type === 'line' && !l.categoryId)) return setError(t('scenario.needLine'));
    if (parsed.length === 0 || parsed.some((l) => l.cents === null || (l.cents === 0 && !(l.type === 'line' && l.how === 'set')))) return setError(t('scenario.needAmount'));
    if (parsed.some((l) => l.end && l.end < l.start)) return setError(t('scenario.endBeforeStart'));
    const changes: ScenarioChange[] = parsed.map((l) => {
      const base = { start: l.start, ...(l.end && l.type !== 'oneOff' ? { end: l.end } : {}) };
      if (l.type === 'line') {
        const cat = categories.find((c) => c.id === l.categoryId);
        return {
          ...base,
          type: 'line',
          target: { targetType: cat?.isIncome ? 'income' : 'category', targetId: l.categoryId },
          mode: l.how === 'set' ? 'set' : 'adjust',
          amount: l.how === 'minus' ? -Math.abs(l.cents!) : Math.abs(l.cents!),
        } satisfies ScenarioChange;
      }
      return { ...base, type: l.type, amount: l.type === 'oneOff' && !l.inflow ? -Math.abs(l.cents!) : Math.abs(l.cents!) };
    });
    const record: Scenario = existing
      ? { ...existing, name: name.trim(), changes, updatedAt: new Date().toISOString() }
      : { ...stamp(systemClock, 'manual'), name: name.trim(), changes };
    await vault.put('scenarios', record);
    notify(t('scenario.saved'));
    window.location.hash = href('plan', { tab: 'scenarios', id: record.id });
    onClose();
  }

  async function remove() {
    if (!existing) return;
    await vault.write([{ type: 'delete', store: 'scenarios', id: existing.id }]);
    notify(t('scenario.deleted'));
    window.location.hash = href('plan', { tab: 'scenarios' });
    onClose();
  }

  const set = (i: number, patch: Partial<Line>) => setLines(lines.map((x, j) => (j === i ? { ...x, ...patch } : x)));
  return (
    <Dialog open title={existing ? t('scenario.editTitle') : t('scenario.addTitle')} onClose={onClose}>
      <form onSubmit={submit} className="form">
        <TextField label={t('scenario.name')} value={name} onChange={(e) => setName(e.target.value)} placeholder={t('scenario.namePlaceholder')} />
        {lines.map((l, i) => (
          <fieldset key={i} className="card scenario-line">
            <legend>{t('scenario.change', { n: i + 1 })}</legend>
            <SelectField label={t('scenario.type')} value={l.type} onChange={(e) => set(i, { type: e.target.value as Line['type'] })}>
              {TYPES.map(([k, key]) => <option key={k} value={k}>{t(key)}</option>)}
            </SelectField>
            {l.type === 'line' && (
              <>
                <SelectField label={t('scenario.line')} value={l.categoryId} onChange={(e) => set(i, { categoryId: e.target.value })}>
                  <option value="">{t('common.choose')}</option>
                  {lineOptions.map((c) => <option key={c.id} value={c.id}>{c.name}{c.isIncome ? ` (${t('categories.income')})` : ''}</option>)}
                </SelectField>
                <SelectField label={t('scenario.how')} value={l.how} onChange={(e) => set(i, { how: e.target.value as Line['how'] })}>
                  <option value="plus">{t('scenario.howPlus')}</option>
                  <option value="minus">{t('scenario.howMinus')}</option>
                  <option value="set">{t('scenario.howSet')}</option>
                </SelectField>
              </>
            )}
            {l.type === 'oneOff' && (
              <SelectField label={t('scenario.direction')} value={l.inflow ? 'in' : 'out'} onChange={(e) => set(i, { inflow: e.target.value === 'in' })}>
                <option value="out">{t('scenario.moneyOut')}</option>
                <option value="in">{t('scenario.moneyIn')}</option>
              </SelectField>
            )}
            <AmountField line={l} onChange={(amount) => set(i, { amount })} />
            <SelectField label={l.type === 'oneOff' ? t('scenario.month') : t('scenario.from')} value={l.start} onChange={(e) => set(i, { start: e.target.value })}>
              {months.map((m) => <option key={m} value={m}>{monthName(m)}</option>)}
            </SelectField>
            {l.type !== 'oneOff' && (
              <SelectField label={t('scenario.until')} value={l.end} onChange={(e) => set(i, { end: e.target.value })}>
                <option value="">{t('scenario.noEnd')}</option>
                {months.filter((m) => m >= l.start).map((m) => <option key={m} value={m}>{monthName(m)}</option>)}
              </SelectField>
            )}
            {lines.length > 1 && (
              <button type="button" className="button button-quiet" onClick={() => setLines(lines.filter((_, j) => j !== i))}>{t('scenario.removeChange')}</button>
            )}
          </fieldset>
        ))}
        <button type="button" className="button button-quiet" onClick={() => setLines([...lines, blank()])}>+ {t('scenario.addChange')}</button>
        {error && <p className="field-error" role="alert">{error}</p>}
        <div className="row">
          <button className="button button-primary">{t('common.save')}</button>
          {existing && <button type="button" className="button button-danger" onClick={() => void remove()}>{t('common.delete')}</button>}
        </div>
      </form>
    </Dialog>
  );
}

function AmountField({ line, onChange }: { line: Line; onChange: (v: string) => void }) {
  const hint =
    line.type === 'line' ? (line.how === 'set' ? t('scenario.setHint') : t('scenario.lineHint'))
    : line.type === 'oneOff' ? t('scenario.oneOffHint') : line.type === 'income' ? t('scenario.incomeHint') : t('scenario.expenseHint');
  const invalid = line.amount.trim() !== '' && parseCents(line.amount) === null;
  return (
    <TextField
      label={t('scenario.amount')}
      hint={hint}
      error={invalid ? t('field.moneyInvalid') : undefined}
      inputMode="decimal"
      autoComplete="off"
      placeholder="0,00"
      value={line.amount}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}

function parseCents(text: string): number | null {
  return text.trim() ? parseMoney(text) : null;
}
