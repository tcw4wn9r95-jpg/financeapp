import { useMemo, useState } from 'react';
import { bucketDetail, buckets, cycleLookup, type BucketWindow } from '../../domain/buckets';
import { currentMonth, formatDate } from '../../domain/dates';
import type { Transaction } from '../../domain/types';
import { monthName, t } from '../../i18n';
import { Dialog } from '../components/Dialog';
import { Money } from '../components/Money';
import { useToast } from '../components/Toast';
import { useBudgetInput, useSettings, useStore, useVault } from '../hooks';
import { TransactionDialog } from './TransactionsPage';

/**
 * What fed and emptied one provision or trip in its current cycle, with each
 * transaction a tap away from being corrected (D-64).
 */
export function BucketDialog({ name, window, onEdit, onClose }: { name: string; window: BucketWindow; onEdit?: () => void; onClose: () => void }) {
  const vault = useVault();
  const notify = useToast();
  const input = useBudgetInput();
  const settings = useSettings();
  const accounts = useStore('accounts');
  const provisions = useStore('provisions');
  const events = useStore('events');
  const [open, setOpen] = useState<Transaction | null>(null);
  const month = currentMonth();
  const accountId = settings.provisionsAccountId;
  const cycleOf = useMemo(() => cycleLookup(provisions, events), [provisions, events]);
  const view = useMemo(() => buckets(input, month, accountId, [window], cycleOf).get(window.categoryId)!, [input, month, accountId, window, cycleOf]);
  const detail = useMemo(() => bucketDetail(input, month, accountId, window, cycleOf), [input, month, accountId, window, cycleOf]);
  const accountName = (id: string) => accounts.find((a) => a.id === id)?.name ?? '?';
  const pinTargets = [
    ...provisions.map((p) => [p.categoryId, p.name] as const),
    ...events.filter((e) => e.status !== 'closed' || e.categoryId === window.categoryId).map((e) => [e.categoryId, e.name] as const),
  ];

  // A transaction opened for correcting replaces this dialog until it closes.
  if (open) return <TransactionDialog tx={open} onClose={() => setOpen(null)} />;

  async function pin(tx: Transaction, categoryId: string) {
    const fresh = vault.get('transactions', tx.id);
    if (!fresh) return;
    const { earmarkCategoryId: _, ...rest } = fresh;
    await vault.put('transactions', { ...rest, ...(categoryId ? { earmarkCategoryId: categoryId } : {}), updatedAt: new Date().toISOString() });
    notify(t('settings.saved'));
  }

  const txButton = (tx: Transaction, amount: number, sub: string) => (
    <button type="button" className="row-button tx-row" onClick={() => setOpen(tx)}>
      <span className="row-main">
        <span className="row-title tx-desc">{tx.descriptionRaw || t('tx.noDescription')}</span>
        <span className="row-sub">{formatDate(tx.date)} · {sub}</span>
      </span>
      <span className="row-end"><Money cents={amount} plusSign className="row-amount tx-amount" /></span>
    </button>
  );

  return (
    <Dialog open title={name} onClose={onClose} wide>
      <ul className="plain-list facts">
        <li className="split-row"><span>{view.tracked ? t('bucket.loaded') : t('bucket.plannedIn')}</span><Money cents={view.loaded} /></li>
        <li className="split-row"><span>{t('plan.spent')}</span><Money cents={-view.spent} /></li>
        <li className="split-row"><strong>{t('bucket.level')}</strong><strong><Money cents={view.level} /></strong></li>
        {view.target > 0 && <li className="split-row"><span className="muted">{t('bucket.target')}</span><Money cents={view.target} /></li>}
      </ul>
      <p className="hint">{t('bucket.cycleFrom', { month: monthName(window.cycleStart) })}</p>
      {!accountId && <p className="notice">{t('bucket.noAccount')}</p>}

      {detail.months.length === 0 && <p className="notice">{t('bucket.nothingYet')}</p>}
      {detail.months.map((m) => (
        <section key={m.month} className="group" aria-label={monthName(m.month)}>
          <div className="group-head">
            <h3>{monthName(m.month)}</h3>
            {accountId && <span className="muted">{t('bucket.forThis')} <Money cents={m.loaded} /></span>}
          </div>
          <ul className="rows">
            {m.moves.map((tx) => (
              <li key={tx.id} className="bucket-move">
                {txButton(tx, tx.amount, t('bucket.moveInto', { name: accountName(tx.accountId) }))}
                <label className="pin">
                  <span>{t('bucket.countsFor')}</span>
                  <select value={tx.earmarkCategoryId ?? ''} onChange={(e) => void pin(tx, e.target.value)}>
                    <option value="">{t('bucket.shared')}</option>
                    {pinTargets.map(([id, n]) => <option key={id} value={id}>{t('bucket.onlyFor', { name: n })}</option>)}
                  </select>
                </label>
              </li>
            ))}
            {m.spending.map((s) => (
              <li key={`${s.tx.id}-${s.amount}`}>{txButton(s.tx, s.amount, `${t('bucket.paidFrom')} ${accountName(s.tx.accountId)}`)}</li>
            ))}
          </ul>
        </section>
      ))}

      {detail.notCounted.length > 0 && (
        <section className="group" aria-labelledby="bk-nc">
          <div className="group-head"><h3 id="bk-nc">{t('bucket.notCounted')}</h3></div>
          <p className="hint">{t('bucket.notCountedHint', { name: accountName(accountId!) })}</p>
          <ul className="rows">
            {detail.notCounted.map((tx) => <li key={tx.id}>{txButton(tx, tx.amount, accountName(tx.accountId))}</li>)}
          </ul>
        </section>
      )}

      <p className="hint">{t('bucket.tapToCorrect')}</p>
      <div className="row">
        {onEdit && <button type="button" className="button" onClick={onEdit}>{t('common.edit')}</button>}
        <button type="button" className="button button-quiet" onClick={onClose}>{t('common.close')}</button>
      </div>
    </Dialog>
  );
}
