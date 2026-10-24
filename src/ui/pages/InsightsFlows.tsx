import { useMemo, useState } from 'react';
import { looseTransfers } from '../../domain/budget';
import { provisionWindow, tripWindow, type BucketWindow } from '../../domain/buckets';
import { addMonths, formatDate, monthRange, todayIso } from '../../domain/dates';
import { accountFlows, provisionHistory, provisionsAhead, transferPairs, transferRows, type TransferPair } from '../../domain/flows';
import { formatWholeEuros } from '../../domain/money';
import { amountFor, nextDue, parseRecurrence } from '../../domain/plan';
import type { MonthKey, Transaction } from '../../domain/types';
import { monthName, t, type MessageKey } from '../../i18n';
import { BarChart } from '../components/BarChart';
import { Dialog } from '../components/Dialog';
import { LineChart } from '../components/LineChart';
import { Money } from '../components/Money';
import { useBuckets, useBudgetInput, useSettings, useStore } from '../hooks';
import { href } from '../router';
import { BucketDialog } from './BucketDialog';
import { TransactionDialog } from './TransactionsPage';

const euros = formatWholeEuros;
const monthAbbr = (m: MonthKey) => t(`month.${Number(m.slice(5))}` as MessageKey).slice(0, 3);

/** The analysed months, as the spending tab has them: the period through this month. */
export function periodMonths(period: '6' | '12' | 'year', startMonth: MonthKey): MonthKey[] {
  const current = todayIso().slice(0, 7);
  let from = period === 'year' ? `${current.slice(0, 4)}-01` : addMonths(current, -Number(period));
  if (from < startMonth) from = startMonth;
  return from <= current ? monthRange(from, current) : [];
}

function Tile({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="tile">
      <p className="tile-label">{label}</p>
      <p className="tile-value">{value}</p>
      {sub && <p className="tile-sub">{sub}</p>}
    </div>
  );
}

/** One route (from → to): month by month and every transfer. */
function PairDialog({ pair, months, name, onClose }: { pair: TransferPair; months: MonthKey[]; name: (id: string) => string; onClose: () => void }) {
  const [open, setOpen] = useState<Transaction | null>(null);
  if (open) return <TransactionDialog tx={open} onClose={() => setOpen(null)} />;
  const current = todayIso().slice(0, 7);
  return (
    <Dialog open title={`${name(pair.from)} → ${name(pair.to)}`} onClose={onClose} wide>
      <p className="muted">{t('flows.pairSub', { total: euros(pair.total), n: pair.count })}</p>
      <BarChart
        bars={months.map((m) => ({ label: monthName(m), axis: monthAbbr(m), value: pair.byMonth.get(m) ?? 0, kind: m === current ? 'current' : 'past' }))}
        title={`${name(pair.from)} → ${name(pair.to)}`}
        valueLabel={t('flows.moved')}
      />
      <h3 className="plan-h">{t('flows.transfers', { n: pair.rows.length })}</h3>
      <ul className="rows">
        {pair.rows.map((r) => (
          <li key={`${r.tx.id}-${r.amount}`}>
            <button type="button" className="row-button tx-row" onClick={() => setOpen(r.tx)}>
              <span className="row-main">
                <span className="row-title tx-desc">{r.tx.descriptionRaw || t('tx.noDescription')}</span>
                <span className="row-sub">{formatDate(r.tx.date)} · {t('flows.seenIn', { name: name(r.tx.accountId) })}</span>
              </span>
              <span className="row-end"><Money cents={r.amount} className="row-amount tx-amount" /></span>
            </button>
          </li>
        ))}
      </ul>
      <div className="row">
        <button type="button" className="button button-quiet" onClick={onClose}>{t('common.close')}</button>
      </div>
    </Dialog>
  );
}

