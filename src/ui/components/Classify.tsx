import { useMemo, useState, type FormEvent } from 'react';
import { formatDate } from '../../domain/dates';
import { systemClock } from '../../domain/ledger';
import { formatMoneyInput, parseMoney } from '../../domain/money';
import { classify, mergeChanges, ReconcileError, similar, type Classification, type SplitLine } from '../../domain/reconcile';
import { CATEGORY_GROUPS, type Account, type Category, type Transaction } from '../../domain/types';
import { t } from '../../i18n';
import { ledgerView } from '../importActions';
import { applyUserChanges } from '../learnActions';
import { useStore, useVault } from '../hooks';
import { groupLabel } from '../labels';
import { Money } from './Money';
import { useToast } from './Toast';

/** Encode a classification choice as one <select> value. */
export function encodeTarget(c: Classification | undefined): string {
  if (!c) return '';
  if (c.kind === 'transfer') return `xfer:${c.accountId}`;
  if (c.kind === 'income') return `inc:${c.categoryId}`;
  if (c.kind === 'category') return `cat:${c.categoryId}`;
  return '';
}

export function decodeTarget(v: string): Classification | undefined {
  const [kind, id] = v.split(':');
  if (!id) return undefined;
  if (kind === 'xfer') return { kind: 'transfer', accountId: id };
  if (kind === 'inc') return { kind: 'income', categoryId: id };
  if (kind === 'cat') return { kind: 'category', categoryId: id };
  return undefined;
}

export function TargetOptions({ tx, categories, accounts, transfers = true }: { tx: Pick<Transaction, 'accountId' | 'amount'>; categories: readonly Category[]; accounts: readonly Account[]; transfers?: boolean }) {
  const expense = categories.filter((c) => !c.isIncome && !c.archivedAt);
  const income = categories.filter((c) => c.isIncome).sort((a, b) => a.sortOrder - b.sortOrder);
  const incomeFirst = tx.amount > 0;
  const incomeGroup = income.length > 0 && (
    <optgroup label={t('categories.income')}>
      {income.map((c) => <option key={c.id} value={`inc:${c.id}`}>{c.name}</option>)}
    </optgroup>
  );
  return (
    <>
      <option value="">{t('common.choose')}</option>
      {incomeFirst && incomeGroup}
      {CATEGORY_GROUPS.map((g) => {
        const cs = expense.filter((c) => c.groupId === g).sort((a, b) => a.sortOrder - b.sortOrder);
        return cs.length ? (
          <optgroup key={g} label={groupLabel(g)}>
            {cs.map((c) => <option key={c.id} value={`cat:${c.id}`}>{c.name}</option>)}
          </optgroup>
        ) : null;
      })}
      {!incomeFirst && incomeGroup}
      {transfers && (
        <optgroup label={tx.amount < 0 ? t('inbox.transferTo') : t('inbox.transferFrom')}>
          {accounts.filter((a) => a.id !== tx.accountId && !a.closedAt).map((a) => <option key={a.id} value={`xfer:${a.id}`}>{a.name}</option>)}
        </optgroup>
      )}
    </>
  );
}

export function errorMessage(e: unknown): string {
  if (e instanceof ReconcileError) return t(`reconcile.${e.code}`);
  return t('common.unexpectedError');
}

