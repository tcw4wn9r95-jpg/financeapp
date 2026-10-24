import { useMemo } from 'react';
import { accountBalances, invested, isOnBudget } from '../../domain/budget';
import { compareMonths, currentMonth, formatDate, todayIso } from '../../domain/dates';
import { eventStatus, provisionStatus } from '../../domain/plan';
import { LineChart } from '../components/LineChart';
import { CATEGORY_GROUPS, type CategoryGroup } from '../../domain/types';
import { monthName, t } from '../../i18n';
import { Money } from '../components/Money';
import { ReadyToAssign } from '../components/ReadyToAssign';
import { useBuckets, useBudgetInput, useBudgetMonth, useDocumentTitle, useForecast, useSettings, useStore } from '../hooks';
import { href } from '../router';
import { groupLabel } from '../labels';
import { Icon } from '../components/Icon';
import { InsightList, useSpendingAnalysis } from './InsightsPage';

const BACKUP_NAG_DAYS = 7;

export function DashboardPage() {
  useDocumentTitle(t('nav.dashboard'));
  const month = currentMonth();
  const settings = useSettings();
  const budget = useBudgetMonth(month);
  const accounts = useStore('accounts');
  const categories = useStore('categories');
  const transactions = useStore('transactions');
  const inbox = transactions.filter((tx) => tx.status === 'new' || tx.status === 'suggested').length;
  const balances = useMemo(() => accountBalances(accounts, transactions, todayIso()), [accounts, transactions]);
  const open = accounts.filter((a) => !a.closedAt);
  const cash = open.filter(isOnBudget).reduce((s, a) => s + (balances.get(a.id) ?? 0), 0);

  const budgetInput = useBudgetInput();
  const analysis = useSpendingAnalysis('6');
  const topInsights = analysis.insights.filter((i) => i.severity !== 'info' && i.kind !== 'unfiled').slice(0, 3);
  const inv = useMemo(() => invested(budgetInput, month), [budgetInput, month]);
  const provisions = useStore('provisions');
  const events = useStore('events');
  // Provisions and trips filled from the provisions account's balance (D-69).
  const summary = useBuckets();
  const bucketView = summary.views;
  const provAccount = accounts.find((a) => a.id === settings.provisionsAccountId);
  const moveLeft = provAccount && summary.toMove > 0 ? { name: provAccount.name, left: summary.toMove } : null;

  const tripPct = (id: string) => {
    const b = bucketView.get(id);
    return b && b.target > 0 ? Math.max(0, Math.min(100, Math.round((b.loaded / b.target) * 100))) : 0;
  };

  const lastBackup = settings.lastBackupAt ? new Date(settings.lastBackupAt) : null;
  const backupDue = !lastBackup || Date.now() - lastBackup.getTime() > BACKUP_NAG_DAYS * 86_400_000;

  const byGroup = useMemo(() => {
    const rows = new Map<CategoryGroup, { assigned: number; spent: number; available: number }>();
    if (!budget) return rows;
    for (const c of categories) {
      if (c.isIncome) continue;
      const m = budget.categories.get(c.id);
      if (!m) continue;
      const r = rows.get(c.groupId) ?? { assigned: 0, spent: 0, available: 0 };
      r.assigned += m.assigned;
      r.spent += -m.activity;
      r.available += m.available;
      rows.set(c.groupId, r);
    }
    return rows;
  }, [budget, categories]);

  const input = useBudgetInput();
  const allocations = useStore('allocations');
  const fc = useForecast(4);
  const days90 = fc.days.slice(0, 91);
  const low90 = days90.reduce((lo, d) => (d.balance < lo.balance ? d : lo), days90[0]!);
  const provisionRows = useMemo(() => provisions.map((p) => provisionStatus(p, input, month, todayIso())).sort((a, b) => a.nextDue.localeCompare(b.nextDue)), [provisions, input, month]);
  const eventRows = useMemo(() => events.filter((e) => e.status !== 'closed').map((e) => eventStatus(e, input, month, allocations)), [events, input, month, allocations]);
  const linked = new Set([...provisions.map((p) => p.categoryId), ...events.map((e) => e.categoryId)]);

  const funds = categories
    .filter((c) => !c.isIncome && !c.archivedAt && (c.groupId === 'provisions' || c.groupId === 'events' || c.groupId === 'savings'))
    .sort((a, b) => CATEGORY_GROUPS.indexOf(a.groupId) - CATEGORY_GROUPS.indexOf(b.groupId) || a.sortOrder - b.sortOrder);

  if (compareMonths(month, settings.budgetStartMonth) < 0) {
    return (
      <>
        <h1>{t('nav.dashboard')}</h1>
        <p className="notice">{t('dashboard.beforeStart', { month: monthName(settings.budgetStartMonth) })}</p>
      </>
    );
  }

  return (
    <>
      <h1 className="visually-hidden">{t('nav.dashboard')}</h1>
      {budget && (
        <a className="hero-link" href={href(`budget/${month}`)} aria-label={t('dashboard.openBudget')}>
          <ReadyToAssign month={budget} />
        </a>
      )}

      {inbox > 0 && (
        <a className="action-row" href={href('inbox')}>
          <span className="nav-count">{inbox}</span>
          <span>{t('dashboard.inboxCount', { n: inbox })}</span>
          <Icon name="chevronRight" size={18} />
        </a>
      )}
      {inv.total !== 0 && (
        <a className="action-row" href={href(`budget/${month}`)}>
          <span aria-hidden="true">↗</span>
          <span>
            {t('invest.dashboard')}: <strong><Money cents={inv.total} /></strong>{' '}
            <span className="muted">· <Money cents={inv.year} /> {t('invest.thisYear')}</span>
          </span>
          <Icon name="chevronRight" size={18} />
        </a>
      )}
      {moveLeft && (
        <a className="action-row" href={href('plan', { tab: 'provisions' })}>
          <span aria-hidden="true">→</span>
          <span>{t('move.dashboard', { name: moveLeft.name })} <strong><Money cents={moveLeft.left} /></strong></span>
          <Icon name="chevronRight" size={18} />
        </a>
      )}
      {backupDue && (
        <a className="action-row action-row-warn" href={href('settings', { section: 'backup' })}>
          <span aria-hidden="true">⚠</span>
          <span>{lastBackup ? t('dashboard.backupOld', { days: BACKUP_NAG_DAYS }) : t('dashboard.backupNever')}</span>
          <Icon name="chevronRight" size={18} />
        </a>
      )}

      {topInsights.length > 0 && (
        <section className="group dash-insights" aria-labelledby="dins-h">
          <div className="group-head">
            <h2 id="dins-h">{t('dash.insights')}</h2>
            <a className="muted" href={href('insights')}>{t('dash.insightsAll')}</a>
          </div>
          <InsightList insights={topInsights} />
        </section>
      )}

      {open.length > 0 && budget && (
        <section className="group" aria-labelledby="cash90-h">
          <div className="group-head">
            <h2 id="cash90-h">{t('dashboard.next90')}</h2>
            <a className="muted" href={href('plan')}>{t('dashboard.toPlan')}</a>
          </div>
          <div className="card">
            <p className="split-row">
              <span className="muted">{t('dashboard.in90', { date: formatDate(days90.at(-1)!.date) })}</span>
              <strong><Money cents={days90.at(-1)!.balance} /></strong>
            </p>
            <p className="split-row">
              <span className="muted">{t('dashboard.low90', { date: formatDate(low90.date) })}</span>
              <span className={settings.minimumBuffer && low90.balance < settings.minimumBuffer ? 'bad' : ''}>
                {settings.minimumBuffer && low90.balance < settings.minimumBuffer ? '⚠ ' : ''}
                <Money cents={low90.balance} />
              </span>
            </p>
            <LineChart
              title={t('dashboard.next90')}
              labels={days90.map((d) => formatDate(d.date))}
              axisLabels={days90.map((d) => formatDate(d.date).slice(0, 5))}
              series={[{ name: t('dashboard.cash'), color: 'var(--series-1)', values: days90.map((d) => d.balance) }]}
              height={150}
              {...(settings.minimumBuffer ? { reference: { value: settings.minimumBuffer, label: t('plan.buffer') } } : {})}
            />
          </div>
        </section>
      )}

      <section className="group" aria-labelledby="cash-h">
        <div className="group-head">
          <h2 id="cash-h">{t('dashboard.accounts')}</h2>
          <span className="muted"><Money cents={cash} /></span>
        </div>
        {open.length === 0 ? (
          <p className="muted"><a href={href('accounts')}>{t('dashboard.addAccount')}</a></p>
        ) : (
          <ul className="rows">
            {open.map((a) => (
              <li key={a.id}>
                <a className="row-button" href={href('transactions', { account: a.id })}>
                  <span className="row-main">
                    <span className="row-title">{a.name}</span>
                    {!isOnBudget(a) && <span className="row-sub">{t('accounts.offBudget')}</span>}
                  </span>
                  <span className="row-end"><Money cents={balances.get(a.id) ?? 0} className="row-amount" /></span>
                </a>
              </li>
            ))}
          </ul>
        )}
      </section>

      {budget && byGroup.size > 0 && (
        <section className="group" aria-labelledby="bva-h">
          <div className="group-head">
            <h2 id="bva-h">{t('dashboard.budgetVsActual', { month: monthName(month) })}</h2>
          </div>
          <ul className="rows">
            {CATEGORY_GROUPS.filter((g) => byGroup.has(g)).map((g) => {
              const r = byGroup.get(g)!;
              const pct = r.assigned > 0 ? Math.round((r.spent / r.assigned) * 100) : r.spent > 0 ? 100 : 0;
              return (
                <li key={g} className="row-static">
                  <span className="row-main">
                    <span className="row-title">{groupLabel(g)}</span>
                    <span className="row-sub">
                      <Money cents={r.spent} /> {t('dashboard.of')} <Money cents={r.assigned} />
                    </span>
                    <Meter percent={pct} label={t('budget.percentSpent', { pct })} />
                  </span>
                </li>
              );
            })}
          </ul>
        </section>
      )}

      {(provisionRows.length > 0 || eventRows.length > 0 || (budget && funds.length > 0)) && (
        <section className="group" aria-labelledby="funds-h">
          <div className="group-head">
            <h2 id="funds-h">{t('dashboard.funds')}</h2>
            <a className="muted" href={href('plan', { tab: 'provisions' })}>{t('dashboard.toPlan')}</a>
          </div>
          <ul className="rows">
            {provisionRows.map((r) => (
              <li key={r.provision.id} className="row-static">
                <span className="row-main">
                  <span className="row-title">{r.provision.name}</span>
                  <span className="row-sub">{t('dashboard.due', { date: formatDate(r.nextDue) })} · <Money cents={r.provision.amount} /></span>
                  <span className="row-bar" aria-hidden="true"><span style={{ width: `${bucketView.get(r.provision.categoryId)?.percent ?? 0}%` }} /></span>
                </span>
                <span className="row-end"><Money cents={bucketView.get(r.provision.categoryId)?.level ?? 0} className="row-amount" /></span>
              </li>
            ))}
            {eventRows.map((v) => (
              <li key={v.event.id} className="row-static">
                <span className="row-main">
                  <span className="row-title">{v.event.name}</span>
                  <span className="row-sub">{formatDate(v.event.targetDate)} · {t('dashboard.funded', { pct: tripPct(v.event.categoryId) })}</span>
                  <span className="row-bar" aria-hidden="true"><span style={{ width: `${tripPct(v.event.categoryId)}%` }} /></span>
                </span>
                <span className="row-end"><Money cents={bucketView.get(v.event.categoryId)?.level ?? 0} className="row-amount" /></span>
              </li>
            ))}
            {budget && funds.filter((c) => !linked.has(c.id)).map((c) => (
              <li key={c.id} className="row-static">
                <span className="row-main">
                  <span className="row-title">{c.name}</span>
                  <span className="row-sub">{groupLabel(c.groupId)}</span>
                </span>
                <span className="row-end"><Money cents={budget.categories.get(c.id)?.available ?? 0} className="row-amount" /></span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </>
  );
}

/** Progress bar with its value in text; over 100% gets a marker and a word. */
export function Meter({ percent, label }: { percent: number; label: string }) {
  const over = percent > 100;
  return (
    <span className={`meter ${over ? 'meter-over' : ''}`}>
      <span className="meter-track" aria-hidden="true">
        <span className="meter-fill" style={{ width: `${Math.min(100, Math.max(0, percent))}%` }} />
      </span>
      <span className="meter-text">
        {label}
        {over && ` · ${t('budget.over')}`}
      </span>
    </span>
  );
}