/** Money moved between own accounts (D-87). */
export function TransfersTab({ months }: { months: MonthKey[] }) {
  const input = useBudgetInput();
  const settings = useSettings();
  const accounts = useStore('accounts');
  const [accountId, setAccountId] = useState('');
  const [pair, setPair] = useState<TransferPair | null>(null);
  const first = months[0];
  const last = months.at(-1);
  const rows = useMemo(() => (first && last ? transferRows(input, first, last) : []), [input, first, last]);
  const loose = useMemo(() => (last ? looseTransfers(input, last).filter((r) => r.kind === 'transit' && months.includes(r.tx.date.slice(0, 7))) : []), [input, last, months]);
  const name = (id: string) => accounts.find((a) => a.id === id)?.name ?? '?';
  const typeOf = (id: string) => accounts.find((a) => a.id === id)?.type;
  const shown = accountId ? rows.filter((r) => r.from === accountId || r.to === accountId) : rows;
  const pairs = transferPairs(shown);
  const total = shown.reduce((s, r) => s + r.amount, 0);
  const toLoans = shown.filter((r) => typeOf(r.to) === 'loan').reduce((s, r) => s + r.amount, 0);
  const toCards = shown.filter((r) => typeOf(r.to) === 'card').reduce((s, r) => s + r.amount, 0);
  const focus = accountId || settings.provisionsAccountId || '';
  const flows = focus ? accountFlows(rows, focus, months) : [];
  const into = flows.reduce((s, f) => s + f.in, 0);
  const outOf = flows.reduce((s, f) => s + f.out, 0);
  const current = todayIso().slice(0, 7);

  return (
    <>
      <div className="toolbar filter-row">
        <label>
          <span className="visually-hidden">{t('flows.account')}</span>
          <select value={accountId} onChange={(e) => setAccountId(e.target.value)} aria-label={t('flows.account')}>
            <option value="">{t('flows.allAccounts')}</option>
            {accounts.filter((a) => !a.closedAt).map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
        </label>
      </div>
      <div className="tiles">
        <Tile label={t('flows.total')} value={euros(total)} sub={t('flows.count', { n: shown.length })} />
        {focus ? (
          <>
            <Tile label={t('flows.into', { name: name(focus) })} value={euros(into)} sub={t('flows.perMonth', { amount: euros(into / Math.max(1, months.length)) })} />
            <Tile label={t('flows.outOf', { name: name(focus) })} value={euros(outOf)} sub={t('flows.net', { amount: euros(into - outOf) })} />
          </>
        ) : null}
        <Tile label={t('flows.loansCards')} value={euros(toLoans + toCards)} sub={t('flows.loansCardsSub', { loans: euros(toLoans), cards: euros(toCards) })} />
      </div>

      {focus && (
        <section className="card" aria-labelledby="fl-h">
          <h2 id="fl-h" className="card-title">{t('flows.chartTitle', { name: name(focus) })}</h2>
          <LineChart
            title={t('flows.chartTitle', { name: name(focus) })}
            labels={months.map((m) => monthName(m))}
            axisLabels={months.map((m) => monthAbbr(m))}
            series={[
              { name: t('flows.inShort'), color: 'var(--series-1)', values: flows.map((f) => f.in) },
              { name: t('flows.outShort'), color: 'var(--series-2)', values: flows.map((f) => f.out) },
            ]}
          />
          <details className="table-twin">
            <summary>{t('plan.table')}</summary>
            <table className="table">
              <thead>
                <tr>
                  <th scope="col">{t('plan.month')}</th>
                  <th scope="col" className="num">{t('flows.inShort')}</th>
                  <th scope="col" className="num">{t('flows.outShort')}</th>
                  <th scope="col" className="num">{t('flows.netCol')}</th>
                </tr>
              </thead>
              <tbody>
                {flows.map((f) => (
                  <tr key={f.month}>
                    <th scope="row">{monthAbbr(f.month)} {f.month.slice(2, 4)}{f.month === current ? ' …' : ''}</th>
                    <td className="num">{euros(f.in)}</td>
                    <td className="num">{euros(f.out)}</td>
                    <td className="num">{euros(f.in - f.out)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </details>
        </section>
      )}

      <section className="card" aria-labelledby="routes-h">
        <h2 id="routes-h" className="card-title">{t('flows.routes')}</h2>
        <p className="hint">{t('flows.routesHint')}</p>
        {pairs.length === 0 ? (
          <p className="muted">{t('flows.none')}</p>
        ) : (
          <ul className="rows">
            {pairs.map((p) => (
              <li key={`${p.from}>${p.to}`}>
                <button type="button" className="row-button" onClick={() => setPair(p)}>
                  <span className="row-main">
                    <span className="row-title">{name(p.from)} → {name(p.to)}</span>
                    <span className="row-sub">{t('flows.routeSub', { n: p.count, avg: euros(p.total / Math.max(1, months.length)) })}</span>
                  </span>
                  <span className="row-end"><span className="row-amount">{euros(p.total)}</span></span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
      {loose.length > 0 && (
        <p className="hint">{t('flows.loose', { n: loose.length, amount: euros(loose.reduce((s, r) => s + r.amount, 0)) })}</p>
      )}
      {pair && <PairDialog pair={pair} months={months} name={name} onClose={() => setPair(null)} />}
    </>
  );
}

/** The provisions account against what its buckets should hold, the bills ahead, and each provision (D-87). */
export function ProvisionsTab({ months }: { months: MonthKey[] }) {
  const input = useBudgetInput();
  const settings = useSettings();
  const accounts = useStore('accounts');
  const provisions = useStore('provisions');
  const events = useStore('events');
  const categories = useStore('categories');
  const summary = useBuckets();
  const [viewing, setViewing] = useState<{ name: string; window: BucketWindow } | null>(null);
  const accountId = settings.provisionsAccountId;
  const account = accounts.find((a) => a.id === accountId);
  const first = months[0];
  const last = months.at(-1);
  const current = todayIso().slice(0, 7);
  const history = useMemo(() => {
    if (!accountId || !first || !last) return [];
    return provisionHistory(input, provisions, events, accountId, months, transferRows(input, first, last));
  }, [input, provisions, events, accountId, months, first, last]);
  const ahead = useMemo(() => provisionsAhead(input, provisions, events, addMonths(current, 1), 6), [input, provisions, events, current]);

  if (!account) {
    return (
      <p className="notice">
        {t('flows.noProvAccount')} <a href={href('plan', { tab: 'provisions' })}>{t('flows.toProvisions')}</a>
      </p>
    );
  }
  const today = todayIso();
  const catName = (id: string) => categories.find((c) => c.id === id)?.name ?? '?';
  const buckets = [
    ...provisions
      .filter((p) => parseRecurrence(p.recurrence) || p.dueDate >= today || (summary.views.get(p.categoryId)?.claim ?? 0) > 0)
      .map((p) => ({ name: p.name, window: provisionWindow(p, current), due: nextDue(p, today), amount: amountFor(p, nextDue(p, today)) })),
    ...events.filter((e) => e.status !== 'closed').map((e) => ({ name: e.name, window: tripWindow(e), due: tripWindow(e).due, amount: e.targetAmount })),
  ].sort((a, b) => a.window.due.localeCompare(b.window.due));
  const soon = buckets.filter((b) => b.due >= today && b.due <= addMonths(current, 2) + '-31');
  const dueAhead = ahead.reduce((s, m) => s + m.due, 0);

  return (
    <>
      <div className="tiles">
        <Tile label={t('flows.balance', { name: account.name })} value={euros(summary.balance)} sub={t('flows.today')} />
        <Tile label={t('move.claimed')} value={euros(summary.claimed)} sub={t('flows.claimedSub')} />
        <Tile
          label={summary.toMove > 0 ? t('flows.shortTile') : t('flows.freeTile')}
          value={euros(summary.toMove > 0 ? summary.toMove : summary.free)}
          sub={summary.toMove > 0 ? t('flows.shortSub', { name: account.name }) : t('flows.freeSub')}
        />
        <Tile label={t('flows.billsAhead')} value={euros(dueAhead)} sub={t('flows.billsAheadSub')} />
      </div>

      <ul className="plain-list insight-list">
        {summary.toMove > 0 && (
          <li className="insight insight-warn">
            <p className="insight-kind"><span aria-hidden="true">⚠ </span>{t('insight.sev.warn')}</p>
            <p className="insight-text">{t('flows.moveNow', { amount: euros(summary.toMove), name: account.name })}</p>
          </li>
        )}
        {soon.map((b) => {
          const v = summary.views.get(b.window.categoryId);
          return (
            <li key={b.window.categoryId} className={`insight ${v && v.toMove > 0 ? 'insight-warn' : ''}`}>
              <p className="insight-kind"><span aria-hidden="true">{v && v.toMove > 0 ? '⚠ ' : '✓ '}</span>{t('flows.dueSoon')}</p>
              <p className="insight-text">
                {v && v.toMove > 0
                  ? t('flows.dueShort', { name: b.name, amount: euros(b.amount), date: formatDate(b.due), short: euros(v.toMove) })
                  : t('flows.dueCovered', { name: b.name, amount: euros(b.amount), date: formatDate(b.due) })}
              </p>
            </li>
          );
        })}
      </ul>

      {history.length > 0 && (
        <section className="card" aria-labelledby="ph-h">
          <h2 id="ph-h" className="card-title">{t('flows.provChart', { name: account.name })}</h2>
          <LineChart
            title={t('flows.provChart', { name: account.name })}
            labels={history.map((h) => monthName(h.month))}
            axisLabels={history.map((h) => monthAbbr(h.month))}
            series={[
              { name: t('flows.balanceShort'), color: 'var(--series-1)', values: history.map((h) => h.balance) },
              { name: t('flows.shouldHoldShort'), color: 'var(--muted)', values: history.map((h) => h.claimed) },
            ]}
          />
          <p className="hint">{t('flows.provChartHint')}</p>
          <details className="table-twin">
            <summary>{t('plan.table')}</summary>
            <div className="table-scroll">
              <table className="table">
                <thead>
                  <tr>
                    <th scope="col">{t('plan.month')}</th>
                    <th scope="col" className="num">{t('flows.inShort')}</th>
                    <th scope="col" className="num">{t('flows.outShort')}</th>
                    <th scope="col" className="num">{t('flows.other')}</th>
                    <th scope="col" className="num">{t('flows.balanceShort')}</th>
                    <th scope="col" className="num">{t('flows.shouldHoldShort')}</th>
                    <th scope="col" className="num">{t('flows.freeShort')}</th>
                  </tr>
                </thead>
                <tbody>
                  {history.map((h) => (
                    <tr key={h.month}>
                      <th scope="row">{monthAbbr(h.month)} {h.month.slice(2, 4)}{h.month === current ? ' …' : ''}</th>
                      <td className="num">{euros(h.movedIn)}</td>
                      <td className="num">{euros(h.movedOut)}</td>
                      <td className="num">{euros(h.other)}</td>
                      <td className="num">{euros(h.balance)}</td>
                      <td className="num">{euros(h.claimed)}</td>
                      <td className={`num ${h.short > 0 ? 'bad' : ''}`}>{h.short > 0 ? euros(-h.short) : euros(h.free)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="hint">{t('flows.tableHint')}</p>
          </details>
        </section>
      )}

      <section className="card" aria-labelledby="pa-h">
        <h2 id="pa-h" className="card-title">{t('flows.aheadTitle')}</h2>
        <table className="table">
          <thead>
            <tr>
              <th scope="col">{t('plan.month')}</th>
              <th scope="col" className="num">{t('flows.setAside')}</th>
              <th scope="col" className="num">{t('flows.due')}</th>
            </tr>
          </thead>
          <tbody>
            {ahead.map((m) => (
              <tr key={m.month}>
                <th scope="row">
                  {monthAbbr(m.month)} {m.month.slice(2, 4)}
                  {m.bills.length > 0 && <span className="muted"> · {m.bills.map((b) => b.name).join(', ')}</span>}
                </th>
                <td className="num">{euros(m.setAside)}</td>
                <td className="num">{m.due ? euros(m.due) : '–'}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="hint">{t('flows.aheadHint')}</p>
      </section>

      <section className="card" aria-labelledby="pl-h">
        <h2 id="pl-h" className="card-title">{t('flows.eachTitle')}</h2>
        <p className="hint">{t('flows.eachHint')}</p>
        <ul className="rows">
          {buckets.map((b) => {
            const v = summary.views.get(b.window.categoryId);
            const pct = v && v.claim > 0 ? Math.min(100, Math.round((v.level / v.claim) * 100)) : 100;
            return (
              <li key={b.window.categoryId}>
                <button type="button" className="row-button" onClick={() => setViewing({ name: b.name, window: b.window })}>
                  <span className="row-main">
                    <span className="row-title">{b.name}</span>
                    <span className="row-sub">{t('flows.bucketSub', { amount: euros(b.amount), date: formatDate(b.due), cat: catName(b.window.categoryId) })}</span>
                    <span className="row-bar" aria-hidden="true"><span style={{ width: `${pct}%` }} /></span>
                    {v && <span className="row-sub">{t('flows.bucketHold', { level: euros(v.level), claim: euros(v.claim) })}{v.toMove > 0 && <> · <strong className="bad">{t('bucket.short')} {euros(v.toMove)}</strong></>}</span>}
                  </span>
                  <span className="row-end"><span className="row-amount">{euros(v?.level ?? 0)}</span></span>
                </button>
              </li>
            );
          })}
        </ul>
      </section>
      {viewing && <BucketDialog name={viewing.name} window={viewing.window} onClose={() => setViewing(null)} />}
    </>
  );
}
