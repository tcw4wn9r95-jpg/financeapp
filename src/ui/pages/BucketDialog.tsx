import { useMemo, useState } from 'react';
import { bucketDetail, buckets, unallocatedMoves, type BucketWindow } from '../../domain/buckets';
import { currentMonth, formatDate } from '../../domain/dates';
import { formatMoney } from '../../domain/money';
import type { Transaction } from '../../domain/types';
import { monthName, t } from '../../i18n';
import { Dialog } from '../components/Dialog';
import { Money } from '../components/Money';
import { useBudgetInput, useSettings, useStore } from '../hooks';
import { AllocateDialog } from './AllocateDialog';
import { TransactionDialog } from './TransactionsPage';

/**
 * What fed and emptied one provision or trip in its current cycle, with each
 * transaction a tap away from being corrected (D-64), and each move into the
 * provisions account allocated by hand (D-65).
 */
export function BucketDialog({ name, window, onEdit, onClose }: { name: string; window: BucketWindow; onEdit?: () => void; onClose: () => void }) {
  const input = useBudgetInput();
  const settings = useSettings();
  const accounts = useStore('accounts');
  const [open, setOpen] = useState<Transaction | null>(null);
  const [allocating, setAllocating] = useState<Transaction | null>(null);
  const month = currentMonth();
  const accountId = settings.provisionsAccountId;
  const view = useMemo(() => buckets(input, month, accountId, [window]).get(window.categoryId)!, [input, month, accountId, window]);
  const detail = useMemo(() => bucketDetail(input, month, accountId, window), [input, month, accountId, window]);
  const waiting = useMemo(() => (accountId ? unallocatedMoves(input, accountId) : []), [input, accountId]);
  const accountName = (id: string) => accounts.find((a) => a.id === id)?.name ?? '?';

  // A transaction opened for correcting or allocating replaces this dialog until it closes.
  if (open) return <TransactionDialog tx={open} onClose={() => setOpen(null)} />;
  if (allocating) return <AllocateDialog tx={allocating} onClose={() => setAllocating(null)} />;

  const txButton = (tx: Transaction, amount: number, sub: string) => (
    <button type="button" className="row-button tx-row" onClick={() => setOpen(tx)}>
      <span className="row-main">
        <span className="row-title tx-desc">{tx.descriptionRaw || t('tx.noDescription')}</span>
        <span className="row-sub">{formatDate(tx.date)} · {sub}</span>
      </span>
      <span className="row-end"><Money cents={amount} plusSign className="row-amount tx-amount" /></span>
    </button>
  );
  const allocateButton = (tx: Transaction) => (
    <div className="pin">
      <button type="button" className="button button-small" onClick={() => setAllocating(tx)}>{t('allocate.button')}</button>
    </div>
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

      {waiting.length > 0 && (
        <section className="group" aria-labelledby="bk-wait">
          <div className="group-head"><h3 id="bk-wait">{t('allocate.waitingTitle')}</h3></div>
          <p className="hint">{t('allocate.waitingHint')}</p>
          <ul className="rows">
            {waiting.map(({ tx, left }) => (
              <li key={tx.id} className="bucket-move">
                {txButton(tx, tx.amount, t('allocate.leftOf', { left: formatMoney(left) }))}
                {allocateButton(tx)}
              </li>
            ))}
          </ul>
        </section>
      )}

      {detail.months.length === 0 && <p className="notice">{t('bucket.nothingYet')}</p>}
      {detail.months.map((m) => (
        <section key={m.month} className="group" aria-label={monthName(m.month)}>
          <div className="group-head">
            <h3>{monthName(m.month)}</h3>
            {accountId && <span className="muted">{t('bucket.forThis')} <Money cents={m.loaded} /></span>}
          </div>
          <ul className="rows">
            {m.moves.map(({ tx, amount }) => (
              <li key={tx.id} className="bucket-move">
                {txButton(tx, amount, t('allocate.partOf', { name: accountName(tx.accountId), total: formatMoney(tx.amount) }))}
                {allocateButton(tx)}
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
