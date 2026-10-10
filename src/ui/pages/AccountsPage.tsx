import { useMemo, useState, type FormEvent } from 'react';
import { accountBalances, isOnBudget } from '../../domain/budget';
import { todayIso } from '../../domain/dates';
import type { Account, AccountType } from '../../domain/types';
import { monthName, t } from '../../i18n';
import { accountInUse, deleteAccount, saveAccount } from '../actions';
import { Dialog } from '../components/Dialog';
import { MoneyField, SelectField, TextField, useMoneyInput } from '../components/fields';
import { Money } from '../components/Money';
import { useToast } from '../components/Toast';
import { useDocumentTitle, useSettings, useStore, useVault } from '../hooks';
import { accountTypeLabel } from '../labels';
import { href } from '../router';

const TYPES: AccountType[] = ['current', 'savings', 'card', 'cash', 'loan'];

export function AccountsPage() {
  useDocumentTitle(t('nav.accounts'));
  const accounts = useStore('accounts');
  const transactions = useStore('transactions');
  const [editing, setEditing] = useState<Account | 'new' | null>(null);
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
            {accountTypeLabel(a.type)}
            {a.institution && ` · ${a.institution}`}
            {a.ibanLast4 && ` · ••${a.ibanLast4}`}
            {!isOnBudget(a) && <span className="tag">{t('accounts.offBudget')}</span>}
          </p>
          {a.type === 'card' && a.settlementAccountId && (
            <p className="muted">{t('accounts.settledFrom', { name: accounts.find((x) => x.id === a.settlementAccountId)?.name ?? '?' })}</p>
          )}
          <div className="row">
            <button type="button" className="button" onClick={() => setEditing(a)} aria-label={t('accounts.editNamed', { name: a.name })}>
              {t('common.edit')}
            </button>
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
    </>
  );
}

function AccountDialog({ existing, onClose }: { existing: Account | undefined; onClose: () => void }) {
  const vault = useVault();
  const notify = useToast();
  const settings = useSettings();
  const [name, setName] = useState(existing?.name ?? '');
  const [type, setType] = useState<AccountType>(existing?.type ?? 'current');
  const [institution, setInstitution] = useState(existing?.institution ?? '');
  const [last4, setLast4] = useState(existing?.ibanLast4 ?? '');
  const opening = useMoneyInput(existing?.openingBalance ?? 0);
  const [settlement, setSettlement] = useState(existing?.settlementAccountId ?? '');
  const [closed, setClosed] = useState(!!existing?.closedAt);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const others = vault.list('accounts').filter((a) => a.id !== existing?.id && (a.type === 'current' || a.type === 'savings'));
  const inUse = existing ? accountInUse(vault, existing.id) : false;

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!name.trim()) return setError(t('accounts.nameRequired'));
    if (opening.cents === null) return setError(t('field.moneyInvalid'));
    if (last4 && !/^\d{4}$/.test(last4)) return setError(t('accounts.last4Invalid'));
    setBusy(true);
    try {
      await saveAccount(vault, {
        name: name.trim(), type, institution: institution.trim(), ibanLast4: last4, openingBalance: opening.cents,
        ...(type === 'card' && settlement ? { settlementAccountId: settlement } : {}), closed,
      }, existing);
      notify(t('accounts.saved', { name: name.trim() }));
      onClose();
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
    <Dialog open title={existing ? t('accounts.editTitle') : t('accounts.addTitle')} onClose={onClose}>
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
        <TextField label={t('accounts.institution')} value={institution} onChange={(e) => setInstitution(e.target.value)} />
        <TextField label={t('accounts.last4')} value={last4} onChange={(e) => setLast4(e.target.value.replace(/\D/g, '').slice(0, 4))} inputMode="numeric" hint={t('accounts.last4Hint')} />
        <MoneyField label={t('accounts.opening')} state={opening} hint={t('accounts.openingHint', { month: monthName(settings.budgetStartMonth) })} />
        {existing && (
          <label className="check">
            <input type="checkbox" checked={closed} onChange={(e) => setClosed(e.target.checked)} />
            {t('accounts.closedLabel')}
          </label>
        )}
        {error && <p className="error" role="alert">⚠ {error}</p>}
        <div className="row">
          <button className="button button-primary" disabled={busy}>{t('common.save')}</button>
          <button type="button" className="button button-quiet" onClick={onClose}>{t('common.cancel')}</button>
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
