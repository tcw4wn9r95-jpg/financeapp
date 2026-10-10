import { useMemo, useState } from 'react';
import { formatDate } from '../../domain/dates';
import { systemClock } from '../../domain/ledger';
import { acceptSuggestion, checkStatement, inbox, lockStatement, undoImport } from '../../domain/reconcile';
import type { ImportBatch, Statement, Transaction } from '../../domain/types';
import { t } from '../../i18n';
import { ClassifyControl, errorMessage, TxSummary } from '../components/Classify';
import { SelectField } from '../components/fields';
import { Money } from '../components/Money';
import { useToast } from '../components/Toast';
import { useDocumentTitle, useStore, useVault } from '../hooks';
import { applyChanges, ledgerView } from '../importActions';
import { href, navigate, useRoute } from '../router';

const PAGE = 40;

export function InboxPage() {
  useDocumentTitle(t('nav.inbox'));
  const route = useRoute();
  const tab = route.query.get('tab') ?? 'review';
  const transactions = useStore('transactions');
  const open = inbox(transactions);
  const tabs = [
    ['review', t('inbox.tab.review', { n: open.length })],
    ['statements', t('inbox.tab.statements')],
    ['history', t('inbox.tab.history')],
  ] as const;
  return (
    <>
      <h1>{t('nav.inbox')}</h1>
      <nav className="tabs" aria-label={t('inbox.tabsLabel')}>
        {tabs.map(([k, label]) => (
          <a key={k} href={href('inbox', { tab: k })} aria-current={tab === k ? 'page' : undefined}>{label}</a>
        ))}
      </nav>
      {tab === 'statements' ? <Statements /> : tab === 'history' ? <History /> : <Review items={open} />}
    </>
  );
}

