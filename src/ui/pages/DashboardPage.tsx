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
      <h1>{t('nav.dashboard')}</h1>
      {backupDue && (
        <p className="notice notice-warn">
          <span aria-hidden="true">⚠ </span>
          {lastBackup ? t('dashboard.backupOld', { days: BACKUP_NAG_DAYS }) : t('dashboard.backupNever')}{' '}
          <a href={href('settings', { section: 'backup' })}>{t('dashboard.backupNow')}</a>
        </p>
      )}
      <div className="grid">
        {budget && (
          <div className="card card-span">
            <ReadyToAssign month={budget} />
            <a className="button" href={href(`budget/${month}`)}>{t('dashboard.openBudget')}</a>
          </div>
        )}

        <section className="card" aria-labelledby="inbox-h">
          <h2 id="inbox-h">{t('dashboard.inbox')}</h2>
          <p className="big-number">{inbox}</p>
          <p>{inbox === 0 ? t('dashboard.inboxEmpty') : t('dashboard.inboxCount', { n: inbox })}</p>
          {inbox > 0 ? <a href={href('inbox')}>{t('dashboard.inboxReview')}</a> : <a href={href('import')}>{t('dashboard.importStatements')}</a>}
        </section>

        <section className="card" aria-labelledby="cash-h">
          <h2 id="cash-h">{t('dashboard.accounts')}</h2>
          <ul className="plain-list">
            {open.map((a) => (
              <li key={a.id} className="split-row">
                <span>
                  {a.name}
                  {!isOnBudget(a) && <span className="tag">{t('accounts.offBudget')}</span>}
                </span>
                <Money cents={balances.get(a.id) ?? 0} />
              </li>
            ))}
          </ul>
          <p className="split-row total">
            <span>{t('dashboard.cashTotal')}</span>
            <Money cents={cash} />
          </p>
          {open.length === 0 && <a href={href('accounts')}>{t('dashboard.addAccount')}</a>}
        </section>

        {budget && (
          <section className="card card-span" aria-labelledby="bva-h">
            <h2 id="bva-h">{t('dashboard.budgetVsActual', { month: monthName(month) })}</h2>
            <table className="table">
              <thead>
                <tr>
                  <th scope="col">{t('budget.group')}</th>
                  <th scope="col" className="num">{t('budget.assigned')}</th>
                  <th scope="col" className="num">{t('budget.spent')}</th>
                  <th scope="col" className="hide-narrow">{t('budget.progress')}</th>
                </tr>
              </thead>
              <tbody>
                {CATEGORY_GROUPS.filter((g) => byGroup.has(g)).map((g) => {
                  const r = byGroup.get(g)!;
                  const pct = r.assigned > 0 ? Math.round((r.spent / r.assigned) * 100) : r.spent > 0 ? 100 : 0;
                  return (
                    <tr key={g}>
                      <th scope="row">{groupLabel(g)}</th>
                      <td className="num"><Money cents={r.assigned} /></td>
                      <td className="num"><Money cents={r.spent} /></td>
                      <td className="hide-narrow">
                        <Meter percent={pct} label={t('budget.percentSpent', { pct })} />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </section>
        )}

        {budget && funds.length > 0 && (
          <section className="card card-span" aria-labelledby="funds-h">
            <h2 id="funds-h">{t('dashboard.funds')}</h2>
            <ul className="plain-list">
              {funds.map((c) => (
                <li key={c.id} className="split-row">
                  <span>
                    {c.name} <span className="tag">{groupLabel(c.groupId)}</span>
                  </span>
                  <Money cents={budget.categories.get(c.id)?.available ?? 0} />
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
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
