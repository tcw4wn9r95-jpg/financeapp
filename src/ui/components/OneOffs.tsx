import { useMemo, useState, type FormEvent } from 'react';
import { addMonths, currentMonth, lastDayOfMonth } from '../../domain/dates';
import { formatMoney, formatMoneyInput, parseMoney } from '../../domain/money';
import { oneOffView } from '../../domain/plan';
import type { EventFund, MonthKey } from '../../domain/types';
import { monthName, t } from '../../i18n';
import { deleteEvent, saveEvent } from '../actions';
import { useStore, useVault } from '../hooks';
import { Dialog } from './Dialog';
import { SelectField, TextField } from './fields';
import { Money } from './Money';
import { useToast } from './Toast';

/**
 * One-off expenses planned for a month (D-108): a party at home, a weekend
 * away. Items with an estimate each; the total is that month's budget for the
 * expense, taken from its unplanned money. When the statements come and the
 * payments are filed to the expense (and its item), each item counts at what
 * was paid instead.
 */
export function MonthOneOffs({ month }: { month: MonthKey }) {
  const events = useStore('events');
  const allocations = useStore('allocations');
  const transactions = useStore('transactions');
  const [editing, setEditing] = useState<EventFund | 'new' | null>(null);
  const views = useMemo(
    () => events.filter((e) => e.kind === 'month' && e.targetDate.startsWith(month)).map((e) => oneOffView(e, allocations, transactions)),
    [events, allocations, transactions, month],
  );
  return (
    <section className="group oneoffs" aria-labelledby="oneoffs-h">
      <div className="group-head">
        <h2 id="oneoffs-h">{t('oneoff.title')}</h2>
        <button type="button" className="button button-small" onClick={() => setEditing('new')}>+ {t('oneoff.add')}</button>
      </div>
      {views.length === 0 && <p className="hint">{t('oneoff.empty', { month: monthName(month) })}</p>}
      {views.map((v) => (
        <OneOffCard key={v.event.id} v={v} onEdit={() => setEditing(v.event)} />
      ))}
      {editing && <OneOffDialog existing={editing === 'new' ? undefined : editing} month={month} onClose={() => setEditing(null)} />}
    </section>
  );
}

function OneOffCard({ v, onEdit }: { v: ReturnType<typeof oneOffView>; onEdit: () => void }) {
  const vault = useVault();
  const notify = useToast();
  const e = v.event;
  const past = v.month <= currentMonth();
  async function settle(settled: boolean) {
    await saveEvent(vault, { name: e.name, targetAmount: e.targetAmount, targetDate: e.targetDate, startDate: e.startDate ?? `${v.month}-01`, subBudgets: e.subBudgets, kind: 'month', settled }, e);
    notify(settled ? t('oneoff.settledDone', { name: e.name }) : t('oneoff.unsettled', { name: e.name }), 'ok', { label: t('inbox.undo'), run: () => void settle(!settled) });
  }
  return (
    <div className="card oneoff-card">
      <div className="split-row">
        <strong>{e.name}</strong>
        <button type="button" className="button button-quiet button-small" onClick={onEdit}>{t('oneoff.edit')}</button>
      </div>
      <p className="hint">
        {t('oneoff.summary', { planned: formatMoney(v.planned), paid: formatMoney(v.actual), budget: formatMoney(v.counts) })}
      </p>
      <ul className="plain-list facts">
        {v.items.map((x) => (
          <li key={x.name} className="split-row">
            <span>
              {x.name}
              <span className="muted"> · {x.actual !== 0 ? t('oneoff.paidVs', { planned: formatMoney(x.planned) }) : e.settled ? t('oneoff.notPaid') : t('oneoff.estimate')}</span>
            </span>
            <span className="row-end">
              <Money cents={x.actual !== 0 ? x.actual : x.planned} />
              {x.actual !== 0 && <span className="badge">{t('oneoff.actual')}</span>}
            </span>
          </li>
        ))}
        {v.other.actual !== 0 && (
          <li className="split-row">
            <span>{t('oneoff.other')}</span>
            <span className="row-end"><Money cents={v.other.actual} /><span className="badge">{t('oneoff.actual')}</span></span>
          </li>
        )}
        <li className="split-row"><strong>{t('oneoff.budgeted', { month: monthName(v.month) })}</strong><strong><Money cents={v.counts} /></strong></li>
      </ul>
      {past && !e.settled && v.items.some((x) => x.actual === 0) && (
        <div className="stack">
          <p className="hint">{t('oneoff.settleHint')}</p>
          <button type="button" className="button button-small" onClick={() => void settle(true)}>{t('oneoff.settle')}</button>
        </div>
      )}
      {e.settled && <p className="hint">✓ {t('oneoff.settledNote')} <button type="button" className="link-button" onClick={() => void settle(false)}>{t('oneoff.reopen')}</button></p>}
    </div>
  );
}

