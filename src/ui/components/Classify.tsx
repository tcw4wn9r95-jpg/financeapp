import { useMemo, useState, type FormEvent } from 'react';
import { formatDate } from '../../domain/dates';
import { systemClock } from '../../domain/ledger';
import { formatMoneyInput, parseMoney } from '../../domain/money';
import { classify, mergeChanges, ReconcileError, similar, unclassify, type Classification, type SplitLine } from '../../domain/reconcile';
import { predictTargets, type Target } from '../../domain/learn';
import { CATEGORY_GROUPS, type Account, type Category, type Transaction } from '../../domain/types';
import { t } from '../../i18n';
import { applyChanges, ledgerView } from '../importActions';
import { applyUserChanges } from '../learnActions';
import { useFiledHistory, useStore, useVault } from '../hooks';
import { groupLabel } from '../labels';
import { Dialog } from './Dialog';
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

/** What a target is called on a button: the category, or the account with the direction. */
function targetLabel(v: string, tx: Pick<Transaction, 'amount'>, categories: readonly Category[], accounts: readonly Account[]): string {
  const d = decodeTarget(v);
  if (!d) return '';
  if (d.kind === 'transfer') {
    const a = accounts.find((x) => x.id === d.accountId);
    if (!a) return '?';
    if (a.type === 'loan' && tx.amount < 0) return t('inbox.repaymentOf', { name: a.name });
    return tx.amount < 0 ? t('inbox.transferToName', { name: a.name }) : t('inbox.transferFromName', { name: a.name });
  }
  return categories.find((c) => c.id === (d as { categoryId: string }).categoryId)?.name ?? '?';
}

const targetValue = (x: Target): string => (x.targetType === 'transfer' ? `xfer:${x.targetId}` : x.targetType === 'income' ? `inc:${x.targetId}` : `cat:${x.targetId}`);

/**
 * Choose a category, income or transfer for one transaction; optionally for
 * all identical ones. The likeliest choices are one tap away; "More" opens a
 * searchable list (D-73).
 */
