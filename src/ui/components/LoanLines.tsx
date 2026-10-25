import { useMemo, useState } from 'react';
import { suggestLoanLines, type LoanLineSuggestion } from '../../domain/loanlines';
import { formatMoney } from '../../domain/money';
import { monthName, t } from '../../i18n';
import { makeLoanLine } from '../actions';
import { useStore, useVault } from '../hooks';
import { cleanUpLedger } from '../importActions';
import { useToast } from './Toast';

/** "Ikea loan is paid every month but has no budget line": make it one, like a mortgage's (D-101). */
export function LoanLinesBanner() {
  const vault = useVault();
  const notify = useToast();
  const accounts = useStore('accounts');
  const transactions = useStore('transactions');
  const allocations = useStore('allocations');
  const categories = useStore('categories');
  const [busy, setBusy] = useState<string | null>(null);
  const suggestions = useMemo(() => suggestLoanLines({ accounts, transactions, allocations }), [accounts, transactions, allocations]);
  if (!suggestions.length) return null;
  const where = (s: LoanLineSuggestion) =>
    Object.entries(s.filedTo)
      .map(([id, n]) => `${n} × ${id ? (categories.find((c) => c.id === id)?.name ?? '?') : t('loanLine.transfer')}`)
      .join(', ');
  async function make(s: LoanLineSuggestion) {
    setBusy(s.loanId);
    try {
      await makeLoanLine(vault, s);
      await cleanUpLedger(vault);
      notify(t('loanLine.done', { name: s.loanName, n: s.rows.length }));
    } finally {
      setBusy(null);
    }
  }
  return (
    <>
      {suggestions.map((s) => (
        <div key={s.loanId} className="notice" role="note">
          <p>
            <strong>{t('loanLine.title', { name: s.loanName })}</strong>
            <br />
            {t('loanLine.body', { payee: s.payee, amount: formatMoney(s.amount), n: s.rows.length, from: monthName(s.firstMonth), where: where(s) })}
            {s.lastMonth ? ` ${t('loanLine.last', { month: monthName(s.lastMonth) })}` : ''}
          </p>
          <button type="button" className="button button-small button-primary" disabled={busy === s.loanId} onClick={() => void make(s)}>
            {t('loanLine.make')}
          </button>
        </div>
      ))}
    </>
  );
}
