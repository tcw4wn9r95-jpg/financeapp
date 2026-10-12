import { useMemo, useState, type FormEvent } from 'react';
import { buckets, cycleLookup, earmarksOf, provisionWindow, suggestAllocation, tripWindow } from '../../domain/buckets';
import { currentMonth, formatDate, monthOf } from '../../domain/dates';
import { formatMoneyInput, parseMoney } from '../../domain/money';
import type { Id, Transaction } from '../../domain/types';
import { t } from '../../i18n';
import { allocateMove } from '../actions';
import { Dialog } from '../components/Dialog';
import { Money } from '../components/Money';
import { useToast } from '../components/Toast';
import { useBudgetInput, useSettings, useStore, useVault } from '../hooks';

/**
 * Say which provisions and trips a move into the provisions account is for
 * (D-65). Nothing is shared out automatically: what is not allocated stays
 * plain savings and fills no bucket. What is left to split stays in view
 * while typing, and each line shows what that bucket still needs (D-66).
 */
export function AllocateDialog({ tx, onClose }: { tx: Transaction; onClose: () => void }) {
  const vault = useVault();
  const notify = useToast();
  const input = useBudgetInput();
  const settings = useSettings();
  const accounts = useStore('accounts');
  const provisions = useStore('provisions');
  const events = useStore('events');
  const accountId = settings.provisionsAccountId;
  const month = currentMonth();
  const targets = useMemo(
    () => [
      ...provisions.map((p) => ({ id: p.categoryId, name: p.name, window: provisionWindow(p, month) })),
      ...events.filter((e) => e.status !== 'closed').map((e) => ({ id: e.categoryId, name: e.name, window: tripWindow(e) })),
    ],
    [provisions, events, month],
  );
  // What each bucket needs to be on plan, without this move's own allocation.
  const needs = useMemo(() => {
    if (!accountId) return new Map<Id, number>();
    const without = { ...input, transactions: input.transactions.map((x) => (x.id === tx.id ? { ...x, earmarks: [], earmarkCategoryId: undefined } : x)) };
    const views = buckets(without, month, accountId, targets.map((x) => x.window));
    return new Map(targets.map((x) => [x.id, views.get(x.id)?.toMove ?? 0]));
  }, [input, month, accountId, targets, tx.id]);

  const [texts, setTexts] = useState<Record<Id, string>>(() => {
    const out: Record<Id, string> = {};
    for (const e of earmarksOf(tx)) out[e.categoryId] = formatMoneyInput(e.amount);
    return out;
  });
  const [busy, setBusy] = useState(false);
  const cents = (id: Id) => {
    const v = (texts[id] ?? '').trim();
    return v === '' ? 0 : parseMoney(v);
  };
  const invalid = targets.some(({ id }) => {
    const c = cents(id);
    return c === null || c < 0;
  });
  const allocated = targets.reduce((s, { id }) => s + Math.max(0, cents(id) ?? 0), 0);
  const rest = tx.amount - allocated;
  const from = accounts.find((a) => a.id === tx.accountId)?.name ?? '?';

  function fillByPlan() {
    if (!accountId) return;
    const split = suggestAllocation(input, monthOf(tx.date), accountId, tx.amount, cycleLookup(provisions, events), tx.id);
    const out: Record<Id, string> = {};
    for (const [id, amount] of split) if (amount > 0) out[id] = formatMoneyInput(amount);
    setTexts(out);
  }

  /** Put what is left to split on this line (on top of what it has). */
  function addRest(id: Id) {
    if (rest <= 0) return;
    setTexts({ ...texts, [id]: formatMoneyInput(Math.max(0, cents(id) ?? 0) + rest) });
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (invalid || rest < 0) return;
    setBusy(true);
    try {
      await allocateMove(vault, tx.id, new Map(targets.map(({ id }) => [id, cents(id) ?? 0])));
      notify(t('allocate.saved'));
      onClose();
    } catch {
      notify(t('allocate.over'), 'error');
      setBusy(false);
    }
  }

  return (
    <Dialog open title={t('allocate.title')} onClose={onClose}>
      <form onSubmit={(e) => void submit(e)} noValidate className="allocate">
        <div className={`allocate-head ${rest < 0 ? 'allocate-over' : ''}`} role="status">
          <div>
            <span className="muted">{formatDate(tx.date)} · {from}</span>
            <strong><Money cents={tx.amount} /></strong>
          </div>
          <div className="allocate-left">
            <span className="muted">{rest < 0 ? t('allocate.tooMuch') : t('allocate.leftToSplit')}</span>
            <strong><Money cents={Math.abs(rest)} /></strong>
          </div>
        </div>
        {targets.length === 0 ? (
          <p className="notice">{t('allocate.noTargets')}</p>
        ) : (
          <>
            <div className="row">
              <button type="button" className="button button-small" onClick={fillByPlan}>{t('allocate.fillByPlan')}</button>
              <button type="button" className="button button-quiet button-small" onClick={() => setTexts({})}>{t('allocate.clear')}</button>
            </div>
            <ul className="plain-list allocate-lines">
              {targets.map(({ id, name }) => {
                const need = needs.get(id) ?? 0;
                const bad = cents(id) === null;
                return (
                  <li key={id} className="allocate-line">
                    <label htmlFor={`al-${id}`} className="allocate-name">
                      <span>{name}</span>
                      <span className="muted">{need > 0 ? <>{t('allocate.needs')} <Money cents={need} /></> : t('allocate.onPlan')}</span>
                    </label>
                    {rest > 0 && <button type="button" className="link-button" onClick={() => addRest(id)}>{t('allocate.addRest')}</button>}
                    <input
                      id={`al-${id}`}
                      className="allocate-input"
                      inputMode="decimal"
                      autoComplete="off"
                      placeholder="0,00"
                      aria-invalid={bad}
                      value={texts[id] ?? ''}
                      onChange={(e) => setTexts({ ...texts, [id]: e.target.value })}
                    />
                  </li>
                );
              })}
            </ul>
          </>
        )}
        <p className="hint">{rest > 0 ? t('allocate.restHint') : t('allocate.intro')}</p>
        <div className="row">
          <button type="submit" className="button button-primary" disabled={busy || invalid || rest < 0}>{t('common.save')}</button>
          <button type="button" className="button button-quiet" onClick={onClose}>{t('common.cancel')}</button>
        </div>
      </form>
    </Dialog>
  );
}
