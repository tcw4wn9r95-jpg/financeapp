import { useMemo, useState, type FormEvent, type ReactNode } from 'react';
import { currentMonth, formatDate, monthOf, parseDate, todayIso } from '../../domain/dates';
import { firstBelow, type ForecastResult } from '../../domain/forecast';
import { addMonthsToDate, amountFor, occurrences, eventPlanParts, eventStatus, formatRecurrence, monthlySetAside, nextDue, parseRecurrence, planCloseEvent, provisionSchedule, provisionStatus, type Recurrence } from '../../domain/plan';
import { planPartAmount } from '../../domain/budget';
import { provisionWindow, tripWindow } from '../../domain/buckets';
import { formatMoney, formatMoneyInput, parseMoney } from '../../domain/money';
import type { EventFund, Provision, SubBudget, Transaction } from '../../domain/types';
import { monthName, monthShort, t, type MessageKey } from '../../i18n';
import { saveSettings, closeEvent, deleteEvent, deleteProvision, saveEvent, saveProvision, setDefaultFrom, defaultStartMonth } from '../actions';
import { Dialog } from '../components/Dialog';
import { BucketDialog } from './BucketDialog';
import { DateField, MoneyField, SelectField, TextField, useDateInput, useMoneyInput } from '../components/fields';
import { Icon } from '../components/Icon';
import { LineChart, type Series } from '../components/LineChart';
import { Money } from '../components/Money';
import { useToast } from '../components/Toast';
import { useBuckets, useBudgetInput, useDocumentTitle, useForecast, useSettings, useStore, useVault } from '../hooks';
import { href, useRoute } from '../router';

export const PLAN_TABS: readonly [string, MessageKey][] = [
  ['forecast', 'plan.tab.forecast'],
  ['provisions', 'plan.tab.provisions'],
  ['events', 'plan.tab.events'],
];

export function PlanPage({ extraTabs = {} }: { extraTabs?: Record<string, ReactNode> }) {
  useDocumentTitle(t('nav.plan'));
  const route = useRoute();
  const tab = route.query.get('tab') ?? 'forecast';
  return (
    <>
      <h1>{t('nav.plan')}</h1>
      <nav className="tabs" aria-label={t('plan.tabsLabel')} style={{ gridTemplateColumns: `repeat(${PLAN_TABS.length + Object.keys(extraTabs).length}, 1fr)` }}>
        {PLAN_TABS.map(([k, key]) => (
          <a key={k} href={href('plan', { tab: k })} aria-current={tab === k ? 'page' : undefined}>{t(key)}</a>
        ))}
        {Object.keys(extraTabs).map((k) => (
          <a key={k} href={href('plan', { tab: k })} aria-current={tab === k ? 'page' : undefined}>{t(`plan.tab.${k}` as MessageKey)}</a>
        ))}
      </nav>
      {tab === 'provisions' ? <Provisions /> : tab === 'events' ? <Events /> : extraTabs[tab] ?? <Forecast />}
    </>
  );
}

// ----------------------------------------------------------------- forecast