/** Choose a category, income or transfer for one transaction; optionally for all similar ones. */
export function ClassifyControl({ tx, onDone, initial = '' }: { tx: Transaction; onDone?: () => void; initial?: string }) {
  const vault = useVault();
  const notify = useToast();
  const categories = useStore('categories');
  const accounts = useStore('accounts');
  const transactions = useStore('transactions');
  const [value, setValue] = useState(initial);
  // The loan's own category when it has one (D-48), else a category that looks like loans.
  const [repaymentPick, setRepaymentPick] = useState('');
  const guessedRepayment = categories.find((c) => !c.isIncome && /loan|pr[eê]t|cr[ée]dit|kredit/i.test(c.name))?.id ?? '';
  const [all, setAll] = useState(true);
  const [showSimilar, setShowSimilar] = useState(false);
  // Similar rows the user unticked in the list: they are left in the inbox.
  const [excluded, setExcluded] = useState<Set<string>>(() => new Set());
  const [busy, setBusy] = useState(false);
  const [splitting, setSplitting] = useState(false);
  const others = useMemo(() => similar(tx, transactions), [tx, transactions]);
  const decoded = decodeTarget(value);
  const target = decoded?.kind === 'transfer' ? accounts.find((a) => a.id === decoded.accountId) : undefined;
  // Paying an off-budget loan from a budget account: ask which budget category it counts in.
  const isRepayment = !!target && target.type === 'loan' && tx.amount < 0 && accounts.find((a) => a.id === tx.accountId)?.type !== 'loan';
  const repaymentCategory = repaymentPick || target?.categoryId || guessedRepayment;
  const setRepaymentCategory = setRepaymentPick;
  const events = useStore('events');
  const event = decoded?.kind === 'category' ? events.find((e) => e.categoryId === decoded.categoryId && e.subBudgets.length > 0) : undefined;
  const [subBudget, setSubBudget] = useState('');
  const choice: Classification | undefined =
    isRepayment && decoded?.kind === 'transfer'
      ? repaymentCategory ? { ...decoded, categoryId: repaymentCategory } : undefined
      : decoded?.kind === 'category' && event && subBudget ? { ...decoded, subBudget } : decoded;
  const picked = others.filter((o) => !excluded.has(o.id));
  const bulk = all && picked.length > 0 && choice && choice.kind !== 'transfer';

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!choice) return;
    setBusy(true);
    try {
      const view = ledgerView(vault);
      const targets = bulk ? [tx, ...picked] : [tx];
      const changes = mergeChanges(...targets.map((x) => classify(x, choice, view, systemClock)));
      await applyUserChanges(vault, changes);
      notify(targets.length > 1 ? t('inbox.doneMany', { n: targets.length }) : t('inbox.done'));
      onDone?.();
    } catch (err) {
      notify(errorMessage(err), 'error');
      setBusy(false);
    }
  }

  const selectId = `cls-${tx.id}`;
  return (
    <>
      <form className="classify" onSubmit={submit}>
        <label htmlFor={selectId} className="visually-hidden">
          {t('inbox.classifyLabel', { name: tx.descriptionRaw })}
        </label>
        <select id={selectId} value={value} onChange={(e) => setValue(e.target.value)}>
          <TargetOptions tx={tx} categories={categories} accounts={accounts} />
        </select>
        {isRepayment && (
          <>
            <label htmlFor={`${selectId}-cat`} className="visually-hidden">{t('inbox.repaymentCategory')}</label>
            <select id={`${selectId}-cat`} value={repaymentCategory} onChange={(e) => setRepaymentCategory(e.target.value)} aria-describedby={`${selectId}-cat-hint`}>
              <option value="">{t('inbox.repaymentCategory')}</option>
              {categories.filter((c) => !c.isIncome).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </>
        )}
        {event && (
          <>
            <label htmlFor={`${selectId}-sb`} className="visually-hidden">{t('inbox.subBudget')}</label>
            <select id={`${selectId}-sb`} value={subBudget} onChange={(e) => setSubBudget(e.target.value)}>
              <option value="">{t('inbox.subBudget')}</option>
              {event.subBudgets.map((b) => <option key={b.name} value={b.name}>{b.name}</option>)}
            </select>
          </>
        )}
        <button className="button button-primary" disabled={!choice || busy}>{t('inbox.apply')}</button>
        <button type="button" className="button button-quiet" onClick={() => setSplitting(true)} disabled={busy}>{t('inbox.split')}</button>
        {others.length > 0 && (
          <span className="similar-toggle">
            <label className="check check-inline">
              <input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} />
              {picked.length === 1 ? t('inbox.alsoSimilarOne') : t('inbox.alsoSimilar', { n: picked.length })}
            </label>
            <button type="button" className="link-button" aria-expanded={showSimilar} aria-controls={`${selectId}-similar`} onClick={() => setShowSimilar(!showSimilar)}>
              {showSimilar ? t('inbox.hideSimilar') : t('inbox.showSimilar')}
            </button>
          </span>
        )}
      </form>
      {showSimilar && others.length > 0 && (
        <ul id={`${selectId}-similar`} className="similar-list" aria-label={t('inbox.similarList')}>
          {others.map((o) => (
            <li key={o.id}>
              <label className="check">
                <input
                  type="checkbox"
                  checked={all && !excluded.has(o.id)}
                  disabled={!all}
                  onChange={(e) => {
                    const next = new Set(excluded);
                    if (e.target.checked) next.delete(o.id);
                    else next.add(o.id);
                    setExcluded(next);
                  }}
                />
                <span className="similar-main">
                  <span className="similar-desc">{o.descriptionRaw}</span>
                  <span className="muted">{formatDate(o.date)} · {accounts.find((a) => a.id === o.accountId)?.name ?? '?'}</span>
                </span>
                <Money cents={o.amount} plusSign />
              </label>
            </li>
          ))}
        </ul>
      )}
      {isRepayment && <p id={`${selectId}-cat-hint`} className="hint">{t('inbox.repaymentHint', { name: target!.name })}</p>}
      {splitting && <SplitEditor tx={tx} onClose={() => setSplitting(false)} onDone={onDone} />}
    </>
  );
}

