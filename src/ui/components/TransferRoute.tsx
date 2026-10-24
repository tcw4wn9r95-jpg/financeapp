import { useMemo, useState } from 'react';
import { formatDate, monthOf } from '../../domain/dates';
import { needsLook, transferRows, type TransferRow } from '../../domain/flows';
import { formatMoney } from '../../domain/money';
import type { Transaction } from '../../domain/types';
import { t } from '../../i18n';
import { useStore, useVault } from '../hooks';
import { linkTransfer } from '../learnActions';
import { useToast } from './Toast';

const CHECK_ICON: Record<TransferRow['check'], string> = {
  matched: '✓',
  mirror: '✓',
  grouped: '✓',
  candidate: '?',
  different: '⚠',
  missing: '⚠',
  unchecked: '–',
  receivedOnly: '–',
};

/** What the check found, in words (D-88). */
export function checkText(r: TransferRow, name: (id: string) => string): string {
  const to = name(r.to);
  const got = r.receiving;
  switch (r.check) {
    case 'matched':
      return t('check.matched', { name: to, date: got ? formatDate(got.date) : '' });
    case 'mirror':
      return t('check.mirror', { name: to });
    case 'grouped':
      return t('check.grouped', { name: to, amount: got ? formatMoney(got.amount) : '', date: got ? formatDate(got.date) : '' });
    case 'candidate':
      return t('check.candidate', { name: to, date: got ? formatDate(got.date) : '', desc: got?.descriptionRaw ?? '' });
    case 'different':
      return t('check.different', { name: to, amount: got ? formatMoney(got.amount) : '', date: got ? formatDate(got.date) : '', diff: got ? formatMoney(got.amount - r.amount, { plusSign: true }) : '' });
    case 'missing':
      return t('check.missing', { name: to });
    case 'unchecked':
      return t('check.unchecked', { name: to });
    case 'receivedOnly':
      return t('check.receivedOnly', { name: name(r.from) });
  }
}

/** The check as a line, with "Link them" when the money is waiting there unlinked. */
export function CheckLine({ row, name, onOpen }: { row: TransferRow; name: (id: string) => string; onOpen?: (tx: Transaction) => void }) {
  const vault = useVault();
  const notify = useToast();
  const [busy, setBusy] = useState(false);
  return (
    <span className={`check-line ${needsLook(row) ? 'check-look' : ''}`}>
      <span aria-hidden="true">{CHECK_ICON[row.check]} </span>
      {checkText(row, name)}
      {row.receiving && onOpen && (
        <>
          {' '}
          <button type="button" className="link-button" onClick={() => onOpen(row.receiving!)}>{t('check.openReceived')}</button>
        </>
      )}
      {row.check === 'candidate' && row.receiving && (
        <>
          {' '}
          <button
            type="button"
            className="button button-small"
            disabled={busy}
            onClick={() => {
              setBusy(true);
              void linkTransfer(vault, row.tx.id, row.receiving!.id)
                .then(() => notify(t('check.linked')))
                .finally(() => setBusy(false));
            }}
          >
            {t('check.link')}
          </button>
        </>
      )}
    </span>
  );
}

/** From → To, plainly. */
export function FromTo({ from, to }: { from: string; to: string }) {
  return (
    <span className="route">
      <span className="route-end"><span className="route-label">{t('route.from')}</span><strong>{from}</strong></span>
      <span className="route-arrow" aria-hidden="true">→</span>
      <span className="route-end"><span className="route-label">{t('route.to')}</span><strong>{to}</strong></span>
    </span>
  );
}

/** For a transfer: where the money left and arrived, and whether it arrived (D-88). */
export function TransferRoute({ tx, onOpen }: { tx: Transaction; onOpen?: (tx: Transaction) => void }) {
  const accounts = useStore('accounts');
  const transactions = useStore('transactions');
  const allocations = useStore('allocations');
  const row = useMemo(() => {
    if (!allocations.some((a) => a.transactionId === tx.id && a.targetType === 'transfer')) return undefined;
    const m = monthOf(tx.date);
    const rows = transferRows({ accounts, transactions, allocations }, m, m);
    return rows.find((r) => r.tx.id === tx.id) ?? rows.find((r) => r.receiving?.id === tx.id);
  }, [accounts, transactions, allocations, tx.id, tx.date]);
  const name = (id: string) => accounts.find((a) => a.id === id)?.name ?? '?';
  if (!row) {
    // The receiving side of a transfer counted from where it left, in another month.
    const a = allocations.find((x) => x.transactionId === tx.id && x.targetType === 'transfer');
    if (!a) return null;
    const other = accounts.some((x) => x.id === a.targetId) ? a.targetId : transactions.find((x) => x.id === a.targetId)?.accountId;
    if (!other) return null;
    return <div className="route-box"><FromTo from={name(tx.amount < 0 ? tx.accountId : other)} to={name(tx.amount < 0 ? other : tx.accountId)} /></div>;
  }
  return (
    <div className="route-box">
      <FromTo from={name(row.from)} to={name(row.to)} />
      <CheckLine row={row} name={name} {...(onOpen ? { onOpen } : {})} />
    </div>
  );
}
