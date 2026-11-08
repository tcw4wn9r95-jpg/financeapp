import { useMemo } from 'react';
import { invested } from '../../domain/budget';
import { compareMonths, currentMonth, formatDate, todayIso } from '../../domain/dates';
import { eventStatus, provisionStatus } from '../../domain/plan';
import { monthName, t } from '../../i18n';
import { Money } from '../components/Money';
import { ReadyToAssign } from '../components/ReadyToAssign';
import { useBuckets, useBudgetInput, useBudgetMonth, useDocumentTitle, useSettings, useStore } from '../hooks';
import { href } from '../router';
import { Icon } from '../components/Icon';
import { LogCard } from './LogPage';
import { CloseMonthBanner } from '../components/CloseMonth';
import { InsightList, useDismissed, useSpendingAnalysis } from './InsightsPage';

const BACKUP_NAG_DAYS = 7;

/** Morning, afternoon or evening, by the clock. */
function greetingKey(): 'home.morning' | 'home.afternoon' | 'home.evening' {
  const h = new Date().getHours();
  return h < 12 ? 'home.morning' : h < 18 ? 'home.afternoon' : 'home.evening';
}

export function DashboardPage() {
  useDocumentTitle(t('nav.dashboard'));
  const month = currentMonth();
  const settings = useSettings();
  const budget = useBudgetMonth(month);
  const accounts = useStore('accounts');
  const transactions = useStore('transactions');
  const inbox = transactions.filter((tx) => tx.status === 'new' || tx.status === 'suggested').length;

  const budgetInput = useBudgetInput();
  const analysis = useSpendingAnalysis('6');
  const dismissed = useDismissed();
  const topInsights = analysis.insights.filter((i) => i.severity !== 'info' && i.kind !== 'unfiled' && !dismissed.isDismissed(i)).slice(0, 2);
  const inv = useMemo(() => invested(budgetInput, month), [budgetInput, month]);
  const provisions = useStore('provisions');
  const events = useStore('events');
  // Provisions and trips filled from the provisions account's balance (D-69).
  const summary = useBuckets();
  const bucketView = summary.views;
  const provAccount = accounts.find((a) => a.id === settings.provisionsAccountId);
  const moveLeft = provAccount && summary.toMove > 0 ? { name: provAccount.name, left: summary.toMove } : null;

  const lastBackup = settings.lastBackupAt ? new Date(settings.lastBackupAt) : null;
  const backupDue = !lastBackup || Date.now() - lastBackup.getTime() > BACKUP_NAG_DAYS * 86_400_000;

  const input = useBudgetInput();
  const allocations = useStore('allocations');
  const provisionRows = useMemo(() => provisions.map((p) => provisionStatus(p, input, month, todayIso())).sort((a, b) => a.nextDue.localeCompare(b.nextDue)), [provisions, input, month]);
  const eventRows = useMemo(() => events.filter((e) => e.status !== 'closed').map((e) => eventStatus(e, input, month, allocations)), [events, input, month, allocations]);

  // The next bills: provisions and trips by due date, with what they hold (D-113).
  const coming = [
    ...provisionRows.map((r) => ({ id: r.provision.id, name: r.provision.name, date: r.nextDue, amount: r.provision.amount, held: bucketView.get(r.provision.categoryId)?.level ?? 0, kind: 'provisions' })),
    ...eventRows.map((v) => ({ id: v.event.id, name: v.event.name, date: v.event.targetDate, amount: v.event.targetAmount, held: bucketView.get(v.event.categoryId)?.level ?? 0, kind: 'events' })),
  ]
    .filter((c) => c.date >= todayIso())
    .sort((a, b) => a.date.localeCompare(b.date))
    .slice(0, 3);

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
      <header className="home-head">
        <p className="home-date">{new Date().toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' })}</p>
        <h1>{t(greetingKey())}</h1>
      </header>
      {budget && (
        <a className="hero-link" href={href(`budget/${month}`)} aria-label={t('dashboard.openBudget')}>
          <ReadyToAssign month={budget} />
        </a>
      )}
      <LogCard />

      <CloseMonthBanner />
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

      {coming.length > 0 && (
        <section className="group" aria-labelledby="coming-h">
          <div className="group-head">
            <h2 id="coming-h">{t('home.comingUp')}</h2>
            <a className="muted" href={href('plan', { tab: 'provisions' })}>{t('home.allProvisions')}</a>
          </div>
          <ul className="rows">
            {coming.map((c) => (
              <li key={c.id} className={`row-static coming kind-${c.kind}`}>
                <span className="coming-date" aria-hidden="true">
                  <b>{c.date.slice(8, 10)}</b>
                  <span>{monthName(c.date.slice(0, 7)).slice(0, 3)}</span>
                </span>
                <span className="row-main">
                  <span className="row-title">{c.name}</span>
                  <span className="row-sub">{formatDate(c.date)} · {c.held >= c.amount ? t('home.covered') : t('home.holds', { pct: c.amount > 0 ? Math.round((Math.max(0, c.held) / c.amount) * 100) : 0 })}</span>
                  <span className="row-bar" aria-hidden="true"><span style={{ width: `${c.amount > 0 ? Math.min(100, Math.round((Math.max(0, c.held) / c.amount) * 100)) : 0}%` }} /></span>
                </span>
                <span className="row-end"><Money cents={c.amount} className="row-amount" /></span>
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
