import { useState, type FormEvent } from 'react';
import { cycleLookup, earmarksOf, suggestAllocation } from '../../domain/buckets';
import { formatDate, monthOf } from '../../domain/dates';
import { formatMoneyInput, parseMoney } from '../../domain/money';
import type { Id, Transaction } from '../../domain/types';
import { t } from '../../i18n';
import { allocateMove } from '../actions';
import { Dialog } from '../components/Dialog';
import { TextField } from '../components/fields';
import { Money } from '../components/Money';
import { useToast } from '../components/Toast';
import { useBudgetInput, useSettings, useStore, useVault } from '../hooks';

/**
 * Say which provisions and trips a move into the provisions account is for
 * (D-65). Nothing is shared out automatically: what is not allocated stays
 * plain savings and fills no bucket.
 */
export function AllocateDialog({ tx, onClose }: { tx: Transaction; onClose: () => void }) {
  const vault = useVault();
  const notify = useToast();
  const input = useBudgetInput();
  const settings = useSettings();
  const accounts = useStore('accounts');
  const provisions = useStore('provisions');
  const events = useStore('events');
  const targets: [Id, string][] = [
    ...provisions.map((p): [Id, string] => [p.categoryId, p.name]),
    ...events.filter((e) => e.status !== 'closed').map((e): [Id, string] => [e.categoryId, e.name]),
  ];
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
  const invalid = targets.some(([id]) => {
    const c = cents(id);
    return c === null || c < 0;
  });
  const allocated = targets.reduce((s, [id]) => s + Math.max(0, cents(id) ?? 0), 0);
  const rest = tx.amount - allocated;
  const from = accounts.find((a) => a.id === tx.accountId)?.name ?? '?';

  function fillByPlan() {
    if (!settings.provisionsAccountId) return;
    const split = suggestAllocation(input, monthOf(tx.date), settings.provisionsAccountId, tx.amount, cycleLookup(provisions, events), tx.id);
    const out: Record<Id, string> = {};
    for (const [id, amount] of split) if (amount > 0) out[id] = formatMoneyInput(amount);
    setTexts(out);
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (invalid || rest < 0) return;
    setBusy(true);
    try {
      await allocateMove(vault, tx.id, new Map(targets.map(([id]) => [id, cents(id) ?? 0])));
      notify(t('allocate.saved'));
      onClose();
    } catch {
      notify(t('allocate.over'), 'error');
      setBusy(false);
    }
  }

  return (
    <Dialog open title={t('allocate.title')} onClose={onClose}>
      <form onSubmit={(e) => void submit(e)} noValidate>
        <div className="split-row">
          <span>
            <span className="tx-desc">{tx.descriptionRaw || t('tx.noDescription')}</span>
            <br />
            <span className="muted">{formatDate(tx.date)} · {from}</span>
          </span>
          <Money cents={tx.amount} plusSign className="tx-amount" />
        </div>
        <p className="hint">{t('allocate.intro')}</p>
        {targets.length === 0 ? (
          <p className="notice">{t('allocate.noTargets')}</p>
        ) : (
          <>
            <div className="row">
              <button type="button" className="button button-small" onClick={fillByPlan}>{t('allocate.fillByPlan')}</button>
              <button type="button" className="button button-quiet button-small" onClick={() => setTexts({})}>{t('allocate.clear')}</button>
            </div>
            {targets.map(([id, name]) => (
              <TextField
                key={id}
                label={name}
                inputMode="decimal"
                autoComplete="off"
                placeholder="0,00"
                value={texts[id] ?? ''}
                onChange={(e) => setTexts({ ...texts, [id]: e.target.value })}
                {...(cents(id) === null ? { error: t('field.moneyInvalid') } : {})}
              />
            ))}
          </>
        )}
        <ul className="plain-list facts">
          <li className="split-row"><span>{t('allocate.allocated')}</span><Money cents={allocated} /></li>
          <li className="split-row">
            <strong className={rest < 0 ? 'bad' : undefined}>{rest < 0 ? t('allocate.tooMuch') : t('allocate.rest')}</strong>
            <strong className={rest < 0 ? 'bad' : undefined}><Money cents={Math.abs(rest)} /></strong>
          </li>
        </ul>
        <div className="row">
          <button type="submit" className="button button-primary" disabled={busy || invalid || rest < 0}>{t('common.save')}</button>
          <button type="button" className="button button-quiet" onClick={onClose}>{t('common.cancel')}</button>
        </div>
      </form>
    </Dialog>
  );
}