function SplitEditor({ tx, onClose, onDone }: { tx: Transaction; onClose: () => void; onDone?: (() => void) | undefined }) {
  const vault = useVault();
  const notify = useToast();
  const categories = useStore('categories');
  const accounts = useStore('accounts');
  const [lines, setLines] = useState([{ target: '', amount: '' }, { target: '', amount: '' }]);
  const sign = tx.amount < 0 ? -1 : 1;
  const parsed = lines.map((l) => ({ target: decodeTarget(l.target), cents: parseMoney(l.amount) }));
  const allocated = parsed.reduce((s, l) => s + (l.cents === null ? 0 : sign * Math.abs(l.cents)), 0);
  const remaining = tx.amount - allocated;
  const valid = parsed.every((l) => l.target && l.cents !== null && l.cents !== 0) && remaining === 0;

  async function save(e: FormEvent) {
    e.preventDefault();
    if (!valid) return;
    try {
      const how: Classification = {
        kind: 'split',
        lines: parsed.map((l): SplitLine => {
          const amt = sign * Math.abs(l.cents!);
          const tg = l.target!;
          return tg.kind === 'transfer' ? { kind: 'transfer', accountId: tg.accountId, amount: amt } : { kind: tg.kind as 'category' | 'income', categoryId: (tg as { categoryId: string }).categoryId, amount: amt };
        }),
      };
      await applyUserChanges(vault, classify(tx, how, ledgerView(vault), systemClock));
      notify(t('inbox.done'));
      onClose();
      onDone?.();
    } catch (err) {
      notify(errorMessage(err), 'error');
    }
  }

  return (
    <form className="split-editor" onSubmit={save}>
      <p>
        {t('inbox.splitTitle')} <Money cents={tx.amount} /> · {t('inbox.remaining')} <Money cents={remaining} />
      </p>
      {lines.map((l, i) => (
        <div className="split-line" key={i}>
          <label className="visually-hidden" htmlFor={`sp-${tx.id}-${i}-t`}>{t('inbox.splitCategory', { n: i + 1 })}</label>
          <select id={`sp-${tx.id}-${i}-t`} value={l.target} onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, target: e.target.value } : x)))}>
            <TargetOptions tx={tx} categories={categories} accounts={accounts} />
          </select>
          <label className="visually-hidden" htmlFor={`sp-${tx.id}-${i}-a`}>{t('inbox.splitAmount', { n: i + 1 })}</label>
          <input id={`sp-${tx.id}-${i}-a`} inputMode="decimal" value={l.amount} placeholder="0,00" onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, amount: e.target.value } : x)))} />
        </div>
      ))}
      <div className="row">
        <button type="button" className="button button-quiet" onClick={() => setLines([...lines, { target: '', amount: '' }])}>+ {t('inbox.addLine')}</button>
        {remaining !== 0 && lines.some((l) => !l.amount.trim()) && (
          <button
            type="button"
            className="button button-quiet"
            onClick={() => {
              const i = lines.findIndex((l) => !l.amount.trim());
              setLines(lines.map((x, j) => (j === i ? { ...x, amount: formatMoneyInput(Math.abs(remaining)) } : x)));
            }}
          >
            {t('inbox.fillRest')}
          </button>
        )}
        <button className="button button-primary" disabled={!valid}>{t('inbox.saveSplit')}</button>
        <button type="button" className="button button-quiet" onClick={onClose}>{t('common.cancel')}</button>
      </div>
      {!valid && remaining !== 0 && <p className="hint">{t('inbox.splitMustSum')}</p>}
    </form>
  );
}

/** One line of transaction facts used in the inbox and dialogs. */
export function TxSummary({ tx, accountName }: { tx: Transaction; accountName: string }) {
  return (
    <span className="tx-main">
      <span className="tx-desc">{tx.descriptionRaw || t('tx.noDescription')}</span>
      <span className="tx-meta">
        {formatDate(tx.date)} · {accountName}
        {tx.counterparty && ` · ${tx.counterparty}`}
        {tx.isMirror && <span className="tag">{t('tx.autoCreated')}</span>}
      </span>
    </span>
  );
}
