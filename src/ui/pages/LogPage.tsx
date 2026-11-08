import { useMemo, useState, type FormEvent } from 'react';
import { currentMonth, formatDate, todayIso } from '../../domain/dates';
import { formatMoney, formatWholeEuros, parseMoney } from '../../domain/money';
import { frequentLines, logMonth, type LogMonth } from '../../domain/spendlog';
import type { Category, LogEntry, MonthKey } from '../../domain/types';
import { monthName, t } from '../../i18n';
import { stamp, systemClock } from '../../domain/ledger';
import { Dialog } from '../components/Dialog';
import { Icon } from '../components/Icon';
import { Money } from '../components/Money';
import { MonthNav } from '../components/MonthNav';
import { useToast } from '../components/Toast';
import { useBudgetMonth, useDocumentTitle, useStore, useVault } from '../hooks';
import { href } from '../router';

/**
 * The spending log (D-112): spends logged by hand as they happen, to see how
 * the month is trending against the plan before the statements come. It is
 * only a tracker: the ledger and the budget still come from the statements.
 */

/** Lines a spend can be logged to: spending lines and one-off expenses. */
const loggable = (c: Category) => !c.isIncome && !c.archivedAt && (c.groupId === 'variable' || c.groupId === 'fixed' || c.groupId === 'events');

