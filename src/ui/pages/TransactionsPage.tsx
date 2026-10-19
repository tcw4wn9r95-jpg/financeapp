import { useMemo, useState, type FormEvent } from 'react';
import { currentMonth, formatDate, isMonthKey, todayIso } from '../../domain/dates';
import { formatMoney } from '../../domain/money';
import { LedgerError, systemClock, transferCounterpartId, type EntryTarget, type ManualEntry } from '../../domain/ledger';
import { unclassify } from '../../domain/reconcile';
import { ClassifyControl, errorMessage, TxSummary } from '../components/Classify';
import { applyChanges, ledgerView } from '../importActions';
import { CATEGORY_GROUPS, type Id, type Transaction } from '../../domain/types';
import { t } from '../../i18n';
import { deleteEntry, saveEntry } from '../actions';
import { Dialog } from '../components/Dialog';
import { Icon } from '../components/Icon';
import { DateField, MoneyField, SelectField, TextField, useDateInput, useMoneyInput } from '../components/fields';
import { Money } from '../components/Money';
import { MonthNav } from '../components/MonthNav';
import { useToast } from '../components/Toast';
import { useDocumentTitle, useStore, useVault } from '../hooks';
import { groupLabel } from '../labels';
import { navigate, useRoute } from '../router';

type Kind = 'expense' | 'income' | 'transfer';

/** Rows are already sorted newest first; keep that order within each day. */
function groupByDate(rows: Transaction[]): [string, Transaction[]][] {
  const out = new Map<string, Transaction[]>();
  for (const r of rows) out.set(r.date, [...(out.get(r.date) ?? []), r]);
  return [...out.entries()];
}

