import { useState, type FormEvent } from 'react';
import type { CategoryMonth } from '../../domain/budget';
import { currentMonth, isMonthKey } from '../../domain/dates';
import { CATEGORY_GROUPS, type Category, type MonthKey } from '../../domain/types';
import { monthName, t } from '../../i18n';
import { resetOverride, setDefaultFrom, setOverride } from '../actions';
import { Dialog } from '../components/Dialog';
import { MoneyField, TextField, useMoneyInput } from '../components/fields';
import { Money } from '../components/Money';
import { MonthNav } from '../components/MonthNav';
import { ReadyToAssign } from '../components/ReadyToAssign';
import { useToast } from '../components/Toast';
import { useBudgetMonth, useDocumentTitle, useSettings, useStore, useVault } from '../hooks';
import { groupLabel, rolloverLabel } from '../labels';
import { href, navigate, useRoute } from '../router';

export function BudgetPage() {
  useDocumentTitle(t('nav.budget'));
  const route = useRoute();
  const param = route.path[1];
  const month = param && isMonthKey(param) ? param : currentMonth();
  const settings = useSettings();
  const budget = useBudgetMonth(month);
  const categories = useStore('categories');
  const [editing, setEditing] = useState<Category | null>(null);
  const setMonth = (m: MonthKey) => navigate(`budget/${m}`);

  const expense = categories.filter((c) => !c.isIncome);
  const income = categories.filter((c) => c.isIncome).sort((a, b) => a.sortOrder - b.sortOrder);

  return (
    <>
      <h1>{t('nav.budget')}</h1>
      <MonthNav month={month} onChange={setMonth} />
      {!budget ? (
        <p className="notice">
          {t('budget.beforeStart', { month: monthName(settings.budgetStartMonth) })}{' '}
          <button type="button" className="link-button" onClick={() => setMonth(settings.budgetStartMonth)}>
            {t('budget.goToStart')}
          </button>
        </p>
      ) : (
        <>
          <ReadyToAssign month={budget} />
          {expense.length === 0 && (
            <p className="notice">
              {t('budget.noCategories')} <a href={href('categories')}>{t('budget.addCategories')}</a>
            </p>
          )}
          {CATEGORY_GROUPS.map((g) => {
            const cats = expense.filter((c) => c.groupId === g).sort((a, b) => a.sortOrder - b.sortOrder);
            if (cats.length === 0) return null;
            const rows = cats.map((c) => [c, budget.categories.get(c.id)!] as const);
            const sum = (k: 'assigned' | 'activity' | 'available') => rows.reduce((s, [, m]) => s + m[k], 0);
            return (
              <section key={g} className="budget-group" aria-labelledby={`g-${g}`}>
                <table className="table budget-table">
                  <caption id={`g-${g}`}>{groupLabel(g)}</caption>
                  <thead>
                    <tr>
                      <th scope="col">{t('budget.category')}</th>
                      <th scope="col" className="num">{t('budget.assigned')}</th>
                      <th scope="col" className="num hide-narrow">{t('budget.activity')}</th>
                      <th scope="col" className="num">{t('budget.available')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map(([c, m]) => (
                      <BudgetRow key={c.id} category={c} m={m} onEdit={() => setEditing(c)} />
                    ))}
                  </tbody>
                  <tfoot>
                    <tr>
                      <th scope="row">{t('budget.total')}</th>
                      <td className="num"><Money cents={sum('assigned')} /></td>
                      <td className="num hide-narrow"><Money cents={sum('activity')} /></td>
                      <td className="num"><Money cents={sum('available')} /></td>
                    </tr>
                  </tfoot>
                </table>
              </section>
            );
          })}

          <section className="card" aria-labelledby="income-h">
            <h2 id="income-h">{t('budget.incomeTitle')}</h2>
            <ul className="plain-list">
              <li className="split-row">
                <span>{t('budget.incomeReceived')}</span>
                <Money cents={budget.income} />
              </li>
              <li className="split-row">
                <span>{t('budget.assignedThisMonth')}</span>
                <Money cents={-budget.assignedTotal} />
              </li>
              {budget.returnedFromLastMonth !== 0 && (
                <li className="split-row">
                  <span>{t('budget.returned')}</span>
                  <Money cents={budget.returnedFromLastMonth} plusSign />
                </li>
              )}
              {budget.uncategorised !== 0 && (
                <li className="split-row">
                  <span>
                    {t('budget.uncategorised')} <a href={href('transactions', { filter: 'new', month })}>{t('budget.review')}</a>
                  </span>
                  <Money cents={budget.uncategorised} />
                </li>
              )}
            </ul>
            {income.length > 0 && <p className="hint">{t('budget.incomeHint', { names: income.map((c) => c.name).join(', ') })}</p>}
          </section>
        </>
      )}
      {editing && budget && (
        <AssignDialog category={editing} month={month} m={budget.categories.get(editing.id)!} onClose={() => setEditing(null)} />
      )}
    </>
  );
}

