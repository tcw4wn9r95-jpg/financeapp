import { useMemo } from 'react';
import { accountBalances, isOnBudget } from '../../domain/budget';
import { compareMonths, currentMonth, todayIso } from '../../domain/dates';
import { CATEGORY_GROUPS, type CategoryGroup } from '../../domain/types';
import { monthName, t } from '../../i18n';
import { Money } from '../components/Money';
import { ReadyToAssign } from '../components/ReadyToAssign';
import { useBudgetMonth, useDocumentTitle, useSettings, useStore } from '../hooks';
import { href } from '../router';
import { groupLabel } from '../labels';
import { Icon } from '../components/Icon';

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

  const funds = categories
    .filter((c) => !c.isIncome && (c.groupId === 'provisions' || c.groupId === 'events' || c.groupId === 'savings'))
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
      {backupDue && (
        <a className="action-row action-row-warn" href={href('settings', { section: 'backup' })}>
          <span aria-hidden="true">⚠</span>
          <span>{lastBackup ? t('dashboard.backupOld', { days: BACKUP_NAG_DAYS }) : t('dashboard.backupNever')}</span>
          <Icon name="chevronRight" size={18} />
        </a>
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

      {budget && funds.length > 0 && (
        <section className="group" aria-labelledby="funds-h">
          <div className="group-head">
            <h2 id="funds-h">{t('dashboard.funds')}</h2>
          </div>
          <ul className="rows">
            {funds.map((c) => (
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
