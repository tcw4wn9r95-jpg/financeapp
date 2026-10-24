import { useMemo, useState } from 'react';
import { computeBudget, isOnBudget } from '../../domain/budget';
import { addMonths, currentMonth } from '../../domain/dates';
import { formatWholeEuros } from '../../domain/money';
import { monthsToClose, type CloseDecision, type CloseSourceChoice, type MonthToClose } from '../../domain/monthclose';
import { monthName, t } from '../../i18n';
import { closeMonth } from '../actions';
import { useBudgetInput, useSettings, useStore, useVault } from '../hooks';
import { Dialog } from './Dialog';
import { Money } from './Money';
import { useToast } from './Toast';

/** Past months with lines below zero still to decide about (D-89). */
export function useMonthsToClose(): MonthToClose[] {
  const input = useBudgetInput();
  const categories = useStore('categories');
  const settings = useSettings();
  const closed = settings.closedMonths;
  return useMemo(() => {
    const current = currentMonth();
    const last = addMonths(current, -1);
    if (last < input.startMonth) return [];
    // A line following an account balance gives back by itself (D-75): it does not lend.
    const notLending = new Set(input.availableTargets?.keys() ?? []);
    return monthsToClose(computeBudget(input, last), categories, closed ?? [], current, notLending);
  }, [input, categories, closed]);
}

/** "September ended with 3 lines over budget": the prompt to close it (D-89). */
export function CloseMonthBanner() {
  const open = useMonthsToClose();
  const [closing, setClosing] = useState(false);
  if (open.length === 0 && !closing) return null;
  const first = open[0];
  const total = open.reduce((s, m) => s + m.lines.reduce((x, l) => x + l.short, 0), 0);
  return (
    <>
      {first && (
        <div className="notice notice-warn close-banner" role="status">
          <p>
            ⚠{' '}
            {open.length === 1
              ? t('close.bannerOne', { month: monthName(first.month), n: first.lines.length, total: formatWholeEuros(total) })
              : t('close.bannerMany', { n: open.length, first: monthName(first.month), total: formatWholeEuros(total) })}
          </p>
          <button type="button" className="button button-primary button-small" onClick={() => setClosing(true)}>
            {open.length === 1 ? t('close.closeOne', { month: monthName(first.month) }) : t('close.closeMany')}
          </button>
        </div>
      )}
      {closing && <CloseMonthDialog onClose={() => setClosing(false)} />}
    </>
  );
}

/**
 * Choices: "ready", "acct:<id>" (money from that account), "line:<id>" (another line), "next".
 * Money from an account is money nobody gave a line: Ready to assign. For the
 * provisions account that is true while free savings follow its balance (the
 * money came back to Ready to assign when it left); otherwise it is the line
 * holding free savings.
 */
function toDecision(v: string, categoryId: string, short: number, savingsLine: string | undefined, provisionsAccount: string | undefined): CloseDecision {
  if (v.startsWith('line:')) return { categoryId, short, source: { kind: 'line', categoryId: v.slice(5) } };
  if (v === 'next') return { categoryId, short, source: { kind: 'next' } };
  if (v.startsWith('acct:')) {
    const fromAccountId = v.slice(5);
    const source: CloseSourceChoice = fromAccountId === provisionsAccount && savingsLine ? { kind: 'line', categoryId: savingsLine } : { kind: 'ready' };
    return { categoryId, short, source, fromAccountId };
  }
  return { categoryId, short, source: { kind: 'ready' } };
}