function BudgetRow({ category, m, onEdit }: { category: Category; m: CategoryMonth; onEdit: () => void }) {
  const over = m.available < 0;
  return (
    <tr className={over ? 'row-over' : ''}>
      <th scope="row">
        <span className="cat-name">{category.name}</span>
        <span className="cat-meta">
          {rolloverLabel(category.rolloverMode)}
          {m.carryIn !== 0 && (
            <>
              {' · '}
              {t('budget.carryIn')} <Money cents={m.carryIn} />
            </>
          )}
        </span>
        <span className="cat-meta show-narrow">
          {t('budget.activity')}: <Money cents={m.activity} />
        </span>
      </th>
      <td className="num">
        <button type="button" className="amount-button" onClick={onEdit} aria-label={t('budget.editAssigned', { name: category.name })}>
          <Money cents={m.assigned} />
          {m.overrideId && <span className="badge">{t('budget.overrideBadge')}</span>}
        </button>
      </td>
      <td className="num hide-narrow">
        <Money cents={m.activity} />
      </td>
      <td className="num">
        <Money cents={m.available} />
        {over && <span className="badge badge-warn">⚠ {t('budget.overspent')}</span>}
      </td>
    </tr>
  );
}

function AssignDialog({ category, month, m, onClose }: { category: Category; month: MonthKey; m: CategoryMonth; onClose: () => void }) {
  const vault = useVault();
  const notify = useToast();
  const amount = useMoneyInput(m.assigned);
  const existingNote = vault.list('budgetOverrides').find((o) => o.id === m.overrideId)?.note ?? '';
  const [note, setNote] = useState(existingNote);
  const [busy, setBusy] = useState(false);
  const cents = amount.cents;
  const invalid = cents === null || cents < 0;

  const run = async (fn: () => Promise<void>, message: string) => {
    setBusy(true);
    try {
      await fn();
      notify(message);
      onClose();
    } catch {
      notify(t('common.unexpectedError'), 'error');
      setBusy(false);
    }
  };

  const submitOverride = (e: FormEvent) => {
    e.preventDefault();
    if (invalid) return;
    void run(() => setOverride(vault, category.id, month, cents, note.trim()), t('budget.savedOverride', { name: category.name, month: monthName(month) }));
  };

  return (
    <Dialog open title={t('budget.assignTitle', { name: category.name, month: monthName(month) })} onClose={onClose}>
      <form onSubmit={submitOverride} noValidate>
        <p>
          {t('budget.defaultIs')} <Money cents={m.defaultAmount} />
          {m.overrideId && (
            <>
              {' · '}
              <span className="badge">{t('budget.overrideBadge')}</span>
            </>
          )}
        </p>
        <MoneyField label={t('budget.amountFor', { month: monthName(month) })} state={amount} error={cents !== null && cents < 0 ? t('budget.negativeAssign') : undefined} autoFocus />
        <TextField label={t('budget.note')} value={note} onChange={(e) => setNote(e.target.value)} hint={t('budget.noteHint')} />
        <div className="stack">
          <button className="button button-primary" disabled={busy || invalid}>
            {t('budget.saveThisMonth')}
          </button>
          <button
            type="button"
            className="button"
            disabled={busy || invalid}
            onClick={() => void run(() => setDefaultFrom(vault, category.id, cents!, month), t('budget.savedDefault', { name: category.name, month: monthName(month) }))}
          >
            {t('budget.saveDefaultFrom', { month: monthName(month) })}
          </button>
          {m.overrideId && (
            <button type="button" className="button button-quiet" disabled={busy} onClick={() => void run(() => resetOverride(vault, m.overrideId!), t('budget.resetDone'))}>
              {t('budget.resetToDefault')}
            </button>
          )}
        </div>
      </form>
    </Dialog>
  );
}