export function ClassifyControl({ tx, onDone, initial = '' }: { tx: Transaction; onDone?: () => void; initial?: string }) {
  const vault = useVault();
  const notify = useToast();
  const categories = useStore('categories');
  const accounts = useStore('accounts');
  const transactions = useStore('transactions');
  const history = useFiledHistory();
  const [value, setValue] = useState(initial);
  // The loan's own category when it has one (D-48), else a category that looks like loans.
  const [repaymentPick, setRepaymentPick] = useState('');
  const guessedRepayment = categories.find((c) => !c.isIncome && /loan|pr[eê]t|cr[ée]dit|kredit/i.test(c.name))?.id ?? '';
  const [all, setAll] = useState(true);
  const [showSimilar, setShowSimilar] = useState(false);
  // Identical rows the user unticked in the list: they are left in the inbox.
  const [excluded, setExcluded] = useState<Set<string>>(() => new Set());
  const [busy, setBusy] = useState(false);
  const [splitting, setSplitting] = useState(false);
  const [picking, setPicking] = useState(false);
  const others = useMemo(() => similar(tx, transactions), [tx, transactions]);
  const events = useStore('events');

  const usable = (x: Target) =>
    x.targetType === 'transfer'
      ? accounts.some((a) => a.id === x.targetId && !a.closedAt && a.id !== tx.accountId)
      : categories.some((c) => c.id === x.targetId && !c.archivedAt && c.isIncome === (x.targetType === 'income'));
  // The likeliest choices from what was filed before (D-80): the first one is one big tap.
  const predicted = useMemo(() => predictTargets(tx, history, categories, usable, 4), [tx, history, categories, accounts]);
  const quick = predicted.map(targetValue);
  // A big first choice only when it rests on something; otherwise the usual choices, all alike.
  const best = predicted.sure ? quick[0] : undefined;
  const alternatives = predicted.sure ? quick.slice(1) : quick;
  const why = tx.suggestion && best === targetValue({ targetType: tx.suggestion.targetType, targetId: tx.suggestion.targetId }) ? tx.suggestion.reason : '';

  // A loan without its own budget line, or a trip with parts, needs one more choice before applying.
  const extraFor = (v: string) => {
    const d = decodeTarget(v);
    const target = d?.kind === 'transfer' ? accounts.find((a) => a.id === d.accountId) : undefined;
    const isRepayment = !!target && target.type === 'loan' && tx.amount < 0 && accounts.find((a) => a.id === tx.accountId)?.type !== 'loan';
    const ownCategory = target?.categoryId && categories.some((c) => c.id === target.categoryId) ? target.categoryId : '';
    const event = d?.kind === 'category' ? events.find((e) => e.categoryId === d.categoryId && e.subBudgets.length > 0) : undefined;
    return { d, target, isRepayment, ownCategory, needsPick: isRepayment && !ownCategory, event };
  };
  const cur = extraFor(value);
  const repaymentCategory = cur.ownCategory || repaymentPick || guessedRepayment;
  const [subBudget, setSubBudget] = useState('');
  const toChoice = (v: string, sb = ''): Classification | undefined => {
    const x = extraFor(v);
    if (x.isRepayment && x.d?.kind === 'transfer') {
      const cat = x.ownCategory || (v === value ? repaymentPick || guessedRepayment : '');
      return cat ? { ...x.d, categoryId: cat } : undefined;
    }
    return x.d?.kind === 'category' && x.event && sb ? { ...x.d, subBudget: sb } : x.d;
  };
  const choice = toChoice(value, subBudget);
  const picked = others.filter((o) => !excluded.has(o.id));

  async function apply(how: Classification, label: string) {
    setBusy(true);
    try {
      const view = ledgerView(vault);
      const bulk = all && picked.length > 0 && how.kind !== 'transfer';
      const targets = bulk ? [tx, ...picked] : [tx];
      const changes = mergeChanges(...targets.map((x) => classify(x, how, view, systemClock)));
      await applyUserChanges(vault, changes);
      const ids = targets.map((x) => x.id);
      const text = targets.length > 1 ? t('inbox.filedMany', { n: targets.length, label }) : t('inbox.filed', { label });
      notify(text, 'ok', {
        label: t('inbox.undo'),
        run: () => void undo(ids),
      });
      onDone?.();
    } catch (err) {
      notify(errorMessage(err), 'error');
    } finally {
      setBusy(false);
    }
  }

  async function undo(ids: string[]) {
    // Back to the inbox, one at a time so each sees the other's changes.
    for (const id of ids) {
      const fresh = vault.get('transactions', id);
      if (fresh && fresh.status !== 'locked') await applyChanges(vault, unclassify(fresh, ledgerView(vault), systemClock));
    }
    notify(t('inbox.undone'));
  }

  /** One tap: apply at once, unless one more choice is needed. */
  function choose(v: string) {
    const x = extraFor(v);
    setValue(v);
    if (x.needsPick || x.event) return;
    const how = toChoice(v);
    if (how) void apply(how, targetLabel(v, tx, categories, accounts));
  }

  function submit(e: FormEvent) {
    e.preventDefault();
    if (choice) void apply(choice, targetLabel(value, tx, categories, accounts));
  }

  const selectId = `cls-${tx.id}`;
  return (
    <>
      <div className="predict" role="group" aria-label={t('inbox.classifyLabel', { name: tx.descriptionRaw })}>
        {best && (
          <button type="button" className={`button predict-main ${value === best ? 'predict-picked' : ''}`} disabled={busy} onClick={() => choose(best)}>
            <span aria-hidden="true">✓ </span>
            {targetLabel(best, tx, categories, accounts)}
          </button>
        )}
        {why && <p className="predict-why">{why}</p>}
        <div className="quick-targets">
          {alternatives.map((v) => (
            <button key={v} type="button" className={`chip ${value === v ? 'chip-on' : ''}`} disabled={busy} onClick={() => choose(v)}>
              {targetLabel(v, tx, categories, accounts)}
            </button>
          ))}
          <button type="button" className="chip chip-more" disabled={busy} onClick={() => setPicking(true)}>
            {value && !quick.includes(value) ? targetLabel(value, tx, categories, accounts) : t('inbox.other')}
          </button>
        </div>
      </div>
      {(cur.needsPick || cur.event) && (
        <form className="classify" onSubmit={submit}>
          {cur.needsPick && (
            <>
              <label htmlFor={`${selectId}-cat`} className="visually-hidden">{t('inbox.repaymentCategory')}</label>
              <select id={`${selectId}-cat`} value={repaymentCategory} onChange={(e) => setRepaymentPick(e.target.value)} aria-describedby={`${selectId}-cat-hint`}>
                <option value="">{t('inbox.repaymentCategory')}</option>
                {categories.filter((c) => !c.isIncome).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </>
          )}
          {cur.event && (
            <>
              <label htmlFor={`${selectId}-sb`} className="visually-hidden">{t('inbox.subBudget')}</label>
              <select id={`${selectId}-sb`} value={subBudget} onChange={(e) => setSubBudget(e.target.value)}>
                <option value="">{t('inbox.subBudget')}</option>
                {cur.event.subBudgets.map((b) => <option key={b.name} value={b.name}>{b.name}</option>)}
              </select>
            </>
          )}
          <button className="button button-primary" disabled={!choice || busy}>{t('inbox.apply')}</button>
        </form>
      )}
      {cur.needsPick && <p id={`${selectId}-cat-hint`} className="hint">{t('inbox.repaymentHint', { name: cur.target!.name })}</p>}
      <div className="classify-more">
        <button type="button" className="link-button" onClick={() => setSplitting(true)} disabled={busy}>{t('inbox.split')}</button>
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
      </div>
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
      {splitting && <SplitEditor tx={tx} onClose={() => setSplitting(false)} onDone={onDone} />}
      {picking && (
        <TargetPicker
          tx={tx}
          quick={quick}
          onClose={() => setPicking(false)}
          onPick={(v) => {
            setPicking(false);
            choose(v);
          }}
        />
      )}
    </>
  );
}

/** Every category, income and own account in one searchable list; a tap picks (D-73). */
function TargetPicker({ tx, quick, onPick, onClose }: { tx: Transaction; quick: readonly string[]; onPick: (v: string) => void; onClose: () => void }) {
  const categories = useStore('categories');
  const accounts = useStore('accounts');
  const [q, setQ] = useState('');
  const needle = q.trim().toLowerCase();
  const match = (name: string) => !needle || name.toLowerCase().includes(needle);
  const expense = categories.filter((c) => !c.isIncome && !c.archivedAt).sort((a, b) => a.sortOrder - b.sortOrder);
  const income = categories.filter((c) => c.isIncome && !c.archivedAt).sort((a, b) => a.sortOrder - b.sortOrder);
  const own = accounts.filter((a) => a.id !== tx.accountId && !a.closedAt);
  const sections: { title: string; items: { v: string; name: string }[] }[] = [];
  if (!needle && quick.length) sections.push({ title: t('inbox.likely'), items: quick.map((v) => ({ v, name: targetLabel(v, tx, categories, accounts) })) });
  const incomeSection = { title: t('categories.income'), items: income.filter((c) => match(c.name)).map((c) => ({ v: `inc:${c.id}`, name: c.name })) };
  if (tx.amount > 0) sections.push(incomeSection);
  for (const g of CATEGORY_GROUPS) sections.push({ title: groupLabel(g), items: expense.filter((c) => c.groupId === g && match(c.name)).map((c) => ({ v: `cat:${c.id}`, name: c.name })) });
  if (tx.amount <= 0) sections.push(incomeSection);
  sections.push({
    title: tx.amount < 0 ? t('inbox.transferTo') : t('inbox.transferFrom'),
    items: own.filter((a) => match(a.name)).map((a) => ({ v: `xfer:${a.id}`, name: targetLabel(`xfer:${a.id}`, tx, categories, accounts) })),
  });
  const shown = sections.filter((s) => s.items.length > 0);
  return (
    <Dialog open title={t('inbox.pickTitle')} onClose={onClose}>
      <div className="picker-head">
        <span className="tx-desc">{tx.descriptionRaw}</span>
        <Money cents={tx.amount} plusSign className="tx-amount" />
      </div>
      <input
        className="picker-search"
        type="search"
        inputMode="search"
        placeholder={t('inbox.searchCategories')}
        aria-label={t('inbox.searchCategories')}
        value={q}
        onChange={(e) => setQ(e.target.value)}
      />
      {shown.length === 0 && <p className="muted">{t('inbox.noMatch')}</p>}
      {shown.map((s) => (
        <section key={s.title} className="picker-section" aria-label={s.title}>
          <h3>{s.title}</h3>
          <div className="picker-items">
            {s.items.map((it) => (
              <button key={`${s.title}-${it.v}`} type="button" className="picker-item" onClick={() => onPick(it.v)}>{it.name}</button>
            ))}
          </div>
        </section>
      ))}
    </Dialog>
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
