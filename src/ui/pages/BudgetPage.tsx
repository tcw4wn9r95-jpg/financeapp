import { useState, type FormEvent } from 'react';
import type { CategoryMonth } from '../../domain/budget';
import { compareMonths, currentMonth, isMonthKey } from '../../domain/dates';
import { CATEGORY_GROUPS, type Category, type MonthKey } from '../../domain/types';
import { monthName, t } from '../../i18n';
import { backdateToStart, saveSettings, resetOverride, setDefaultFrom, setOverride } from '../actions';
import { backdateDefaults } from '../../domain/budget';
import { Dialog } from '../components/Dialog';
import { MoneyField, TextField, useMoneyInput } from '../components/fields';
import { Money } from '../components/Money';
import { MonthNav } from '../components/MonthNav';
import { ReadyToAssign } from '../components/ReadyToAssign';
import { useToast } from '../components/Toast';
import { useBudgetMonth, useDocumentTitle, useSettings, useStore, useVault } from '../hooks';
import { groupLabel, rolloverLabel } from '../labels';
import { href, navigate, useRoute } from '../router';

/** "Keep as is" hides the hint until the app is reopened. */
let lateDismissed = false;

/** Monthly amounts that start after this month although the budget starts earlier: offer to carry them back (D-45). */
function LateAmounts({ month }: { month: MonthKey }) {
  const vault = useVault();
  const notify = useToast();
  const settings = useSettings();
  const defaults = useStore('budgetDefaults');
  const [hidden, setHidden] = useState(lateDismissed);
  const late = backdateDefaults(defaults, settings.budgetStartMonth)
    .map((d) => defaults.find((x) => x.id === d.id)!)
    .filter((d) => compareMonths(d.effectiveFrom, month) > 0);
  // Only when no category starts at the budget start: a set-up made before the
  // start was moved. Amounts deliberately starting later are left alone (D-47).
  const categoriesWithAmounts = new Set(defaults.map((d) => d.categoryId)).size;
  const anyFromStart = defaults.some((d) => compareMonths(d.effectiveFrom, settings.budgetStartMonth) <= 0);
  const sameMonth = new Set(late.map((d) => d.effectiveFrom)).size === 1;
  if (late.length < 2 || !sameMonth || hidden || settings.lateAmountsKept || anyFromStart || late.length < categoriesWithAmounts / 2) return null;
  const from = late.map((d) => d.effectiveFrom).sort()[0]!;
  return (
    <div className="notice notice-warn" role="status">
      <p>⚠ {t('budget.lateAmounts', { n: late.length, month: monthName(from) })}</p>
      <button
        type="button"
        className="button button-primary"
        onClick={() => void backdateToStart(vault).then((n) => notify(t(n === 1 ? 'settings.startMovedOne' : 'settings.startMoved', { n, month: monthName(settings.budgetStartMonth) })))}
      >
        {t('budget.applyFromStart', { month: monthName(settings.budgetStartMonth) })}
      </button>{' '}
      <button type="button" className="button button-quiet" onClick={() => { lateDismissed = true; setHidden(true); void saveSettings(vault, { lateAmountsKept: true }); }}>{t('budget.keepLate')}</button>
    </div>
  );
}

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

  const expense = categories.filter((c) => !c.isIncome && !c.archivedAt);
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
          <LateAmounts month={month} />
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
            const available = rows.reduce((s, [, m]) => s + m.available, 0);
            return (
              <section key={g} className="group" aria-labelledby={`g-${g}`}>
                <div className="group-head">
                  <h2 id={`g-${g}`}>{groupLabel(g)}</h2>
                  <span className="muted">
                    {t('budget.available')} <Money cents={available} />
                  </span>
                </div>
                <ul className="rows">
                  {rows.map(([c, m]) => (
                    <BudgetRow key={c.id} category={c} m={m} onEdit={() => setEditing(c)} />
                  ))}
                </ul>
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

/** One category: tap to change what is assigned. The bar shows how much of the money has been used. */
function BudgetRow({ category, m, onEdit }: { category: Category; m: CategoryMonth; onEdit: () => void }) {
  const over = m.available < 0;
  const funds = m.carryIn + m.assigned;
  const used = funds > 0 ? Math.min(100, Math.max(0, Math.round((-m.activity / funds) * 100))) : m.activity < 0 ? 100 : 0;
  return (
    <li>
      <button type="button" className="row-button" onClick={onEdit} aria-label={t('budget.editAssigned', { name: category.name })}>
        <span className="row-main">
          <span className="row-title">
            {category.name}
            {m.overrideId && <span className="badge">{t('budget.overrideBadge')}</span>}
          </span>
          <span className="row-sub">
            {t('budget.assigned')} <Money cents={m.assigned} />
            {m.activity !== 0 && (
              <>
                {' · '}
                {t('budget.spent')} <Money cents={-m.activity} />
              </>
            )}
          </span>
          <span className={`row-bar ${over ? 'row-bar-over' : ''}`} aria-hidden="true">
            <span style={{ width: `${over ? 100 : used}%` }} />
          </span>
        </span>
        <span className="row-end">
          <Money cents={m.available} className="row-amount" />
          {over && <span className="badge badge-warn">⚠ {t('budget.overspent')}</span>}
        </span>
      </button>
    </li>
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
        <ul className="plain-list facts">
          <li className="split-row"><span>{t('budget.defaultIs')}</span><Money cents={m.defaultAmount} /></li>
          {m.carryIn !== 0 && <li className="split-row"><span>{t('budget.carryIn')}</span><Money cents={m.carryIn} /></li>}
          <li className="split-row"><span>{t('budget.activity')}</span><Money cents={m.activity} /></li>
          <li className="split-row"><span>{t('budget.available')}</span><strong><Money cents={m.available} /></strong></li>
          <li className="split-row"><span>{t('categories.rollover')}</span><span>{rolloverLabel(category.rolloverMode)}</span></li>
        </ul>
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
