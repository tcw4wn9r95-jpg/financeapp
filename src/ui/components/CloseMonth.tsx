import { useMemo, useState } from 'react';
import { computeBudget, isOnBudget } from '../../domain/budget';
import { addMonths, currentMonth } from '../../domain/dates';
import { formatWholeEuros } from '../../domain/money';
import { monthsToClose, type CloseDecision, type CloseSourceChoice, type MonthToClose } from '../../domain/monthclose';
import { monthName, t } from '../../i18n';
import { closeMonth } from '../actions';
import { useBudgetInput, useSettings, useStore, useVault } from '../hooks';
import { Dialog } from './Dialog';
import { SelectField } from './fields';
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
    return monthsToClose(computeBudget(input, last), categories, closed ?? [], current);
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

const sourceValue = (s: CloseSourceChoice) => (s.kind === 'line' ? `line:${s.categoryId}` : s.kind);
const parseSource = (v: string): CloseSourceChoice => (v.startsWith('line:') ? { kind: 'line', categoryId: v.slice(5) } : v === 'next' ? { kind: 'next' } : { kind: 'ready' });

/** Close the oldest open month, then the next one, until none is left (D-89). */
export function CloseMonthDialog({ onClose }: { onClose: () => void }) {
  const open = useMonthsToClose();
  const vault = useVault();
  const notify = useToast();
  const categories = useStore('categories');
  const accounts = useStore('accounts');
  const [total] = useState(open.length);
  const m = open[0];
  const [choices, setChoices] = useState<Record<string, string>>({});
  const [account, setAccount] = useState('');
  const [busy, setBusy] = useState(false);
  const name = (id: string) => categories.find((c) => c.id === id)?.name ?? '?';

  if (!m) {
    return (
      <Dialog open title={t('close.title')} onClose={onClose}>
        <p>✓ {t('close.allDone')}</p>
        <div className="row"><button type="button" className="button button-primary" onClick={onClose}>{t('common.close')}</button></div>
      </Dialog>
    );
  }
  const key = (id: string) => `${m.month}|${id}`;
  const choice = (id: string) => choices[key(id)] ?? 'ready';
  const next = monthName(addMonths(m.month, 1));
  // What each lending line has left once the choices above are taken from it.
  const lent = new Map<string, number>();
  for (const l of m.lines) {
    const c = choice(l.categoryId);
    if (c.startsWith('line:')) lent.set(c.slice(5), (lent.get(c.slice(5)) ?? 0) + l.short);
  }
  const fromReady = m.lines.filter((l) => choice(l.categoryId) === 'ready').reduce((s, l) => s + l.short, 0);
  const decisions: CloseDecision[] = m.lines.map((l) => ({ categoryId: l.categoryId, short: l.short, source: parseSource(choice(l.categoryId)) }));
  const overLent = m.sources.some((s) => (lent.get(s.categoryId) ?? 0) > s.available);
  const setAll = (v: string) => setChoices((c) => ({ ...c, ...Object.fromEntries(m.lines.map((l) => [key(l.categoryId), v])) }));

  async function apply() {
    setBusy(true);
    try {
      const undo = await closeMonth(vault, m!, decisions, account || undefined);
      notify(t('close.done', { month: monthName(m!.month) }), 'ok', { label: t('inbox.undo'), run: () => void undo().then(() => notify(t('close.undone'))) });
      setAccount('');
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
                {m.sources
                  .filter((s) => s.categoryId !== l.categoryId)
                  .map((s) => {
                    const left = s.available - (lent.get(s.categoryId) ?? 0) + (choice(l.categoryId) === `line:${s.categoryId}` ? l.short : 0);
                    return (
                      <option key={s.categoryId} value={sourceValue({ kind: 'line', categoryId: s.categoryId })} disabled={left < l.short}>
                        {t('close.fromLine', { name: name(s.categoryId), amount: formatWholeEuros(left) })}
                      </option>
                    );
                  })}
                <option value="next">{t('close.leave', { next })}</option>
              </select>
            </li>
          );
        })}
      </ul>
      <SelectField label={t('close.account')} value={account} onChange={(e) => setAccount(e.target.value)} hint={t('close.accountHint')}>
        <option value="">{t('close.noAccount')}</option>
        {accounts.filter((a) => !a.closedAt && isOnBudget(a)).map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
      </SelectField>
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
