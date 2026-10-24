import { useMemo } from 'react';
import { formatDate, monthOf } from '../../domain/dates';
import type { Allocation, MonthKey, Transaction } from '../../domain/types';
import { formatMoney } from '../../domain/money';
import { monthName, t, type MessageKey } from '../../i18n';
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
export function CategoryTransactions({ categoryId, month, onOpen }: { categoryId: string; month: MonthKey | readonly MonthKey[]; onOpen: (tx: Transaction) => void }) {
  const months = useMemo(() => new Set(typeof month === 'string' ? [month] : month), [month]);
  const many = typeof month !== 'string';
  const allocations = useStore('allocations');
  const transactions = useStore('transactions');
  const accounts = useStore('accounts');
  const rows = useMemo(() => {
    const byId = new Map(transactions.map((x) => [x.id, x]));
    return allocations
      .filter((a) => a.targetId === categoryId && a.targetType !== 'transfer')
      .map((a) => ({ a, tx: byId.get(a.transactionId) }))
      .filter((r): r is { a: Allocation; tx: Transaction } => !!r.tx && months.has(monthOf(r.tx.date)))
      .sort((x, y) => y.tx.date.localeCompare(x.tx.date));
  }, [allocations, transactions, categoryId, months]);
  const auto = rows.filter((r) => r.a.decidedBy !== 'user' && !r.a.reason.startsWith('Accepted:')).length;
  const accountName = (id: string) => accounts.find((x) => x.id === id)?.name ?? '?';
  return (
    <section className="cat-tx" aria-labelledby={`ct-${categoryId}`}>
      <h3 id={`ct-${categoryId}`} className="plan-h">{many ? t('catTx.titleAll', { n: rows.length }) : t('catTx.title', { n: rows.length })}</h3>
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
            {rows.map(({ a, tx }, i) => (
              <li key={a.id}>
                {many && (i === 0 || monthOf(rows[i - 1]!.tx.date) !== monthOf(tx.date)) && (
                  <p className="month-sep">
                    {t('catTx.monthTotal', { month: monthName(monthOf(tx.date)), amount: formatMoney(rows.filter((r) => monthOf(r.tx.date) === monthOf(tx.date)).reduce((s, r) => s + r.a.amount, 0)) })}
                  </p>
                )}
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