function Review({ items }: { items: Transaction[] }) {
  const vault = useVault();
  const notify = useToast();
  const accounts = useStore('accounts');
  const route = useRoute();
  const accountFilter = route.query.get('account') ?? '';
  const [limit, setLimit] = useState(PAGE);
  const name = useMemo(() => new Map(accounts.map((a) => [a.id, a.name])), [accounts]);
  const shown = items.filter((x) => !accountFilter || x.accountId === accountFilter);
  const isLoan = (id: string) => accounts.find((a) => a.id === id)?.type === 'loan';
  // Loan repayments need a budget category, so they are confirmed one by one.
  const suggested = shown.filter((x) => x.status === 'suggested' && !(x.suggestion?.targetType === 'transfer' && isLoan(x.suggestion.targetId)));

  async function accept(list: Transaction[]) {
    try {
      for (const tx of list) {
        const fresh = vault.get('transactions', tx.id);
        if (fresh?.suggestion) await applyChanges(vault, acceptSuggestion(fresh, ledgerView(vault), systemClock));
      }
      notify(t('inbox.doneMany', { n: list.length }));
    } catch (e) {
      notify(errorMessage(e), 'error');
    }
  }

  if (items.length === 0) {
    return (
      <p className="notice">
        ✓ {t('inbox.empty')} <a href={href('import')}>{t('inbox.importMore')}</a>
      </p>
    );
  }
  return (
    <>
      <div className="filters">
        <SelectField label={t('tx.account')} value={accountFilter} onChange={(e) => navigate('inbox', { tab: 'review', account: e.target.value || undefined })}>
          <option value="">{t('tx.allAccounts')}</option>
          {accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
        </SelectField>
        {suggested.length > 1 && (
          <button type="button" className="button" onClick={() => void accept(suggested)}>{t('inbox.acceptAll', { n: suggested.length })}</button>
        )}
      </div>
      <p className="summary-line">{t('inbox.count', { n: shown.length })}</p>
      <ul className="inbox-list">
        {shown.slice(0, limit).map((tx) => (
          <li key={tx.id} className="inbox-item">
            <div className="split-row">
              <TxSummary tx={tx} accountName={name.get(tx.accountId) ?? '?'} />
              <Money cents={tx.amount} plusSign className="tx-amount" />
            </div>
            {tx.suggestion && (() => {
              const sg = tx.suggestion;
              const target = name.get(sg.targetId) ?? '?';
              const label =
                sg.targetType === 'transfer' && isLoan(sg.targetId) ? t('inbox.repaymentOf', { name: target })
                : sg.targetType === 'transfer' ? (tx.amount < 0 ? t('inbox.transferToName', { name: target }) : t('inbox.transferFromName', { name: target }))
                : vault.get('categories', sg.targetId)?.name ?? '?';
              return (
                <p className="suggestion">
                  <span>
                    <strong>{t('inbox.suggested')}</strong> {label}
                    {' · '}
                    <span className="muted">{sg.reason !== label ? `${sg.reason} · ` : ''}{Math.round(sg.confidence * 100)}%</span>
                  </span>
                  {!(sg.targetType === 'transfer' && isLoan(sg.targetId)) && (
                    <button type="button" className="button" onClick={() => void accept([tx])}>{t('inbox.accept')}</button>
                  )}
                </p>
              );
            })()}
            <ClassifyControl
              tx={tx}
              initial={tx.suggestion?.targetType === 'transfer' && isLoan(tx.suggestion.targetId) ? `xfer:${tx.suggestion.targetId}` : ''}
            />
          </li>
        ))}
      </ul>
      {shown.length > limit && (
        <button type="button" className="button" onClick={() => setLimit(limit + PAGE)}>{t('inbox.showMore', { n: shown.length - limit })}</button>
      )}
    </>
  );
}

function Statements() {
  const vault = useVault();
  const notify = useToast();
  const statements = useStore('statements');
  const accounts = useStore('accounts');
  const transactions = useStore('transactions');
  const allocations = useStore('allocations');
  const view = { accounts, transactions, allocations };
  const sorted = [...statements].sort((a, b) => b.periodEnd.localeCompare(a.periodEnd));
  if (sorted.length === 0) return <p className="notice">{t('statements.none')} <a href={href('import')}>{t('nav.import')}</a></p>;

  async function lock(s: Statement) {
    try {
      await applyChanges(vault, lockStatement(s, ledgerView(vault), systemClock));
      notify(t('statements.locked'));
    } catch (e) {
      notify(errorMessage(e), 'error');
    }
  }

  return (
    <ul className="card-list">
      {sorted.map((s) => {
        const account = accounts.find((a) => a.id === s.accountId);
        const check = checkStatement(s, view);
        const settlementTx = s.settlement?.transactionId ? transactions.find((x) => x.id === s.settlement!.transactionId) : undefined;
        return (
          <li key={s.id} className="card">
            <div className="split-row">
              <h3>{account?.name ?? '?'}</h3>
              <span className="muted">{formatDate(s.periodStart)} – {formatDate(s.periodEnd)}</span>
            </div>
            <ul className="plain-list">
              {s.closingBalance !== undefined && (
                <li className="split-row"><span>{t('statements.closing')}</span><Money cents={s.closingBalance} /></li>
              )}
              <li className="split-row"><span>{t('statements.computed')}</span><Money cents={check.computed} /></li>
              <li className="split-row">
                <span>{t('statements.status')}</span>
                {check.difference === null ? (
                  <span className="muted">{t('statements.noClosing')}</span>
                ) : check.difference === 0 ? (
                  <strong className="ok">✓ {t('statements.matches')}</strong>
                ) : (
                  <strong className="bad">⚠ {t('statements.differs')} <Money cents={check.difference} plusSign /></strong>
                )}
              </li>
              {check.openItems > 0 && (
                <li className="split-row">
                  <span>{t('statements.open')}</span>
                  <a href={href('inbox', { tab: 'review', account: s.accountId })}>{t('statements.openN', { n: check.openItems })}</a>
                </li>
              )}
              {s.settlement && (
                <li className="split-row">
                  <span>{t('statements.cardDebit', { date: formatDate(s.settlement.date) })} <Money cents={s.settlement.amount} /></span>
                  {settlementTx ? <strong className="ok">✓ {t('statements.settled', { date: formatDate(settlementTx.date) })}</strong> : <span className="muted">{t('statements.waiting')}</span>}
                </li>
              )}
            </ul>
            <div className="row">
              {s.lockedAt ? (
                <span className="badge">🔒 {t('statements.lockedOn', { date: formatDate(s.lockedAt.slice(0, 10)) })}</span>
              ) : (
                <button type="button" className="button" disabled={!check.canLock} onClick={() => void lock(s)}>{t('statements.lock')}</button>
              )}
              {!s.lockedAt && !check.canLock && <span className="hint">{t('statements.lockHint')}</span>}
            </div>
          </li>
        );
      })}
    </ul>
  );
}

function History() {
  const vault = useVault();
  const notify = useToast();
  const batches = useStore('importBatches');
  const accounts = useStore('accounts');
  const [confirm, setConfirm] = useState<string | null>(null);
  const sorted = [...batches].sort((a, b) => b.importedAt.localeCompare(a.importedAt));
  if (sorted.length === 0) return <p className="notice">{t('history.none')}</p>;

  async function undo(b: ImportBatch) {
    try {
      await applyChanges(vault, undoImport(b, { ...ledgerView(vault) }, systemClock));
      notify(t('history.undone'));
      setConfirm(null);
    } catch (e) {
      notify(errorMessage(e), 'error');
    }
  }

  return (
    <ul className="card-list">
      {sorted.map((b) => (
        <li key={b.id} className="card">
          <div className="split-row">
            <h3 className="file-name">{b.fileName}</h3>
            <span className="muted">{formatDate(b.importedAt.slice(0, 10))}</span>
          </div>
          <p className="muted">
            {b.accountIds.map((id) => accounts.find((a) => a.id === id)?.name ?? '?').join(', ')} ·{' '}
            {t('history.summary', { n: b.report.newCount, d: b.report.duplicateCount, s: b.report.skipped.length })}
          </p>
          {confirm === b.id ? (
            <p className="notice notice-warn" role="alert">
              {t('history.confirm')}{' '}
              <button type="button" className="button button-danger" onClick={() => void undo(b)}>{t('history.undo')}</button>{' '}
              <button type="button" className="button button-quiet" onClick={() => setConfirm(null)}>{t('common.cancel')}</button>
            </p>
          ) : (
            <button type="button" className="button button-quiet" onClick={() => setConfirm(b.id)}>{t('history.undo')}</button>
          )}
        </li>
      ))}
    </ul>
  );
}
