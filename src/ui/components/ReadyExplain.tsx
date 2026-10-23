import { useMemo, useState, type ReactNode } from 'react';
import { explainReady, isOnBudget, looseTransfers, type LooseTransfer } from '../../domain/budget';
import { formatDate } from '../../domain/dates';
import type { MonthKey, Transaction } from '../../domain/types';
import { monthName, t, type MessageKey } from '../../i18n';
import { useBudgetInput, useStore } from '../hooks';
import { TransactionDialog } from '../pages/TransactionsPage';
import { href } from '../router';
import { Dialog } from './Dialog';
import { Money } from './Money';

/** One line of the sum, with its detail folded away. */
function Part({ label, cents, hint, children }: { label: string; cents: number; hint?: ReactNode; children?: ReactNode }) {
  const head = (
    <span className="split-row">
      <span>{label}</span>
      <Money cents={cents} plusSign />
    </span>
  );
  return (
    <li>
      {children ? (
        <details>
          <summary>{head}</summary>
          <div className="explain-detail">{children}</div>
        </details>
      ) : (
        head
      )}
      {hint && <p className="hint">{hint}</p>}
    </li>
  );
}

/**
 * Where Ready to assign comes from (D-85): everything that came into the
 * budget since it starts, less what was given to categories, line by line,
 * with a cross-check against the money in the accounts.
 */
export function ReadyExplainDialog({ month, onClose }: { month: MonthKey; onClose: () => void }) {
  const input = useBudgetInput();
  const categories = useStore('categories');
  const accounts = useStore('accounts');
  const [open, setOpen] = useState<Transaction | null>(null);
  const x = useMemo(() => explainReady(input, month), [input, month]);
  const loose = useMemo(() => looseTransfers(input, month), [input, month]);
  if (open) return <TransactionDialog tx={open} onClose={() => setOpen(null)} />;

  const catName = (id: string) => categories.find((c) => c.id === id)?.name ?? '?';
  const accountName = (id: string) => accounts.find((a) => a.id === id)?.name ?? '?';
  const rows = (list: LooseTransfer[]) => (
    <ul className="rows">
      {list.map(({ tx, amount }) => (
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
  );

  return (
    <Dialog open title={t('explain.title', { month: monthName(month) })} onClose={onClose} wide>
      {!x ? (
        <p className="muted">{t('explain.none')}</p>
      ) : (
        <>
          <p className="hint">{t('explain.intro', { start: monthName(input.startMonth), month: monthName(month) })}</p>
          <ul className="plain-list move-list explain-list">
            <Part label={t('explain.opening')} cents={x.opening}>
              <ul className="plain-list">
                {accounts.filter((a) => isOnBudget(a) && a.openingBalance !== 0).map((a) => (
                  <li key={a.id} className="split-row"><span>{a.name}</span><Money cents={a.openingBalance} /></li>
                ))}
              </ul>
            </Part>
            <Part label={t('explain.income')} cents={x.income}>
              <ul className="plain-list">
                {[...x.incomeByCategory].sort((a, b) => b[1] - a[1]).map(([id, v]) => (
                  <li key={id} className="split-row"><span>{catName(id)}</span><Money cents={v} /></li>
                ))}
              </ul>
            </Part>
            <Part label={t('explain.assigned')} cents={x.assigned} hint={t('explain.assignedHint')}>
              <ul className="plain-list">
                {[...x.assignedByGroup].filter(([, v]) => v !== 0).sort((a, b) => a[1] - b[1]).map(([g, v]) => (
                  <li key={g} className="split-row"><span>{t(`group.${g}` as MessageKey)}</span><Money cents={v} /></li>
                ))}
              </ul>
            </Part>
            {x.returned !== 0 && <Part label={t('explain.returned')} cents={x.returned} hint={t('explain.returnedHint')} />}
            {x.unfiled !== 0 && (
              <Part
                label={t('explain.unfiled')}
                cents={x.unfiled}
                hint={<>{t('explain.unfiledHint')} <a href={href('inbox')} onClick={onClose}>{t('explain.toInbox')}</a></>}
              />
            )}
            {x.transit !== 0 && (
              <Part label={t('explain.transit')} cents={x.transit} hint={t('explain.transitHint')}>
                {rows(loose.filter((r) => r.kind === 'transit'))}
              </Part>
            )}
            {x.offBudget !== 0 && (
              <Part label={t('explain.offBudget')} cents={x.offBudget} hint={t('explain.offBudgetHint')}>
                {rows(loose.filter((r) => r.kind === 'offBudget'))}
              </Part>
            )}
            <li className="split-row explain-total"><strong>{t('rta.label')}</strong><strong><Money cents={x.readyToAssign} /></strong></li>
          </ul>

          <h3 className="bucket-h">{t('explain.check')}</h3>
          <ul className="plain-list move-list">
            <li className="split-row"><span>{t('explain.cash', { month: monthName(month) })}</span><Money cents={x.cash} /></li>
            <li className="split-row"><span>{t('explain.inCategories')}</span><Money cents={-x.inCategories} /></li>
            {x.held !== 0 && <li className="split-row"><span>{t('explain.held')}</span><Money cents={-x.held} /></li>}
            <li className="split-row explain-total"><strong>{t('rta.label')}</strong><strong><Money cents={x.cash - x.inCategories - x.held} /></strong></li>
          </ul>
          <p className="hint">{t('explain.checkHint')}</p>
        </>
      )}
      <div className="row">
        <button type="button" className="button button-quiet" onClick={onClose}>{t('common.close')}</button>
      </div>
    </Dialog>
  );
}
