import { useMemo } from 'react';
import { formatDate, monthOf } from '../../domain/dates';
import type { Allocation, MonthKey, Transaction } from '../../domain/types';
import { t, type MessageKey } from '../../i18n';
import { useStore } from '../hooks';
import { href } from '../router';
import { Money } from './Money';

/** Who filed it: you, a rule, your history, Claude, or an automatic transfer match (D-85). */
export function filedByLabel(a: Allocation): string {
  if (a.decidedBy === 'user' || a.reason.startsWith('Accepted:')) return t('filedBy.you');
  return t(`filedBy.${a.decidedBy}` as MessageKey);
}

/**
 * The transactions filed under one category in one month, with who filed each
 * one, so the budget line can be checked (D-85). A tap opens the transaction
 * to correct it.
 */
export function CategoryTransactions({ categoryId, month, onOpen }: { categoryId: string; month: MonthKey; onOpen: (tx: Transaction) => void }) {
  const allocations = useStore('allocations');
  const transactions = useStore('transactions');
  const accounts = useStore('accounts');
  const rows = useMemo(() => {
    const byId = new Map(transactions.map((x) => [x.id, x]));
    return allocations
      .filter((a) => a.targetId === categoryId && a.targetType !== 'transfer')
      .map((a) => ({ a, tx: byId.get(a.transactionId) }))
      .filter((r): r is { a: Allocation; tx: Transaction } => !!r.tx && monthOf(r.tx.date) === month)
      .sort((x, y) => y.tx.date.localeCompare(x.tx.date));
  }, [allocations, transactions, categoryId, month]);
  const auto = rows.filter((r) => r.a.decidedBy !== 'user' && !r.a.reason.startsWith('Accepted:')).length;
  const accountName = (id: string) => accounts.find((x) => x.id === id)?.name ?? '?';
  return (
    <section className="cat-tx" aria-labelledby={`ct-${categoryId}`}>
      <h3 id={`ct-${categoryId}`} className="plan-h">{t('catTx.title', { n: rows.length })}</h3>
      {rows.length === 0 ? (
        <p className="muted">{t('catTx.none')}</p>
      ) : (
        <>
          {auto > 0 && (
            <p className="hint">
              {t('catTx.auto', { n: auto })} <a href={href('inbox', { tab: 'history', target: `category:${categoryId}` })}>{t('catTx.allAuto')}</a>
            </p>
          )}
          <ul className="rows">
            {rows.map(({ a, tx }) => (
              <li key={a.id}>
                <button type="button" className="row-button tx-row" onClick={() => onOpen(tx)}>
                  <span className="row-main">
                    <span className="row-title tx-desc">{tx.descriptionRaw || t('tx.noDescription')}</span>
                    <span className="row-sub">
                      {formatDate(tx.date)} · {accountName(tx.accountId)} · <span className={`filed-by filed-${a.decidedBy}`}>{filedByLabel(a)}</span>
                      {a.amount !== tx.amount && <> · {t('catTx.part')}</>}
                    </span>
                  </span>
                  <span className="row-end"><Money cents={a.amount} plusSign className="row-amount tx-amount" /></span>
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