/** Close the oldest open month, then the next one, until none is left (D-89). */
export function CloseMonthDialog({ onClose, only }: { onClose: () => void; only?: string }) {
  const open = useMonthsToClose().filter((x) => !only || x.month === only);
  const vault = useVault();
  const notify = useToast();
  const categories = useStore('categories');
  const accounts = useStore('accounts');
  const settings = useSettings();
  const input = useBudgetInput();
  const [total] = useState(open.length);
  const m = open[0];
  const [choices, setChoices] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const name = (id: string) => categories.find((c) => c.id === id)?.name ?? '?';

  if (!m) {
    return (
      <Dialog open title={t('close.title')} onClose={onClose}>
        <p>✓ {only ? t('close.done', { month: monthName(only) }) : t('close.allDone')}</p>
        <div className="row"><button type="button" className="button button-primary" onClick={onClose}>{t('common.close')}</button></div>
      </Dialog>
    );
  }
  const key = (id: string) => `${m.month}|${id}`;
  const choice = (id: string) => choices[key(id)] ?? 'ready';
  const next = monthName(addMonths(m.month, 1));
  // What each lending line has left once the choices above are taken from it.
  // The line holding free savings lends for the provisions account only when it does not follow its balance.
  const savingsLine = settings.sweepTargetCategoryId && !input.availableTargets?.has(settings.sweepTargetCategoryId) ? settings.sweepTargetCategoryId : undefined;
  const savingsLeft = savingsLine ? (m.sources.find((x) => x.categoryId === savingsLine)?.available ?? 0) : 0;
  const decisions: CloseDecision[] = m.lines.map((l) => toDecision(choice(l.categoryId), l.categoryId, l.short, savingsLine, settings.provisionsAccountId));
  const lent = new Map<string, number>();
  for (const d of decisions) if (d.source.kind === 'line') lent.set(d.source.categoryId, (lent.get(d.source.categoryId) ?? 0) + d.short);
  const fromReady = decisions.filter((d) => d.source.kind === 'ready').reduce((s, d) => s + d.short, 0);
  const onBudget = accounts.filter((a) => !a.closedAt && isOnBudget(a));
  const overLent = m.sources.some((s) => (lent.get(s.categoryId) ?? 0) > s.available);
  const setAll = (v: string) => setChoices((c) => ({ ...c, ...Object.fromEntries(m.lines.map((l) => [key(l.categoryId), v])) }));

  async function apply() {
    setBusy(true);
    try {
      const undo = await closeMonth(vault, m!, decisions);
      notify(t('close.done', { month: monthName(m!.month) }), 'ok', { label: t('inbox.undo'), run: () => void undo().then(() => notify(t('close.undone'))) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open title={t('close.titleMonth', { month: monthName(m.month) })} onClose={onClose} wide>
      {total > 1 && <p className="muted">{t('close.progress', { left: open.length })}</p>}
      <p className="hint">{t('close.intro', { next })}</p>
      <div className="row close-quick">
        <button type="button" className="button button-small" onClick={() => setAll('ready')}>{t('close.allReady')}</button>
        <button type="button" className="button button-small button-quiet" onClick={() => setAll('next')}>{t('close.allNext', { next })}</button>
      </div>
      <ul className="plain-list close-list">
        {m.lines.map((l) => {
          const id = `close-${l.categoryId}`;
          return (
            <li key={l.categoryId}>
              <div className="split-row">
                <label htmlFor={id}><strong>{name(l.categoryId)}</strong></label>
                <Money cents={-l.short} />
              </div>
              <select id={id} value={choice(l.categoryId)} onChange={(e) => setChoices((c) => ({ ...c, [key(l.categoryId)]: e.target.value }))}>
                <option value="ready">{t('close.fromReady', { amount: formatWholeEuros(m.readyToAssign) })}</option>
                <optgroup label={t('close.fromAccounts')}>
                  {onBudget.map((a) => {
                    const viaSavings = a.id === settings.provisionsAccountId && savingsLine;
                    const left = viaSavings ? savingsLeft - (lent.get(savingsLine) ?? 0) + (choice(l.categoryId) === `acct:${a.id}` ? l.short : 0) : 0;
                    return (
                      <option key={a.id} value={`acct:${a.id}`} disabled={!!viaSavings && left < l.short}>
                        {viaSavings ? t('close.fromSavings', { name: a.name, amount: formatWholeEuros(left) }) : t('close.fromAccount', { name: a.name })}
                      </option>
                    );
                  })}
                </optgroup>
                <optgroup label={t('close.fromLines')}>
                {m.sources
                  .filter((s) => s.categoryId !== l.categoryId && s.categoryId !== savingsLine)
                  .map((s) => {
                    const left = s.available - (lent.get(s.categoryId) ?? 0) + (choice(l.categoryId) === `line:${s.categoryId}` ? l.short : 0);
                    return (
                      <option key={s.categoryId} value={`line:${s.categoryId}`} disabled={left < l.short}>
                        {t('close.fromLine', { name: name(s.categoryId), amount: formatWholeEuros(left) })}
                      </option>
                    );
                  })}
                </optgroup>
                <option value="next">{t('close.leave', { next })}</option>
              </select>
            </li>
          );
        })}
      </ul>
      <p className="split-row close-summary">
        <span>{t('close.readyAfter', { month: monthName(m.month) })}</span>
        <strong><Money cents={m.readyToAssign - fromReady} /></strong>
      </p>
      {overLent && <p className="error" role="alert">⚠ {t('close.overLent')}</p>}
      <div className="row">
        <button type="button" className="button button-primary" disabled={busy || overLent} onClick={() => void apply()}>{t('close.closeOne', { month: monthName(m.month) })}</button>
        <button type="button" className="button button-quiet" onClick={onClose}>{t('close.later')}</button>
      </div>
    </Dialog>
  );
}

/**
 * Whether a month is closed (D-91): the running month is open by nature; a
 * past month is closed once every line that ended below zero was covered or
 * left for the next month.
 */
export function MonthStatus({ month }: { month: string }) {
  const open = useMonthsToClose();
  const settings = useSettings();
  const categories = useStore('categories');
  const accounts = useStore('accounts');
  const [closing, setClosing] = useState(false);
  const current = currentMonth();
  if (month < settings.budgetStartMonth) return null;
  if (month >= current) {
    return <p className="month-status"><span aria-hidden="true">● </span>{month === current ? t('close.running') : t('close.future')}</p>;
  }
  const o = open.find((x) => x.month === month);
  if (o) {
    const total = o.lines.reduce((s, l) => s + l.short, 0);
    return (
      <div className="month-status month-status-open">
        <span><span aria-hidden="true">⚠ </span>{t('close.statusOpen', { n: o.lines.length, total: formatWholeEuros(total) })}</span>
        <button type="button" className="button button-small button-primary" onClick={() => setClosing(true)}>{t('close.closeOne', { month: monthName(month) })}</button>
        {closing && <CloseMonthDialog only={month} onClose={() => setClosing(false)} />}
      </div>
    );
  }
  const covers = (settings.covers ?? []).filter((c) => c.month === month);
  const left = settings.closedMonths?.find((x) => x.month === month)?.left ?? [];
  const name = (id: string) => categories.find((c) => c.id === id)?.name ?? '?';
  if (covers.length === 0 && left.length === 0) {
    return <p className="month-status month-status-closed"><span aria-hidden="true">✓ </span>{t('close.statusClean')}</p>;
  }
  return (
    <details className="month-status month-status-closed">
      <summary><span aria-hidden="true">✓ </span>{t('close.statusClosed', { covered: covers.length, left: left.length })}</summary>
      <ul className="plain-list">
        {covers.map((c) => (
          <li key={c.id} className="split-row">
            <span>
              {name(c.categoryId)}{' '}
              <span className="muted">
                {c.fromAccountId ? t('cover.fromAccount', { name: accounts.find((a) => a.id === c.fromAccountId)?.name ?? '?' }) : c.fromCategoryId ? t('cover.fromLine', { name: name(c.fromCategoryId) }) : t('cover.fromReady')}
              </span>
            </span>
            <Money cents={c.amount} />
          </li>
        ))}
        {left.map((id) => (
          <li key={id} className="split-row">
            <span>{name(id)} <span className="muted">{t('close.leftNext')}</span></span>
          </li>
        ))}
      </ul>
    </details>
  );
}
