import { useMemo, useState, type FormEvent } from 'react';
import { accountBalances, isOnBudget } from '../../domain/budget';
import { addMonths, currentMonth, formatDate, monthRange, parseDate, todayIso } from '../../domain/dates';
import type { Account, AccountType } from '../../domain/types';
import { monthName, t } from '../../i18n';
import { accountInUse, adjustBalance, deleteAccount, ownerName, saveAccount } from '../actions';
import { Dialog } from '../components/Dialog';
import { DateField, MoneyField, SelectField, TextField, useDateInput, useMoneyInput } from '../components/fields';
import { Money } from '../components/Money';
import { formatMoney } from '../../domain/money';
import { useToast } from '../components/Toast';
import { useDocumentTitle, useSettings, useStore, useVault } from '../hooks';
import { accountTypeLabel } from '../labels';
import { href } from '../router';

const TYPES: AccountType[] = ['current', 'savings', 'card', 'cash', 'loan'];

export function AccountsPage() {
  useDocumentTitle(t('nav.accounts'));
  const vault = useVault();
  useStore('settings');
  const accounts = useStore('accounts');
  const transactions = useStore('transactions');
  const [editing, setEditing] = useState<Account | 'new' | null>(null);
  const [adjusting, setAdjusting] = useState<Account | null>(null);
  const balances = useMemo(() => accountBalances(accounts, transactions, todayIso()), [accounts, transactions]);
  const open = accounts.filter((a) => !a.closedAt);
  const closed = accounts.filter((a) => a.closedAt);
  const onBudget = open.filter(isOnBudget).reduce((s, a) => s + (balances.get(a.id) ?? 0), 0);

  const list = (items: Account[]) => (
    <ul className="card-list">
      {items.map((a) => (
        <li key={a.id} className="card account-card">
          <div className="split-row">
            <h3>{a.name}</h3>
            <Money cents={balances.get(a.id) ?? 0} className="big" />
          </div>
          <p className="muted">
            {ownerName(vault, a.owner) && <span className="tag tag-first">{ownerName(vault, a.owner)}</span>}
            {accountTypeLabel(a.type)}
            {a.institution && ` · ${a.institution}`}
            {a.ibanLast4 && ` · ••${a.ibanLast4}`}
            {a.openingDate && ` · ${t('accounts.countsFrom', { date: formatDate(a.openingDate) })}`}
            {a.type === 'loan' && a.monthlyPayment ? ` · ${t('accounts.paymentShort', { amount: formatMoney(a.monthlyPayment) })}` : ''}
            {!isOnBudget(a) && <span className="tag">{t('accounts.offBudget')}</span>}
          </p>
          {a.type === 'card' && a.settlementAccountId && (
            <p className="muted">{t('accounts.settledFrom', { name: accounts.find((x) => x.id === a.settlementAccountId)?.name ?? '?' })}</p>
          )}
          <div className="row">
            <button type="button" className="button" onClick={() => setEditing(a)} aria-label={t('accounts.editNamed', { name: a.name })}>
              {t('common.edit')}
            </button>
            <button type="button" className="button" onClick={() => setAdjusting(a)} aria-label={t('adjust.named', { name: a.name })}>{t('adjust.button')}</button>
            <a className="button button-quiet" href={href('transactions', { account: a.id })}>{t('accounts.viewTransactions')}</a>
          </div>
        </li>
      ))}
    </ul>
  );

  return (
    <>
      <div className="page-head">
        <h1>{t('nav.accounts')}</h1>
        <button type="button" className="button button-primary" onClick={() => setEditing('new')}>+ {t('accounts.add')}</button>
      </div>
      <p className="summary-line">
        {t('accounts.onBudgetTotal')} <Money cents={onBudget} />
      </p>
      {open.length === 0 ? <p className="notice">{t('accounts.none')}</p> : list(open)}
      {closed.length > 0 && (
        <details>
          <summary>{t('accounts.closed', { n: closed.length })}</summary>
          {list(closed)}
        </details>
      )}
      {editing && <AccountDialog existing={editing === 'new' ? undefined : editing} onClose={() => setEditing(null)} />}
      {adjusting && <AdjustBalanceDialog account={adjusting} onClose={() => setAdjusting(null)} />}
    </>
  );
}

