import { useMemo, useState } from 'react';
import { bucketDetail, type BucketWindow } from '../../domain/buckets';
import { currentMonth, formatDate } from '../../domain/dates';
import type { Transaction } from '../../domain/types';
import { monthName, t } from '../../i18n';
import { Dialog } from '../components/Dialog';
import { Money } from '../components/Money';
import { useBuckets, useBudgetInput, useSettings, useStore } from '../hooks';
import { TransactionDialog } from './TransactionsPage';

/**
 * One provision or trip: what it should hold now (planned since its cycle
 * began, less what was paid from it), how much of that the provisions
 * account covers, and the bills paid from it (D-69). Each bill opens to be
 * corrected.
 */
export function BucketDialog({ name, window, onEdit, onClose }: { name: string; window: BucketWindow; onEdit?: () => void; onClose: () => void }) {
  const input = useBudgetInput();
  const settings = useSettings();
  const accounts = useStore('accounts');
  const summary = useBuckets();
  const [open, setOpen] = useState<Transaction | null>(null);
  const month = currentMonth();
  const view = summary.views.get(window.categoryId);
  const detail = useMemo(() => bucketDetail(input, month, window), [input, month, window]);
  const account = accounts.find((a) => a.id === settings.provisionsAccountId);
  const accountName = (id: string) => accounts.find((a) => a.id === id)?.name ?? '?';

  if (open) return <TransactionDialog tx={open} onClose={() => setOpen(null)} />;

  const paid = detail.flatMap((m) => m.spending);
  return (
    <Dialog open title={name} onClose={onClose} wide>
      {view && (
        <>
          <div className="bucket-head">
            <span className="muted">{view.tracked ? t('bucket.level') : t('bucket.plannedIn')}</span>
            <strong><Money cents={view.level} /></strong>
            {view.target > 0 && <span className="muted">{t('bucket.ofTarget')} <Money cents={view.target} /></span>}
          </div>
          <ul className="plain-list move-list">
            <li className="split-row"><span>{t('bucket.plannedSince', { month: monthName(window.cycleStart) })}</span><Money cents={view.planned} /></li>
            {view.spent > 0 && <li className="split-row"><span>{t('bucket.paidOut')}</span><Money cents={-view.spent} /></li>}
            <li className="split-row"><strong>{t('bucket.shouldHold')}</strong><strong><Money cents={view.claim} /></strong></li>
            {view.tracked && account && (
              <li className="split-row">
                <span>{view.toMove > 0 ? t('bucket.coveredShort', { name: account.name }) : t('bucket.covered', { name: account.name })}</span>
                {view.toMove > 0 ? <strong className="bad"><Money cents={view.toMove} /></strong> : <span>✓</span>}
              </li>
            )}
          </ul>
        </>
      )}
      {!settings.provisionsAccountId && <p className="notice">{t('bucket.noAccount')}</p>}

      <h3 className="bucket-h">{t('bucket.paidList')}</h3>
      {paid.length === 0 ? (
        <p className="muted">{t('bucket.nothingPaid')}</p>
      ) : (
        <ul className="rows">
          {paid.map(({ tx, amount }) => (
            <li key={`${tx.id}-${amount}`}>
              <button type="button" className="row-button tx-row" onClick={() => setOpen(tx)}>
                <span className="row-main">
                  <span className="row-title tx-desc">{tx.descriptionRaw || t('tx.noDescription')}</span>
                  <span className="row-sub">{formatDate(tx.date)} · {accountName(tx.accountId)}</span>
                </span>
                <span className="row-end"><Money cents={amount} plusSign className="row-amount tx-amount" /></span>
              </button>
            </li>
          ))}
        </ul>
      )}
      <p className="hint">{t('bucket.how')}</p>

      <div className="row">
        {onEdit && <button type="button" className="button" onClick={onEdit}>{t('common.edit')}</button>}
        <button type="button" className="button button-quiet" onClick={onClose}>{t('common.close')}</button>
      </div>
    </Dialog>
  );
}