/** Local date and time now, "YYYY-MM-DDTHH:mm". */
function nowStamp(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

function useLogMonth(month: MonthKey): LogMonth {
  const entries = useStore('logEntries');
  const categories = useStore('categories');
  const budget = useBudgetMonth(month);
  return useMemo(() => {
    const dayToDay = categories.filter((c) => !c.isIncome && !c.archivedAt && c.groupId === 'variable').map((c) => c.id);
    return logMonth(entries, month, todayIso(), (id) => budget?.categories.get(id)?.assigned ?? 0, dayToDay);
  }, [entries, categories, budget, month]);
}

export function LogSheet({ onClose }: { onClose: () => void }) {
  const vault = useVault();
  const notify = useToast();
  const categories = useStore('categories');
  const entries = useStore('logEntries');
  const now = nowStamp();
  const lines = useMemo(() => {
    const ids = frequentLines(entries, now, categories.filter(loggable).sort((a, b) => Number(a.groupId !== 'variable') - Number(b.groupId !== 'variable') || a.sortOrder - b.sortOrder).map((c) => c.id));
    return ids.map((id) => categories.find((c) => c.id === id)!);
    // Order once per opening: the chips must not move while choosing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const [amount, setAmount] = useState('');
  const [categoryId, setCategoryId] = useState(lines[0]?.id ?? '');
  const [note, setNote] = useState('');
  const [all, setAll] = useState(false);
  const [error, setError] = useState<string>();
  const month = useLogMonth(currentMonth());
  const cents = amount.trim() ? parseMoney(amount) : null;
  const chosen = categories.find((c) => c.id === categoryId);
  const line = month.lines.find((l) => l.categoryId === categoryId);
  const shown = all ? lines : lines.slice(0, 8);
  if (chosen && !shown.includes(chosen)) shown.push(chosen);

  async function save(e: FormEvent) {
    e.preventDefault();
    if (cents === null || cents <= 0) return setError(t('log.amountRequired'));
    if (!chosen) return setError(t('log.categoryRequired'));
    const record: LogEntry = { ...(stamp(systemClock, 'manual') as LogEntry), at: now, amount: Math.abs(cents), categoryId, ...(note.trim() ? { note: note.trim() } : {}) };
    await vault.put('logEntries', record);
    notify(t('log.saved', { amount: formatMoney(record.amount), name: chosen.name }), 'ok', { label: t('inbox.undo'), run: () => void vault.remove('logEntries', record.id) });
    onClose();
  }

  return (
    <Dialog open title={t('log.add')} onClose={onClose}>
      <form onSubmit={save} noValidate className="log-sheet">
        <p className="log-when">
          <Icon name="receipt" size={16} /> {t('log.when', { date: formatDate(now.slice(0, 10)), time: now.slice(11) })}
        </p>
        <label className="log-amount">
          <span className="visually-hidden">{t('log.amount')}</span>
          <input inputMode="decimal" autoComplete="off" placeholder="0,00" value={amount} onChange={(e) => setAmount(e.target.value)} autoFocus aria-invalid={!!error && (cents === null || cents <= 0)} />
          <span aria-hidden="true">€</span>
        </label>
        <fieldset className="log-lines">
          <legend>{t('log.category')}</legend>
          <div className="log-chips">
            {shown.map((c) => (
              <button key={c.id} type="button" className={`log-chip kind-${c.groupId}`} aria-pressed={categoryId === c.id} onClick={() => setCategoryId(c.id)}>
                <span className="log-dot" aria-hidden="true" />
                {c.name}
              </button>
            ))}
            {!all && lines.length > 8 && (
              <button type="button" className="log-chip log-more" onClick={() => setAll(true)}>{t('log.allLines', { n: lines.length })}</button>
            )}
          </div>
        </fieldset>
        <label className="field">
          <span>{t('log.note')}</span>
          <input value={note} onChange={(e) => setNote(e.target.value)} placeholder={t('log.notePlaceholder')} />
        </label>
        {chosen && line && line.planned > 0 && (
          <p className="log-context">
            {t('log.context', { name: chosen.name, logged: formatWholeEuros(line.logged), planned: formatWholeEuros(line.planned) })}
          </p>
        )}
        {error && <p className="field-error" role="alert">{error}</p>}
        <button className="button button-primary button-block log-save">{cents && cents > 0 ? t('log.saveAmount', { amount: formatMoney(Math.abs(cents)) }) : t('log.save')}</button>
        <p className="hint">{t('log.onlyTracker')}</p>
      </form>
    </Dialog>
  );
}

/** Logged so far (cumulative), the even pace to the plan, and where the month heads. */
function PaceChart({ m }: { m: LogMonth }) {
  const W = 320;
  const H = 140;
  const top = Math.max(m.planned, m.projected, m.total, 1) * 1.08;
  const x = (day: number) => (day / m.days) * W;
  const y = (v: number) => H - 6 - (v / top) * (H - 16);
  const path = m.cumulative.map((v, i) => `${i === 0 ? 'M' : 'L'}${x(i + 1).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
  const last = m.cumulative.at(-1) ?? 0;
  const label = t('log.chartLabel', { logged: formatWholeEuros(m.total), planned: formatWholeEuros(m.planned), day: m.day, days: m.days });
  return (
    <figure className="log-chart">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={label} preserveAspectRatio="none">
        {[0.25, 0.5, 0.75].map((f) => <line key={f} x1="0" x2={W} y1={y(top * f)} y2={y(top * f)} className="chart-grid" />)}
        <line x1="0" y1={y(0)} x2={W} y2={y(m.planned)} className="log-pace" />
        {m.day > 0 && m.day < m.days && <line x1={x(m.day)} y1={y(last)} x2={W} y2={y(m.projected)} className="log-projection" />}
        {path && <path d={path} className="log-line" />}
        {m.day > 0 && <circle cx={x(m.day)} cy={y(last)} r="5" className="log-now" />}
      </svg>
      <figcaption className="chart-legend">
        <span><span className="log-key log-key-line" aria-hidden="true" />{t('log.legendLogged')}</span>
        <span><span className="log-key log-key-pace" aria-hidden="true" />{t('log.legendPace')}</span>
        {m.day > 0 && m.day < m.days && <span><span className="log-key log-key-proj" aria-hidden="true" />{t('log.legendProjected')}</span>}
      </figcaption>
    </figure>
  );
}

export function LogPage() {
  useDocumentTitle(t('nav.log'));
  const vault = useVault();
  const notify = useToast();
  const categories = useStore('categories');
  const [month, setMonth] = useState(currentMonth());
  const [adding, setAdding] = useState(false);
  const m = useLogMonth(month);
  const budget = useBudgetMonth(month);
  const name = (id: string) => categories.find((c) => c.id === id)?.name ?? '?';
  const group = (id: string) => categories.find((c) => c.id === id)?.groupId ?? 'variable';
  const gap = m.projected - m.planned;
  const byDay = useMemo(() => {
    const out: { day: string; items: LogEntry[]; total: number }[] = [];
    for (const e of m.entries) {
      const d = e.at.slice(0, 10);
      const g = out.at(-1)?.day === d ? out.at(-1)! : (out.push({ day: d, items: [], total: 0 }), out.at(-1)!);
      g.items.push(e);
      g.total += e.amount;
    }
    return out;
  }, [m.entries]);

  async function remove(e: LogEntry) {
    await vault.remove('logEntries', e.id);
    notify(t('log.deleted', { amount: formatMoney(e.amount) }), 'ok', { label: t('inbox.undo'), run: () => void vault.put('logEntries', e) });
  }

  return (
    <>
      <div className="page-head">
        <h1>{t('nav.log')}</h1>
        <button type="button" className="button button-primary" onClick={() => setAdding(true)}>
          <Icon name="plus" size={18} /> {t('log.addShort')}
        </button>
      </div>
      <MonthNav month={month} onChange={setMonth} />

      <section className="card log-summary" aria-labelledby="log-sum">
        <div className="split-row">
          <h2 id="log-sum">{t('log.summaryTitle')}</h2>
          {m.day > 0 && <span className="muted">{t('log.dayOf', { day: m.day, days: m.days })}</span>}
        </div>
        <p className="log-total">
          <span className="big-number">{formatWholeEuros(m.total)}</span>
          <span className="muted"> {t('log.ofPlanned', { planned: formatWholeEuros(m.planned) })}</span>
        </p>
        <PaceChart m={m} />
        {m.day > 0 && m.total > 0 && (
          <p className="log-verdict">
            {m.day < m.days
              ? gap > 0
                ? t('log.headsOver', { projected: formatWholeEuros(m.projected), gap: formatWholeEuros(gap) })
                : t('log.headsUnder', { projected: formatWholeEuros(m.projected), gap: formatWholeEuros(-gap) })
              : t('log.monthDone', { total: formatWholeEuros(m.total), planned: formatWholeEuros(m.planned) })}
          </p>
        )}
        {m.total === 0 && <p className="hint">{t('log.empty', { month: monthName(month) })}</p>}
      </section>

      {m.lines.length > 0 && (
        <section className="card" aria-labelledby="log-lines">
          <h2 id="log-lines">{t('log.byLine')}</h2>
          <ul className="plain-list log-bars">
            {m.lines.map((l) => {
              const spent = -(budget?.categories.get(l.categoryId)?.activity ?? 0);
              const pct = l.planned > 0 ? Math.min(100, Math.round((l.logged / l.planned) * 100)) : l.logged > 0 ? 100 : 0;
              return (
                <li key={l.categoryId} className={`kind-${group(l.categoryId)}`}>
                  <div className="split-row">
                    <strong>{name(l.categoryId)}</strong>
                    <span>
                      <strong>{formatWholeEuros(l.logged)}</strong>
                      <span className="muted"> / {formatWholeEuros(l.planned)}</span>
                    </span>
                  </div>
                  <span className={`log-bar ${l.planned > 0 && l.logged > l.planned ? 'log-bar-over' : ''}`} aria-hidden="true"><span style={{ width: `${pct}%` }} /></span>
                  {spent > 0 && <span className="hint">{t('log.fromStatements', { spent: formatWholeEuros(spent) })}</span>}
                </li>
              );
            })}
          </ul>
        </section>
      )}

      {byDay.map((d) => (
        <section key={d.day} className="log-day" aria-label={formatDate(d.day)}>
          <div className="group-head">
            <h2>{d.day === todayIso() ? t('log.today') : formatDate(d.day)}</h2>
            <span className="muted">{formatMoney(d.total)}</span>
          </div>
          <ul className="rows">
            {d.items.map((e) => (
              <li key={e.id} className={`log-entry kind-${group(e.categoryId)}`}>
                <span className="log-avatar" aria-hidden="true">{name(e.categoryId).slice(0, 1)}</span>
                <span className="row-main">
                  <span className="row-title">{name(e.categoryId)}</span>
                  <span className="row-sub">{e.at.slice(11, 16)}{e.note ? ` · ${e.note}` : ''}</span>
                </span>
                <Money cents={-e.amount} />
                <button type="button" className="icon-button" onClick={() => void remove(e)} aria-label={t('log.delete', { name: name(e.categoryId), amount: formatMoney(e.amount) })}>
                  <Icon name="trash" size={18} />
                </button>
              </li>
            ))}
          </ul>
        </section>
      ))}
      <p className="hint">{t('log.onlyTracker')} <a href={href('budget')}>{t('log.toBudget')}</a></p>
      {adding && <LogSheet onClose={() => setAdding(false)} />}
    </>
  );
}

/** The log in short, for the home page: logged so far against the plan of the day-to-day lines. */
export function LogCard() {
  const m = useLogMonth(currentMonth());
  const ahead = m.total - m.pace;
  const pct = m.planned > 0 ? Math.min(100, Math.round((m.total / m.planned) * 100)) : 0;
  const pacePct = m.planned > 0 ? Math.min(100, Math.round((m.pace / m.planned) * 100)) : 0;
  return (
    <a className="card log-home kind-variable" href={href('log')}>
      <span className="split-row">
        <strong className="log-home-title">{t('log.homeTitle')}</strong>
        <span className="muted">{t('log.open')} ›</span>
      </span>
      <span className="log-total">
        <span className="big-number">{formatWholeEuros(m.total)}</span>
        <span className="muted"> {t('log.ofPlanned', { planned: formatWholeEuros(m.planned) })}</span>
      </span>
      <span className="log-meter" aria-hidden="true">
        <span style={{ width: `${pct}%` }} />
        <i style={{ left: `${pacePct}%` }} />
      </span>
      <span className="muted">
        {m.total === 0 ? t('log.homeEmpty') : ahead > 0 ? t('log.aheadOfPace', { day: m.day, days: m.days, amount: formatWholeEuros(ahead) }) : t('log.behindPace', { day: m.day, days: m.days, amount: formatWholeEuros(-ahead) })}
      </span>
    </a>
  );
}