export function ForecastView({ result, compare, compareName }: { result: ForecastResult; compare?: ForecastResult; compareName?: string }) {
  const settings = useSettings();
  const accounts = useStore('accounts');
  const [account, setAccount] = useState('');
  const buffer = settings.minimumBuffer ?? 0;
  const months = result.months;
  const values = account ? (result.byAccount.get(account) ?? []).map((m) => m.end) : months.map((m) => m.min);
  const series: Series[] = [{ name: t('plan.baseline'), color: 'var(--series-1)', values }];
  if (compare) {
    series.push({
      name: compareName ?? t('plan.scenario'),
      color: 'var(--series-2)',
      values: account ? (compare.byAccount.get(account) ?? []).map((m) => m.end) : compare.months.map((m) => m.min),
    });
  }
  const watched = compare ?? result;
  const below = !account && buffer > 0 ? firstBelow(watched.months, buffer) : undefined;
  const lowest = months.reduce((lo, m) => (m.min < lo.min ? m : lo), months[0]!);
  const onBudget = accounts.filter((a) => a.type !== 'loan' && !a.closedAt);

  return (
    <>
      <div className="headline">
        <span className="muted">{t('plan.inMonths', { n: months.length, month: monthName(months.at(-1)!.month) })}</span>
        <span className="big-number"><Money cents={months.at(-1)!.end} /></span>
        <span className="muted">
          {t('plan.lowest')} <Money cents={lowest.min} /> · {formatDate(lowest.minDate)}
        </span>
      </div>
      {buffer > 0 && !account && (
        <p className={`action-row ${below ? 'action-row-warn' : ''}`} role="status">
          <span aria-hidden="true">{below ? '⚠' : '✓'}</span>
          <span>
            {below
              ? t('plan.belowBuffer', { month: monthName(below.month), date: formatDate(below.minDate) })
              : t('plan.neverBelow', { months: months.length })}
          </span>
        </p>
      )}
      <div className="toolbar">
        <label className="visually-hidden" htmlFor="fc-account">{t('plan.view')}</label>
        <select id="fc-account" value={account} onChange={(e) => setAccount(e.target.value)}>
          <option value="">{t('plan.allAccounts')}</option>
          {onBudget.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
        </select>
      </div>
      <div className="card">
        <LineChart
          title={account ? t('plan.chartAccount') : t('plan.chartTitle')}
          labels={months.map((m) => monthName(m.month))}
          axisLabels={months.map((m) => monthShort(m.month))}
          series={series}
          {...(buffer > 0 && !account ? { reference: { value: buffer, label: t('plan.buffer') } } : {})}
          {...(below ? { mark: { index: watched.months.indexOf(below), label: monthShort(below.month) } } : {})}
        />
        <p className="hint">{account ? t('plan.accountHint') : t('plan.totalHint')}</p>
      </div>
      <details className="card">
        <summary>{t('plan.table')}</summary>
        <table className="table">
          <thead>
            <tr>
              <th scope="col">{t('plan.month')}</th>
              <th scope="col" className="num">{t('plan.in')}</th>
              <th scope="col" className="num">{t('plan.out')}</th>
              <th scope="col" className="num">{t('plan.end')}</th>
            </tr>
          </thead>
          <tbody>
            {months.map((m) => (
              <tr key={m.month}>
                <th scope="row">{monthShort(m.month)}</th>
                <td className="num"><Money cents={m.inflow} /></td>
                <td className="num"><Money cents={-m.outflow} /></td>
                <td className="num"><Money cents={m.end} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </>
  );
}

function Forecast() {
  const result = useForecast(24);
  return (
    <>
      <ForecastView result={result} />
      <p className="hint">{t('plan.how')} <a href={href('settings', { section: 'budget' })}>{t('plan.setBuffer')}</a></p>
    </>
  );
}

// --------------------------------------------------------------- provisions

const RECURRENCES: [string, MessageKey][] = [
  ['', 'plan.rec.none'],
  ['FREQ=MONTHLY;INTERVAL=1', 'plan.rec.monthly'],
  ['FREQ=MONTHLY;INTERVAL=3', 'plan.rec.quarterly'],
  ['FREQ=MONTHLY;INTERVAL=6', 'plan.rec.half'],
  ['FREQ=YEARLY;INTERVAL=1', 'plan.rec.yearly'],
];

function recurrenceLabel(r: string): string {
  const found = RECURRENCES.find(([v]) => v === r);
  if (found) return t(found[1]);
  const p = parseRecurrence(r);
  return p ? t('plan.rec.custom', { n: p.interval, unit: p.freq === 'YEARLY' ? t('plan.rec.years') : t('plan.rec.months') }) : t('plan.rec.none');
}

/**
 * The provisions account's balance shared out between provisions and trips,
 * soonest due first, and what to move so all are covered (D-69).
 */
export function ProvisionsMoveCard() {
  const vault = useVault();
  const notify = useToast();
  const settings = useSettings();
  const accounts = useStore('accounts');
  const provisions = useStore('provisions');
  const events = useStore('events');
  const categories = useStore('categories');
  const summary = useBuckets();
  const savings = accounts.filter((a) => !a.closedAt && a.type !== 'loan' && a.type !== 'card');
  const accountId = settings.provisionsAccountId;
  const account = accounts.find((a) => a.id === accountId);
  const names = new Map<string, string>([...provisions.map((p) => [p.categoryId, p.name] as const), ...events.map((e) => [e.categoryId, e.name] as const)]);
  const short = [...summary.views.values()].filter((v) => v.toMove > 0).sort((x, y) => y.toMove - x.toMove);
  const freeName = categories.find((c) => c.id === settings.sweepTargetCategoryId)?.name ?? t('move.freeSavings');
  const accountSelect = (
    <SelectField
      label={t('move.account')}
      value={accountId ?? ''}
      onChange={(e) => void saveSettings(vault, { provisionsAccountId: e.target.value || undefined }).then(() => notify(t('settings.saved')))}
      hint={t('move.accountHint')}
    >
      <option value="">{t('move.none')}</option>
      {savings.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
    </SelectField>
  );
  return (
    <section className="card move-card" aria-labelledby="move-h">
      <h2 id="move-h">{t('move.title')}</h2>
      {!account ? (
        accountSelect
      ) : (
        <>
          {summary.toMove > 0 ? (
            <p className="move-amount">
              <span className="muted">{t('move.moveTo', { name: account.name })}</span>
              <strong><Money cents={summary.toMove} /></strong>
            </p>
          ) : (
            <p className="move-amount">✓ {t('move.allCovered')}</p>
          )}
          <ul className="plain-list move-list">
            <li className="split-row"><span>{t('move.holds', { name: account.name })}</span><strong><Money cents={summary.balance} /></strong></li>
            <li className="split-row"><span>{t('move.claimed')}</span><Money cents={summary.claimed} /></li>
            <li className="split-row"><span>{freeName}</span><Money cents={summary.free} /></li>
          </ul>
          {short.length > 0 && (
            <>
              <h3 className="move-sub">{t('move.shortBy')}</h3>
              <ul className="plain-list move-list">
                {short.map((v) => (
                  <li key={v.categoryId} className="split-row"><span>{names.get(v.categoryId) ?? '?'}</span><Money cents={v.toMove} /></li>
                ))}
              </ul>
            </>
          )}
          <details className="move-settings">
            <summary>{t('move.settings', { name: account.name })}</summary>
            {accountSelect}
            <p className="hint">{t('move.how', { name: account.name })}</p>
          </details>
        </>
      )}
    </section>
  );
}

function Provisions() {
  const provisions = useStore('provisions');
  const input = useBudgetInput();
  const [editing, setEditing] = useState<Provision | 'new' | null>(null);
  const [viewing, setViewing] = useState<Provision | null>(null);
  const month = currentMonth();
  const today = todayIso();
  const summary = useBuckets();
  const all = provisions.map((p) => provisionStatus(p, input, month, today)).sort((a, b) => a.nextDue.localeCompare(b.nextDue));
  // A one-off bill whose date has passed and that needs nothing more is finished.
  const finished = (r: (typeof all)[number]) => !parseRecurrence(r.provision.recurrence) && r.nextDue < today && (summary.views.get(r.provision.categoryId)?.claim ?? 0) === 0;
  const rows = all.filter((r) => !finished(r));
  const done = all.filter(finished);
  const totalMonthly = rows.reduce((s, r) => s + r.assignedThisMonth, 0);

  const row = (r: (typeof all)[number]) => {
    const bk = summary.views.get(r.provision.categoryId);
    const notStarted = !!r.provision.startDate && monthOf(r.provision.startDate) > month;
    return (
      <li key={r.provision.id}>
        <button type="button" className="row-button" onClick={() => setViewing(r.provision)}>
          <span className="row-main">
            <span className="row-title">{r.provision.name}</span>
            <span className="row-sub">
              <Money cents={amountFor(r.provision, r.nextDue)} /> · {formatDate(r.nextDue)} · {recurrenceLabel(r.provision.recurrence)}
            </span>
            {bk && !finished(r) && (
              <>
                <span className="row-bar" aria-hidden="true"><span style={{ width: `${bk.percent}%` }} /></span>
                <span className="row-sub">
                  {notStarted ? (
                    t('plan.startsIn', { month: monthName(monthOf(r.provision.startDate!)) })
                  ) : (
                    <>
                      <Money cents={r.assignedThisMonth} /> {t('plan.perMonthShort')}
                      {bk.toMove > 0 && <> · <strong className="bad">{t('bucket.short')} <Money cents={bk.toMove} /></strong></>}
                    </>
                  )}
                </span>
              </>
            )}
          </span>
          <span className="row-end"><Money cents={bk?.level ?? 0} className="row-amount" /></span>
        </button>
      </li>
    );
  };

  return (
    <>
      <ProvisionsMoveCard />
      <div className="page-head">
        <p className="muted">{t('plan.provisionsIntro')}</p>
        <button type="button" className="button button-primary button-small" onClick={() => setEditing('new')}>
          <Icon name="plus" size={18} />
          {t('plan.add')}
        </button>
      </div>
      {all.length === 0 ? (
        <p className="notice">{t('plan.noProvisions')}</p>
      ) : (
        <section className="group" aria-label={t('plan.tab.provisions')}>
          <div className="group-head">
            <h2>{t('plan.setAsideMonthly')}</h2>
            <span className="muted"><Money cents={totalMonthly} /></span>
          </div>
          <ul className="rows">{rows.map(row)}</ul>
          {done.length > 0 && (
            <details className="finished">
              <summary>{t('plan.finished', { n: done.length })}</summary>
              <ul className="rows">{done.map(row)}</ul>
            </details>
          )}
        </section>
      )}
      <p className="hint">{t('plan.provisionsHow')}</p>
      {editing && <ProvisionDialog existing={editing === 'new' ? undefined : editing} onClose={() => setEditing(null)} />}
      {viewing && (
        <BucketDialog
          name={viewing.name}
          window={provisionWindow(viewing, month)}
          onEdit={() => {
            setEditing(viewing);
            setViewing(null);
          }}
          onClose={() => setViewing(null)}
        />
      )}
    </>
  );
}

function ProvisionDialog({ existing, onClose }: { existing: Provision | undefined; onClose: () => void }) {
  const vault = useVault();
  const notify = useToast();
  const today = todayIso();
  const [name, setName] = useState(existing?.name ?? '');
  // A recurring bill's amount can change from a given bill on (D-70): the field shows the next bill's amount.
  const isRecurring = !!existing && !!parseRecurrence(existing.recurrence);
  const upcoming = isRecurring ? occurrences(existing, today, addMonthsToDate(today, 24)).slice(0, 5) : [];
  const currentAmount = existing ? amountFor(existing, upcoming[0] ?? existing.dueDate) : undefined;
  const amount = useMoneyInput(currentAmount);
  const [fromDue, setFromDue] = useState(upcoming[0] ?? '');
  const [changes, setChanges] = useState(existing?.amountChanges ?? []);
  const amountChanged = isRecurring && amount.cents !== null && amount.cents !== currentAmount;
  const due = useDateInput(existing ? (existing.startDate ? existing.dueDate : nextDue(existing, todayIso())) : todayIso());
  // Existing provisions without a start date: the month their amounts began, else today.
  const firstDefault = existing
    ? vault.list('budgetDefaults').filter((d) => d.categoryId === existing.categoryId).map((d) => d.effectiveFrom).sort()[0]
    : undefined;
  const start = useDateInput(existing?.startDate ?? (firstDefault ? `${firstDefault}-01` : todayIso()));
  const [recurrence, setRecurrence] = useState(existing?.recurrence ?? '');
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  // The amount typed applies from the chosen bill on; later changes are replaced by it.
  const nextChanges = amountChanged && fromDue && amount.cents ? [...changes.filter((c) => c.fromDue < fromDue), { fromDue, amount: amount.cents }] : changes;
  const baseAmount = isRecurring ? existing!.amount : amount.cents;
  const schedule =
    baseAmount && due.iso && start.iso ? provisionSchedule({ amount: baseAmount, dueDate: due.iso, recurrence, startDate: start.iso, amountChanges: nextChanges }, monthOf(start.iso)) : null;

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!name.trim()) return setError(t('plan.nameRequired'));
    if (!amount.cents || amount.cents <= 0) return setError(t('tx.amountRequired'));
    if (!due.iso || !start.iso) return setError(t('field.dateInvalid'));
    if (!recurrence && start.iso > due.iso) return setError(t('plan.startAfterTarget'));
    setBusy(true);
    try {
      await saveProvision(vault, { name: name.trim(), amount: isRecurring ? existing!.amount : amount.cents, dueDate: due.iso, recurrence, startDate: start.iso, amountChanges: nextChanges }, existing);
      notify(t('plan.saved', { name: name.trim() }));
      onClose();
    } catch {
      setBusy(false);
      setError(t('common.unexpectedError'));
    }
  }

  return (
    <Dialog open title={existing ? t('plan.editProvision') : t('plan.newProvision')} onClose={onClose}>
      <form onSubmit={submit} noValidate>
        <TextField label={t('plan.name')} value={name} onChange={(e) => setName(e.target.value)} placeholder={t('plan.provisionExample')} autoFocus />
        <DateField label={t('plan.startDate')} state={start} hint={t('plan.startDateHint')} />
        <DateField label={t('plan.targetDate')} state={due} hint={t('plan.targetDateHint')} />
        <MoneyField label={isRecurring ? t('plan.amountPerBill') : t('plan.targetAmount')} state={amount} />
        {amountChanged && (
          <SelectField label={t('plan.appliesFrom')} value={fromDue} onChange={(e) => setFromDue(e.target.value)}>
            {upcoming.map((d) => <option key={d} value={d}>{formatDate(d)}</option>)}
          </SelectField>
        )}
        {changes.length > 0 && (
          <ul className="plain-list move-list">
            <li className="split-row muted"><span>{t('plan.amountFirst', { date: formatDate(existing!.dueDate) })}</span><Money cents={existing!.amount} /></li>
            {changes.map((c) => (
              <li key={c.fromDue} className="split-row">
                <span>{t('plan.amountFrom', { date: formatDate(c.fromDue) })}</span>
                <span>
                  <Money cents={c.amount} />{' '}
                  <button type="button" className="link-button" aria-label={t('common.delete')} onClick={() => setChanges(changes.filter((x) => x !== c))}>✕</button>
                </span>
              </li>
            ))}
          </ul>
        )}
        <SelectField label={t('plan.repeats')} value={recurrence} onChange={(e) => setRecurrence(e.target.value)}>
          {RECURRENCES.map(([v, k]) => <option key={v} value={v}>{t(k)}</option>)}
          {!RECURRENCES.some(([v]) => v === recurrence) && <option value={recurrence}>{recurrenceLabel(recurrence)}</option>}
        </SelectField>
        {schedule && (
          <div className="notice schedule-preview" role="status">
            <p className="schedule-amount">
              <strong><Money cents={schedule[0]!.amount} /></strong> {t('plan.perMonthShort')}
            </p>
            <p>
              {t('plan.scheduleRange', { from: monthName(schedule[0]!.from), to: monthName(monthOf(due.iso!)) })}
              {schedule[1] && schedule[1].amount > 0 && <> {t('plan.scheduleThen', { from: monthName(schedule[1].from) })} <Money cents={schedule[1].amount} /> {t('plan.perMonthShort')}</>}
              {' '}{t('plan.scheduleAuto')}
            </p>
          </div>
        )}
        {error && <p className="error" role="alert">⚠ {error}</p>}
        <div className="row">
          <button className="button button-primary" disabled={busy}>{t('common.save')}</button>
          <button type="button" className="button button-quiet" onClick={onClose}>{t('common.cancel')}</button>
          {existing && (
            <button type="button" className="button button-danger push-right" onClick={() => void deleteProvision(vault, existing).then(onClose)}>
              {t('common.delete')}
            </button>
          )}
        </div>
      </form>
    </Dialog>
  );
}

// ------------------------------------------------------------------- events

function Events() {
  const events = useStore('events');
  const allocations = useStore('allocations');
  const input = useBudgetInput();
  const [editing, setEditing] = useState<EventFund | 'new' | null>(null);
  const [closing, setClosing] = useState<EventFund | null>(null);
  const [viewing, setViewing] = useState<EventFund | null>(null);
  const month = currentMonth();
  const bucketsView = useBuckets().views;
  const views = useMemo(
    () => events.map((e) => eventStatus(e, input, month, allocations)).sort((a, b) => Number(a.event.status === 'closed') - Number(b.event.status === 'closed') || a.event.targetDate.localeCompare(b.event.targetDate)),
    [events, input, month, allocations],
  );

  return (
    <>
      <div className="page-head">
        <p className="muted">{t('plan.eventsIntro')}</p>
        <button type="button" className="button button-primary button-small" onClick={() => setEditing('new')}>
          <Icon name="plus" size={18} />
          {t('plan.add')}
        </button>
      </div>
      {views.length === 0 && <p className="notice">{t('plan.noEvents')}</p>}
      {views.map((v) => (
        <section key={v.event.id} className="card event-card" aria-labelledby={`ev-${v.event.id}`}>
          <div className="split-row">
            <h2 id={`ev-${v.event.id}`}>{v.event.name}</h2>
            <span className="badge">{t(`plan.status.${v.event.status}` as MessageKey)}</span>
          </div>
          <p className="muted">
            {formatDate(v.event.targetDate)} · {t('plan.target')} <Money cents={v.event.targetAmount} />
          </p>
          {(() => {
            const bk = bucketsView.get(v.event.categoryId)!;
            const closed = v.event.status === 'closed';
            const pct = closed ? v.fundedPercent : bk.target > 0 ? Math.max(0, Math.min(100, Math.round(((bk.loaded) / bk.target) * 100))) : 0;
            return (
              <>
                <span className="row-bar" aria-hidden="true"><span style={{ width: `${Math.min(100, pct)}%` }} /></span>
                <ul className="plain-list facts">
                  <li className="split-row"><span>{bk.tracked && !closed ? t('bucket.loaded') : t('plan.funded')}</span><span>{pct}%</span></li>
                  <li className="split-row"><span>{t('plan.spent')}</span><Money cents={v.spent} /></li>
                  <li className="split-row"><span>{t('plan.leftInFund')}</span><strong><Money cents={closed ? v.available : bk.level} /></strong></li>
                  {bk.tracked && !closed && bk.behind > 0 && (
                    <li className="split-row"><span className="bad">{t('bucket.behind')}</span><strong className="bad"><Money cents={bk.behind} /></strong></li>
                  )}
                </ul>
              </>
            );
          })()}
          <ul className="plain-list facts">
            {v.event.status !== 'closed' && v.suggested > 0 && (
              <li className="split-row"><span>{t('plan.budgetedThisMonth')}</span><Money cents={v.suggested} /></li>
            )}
            {v.event.status === 'closed' && v.event.closeDisposition && (
              <li className="split-row"><span>{v.event.closeDisposition.amount >= 0 ? t('plan.surplusMoved') : t('plan.deficitCovered')}</span><Money cents={Math.abs(v.event.closeDisposition.amount)} /></li>
            )}
          </ul>
          {v.bySubBudget.length > 0 && (
            <>
              <h3>{t('plan.subBudgets')}</h3>
              <ul className="plain-list facts">
                {v.bySubBudget.map((b) => (
                  <li key={b.name} className="split-row">
                    <span>
                      {b.name}
                      <span className="muted"> · {b.paid ? t('plan.paidShort') : t('plan.byDate', { date: formatDate(b.due) })}</span>
                    </span>
                    <span>
                      <Money cents={b.spent} /> / <Money cents={b.budget} />
                      {b.spent > b.budget && <span className="badge badge-warn">⚠ {t('budget.over')}</span>}
                    </span>
                  </li>
                ))}
                {v.unassignedSpent !== 0 && (
                  <li className="split-row"><span className="muted">{t('plan.otherSpending')}</span><Money cents={v.unassignedSpent} /></li>
                )}
              </ul>
            </>
          )}
          {v.event.status !== 'closed' && (
            <div className="row">
              <button type="button" className="button button-small" onClick={() => setViewing(v.event)}>{t('bucket.transactions')}</button>
              <button type="button" className="button button-small" onClick={() => setEditing(v.event)}>{t('common.edit')}</button>
              <button type="button" className="button button-small" onClick={() => setClosing(v.event)}>{t('plan.close')}</button>
            </div>
          )}
        </section>
      ))}
      <p className="hint">{t('plan.eventsHow')}</p>
      {editing && <EventDialog existing={editing === 'new' ? undefined : editing} onClose={() => setEditing(null)} />}
      {closing && <CloseDialog event={closing} onClose={() => setClosing(null)} />}
      {viewing && <BucketDialog name={viewing.name} window={tripWindow(viewing)} onClose={() => setViewing(null)} />}
    </>
  );
}

interface PartDraft {
  name: string;
  amount: string;
  due: string;
  paidMonth?: string;
}

function EventDialog({ existing, onClose }: { existing: EventFund | undefined; onClose: () => void }) {
  const vault = useVault();
  const notify = useToast();
  const [name, setName] = useState(existing?.name ?? '');
  const amount = useMoneyInput(existing?.targetAmount);
  const date = useDateInput(existing?.targetDate ?? todayIso());
  const start = useDateInput(existing?.startDate ?? (existing ? existing.createdAt.slice(0, 10) : todayIso()));
  const [subs, setSubs] = useState<PartDraft[]>(
    existing?.subBudgets.map((s) => ({ name: s.name, amount: formatMoneyInput(s.amount), due: s.dueDate ?? '', ...(s.paidMonth ? { paidMonth: s.paidMonth } : {}) })) ?? [],
  );
  const [error, setError] = useState<string>();

  const parsed = subs
    .filter((s) => s.name.trim())
    .map((s): SubBudget | null => {
      const cents = s.amount.trim() ? parseMoney(s.amount) : 0;
      if (cents === null || cents < 0) return null;
      return { name: s.name.trim(), amount: cents, ...(s.due ? { dueDate: s.due } : {}), ...(s.paidMonth ? { paidMonth: s.paidMonth } : {}) };
    });
  const valid = parsed.every((x) => x !== null);
  const subBudgets = parsed.filter((x): x is SubBudget => x !== null);
  const partsTotal = subBudgets.reduce((s, x) => s + x.amount, 0);
  const preview =
    amount.cents && date.iso && start.iso && valid
      ? eventPlanParts({ ...(existing ?? ({ createdAt: `${todayIso()}T00:00:00Z` } as EventFund)), name, targetAmount: amount.cents, targetDate: date.iso, startDate: start.iso, subBudgets })
      : null;

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!name.trim()) return setError(t('plan.nameRequired'));
    if (!amount.cents || amount.cents <= 0) return setError(t('tx.amountRequired'));
    if (!date.iso || !start.iso) return setError(t('field.dateInvalid'));
    if (!valid) return setError(t('field.moneyInvalid'));
    if (partsTotal > amount.cents) return setError(t('plan.partsOverTarget'));
    await saveEvent(vault, { name: name.trim(), targetAmount: amount.cents, targetDate: date.iso, startDate: start.iso, subBudgets }, existing);
    notify(t('plan.saved', { name: name.trim() }));
    onClose();
  }

  const set = (i: number, patch: Partial<PartDraft>) => setSubs(subs.map((x, j) => (j === i ? { ...x, ...patch } : x)));
  return (
    <Dialog open title={existing ? t('plan.editEvent') : t('plan.newEvent')} onClose={onClose}>
      <form onSubmit={submit} noValidate>
        <TextField label={t('plan.name')} value={name} onChange={(e) => setName(e.target.value)} placeholder={t('plan.eventExample')} autoFocus />
        <DateField label={t('plan.startDate')} state={start} hint={t('plan.startDateHint')} />
        <DateField label={t('plan.eventDate')} state={date} />
        <MoneyField label={t('plan.targetAmount')} state={amount} hint={t('plan.tripTotalHint')} />
        <fieldset>
          <legend>{t('plan.parts')}</legend>
          <p className="hint">{t('plan.partsHint')}</p>
          {subs.map((s, i) => (
            <div key={i} className="card part-card">
              <TextField label={t('plan.subName', { n: i + 1 })} value={s.name} placeholder={t('plan.subExample')} onChange={(e) => set(i, { name: e.target.value })} />
              <TextField label={t('plan.subAmount', { n: i + 1 })} inputMode="decimal" value={s.amount} placeholder="0,00" onChange={(e) => set(i, { amount: e.target.value })} />
              <TextField label={t('plan.partDue')} type="date" value={s.due} onChange={(e) => set(i, { due: e.target.value })} hint={t('plan.partDueHint')} />
              {existing && (
                <label className="check">
                  <input type="checkbox" checked={!!s.paidMonth} onChange={(e) => set(i, e.target.checked ? { paidMonth: currentMonth() } : { paidMonth: undefined })} />
                  {t('plan.partPaid')}
                </label>
              )}
              <button type="button" className="button button-quiet button-small" onClick={() => setSubs(subs.filter((_, j) => j !== i))}>{t('plan.removePart')}</button>
            </div>
          ))}
          <button type="button" className="button button-quiet button-small" onClick={() => setSubs([...subs, { name: '', amount: '', due: '' }])}>+ {t('plan.addSub')}</button>
        </fieldset>
        {preview && (
          <div className="notice" role="status">
            <p><strong>{t('plan.tripPlan')}</strong></p>
            <ul className="plain-list">
              {preview.map((p) => {
                const first = planPartAmount(p, p.start, 0);
                return (
                  <li key={p.key || 'rest'} className="split-row">
                    <span>{p.key || (subBudgets.length ? t('plan.restOfTrip') : name || t('plan.trip'))} · {t('plan.until', { month: monthName(p.due) })}</span>
                    <span>{p.doneMonth ? t('plan.paidShort') : <><Money cents={first} /> {t('plan.perMonthShort')}</>}</span>
                  </li>
                );
              })}
            </ul>
            <p className="hint">{t('plan.tripPlanHint')}</p>
          </div>
        )}
        {error && <p className="error" role="alert">⚠ {error}</p>}
        <div className="row">
          <button className="button button-primary">{t('common.save')}</button>
          <button type="button" className="button button-quiet" onClick={onClose}>{t('common.cancel')}</button>
          {existing && (
            <button type="button" className="button button-danger push-right" onClick={() => void deleteEvent(vault, existing).then(onClose)}>{t('common.delete')}</button>
          )}
        </div>
      </form>
    </Dialog>
  );
}

function CloseDialog({ event, onClose }: { event: EventFund; onClose: () => void }) {
  const vault = useVault();
  const notify = useToast();
  const input = useBudgetInput();
  const categories = useStore('categories');
  const settings = useSettings();
  const targets = categories.filter((c) => !c.isIncome && !c.archivedAt && c.id !== event.categoryId);
  const [target, setTarget] = useState(settings.sweepTargetCategoryId && targets.some((c) => c.id === settings.sweepTargetCategoryId) ? settings.sweepTargetCategoryId : targets[0]?.id ?? '');
  const month = currentMonth();
  const plan = target ? planCloseEvent(event, input, month, target) : null;

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!plan) return;
    await closeEvent(vault, event, plan, target, month);
    notify(t('plan.closed', { name: event.name }));
    onClose();
  }

  return (
    <Dialog open title={t('plan.closeTitle', { name: event.name })} onClose={onClose}>
      <form onSubmit={submit} noValidate>
        {plan && (
          <p className="notice">
            {plan.moved >= 0 ? t('plan.closeSurplus') : t('plan.closeDeficit')} <strong><Money cents={Math.abs(plan.moved)} /></strong>
          </p>
        )}
        <SelectField label={plan && plan.moved < 0 ? t('plan.coverFrom') : t('plan.moveTo')} value={target} onChange={(e) => setTarget(e.target.value)}>
          {targets.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </SelectField>
        <p className="hint">{t('plan.closeHint', { month: monthName(monthOf(todayIso())) })}</p>
        <div className="row">
          <button className="button button-primary" disabled={!plan}>{t('plan.close')}</button>
          <button type="button" className="button button-quiet" onClick={onClose}>{t('common.cancel')}</button>
        </div>
      </form>
    </Dialog>
  );
}

// re-exported helpers for other pages
export { formatRecurrence, parseDate };
export type { Recurrence };