export function AccountDialog({ existing, initial, onClose }: {
  existing: Account | undefined;
  initial?: Partial<Pick<Account, 'type' | 'ibanLast4' | 'institution' | 'name'>>;
  onClose: (savedId?: string) => void;
}) {
  const vault = useVault();
  const notify = useToast();
  const settings = useSettings();
  const members = settings.members ?? [];
  const [name, setName] = useState(existing?.name ?? initial?.name ?? '');
  const [type, setType] = useState<AccountType>(existing?.type ?? initial?.type ?? 'current');
  const [institution, setInstitution] = useState(existing?.institution ?? initial?.institution ?? '');
  const [last4, setLast4] = useState(existing?.ibanLast4 ?? initial?.ibanLast4 ?? '');
  const [owner, setOwner] = useState(existing?.owner ?? '');
  const [hints, setHints] = useState((existing?.matchHints ?? []).join(', '));
  // Loans are entered as the amount still owed (positive) and stored as a negative balance.
  const opening = useMoneyInput(existing ? (existing.type === 'loan' ? Math.abs(existing.openingBalance) : existing.openingBalance) : 0);
  const [settlement, setSettlement] = useState(existing?.settlementAccountId ?? '');
  const sinceInput = useDateInput(existing?.openingDate);
  const since = sinceInput.text;
  const sinceIso = since.trim() ? (sinceInput.iso ?? undefined) : undefined;
  const payment = useMoneyInput(existing?.monthlyPayment);
  const [lastPayment, setLastPayment] = useState(existing?.lastPaymentMonth ?? '');
  const [closed, setClosed] = useState(!!existing?.closedAt);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const others = vault.list('accounts').filter((a) => a.id !== existing?.id && (a.type === 'current' || a.type === 'savings'));
  const inUse = existing ? accountInUse(vault, existing.id) : false;

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!name.trim()) return setError(t('accounts.nameRequired'));
    if (opening.cents === null) return setError(t('field.moneyInvalid'));
    if (last4 && !/^[A-Za-z0-9]{4}$/.test(last4)) return setError(t('accounts.last4Invalid'));
    if (since.trim() && !sinceIso) return setError(t('field.dateInvalid'));
    if (type === 'loan' && !payment.valid) return setError(t('field.moneyInvalid'));
    setBusy(true);
    try {
      const id = await saveAccount(vault, {
        name: name.trim(), type, institution: institution.trim(), ibanLast4: last4, openingBalance: type === 'loan' ? -Math.abs(opening.cents) : opening.cents,
        ...(type === 'card' && settlement ? { settlementAccountId: settlement } : {}), closed,
        ...(owner ? { owner } : {}),
        ...(sinceIso ? { openingDate: sinceIso } : {}),
        ...(type === 'loan' && payment.cents ? { monthlyPayment: Math.abs(payment.cents) } : {}),
        ...(type === 'loan' && lastPayment ? { lastPaymentMonth: lastPayment } : {}),
        matchHints: hints.split(',').map((h) => h.trim()).filter(Boolean),
      }, existing);
      notify(t('accounts.saved', { name: name.trim() }));
      onClose(id);
    } catch {
      setBusy(false);
      setError(t('common.unexpectedError'));
    }
  }

  async function remove() {
    if (!existing) return;
    await deleteAccount(vault, existing.id);
    notify(t('accounts.deleted'));
    onClose();
  }

  return (
    <Dialog open title={existing ? t('accounts.editTitle') : t('accounts.addTitle')} onClose={() => onClose()}>
      <form onSubmit={submit} noValidate>
        <TextField label={t('accounts.name')} value={name} onChange={(e) => setName(e.target.value)} required autoFocus />
        <SelectField label={t('accounts.type')} value={type} onChange={(e) => setType(e.target.value as AccountType)} hint={type === 'loan' ? t('accounts.loanHint') : undefined}>
          {TYPES.map((x) => <option key={x} value={x}>{accountTypeLabel(x)}</option>)}
        </SelectField>
        {type === 'card' && (
          <SelectField label={t('accounts.settlement')} value={settlement} onChange={(e) => setSettlement(e.target.value)} hint={t('accounts.settlementHint')}>
            <option value="">{t('common.none')}</option>
            {others.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
          </SelectField>
        )}
        <SelectField label={t('accounts.owner')} value={owner} onChange={(e) => setOwner(e.target.value)} hint={members.length === 0 ? t('accounts.ownerHint') : undefined}>
          <option value="">{t('common.none')}</option>
          <option value="joint">{t('accounts.joint')}</option>
          {members.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
        </SelectField>
        <TextField label={t('accounts.institution')} value={institution} onChange={(e) => setInstitution(e.target.value)} />
        <TextField label={t('accounts.last4')} value={last4} onChange={(e) => setLast4(e.target.value.replace(/[^A-Za-z0-9]/g, '').slice(0, 4).toUpperCase())} hint={t('accounts.last4Hint')} autoComplete="off" />
        <TextField label={t('accounts.hints')} value={hints} onChange={(e) => setHints(e.target.value)} hint={t('accounts.hintsHint')} autoComplete="off" />
        <DateField
          label={type === 'loan' ? t('accounts.loanSince') : t('accounts.since')}
          hint={type === 'loan' ? t('accounts.loanSinceHint') : t('accounts.sinceHint', { month: monthName(settings.budgetStartMonth) })}
          state={sinceInput}
        />
        {type === 'loan' && (
          <>
            <MoneyField label={t('accounts.payment')} state={payment} hint={t('accounts.paymentHint')} />
            {!!payment.cents && (
              <SelectField label={t('accounts.lastPayment')} value={lastPayment} onChange={(e) => setLastPayment(e.target.value)} hint={t('accounts.lastPaymentHint')}>
                <option value="">{t('accounts.lastPaymentUnknown')}</option>
                {monthRange(currentMonth(), addMonths(currentMonth(), 30 * 12)).map((m) => <option key={m} value={m}>{monthName(m)}</option>)}
              </SelectField>
            )}
          </>
        )}
        {type === 'loan' ? (
          <MoneyField label={t('accounts.owed')} state={opening} hint={sinceIso ? t('accounts.owedOnHint', { date: formatDate(sinceIso) }) : t('accounts.owedHint', { month: monthName(settings.budgetStartMonth) })} />
        ) : (
          <MoneyField signed label={t('accounts.opening')} state={opening} hint={sinceIso ? t('accounts.openingOnHint', { date: formatDate(sinceIso) }) : t('accounts.openingHint', { month: monthName(settings.budgetStartMonth) })} />
        )}
        {existing && (
          <label className="check">
            <input type="checkbox" checked={closed} onChange={(e) => setClosed(e.target.checked)} />
            {t('accounts.closedLabel')}
          </label>
        )}
        {error && <p className="error" role="alert">⚠ {error}</p>}
        <div className="row">
          <button className="button button-primary" disabled={busy}>{t('common.save')}</button>
          <button type="button" className="button button-quiet" onClick={() => onClose()}>{t('common.cancel')}</button>
          {existing && (
            <button type="button" className="button button-danger push-right" disabled={inUse} onClick={() => void remove()} title={inUse ? t('accounts.cannotDelete') : undefined}>
              {t('common.delete')}
            </button>
          )}
        </div>
        {existing && inUse && <p className="hint">{t('accounts.cannotDelete')}</p>}
      </form>
    </Dialog>
  );
}

/**
 * Set an account to its real balance (D-88): the difference becomes one
 * transaction with a note, counted in a budget line or kept out of them.
 */
function AdjustBalanceDialog({ account, onClose }: { account: Account; onClose: () => void }) {
  const vault = useVault();
  const notify = useToast();
  const accounts = useStore('accounts');
  const transactions = useStore('transactions');
  const categories = useStore('categories');
  const dateInput = useDateInput(todayIso());
  const date = dateInput.iso ?? todayIso();
  const balance = useMemo(() => accountBalances(accounts, transactions, date).get(account.id) ?? 0, [accounts, transactions, date, account.id]);
  const real = useMoneyInput();
  const [note, setNote] = useState('');
  const [track, setTrack] = useState(false);
  const [categoryId, setCategoryId] = useState('');
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const onBudget = isOnBudget(account);
  const diff = real.cents === null || real.text.trim() === '' ? null : (account.type === 'loan' ? -Math.abs(real.cents) : real.cents) - balance;
  const choices = categories.filter((c) => !c.archivedAt && (diff !== null && diff > 0 ? true : !c.isIncome)).sort((a, b) => Number(b.isIncome) - Number(a.isIncome) || a.sortOrder - b.sortOrder);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!dateInput.iso) return setError(t('field.dateInvalid'));
    if (diff === null) return setError(t('field.moneyInvalid'));
    if (diff === 0) return setError(t('adjust.nothing'));
    if (!note.trim()) return setError(t('adjust.noteRequired'));
    if (onBudget && track && !categoryId) return setError(t('adjust.pickLine'));
    const cat = categories.find((c) => c.id === categoryId);
    setBusy(true);
    try {
      const undo = await adjustBalance(vault, {
        accountId: account.id,
        date: dateInput.iso,
        amount: diff,
        note: note.trim(),
        target: onBudget && track && cat ? { kind: cat.isIncome ? 'income' : 'category', categoryId: cat.id } : { kind: 'none' },
      });
      notify(t('adjust.done', { name: account.name, amount: formatMoney(diff, { plusSign: true }) }), 'ok', { label: t('inbox.undo'), run: () => void undo().then(() => notify(t('adjust.undone'))) });
      onClose();
    } catch {
      setBusy(false);
      setError(t('common.unexpectedError'));
    }
  }

  return (
    <Dialog open title={t('adjust.title', { name: account.name })} onClose={onClose}>
      <form onSubmit={submit} noValidate>
        <DateField label={t('adjust.date')} state={dateInput} />
        <p className="split-row">
          <span className="muted">{t('adjust.appBalance', { date: formatDate(date) })}</span>
          <strong><Money cents={account.type === 'loan' ? -balance : balance} /></strong>
        </p>
        <MoneyField signed={account.type !== 'loan'} label={account.type === 'loan' ? t('adjust.realOwed') : t('adjust.real')} state={real} hint={t('adjust.realHint')} autoFocus />
        {diff !== null && diff !== 0 && (
          <p className="split-row adjust-diff">
            <span>{t('adjust.difference')}</span>
            <strong><Money cents={diff} plusSign /></strong>
          </p>
        )}
        <TextField label={t('adjust.note')} value={note} onChange={(e) => setNote(e.target.value)} hint={t('adjust.noteHint')} />
        {onBudget ? (
          <fieldset className="radio-group">
            <legend>{t('adjust.budgetQ')}</legend>
            <label className="check">
              <input type="radio" name="track" checked={!track} onChange={() => setTrack(false)} />
              <span>{t('adjust.untracked')}<span className="hint block">{t('adjust.untrackedHint')}</span></span>
            </label>
            <label className="check">
              <input type="radio" name="track" checked={track} onChange={() => setTrack(true)} />
              <span>{t('adjust.tracked')}<span className="hint block">{t('adjust.trackedHint')}</span></span>
            </label>
            {track && (
              <SelectField label={t('adjust.line')} value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
                <option value="">{t('adjust.pick')}</option>
                {choices.map((c) => <option key={c.id} value={c.id}>{c.isIncome ? `${c.name} (${t('adjust.incomeTag')})` : c.name}</option>)}
              </SelectField>
            )}
          </fieldset>
        ) : (
          <p className="hint">{t('adjust.offBudget')}</p>
        )}
        {error && <p className="error" role="alert">⚠ {error}</p>}
        <div className="row">
          <button className="button button-primary" disabled={busy}>{t('adjust.save')}</button>
          <button type="button" className="button button-quiet" onClick={onClose}>{t('common.cancel')}</button>
        </div>
      </form>
    </Dialog>
  );
}
