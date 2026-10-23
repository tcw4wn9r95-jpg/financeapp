import { useMemo, useState } from 'react';
import { formatDate } from '../../domain/dates';
import { systemClock } from '../../domain/ledger';
import { acceptSuggestion, byRepeats, checkStatement, inbox, lockStatement, unclassify, undoImport } from '../../domain/reconcile';
import type { ImportBatch, Statement, Transaction } from '../../domain/types';
import { t } from '../../i18n';
import { ClassifyControl, errorMessage, TxSummary } from '../components/Classify';
import { Money } from '../components/Money';
import { useToast } from '../components/Toast';
import { useDocumentTitle, useSettings, useStore, useVault } from '../hooks';
import { applyChanges, ledgerView } from '../importActions';
import { acceptProposal, applyUserChanges, askClaudeForInbox, claudeCandidates, dismissProposal, householdNames, learnInbox } from '../learnActions';
import { autoApplied, redact, ruleProposals } from '../../domain/learn';
import { ClaudeError } from '../../infra/claude';
import { Dialog } from '../components/Dialog';
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
  // Most repeated first by default, so one decision clears the most rows (D-63).
  const sort = route.query.get('sort') === 'date' ? 'date' : 'repeats';
  const showFilter = route.query.get('show') === 'suggested' || route.query.get('show') === 'new' ? route.query.get('show')! : '';
  const go = (patch: Record<string, string | undefined>) =>
    navigate('inbox', { tab: 'review', account: accountFilter || undefined, sort: sort === 'date' ? 'date' : undefined, show: showFilter || undefined, ...patch });
  const [limit, setLimit] = useState(PAGE);
  const name = useMemo(() => new Map(accounts.map((a) => [a.id, a.name])), [accounts]);
  const inAccount = items.filter((x) => !accountFilter || x.accountId === accountFilter);
  const filtered = inAccount.filter((x) => !showFilter || x.status === showFilter);
  const grouped = useMemo(() => byRepeats(filtered), [filtered]);
  const shown = sort === 'repeats' ? grouped.items : filtered;
  const suggestedCount = inAccount.filter((x) => x.status === 'suggested').length;
  // A loan without its own budget category needs the category picked by hand (D-29, D-48).
  const isLoan = (id: string) => accounts.find((a) => a.id === id)?.type === 'loan';
  const needsCategory = (id: string) => {
    const a = accounts.find((x) => x.id === id);
    return a?.type === 'loan' && !a.categoryId;
  };
  // Loan repayments need a budget category, so they are confirmed one by one.
  const suggested = shown.filter((x) => x.status === 'suggested' && !(x.suggestion?.targetType === 'transfer' && needsCategory(x.suggestion.targetId)));

  async function accept(list: Transaction[]) {
    try {
      for (const tx of list) {
        const fresh = vault.get('transactions', tx.id);
        if (fresh?.suggestion) await applyUserChanges(vault, acceptSuggestion(fresh, ledgerView(vault), systemClock));
      }
      notify(t('inbox.doneMany', { n: list.length }));
    } catch (e) {
      notify(errorMessage(e), 'error');
    }
  }

  if (items.length === 0) {
    return (
      <>
        <RuleProposalBanner />
        <p className="notice">
          ✓ {t('inbox.empty')} <a href={href('import')}>{t('inbox.importMore')}</a>
        </p>
      </>
    );
  }
  return (
    <>
      <RuleProposalBanner />
      <LearnBar />
      <div className="toolbar">
        <label className="visually-hidden" htmlFor="inbox-account">{t('tx.account')}</label>
        <select id="inbox-account" value={accountFilter} onChange={(e) => go({ account: e.target.value || undefined })}>
          <option value="">{t('tx.allAccounts')}</option>
          {accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
        </select>
        <label className="visually-hidden" htmlFor="inbox-sort">{t('inbox.sortLabel')}</label>
        <select id="inbox-sort" value={sort} onChange={(e) => go({ sort: e.target.value === 'date' ? 'date' : undefined })}>
          <option value="repeats">{t('inbox.sortRepeats')}</option>
          <option value="date">{t('inbox.sortDate')}</option>
        </select>
      </div>
      <div className="chips" role="group" aria-label={t('inbox.showLabel')}>
        {([['', t('inbox.showAll', { n: inAccount.length })], ['suggested', t('inbox.showSuggested', { n: suggestedCount })], ['new', t('inbox.showNew', { n: inAccount.length - suggestedCount })]] as const).map(([k, label]) => (
          <button key={k} type="button" className="chip" aria-pressed={showFilter === k} onClick={() => go({ show: k || undefined })}>{label}</button>
        ))}
      </div>
      {suggested.length > 1 && (
        <button type="button" className="button button-block accept-all" onClick={() => void accept(suggested)}>{t('inbox.acceptAll', { n: suggested.length })}</button>
      )}
      <p className="summary-line">{t('inbox.count', { n: shown.length })}</p>
      {shown.length === 0 && <p className="notice">{t('inbox.noneInFilter')}</p>}
      <ul className="inbox-list">
        {shown.slice(0, limit).map((tx) => (
          <li key={tx.id} className="inbox-item">
            <div className="split-row">
              <TxSummary tx={tx} accountName={name.get(tx.accountId) ?? '?'} />
              <Money cents={tx.amount} plusSign className="tx-amount" />
            </div>
            {sort === 'repeats' && (grouped.count.get(tx.id) ?? 1) > 1 && (
              <p className="repeat-count">{t('inbox.repeats', { n: grouped.count.get(tx.id)! })}</p>
            )}
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

/** "You filed X under Y three times — always do this?" (rule hardening). */
function RuleProposalBanner() {
  const vault = useVault();
  const notify = useToast();
  const examples = useStore('trainingExamples');
  const rules = useStore('rules');
  const categories = useStore('categories');
  const accounts = useStore('accounts');
  const settings = useSettings();
  const p = useMemo(() => ruleProposals(examples, rules, settings.dismissedRuleProposals)[0], [examples, rules, settings.dismissedRuleProposals]);
  if (!p) return null;
  const target =
    p.target.targetType === 'transfer' ? accounts.find((a) => a.id === p.target.targetId)?.name : categories.find((c) => c.id === p.target.targetId)?.name;
  if (!target) return null;
  return (
    <div className="card proposal" role="status">
      <p>{t('rules.proposal', { merchant: p.merchantNorm, target, n: p.count })}</p>
      <div className="row">
        <button
          type="button"
          className="button button-primary"
          onClick={() => void acceptProposal(vault, p).then(() => notify(t('rules.created')))}
        >
          {t('rules.proposalYes')}
        </button>
        <button type="button" className="button button-quiet" onClick={() => void dismissProposal(vault, p.merchantNorm)}>{t('rules.proposalNo')}</button>
      </div>
    </div>
  );
}

/** Re-run rules and history over the inbox; ask Claude about what is left. */
function LearnBar() {
  const vault = useVault();
  const notify = useToast();
  const settings = useSettings();
  const transactions = useStore('transactions');
  const rules = useStore('rules');
  const examples = useStore('trainingExamples');
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState(false);
  const candidates = useMemo(() => claudeCandidates(transactions), [transactions]);
  const aiOn = !!settings.ai?.enabled && !!settings.ai.apiKey;
  if (rules.length === 0 && examples.length === 0 && !aiOn) return null;

  async function runRules() {
    setBusy(true);
    try {
      const r = await learnInbox(vault);
      notify(t('learn.ran', { a: r.applied, s: r.suggested }));
    } catch (e) {
      notify(errorMessage(e), 'error');
    }
    setBusy(false);
  }

  async function ask() {
    setPreview(false);
    setBusy(true);
    try {
      const r = await askClaudeForInbox(vault, candidates);
      notify(t('learn.claudeDone', { a: r.applied, s: r.suggested }));
    } catch (e) {
      notify(e instanceof ClaudeError ? t(`learn.err.${e.code}`) : t('common.unexpectedError'), 'error');
    }
    setBusy(false);
  }

  return (
    <div className="row learn-bar">
      {(rules.length > 0 || examples.length > 0) && (
        <button type="button" className="button" disabled={busy} onClick={() => void runRules()}>{t('learn.run')}</button>
      )}
      {aiOn && candidates.length > 0 && (
        <button type="button" className="button" disabled={busy} onClick={() => setPreview(true)}>
          {busy ? t('learn.asking') : t('learn.ask', { n: candidates.length })}
        </button>
      )}
      <Dialog open={preview} title={t('learn.previewTitle')} onClose={() => setPreview(false)}>
        <p>{t('learn.previewIntro', { n: candidates.length })}</p>
        <ul className="plain-list preview-list">
          {redact(candidates, householdNames(vault)).map((x) => (
            <li key={x.ref} className="split-row">
              <span>{x.merchant}{x.country && ` · ${x.country}`}</span>
              <span className="muted">{x.date} · {x.amount.toFixed(2).replace('.', ',')}</span>
            </li>
          ))}
        </ul>
        <p className="hint">{t('learn.previewHint')}</p>
        <div className="row">
          <button type="button" className="button button-primary" onClick={() => void ask()}>{t('learn.send')}</button>
          <button type="button" className="button button-quiet" onClick={() => setPreview(false)}>{t('common.cancel')}</button>
        </div>
      </Dialog>
    </div>
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
                <span className="badge">{t('statements.lockedOn', { date: formatDate(s.lockedAt.slice(0, 10)) })}</span>
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
  if (sorted.length === 0) return <><AutoLog /><p className="notice">{t('history.none')}</p></>;

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
    <>
    <AutoLog />
    <h2 className="section-title">{t('history.imports')}</h2>
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
    </>
  );
}

const LOG_PAGE = 30;

/** Decisions made by rules, history or Claude, with undo (back to the inbox). */
function AutoLog() {
  const vault = useVault();
  const notify = useToast();
  const allocations = useStore('allocations');
  const transactions = useStore('transactions');
  const categories = useStore('categories');
  const accounts = useStore('accounts');
  const [limit, setLimit] = useState(LOG_PAGE);
  const log = useMemo(() => autoApplied(allocations, transactions), [allocations, transactions]);
  if (log.length === 0) return null;
  const by = { rule: t('learn.by.rule'), history: t('learn.by.history'), ai: t('learn.by.ai'), user: '' };

  async function undo(tx: Transaction) {
    try {
      await applyChanges(vault, unclassify(tx, ledgerView(vault), systemClock));
      notify(t('learn.undone'));
    } catch (e) {
      notify(errorMessage(e), 'error');
    }
  }

  return (
    <>
      <h2 className="section-title">{t('learn.logTitle')}</h2>
      <ul className="rows">
        {log.slice(0, limit).map(({ allocation: a, transaction: tx }) => (
          <li key={a.id} className="row-item">
            <span className="row-main">
              <span className="row-title">{tx.descriptionRaw}</span>
              <span className="row-sub">
                {formatDate(tx.date)} · {accounts.find((x) => x.id === tx.accountId)?.name ?? '?'} → <strong>{categories.find((c) => c.id === a.targetId)?.name ?? '?'}</strong>
              </span>
              <span className="row-sub">{a.reason.startsWith(`${by[a.decidedBy]}:`) ? a.reason : `${by[a.decidedBy]} · ${a.reason}`} · {Math.round(a.confidence * 100)} %</span>
            </span>
            <span className="row-end">
              <Money cents={tx.amount} plusSign />
              <button type="button" className="button button-quiet button-small" onClick={() => void undo(tx)}>{t('learn.undo')}</button>
            </span>
          </li>
        ))}
      </ul>
      {log.length > limit && <button type="button" className="button" onClick={() => setLimit(limit + LOG_PAGE)}>{t('inbox.showMore', { n: log.length - limit })}</button>}
    </>
  );
}
