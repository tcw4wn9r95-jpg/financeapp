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
 * One provision or trip: what is in it, and one list of what went in
 * (allocated moves) and out (bills, trip spending) in its current cycle
 * (D-64, D-65, D-66). Money taken out of the provisions account is a plain
 * transfer and is not listed: the bucket empties where the bill is filed.
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

  const history = detail.months
    .flatMap((m) => [
      ...m.moves.map(({ tx, amount }) => ({
        key: `in-${tx.id}`,
        date: tx.date,
        title: t('bucket.allocated'),
        sub: t('bucket.fromMove', { total: formatMoney(tx.amount) }),
        amount,
        onClick: () => setAllocating(tx),
      })),
      ...m.spending.map(({ tx, amount }) => ({
        key: `out-${tx.id}-${amount}`,
        date: tx.date,
        title: tx.descriptionRaw || t('tx.noDescription'),
        sub: accountName(tx.accountId),
        amount,
        onClick: () => setOpen(tx),
      })),
    ])
    .sort((a, b) => b.date.localeCompare(a.date));

  return (
    <Dialog open title={name} onClose={onClose} wide>
      <div className="bucket-head">
        <span className="muted">{view.tracked ? t('bucket.level') : t('bucket.plannedIn')}</span>
        <strong><Money cents={view.level} /></strong>
        <span className="muted">
          {view.target > 0 && <>{t('bucket.ofTarget')} <Money cents={view.target} /></>}
          {view.tracked && view.toMove > 0 && <> · {t('bucket.toMove')} <Money cents={view.toMove} /></>}
        </span>
      </div>
      {!accountId && <p className="notice">{t('bucket.noAccount')}</p>}

      {waiting.length > 0 && (
        <div className="bucket-waiting">
          <p><strong>{t('allocate.waitingTitle')}</strong></p>
          <ul className="plain-list move-list">
            {waiting.map(({ tx }) => (
              <li key={tx.id} className="waiting-row">
                <span className="waiting-main">
                  <Money cents={tx.amount} />
                  <span className="muted">{formatDate(tx.date)}</span>
                </span>
                <button type="button" className="button button-small" onClick={() => setAllocating(tx)}>{t('allocate.button')}</button>
              </li>
            ))}
          </ul>
        </div>
      )}

      <h3 className="bucket-h">{t('bucket.history', { month: monthName(window.cycleStart) })}</h3>
      {history.length === 0 && view.carried === 0 ? (
        <p className="muted">{t('bucket.nothingYet')}</p>
      ) : (
        <ul className="rows">
          {history.map((h) => (
            <li key={h.key}>
              <button type="button" className="row-button tx-row" onClick={h.onClick}>
                <span className="row-main">
                  <span className="row-title tx-desc">{h.title}</span>
                  <span className="row-sub">{formatDate(h.date)} · {h.sub}</span>
                </span>
                <span className="row-end"><Money cents={h.amount} plusSign className="row-amount tx-amount" /></span>
              </button>
            </li>
          ))}
          {view.carried > 0 && (
            <li className="row-static split-row">
              <span className="muted">{t('bucket.carried')}</span>
              <Money cents={view.carried} plusSign />
            </li>
          )}
        </ul>
      )}

      {detail.notCounted.length > 0 && (
        <>
          <h3 className="bucket-h">{t('bucket.notCounted')}</h3>
          <p className="hint">{t('bucket.notCountedHint', { name: accountName(accountId!) })}</p>
          <ul className="rows">
            {detail.notCounted.map((tx) => (
              <li key={tx.id}>
                <button type="button" className="row-button tx-row" onClick={() => setOpen(tx)}>
                  <span className="row-main">
                    <span className="row-title tx-desc">{tx.descriptionRaw || t('tx.noDescription')}</span>
                    <span className="row-sub">{formatDate(tx.date)}</span>
                  </span>
                  <span className="row-end"><Money cents={tx.amount} plusSign className="row-amount tx-amount" /></span>
                </button>
              </li>
            ))}
          </ul>
        </>
      )}

      <div className="row">
        {onEdit && <button type="button" className="button" onClick={onEdit}>{t('common.edit')}</button>}
        <button type="button" className="button button-quiet" onClick={onClose}>{t('common.close')}</button>
      </div>
    </Dialog>
  );
}