interface ItemDraft {
  name: string;
  amount: string;
}

export function OneOffDialog({ existing, month, onClose }: { existing: EventFund | undefined; month: MonthKey; onClose: () => void }) {
  const vault = useVault();
  const notify = useToast();
  const [name, setName] = useState(existing?.name ?? '');
  const [when, setWhen] = useState<MonthKey>(existing ? existing.targetDate.slice(0, 7) : month);
  const [items, setItems] = useState<ItemDraft[]>(existing?.subBudgets.map((s) => ({ name: s.name, amount: formatMoneyInput(s.amount) })) ?? [{ name: '', amount: '' }]);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const months = Array.from({ length: 16 }, (_, i) => addMonths(currentMonth(), i - 3));
  if (!months.includes(when)) months.unshift(when);
  const parsed = items.map((x) => ({ name: x.name.trim(), amount: x.amount.trim() ? parseMoney(x.amount) : null }));
  const total = parsed.reduce((s, x) => s + (x.amount && x.amount > 0 ? x.amount : 0), 0);
  const set = (i: number, patch: Partial<ItemDraft>) => setItems(items.map((x, j) => (j === i ? { ...x, ...patch } : x)));

  async function submit(e: FormEvent) {
    e.preventDefault();
    const kept = parsed.filter((x) => x.name || x.amount);
    if (!name.trim()) return setError(t('plan.nameRequired'));
    if (!kept.length) return setError(t('oneoff.needItem'));
    if (kept.some((x) => !x.name || x.amount === null || x.amount <= 0)) return setError(t('oneoff.itemInvalid'));
    if (new Set(kept.map((x) => x.name.toLowerCase())).size !== kept.length) return setError(t('oneoff.itemTwice'));
    setBusy(true);
    try {
      await saveEvent(
        vault,
        {
          name: name.trim(),
          targetAmount: total,
          targetDate: lastDayOfMonth(when),
          startDate: `${when}-01`,
          subBudgets: kept.map((x) => ({ name: x.name, amount: x.amount! })),
          kind: 'month',
          ...(existing?.settled ? { settled: true } : {}),
        },
        existing,
      );
      notify(t('oneoff.saved', { name: name.trim(), amount: formatMoney(total), month: monthName(when) }));
      onClose();
    } catch {
      setBusy(false);
      setError(t('common.unexpectedError'));
    }
  }

  async function remove() {
    if (!existing) return;
    setBusy(true);
    await deleteEvent(vault, existing);
    notify(t('oneoff.deleted', { name: existing.name }));
    onClose();
  }

  return (
    <Dialog open title={existing ? existing.name : t('oneoff.newTitle')} onClose={onClose}>
      <form onSubmit={submit} noValidate>
        <p className="hint">{t('oneoff.intro')}</p>
        <TextField label={t('oneoff.name')} placeholder={t('oneoff.namePlaceholder')} value={name} onChange={(e) => setName(e.target.value)} autoFocus={!existing} />
        <SelectField label={t('oneoff.month')} value={when} onChange={(e) => setWhen(e.target.value)}>
          {months.map((m) => <option key={m} value={m}>{monthName(m)}</option>)}
        </SelectField>
        <fieldset className="oneoff-items">
          <legend>{t('oneoff.items')}</legend>
          {items.map((x, i) => (
            <div key={i} className="oneoff-item">
              <TextField label={t('oneoff.itemName')} placeholder={i === 0 ? t('oneoff.itemPlaceholder') : ''} value={x.name} onChange={(e) => set(i, { name: e.target.value })} />
              <TextField label={t('oneoff.itemAmount')} inputMode="decimal" value={x.amount} onChange={(e) => set(i, { amount: e.target.value })} />
              <button type="button" className="button button-quiet button-small" aria-label={t('oneoff.removeItem', { name: x.name || String(i + 1) })} onClick={() => setItems(items.length > 1 ? items.filter((_, j) => j !== i) : [{ name: '', amount: '' }])}>✕</button>
            </div>
          ))}
          <button type="button" className="button button-quiet button-small" onClick={() => setItems([...items, { name: '', amount: '' }])}>+ {t('oneoff.addItem')}</button>
        </fieldset>
        <p className="split-row oneoff-total"><strong>{t('oneoff.total')}</strong><strong><Money cents={total} /></strong></p>
        <p className="hint">{t('oneoff.totalHint', { month: monthName(when) })}</p>
        {error && <p className="field-error" role="alert">{error}</p>}
        <div className="stack">
          <button className="button button-primary" disabled={busy}>{t('common.save')}</button>
          {existing && <button type="button" className="button button-quiet" disabled={busy} onClick={() => void remove()}>{t('oneoff.delete')}</button>}
        </div>
      </form>
    </Dialog>
  );
}