export function TransactionsPage() {
  useDocumentTitle(t('nav.transactions'));
  const route = useRoute();
  const q = route.query;
  const month = q.get('month') && isMonthKey(q.get('month')!) ? q.get('month')! : currentMonth();
  const accountFilter = q.get('account') ?? '';
  const onlyNew = q.get('filter') === 'new';
  const setQuery = (patch: Record<string, string | undefined>) =>
    navigate('transactions', { month, account: accountFilter || undefined, filter: onlyNew ? 'new' : undefined, ...patch });

  const accounts = useStore('accounts');
  const transactions = useStore('transactions');
  const [editing, setEditing] = useState<Transaction | 'new' | null>(null);

  const accountName = useMemo(() => new Map(accounts.map((a) => [a.id, a.name])), [accounts]);

  const rows = transactions
    .filter((tx) => (onlyNew ? tx.status === 'new' || tx.status === 'suggested' : tx.date.startsWith(month)))
    .filter((tx) => !accountFilter || tx.accountId === accountFilter)
    .sort((a, b) => (a.date === b.date ? b.createdAt.localeCompare(a.createdAt) : b.date.localeCompare(a.date)));

  const inflow = rows.filter((r) => r.amount > 0).reduce((s, r) => s + r.amount, 0);
  const outflow = rows.filter((r) => r.amount < 0).reduce((s, r) => s + r.amount, 0);

  const label = useTxLabel();

  return (
    <>
      <div className="page-head">
        <h1>{t('nav.transactions')}</h1>
        <button type="button" className="button button-primary button-small" onClick={() => setEditing('new')} disabled={accounts.length === 0}>
          <Icon name="plus" size={18} />
          {t('tx.add')}
        </button>
      </div>
      {accounts.length === 0 && <p className="notice">{t('tx.needAccount')}</p>}
      {!onlyNew && <MonthNav month={month} onChange={(m) => setQuery({ month: m })} />}
      <div className="toolbar">
        <label className="visually-hidden" htmlFor="tx-account">{t('tx.account')}</label>
        <select id="tx-account" value={accountFilter} onChange={(e) => setQuery({ account: e.target.value || undefined })}>
          <option value="">{t('tx.allAccounts')}</option>
          {accounts.map((a) => (
            <option key={a.id} value={a.id}>{a.name}</option>
          ))}
        </select>
        <button
          type="button"
          className={`chip ${onlyNew ? 'chip-on' : ''}`}
          aria-pressed={onlyNew}
          onClick={() => setQuery({ filter: onlyNew ? undefined : 'new' })}
        >
          {t('tx.onlyUncategorisedShort')}
        </button>
      </div>
      <p className="summary-line">
        {t('tx.count', { n: rows.length })} · {t('tx.in')} <Money cents={inflow} /> · {t('tx.out')} <Money cents={outflow} />
      </p>
      {rows.length === 0 ? (
        <p className="notice">{onlyNew ? t('tx.noneUncategorised') : t('tx.none')}</p>
      ) : (
        <div className="day-groups">
          {groupByDate(rows).map(([date, list]) => (
            <section key={date} className="group" aria-label={formatDate(date)}>
              <h2 className="day-head">{formatDate(date)}</h2>
              <ul className="rows">
                {list.map((tx) => (
                  <li key={tx.id}>
                    <button type="button" className="row-button tx-row" onClick={() => setEditing(tx)}>
                      <span className="row-main">
                        <span className="row-title tx-desc">{tx.descriptionRaw || t('tx.noDescription')}</span>
                        <span className="row-sub">
                          {tx.status === 'new' || tx.status === 'suggested' ? <span className="badge badge-warn tag-first">⚠ {label(tx)}</span> : label(tx)}
                          {' · '}
                          {accountName.get(tx.accountId)}
                          {tx.status === 'locked' && <span className="tag">{t('tx.lockedTag')}</span>}
                          {tx.isMirror && <span className="tag">{t('tx.autoCreated')}</span>}
                          {tx.originalCurrency && tx.originalAmount !== undefined && (
                            <> · {formatMoney(Math.abs(tx.originalAmount), { symbol: false })} {tx.originalCurrency}</>
                          )}
                        </span>
                      </span>
                      <span className="row-end">
                        <Money cents={tx.amount} plusSign className="row-amount tx-amount" />
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}
      {editing && editing !== 'new' && (editing.importBatchId || editing.isMirror) ? (
        <ImportedDialog tx={editing} label={label(editing)} accountName={accountName.get(editing.accountId) ?? '?'} onClose={() => setEditing(null)} />
      ) : (
        editing && <EntryDialog existing={editing === 'new' ? undefined : editing} defaultAccount={accountFilter} onClose={() => setEditing(null)} />
      )}
    </>
  );
}

/** "Groceries", "Transfer to Savings", "Split in 3"… for a transaction. */
function useTxLabel(): (tx: Transaction) => string {
  const accounts = useStore('accounts');
  const categories = useStore('categories');
  const transactions = useStore('transactions');
  const allocations = useStore('allocations');
  return useMemo(() => {
    const accountName = new Map(accounts.map((a) => [a.id, a.name]));
    const categoryName = new Map(categories.map((c) => [c.id, c.name]));
    const txById = new Map(transactions.map((x) => [x.id, x]));
    const allocByTxn = new Map<Id, typeof allocations[number][]>();
    for (const a of allocations) allocByTxn.set(a.transactionId, [...(allocByTxn.get(a.transactionId) ?? []), a]);
    return (tx: Transaction): string => {
      const allocs = allocByTxn.get(tx.id) ?? [];
      if (allocs.length === 0) return t('tx.uncategorised');
      if (allocs.length > 1) return t('tx.split', { n: allocs.length });
      const a = allocs[0]!;
      if (a.targetType === 'transfer') {
        // The paired row, or the account itself when its own statement covers it (D-68).
        const other = txById.get(a.targetId);
        const name = accountName.get(other ? other.accountId : a.targetId) ?? '?';
        return tx.amount < 0 ? t('tx.transferTo', { name }) : t('tx.transferFrom', { name });
      }
      return categoryName.get(a.targetId) ?? '?';
    };
  }, [accounts, categories, transactions, allocations]);
}

/** Open one transaction to see or correct it, from anywhere (D-64). */
export function TransactionDialog({ tx, onClose }: { tx: Transaction; onClose: () => void }) {
  const label = useTxLabel();
  const accounts = useStore('accounts');
  // Follow the live record: it changes when it is reclassified.
  const live = useStore('transactions').find((x) => x.id === tx.id) ?? tx;
  const accountName = accounts.find((a) => a.id === live.accountId)?.name ?? '?';
  return live.importBatchId || live.isMirror ? (
    <ImportedDialog tx={live} label={label(live)} accountName={accountName} onClose={onClose} />
  ) : (
    <EntryDialog existing={live} defaultAccount={live.accountId} onClose={onClose} />
  );
}

function EntryDialog({ existing, defaultAccount, onClose }: { existing: Transaction | undefined; defaultAccount: string; onClose: () => void }) {
  const vault = useVault();
  const notify = useToast();
  const accounts = vault.list('accounts').filter((a) => !a.closedAt || a.id === existing?.accountId);
  const categories = vault.list('categories');
  const allocs = existing ? vault.list('allocations').filter((a) => a.transactionId === existing.id) : [];
  const first = allocs[0];
  const isSplit = allocs.length > 1;
  const counterpartId = existing ? transferCounterpartId(allocs, existing.id) : undefined;
  const counterpart = counterpartId ? vault.get('transactions', counterpartId) : undefined;

  const initialKind: Kind = first?.targetType === 'transfer' ? 'transfer' : first?.targetType === 'income' || (!first && (existing?.amount ?? 0) > 0) ? 'income' : 'expense';
  const [kind, setKind] = useState<Kind>(initialKind);
  // Transfers are entered from the account the money leaves.
  const fromSide = existing && counterpart && existing.amount > 0 ? counterpart : existing;
  const toSide = existing && counterpart && existing.amount > 0 ? existing : counterpart;
  const [accountId, setAccountId] = useState(fromSide?.accountId ?? (defaultAccount || accounts[0]?.id || ''));
  const [toAccountId, setToAccountId] = useState(toSide?.accountId ?? '');
  const date = useDateInput(existing?.date ?? todayIso());
  const signed = existing ? (kind === 'income' ? existing.amount : -(fromSide ?? existing).amount) : undefined;
  const amount = useMoneyInput(signed);
  const [description, setDescription] = useState(existing?.descriptionRaw ?? '');
  const [counterparty, setCounterparty] = useState(existing?.counterparty ?? '');
  const [note, setNote] = useState(existing?.note ?? '');
  const [categoryId, setCategoryId] = useState(first && first.targetType !== 'transfer' ? first.targetId : '');
  const [foreign, setForeign] = useState(!!existing?.originalCurrency);
  const [currency, setCurrency] = useState(existing?.originalCurrency ?? '');
  const original = useMoneyInput(existing?.originalAmount !== undefined ? Math.abs(existing.originalAmount) : undefined);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const locked = existing?.status === 'locked';
  const expenseCats = categories.filter((c) => !c.isIncome);
  const incomeCats = categories.filter((c) => c.isIncome);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(undefined);
    if (!date.iso) return setError(t('field.dateInvalid'));
    if (amount.cents === null || amount.cents === 0) return setError(t('tx.amountRequired'));
    if (!accountId) return setError(t('tx.accountRequired'));
    if (kind === 'transfer' && !toAccountId) return setError(t('tx.toAccountRequired'));
    if (foreign && (!/^[A-Za-z]{3}$/.test(currency) || original.cents === null || original.cents === 0)) return setError(t('tx.foreignInvalid'));

    // Expenses are typed as positive numbers; a minus sign means a refund.
    const value = kind === 'income' ? amount.cents : -amount.cents;
    const target: EntryTarget =
      kind === 'transfer' ? { kind: 'transfer', toAccountId }
      : !categoryId ? { kind: 'none' }
      : kind === 'income' ? { kind: 'income', categoryId }
      : { kind: 'category', categoryId };
    const entry: ManualEntry = {
      accountId,
      date: date.iso,
      amount: value,
      description: description.trim(),
      counterparty: counterparty.trim(),
      note: note.trim(),
      target,
      ...(foreign ? { originalCurrency: currency.toUpperCase(), originalAmount: Math.sign(value) * Math.abs(original.cents!) } : {}),
    };
    setBusy(true);
    try {
      await saveEntry(vault, entry, fromSide?.id ?? existing?.id);
      notify(existing ? t('tx.updated') : t('tx.added'));
      onClose();
    } catch (err) {
      setBusy(false);
      setError(err instanceof LedgerError ? t(`ledger.${err.message}` as 'ledger.zeroAmount') : t('common.unexpectedError'));
    }
  }

  async function remove() {
    if (!existing) return;
    setBusy(true);
    try {
      await deleteEntry(vault, existing.id);
      notify(t('tx.deleted'));
      onClose();
    } catch {
      setBusy(false);
      setError(t('common.unexpectedError'));
    }
  }

  return (
    <Dialog open title={existing ? t('tx.editTitle') : t('tx.addTitle')} onClose={onClose} wide>
      {locked && <p className="notice">{t('tx.lockedNote')}</p>}
      {isSplit && <p className="notice notice-warn">⚠ {t('tx.splitNote')}</p>}
      <form onSubmit={submit} noValidate>
        <fieldset className="segmented">
          <legend>{t('tx.type')}</legend>
          {(['expense', 'income', 'transfer'] as const).map((k) => (
            <label key={k} className={kind === k ? 'active' : ''}>
              <input type="radio" name="kind" value={k} checked={kind === k} onChange={() => setKind(k)} />
              {t(`tx.kind.${k}`)}
            </label>
          ))}
        </fieldset>
        <div className="form-grid">
          <SelectField label={kind === 'transfer' ? t('tx.fromAccount') : t('tx.account')} value={accountId} onChange={(e) => setAccountId(e.target.value)} required>
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>{a.name}</option>
            ))}
          </SelectField>
          {kind === 'transfer' ? (
            <SelectField label={t('tx.toAccount')} value={toAccountId} onChange={(e) => setToAccountId(e.target.value)} required>
              <option value="">{t('common.choose')}</option>
              {accounts.filter((a) => a.id !== accountId).map((a) => (
                <option key={a.id} value={a.id}>{a.name}</option>
              ))}
            </SelectField>
          ) : (
            <SelectField label={t('tx.category')} value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
              <option value="">{t('tx.uncategorised')}</option>
              {kind === 'income'
                ? incomeCats.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)
                : CATEGORY_GROUPS.map((g) => {
                    const cs = expenseCats.filter((c) => c.groupId === g).sort((a, b) => a.sortOrder - b.sortOrder);
                    return cs.length ? (
                      <optgroup key={g} label={groupLabel(g)}>
                        {cs.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                      </optgroup>
                    ) : null;
                  })}
            </SelectField>
          )}
          <DateField label={t('tx.date')} state={date} required />
          <MoneyField label={t('tx.amount')} state={amount} hint={kind === 'expense' ? t('tx.amountHintExpense') : undefined} required />
        </div>
        <TextField label={t('tx.description')} value={description} onChange={(e) => setDescription(e.target.value)} />
        <TextField label={t('tx.counterparty')} value={counterparty} onChange={(e) => setCounterparty(e.target.value)} />
        <TextField label={t('tx.note')} value={note} onChange={(e) => setNote(e.target.value)} />
        <label className="check">
          <input type="checkbox" checked={foreign} onChange={(e) => setForeign(e.target.checked)} />
          {t('tx.foreign')}
        </label>
        {foreign && (
          <div className="form-grid">
            <TextField label={t('tx.currency')} value={currency} maxLength={3} onChange={(e) => setCurrency(e.target.value.toUpperCase())} placeholder="GBP" hint={t('tx.currencyHint')} />
            <MoneyField label={t('tx.originalAmount')} state={original} hint={t('tx.originalHint')} />
          </div>
        )}
        {error && <p className="error" role="alert">⚠ {error}</p>}
        <div className="row">
          <button className="button button-primary" disabled={busy || locked}>{t('common.save')}</button>
          <button type="button" className="button button-quiet" onClick={onClose}>{t('common.cancel')}</button>
          {existing && !locked && !confirmDelete && (
            <button type="button" className="button button-danger push-right" onClick={() => setConfirmDelete(true)}>{t('common.delete')}</button>
          )}
        </div>
        {confirmDelete && (
          <p className="notice notice-warn" role="alert">
            {counterpart ? t('tx.confirmDeleteTransfer') : t('tx.confirmDelete')}{' '}
            <button type="button" className="button button-danger" onClick={() => void remove()} disabled={busy}>{t('common.delete')}</button>{' '}
            <button type="button" className="button button-quiet" onClick={() => setConfirmDelete(false)}>{t('common.cancel')}</button>
          </p>
        )}
      </form>
    </Dialog>
  );
}

/** Imported rows keep their bank data; only their classification changes here. */
function ImportedDialog({ tx, label, accountName, onClose }: { tx: Transaction; label: string; accountName: string; onClose: () => void }) {
  const vault = useVault();
  const notify = useToast();
  const locked = tx.status === 'locked';
  async function back() {
    try {
      await applyChanges(vault, unclassify(tx, ledgerView(vault), systemClock));
      notify(t('tx.backToInbox'));
      onClose();
    } catch (e) {
      notify(errorMessage(e), 'error');
    }
  }
  return (
    <Dialog open title={t('tx.importedTitle')} onClose={onClose} wide>
      <div className="split-row">
        <TxSummary tx={tx} accountName={accountName} />
        <Money cents={tx.amount} plusSign className="tx-amount" />
      </div>
      <ul className="plain-list detail-list">
        {tx.valueDate && <li>{t('tx.valueDate')}: {formatDate(tx.valueDate)}</li>}
        {tx.originalCurrency && tx.originalAmount !== undefined && <li>{t('tx.originalAmount')}: {formatMoney(Math.abs(tx.originalAmount), { symbol: false })} {tx.originalCurrency}</li>}
        {tx.counterpartyIbanLast4 && <li>{t('tx.counterpartyAccount')}: ••{tx.counterpartyIbanLast4}</li>}
        <li>{t('tx.classification')}: <strong>{label}</strong></li>
      </ul>
      {tx.isMirror ? (
        <p className="notice">{t('tx.mirrorNote')}</p>
      ) : locked ? (
        <p className="notice">{t('tx.lockedNote')}</p>
      ) : (
        <>
          <h3>{t('tx.reclassify')}</h3>
          <ClassifyControl tx={tx} onDone={onClose} />
          {tx.status === 'reconciled' && (
            <button type="button" className="button button-quiet" onClick={() => void back()}>{t('tx.sendBack')}</button>
          )}
        </>
      )}
    </Dialog>
  );
}
