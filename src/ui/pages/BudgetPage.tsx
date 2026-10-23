import { useMemo, useState, type FormEvent } from 'react';
import type { BudgetMonth, CategoryMonth } from '../../domain/budget';
import { addMonths, compareMonths, currentMonth, isMonthKey, monthOf } from '../../domain/dates';
import { formatMoney, formatMoneyInput, parseMoney } from '../../domain/money';
import { parseRecurrence } from '../../domain/plan';
import type { Category, CategoryGroup, MonthKey } from '../../domain/types';
import { monthName, t } from '../../i18n';
import { backdateToStart, removeDefault, saveMonthPlan, saveSettings, resetOverride, setDefaultFrom, setOverride } from '../actions';
import { backdateDefaults, defaultFor, futureChanges, invested } from '../../domain/budget';
import { Dialog } from '../components/Dialog';
import { MoneyField, TextField, useMoneyInput } from '../components/fields';
import { Money } from '../components/Money';
import { MonthNav } from '../components/MonthNav';
import { ReadyToAssign } from '../components/ReadyToAssign';
import { useToast } from '../components/Toast';
import { useBudgetInput, useBudgetMonth, useDocumentTitle, useSettings, useStore, useVault } from '../hooks';
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

/** How much has gone into investments so far (D-57). */
function InvestedLine({ month }: { month: MonthKey }) {
  const input = useBudgetInput();
  const inv = useMemo(() => invested(input, month), [input, month]);
  return (
    <p className="invested-line">
      <span>{t('invest.total')} <strong><Money cents={inv.total} /></strong></span>
      <span className="muted">
        <Money cents={inv.year} /> {t('invest.thisYear')} · <Money cents={inv.month} /> {t('invest.thisMonth')}
      </span>
    </p>
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
  const [planning, setPlanning] = useState<Category | null>(null);
  const provisions = useStore('provisions');
  // A provision whose bill date has passed, or that has not started, with nothing in it this month is not shown (D-76).
  const finished = (c: Category, m: MonthKey, cm: CategoryMonth | undefined) => {
    const p = c.groupId === 'provisions' ? provisions.find((x) => x.categoryId === c.id) : undefined;
    if (!p || !cm) return false;
    const empty = cm.assigned === 0 && cm.activity === 0 && Math.abs(cm.available) < 100;
    const expired = !parseRecurrence(p.recurrence) && compareMonths(monthOf(p.dueDate), m) < 0;
    const notStarted = !!p.startDate && compareMonths(monthOf(p.startDate), m) > 0;
    return empty && (expired || notStarted);
  };
  const setMonth = (m: MonthKey) => navigate(`budget/${m}`);

  const expense = categories.filter((c) => !c.isIncome && !c.archivedAt);

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
          <IncomeSection month={month} budget={budget} onPlan={setPlanning} />
          {BUDGET_ORDER.map((g) => {
            const cats = expense.filter((c) => c.groupId === g && !finished(c, month, budget.categories.get(c.id))).sort((a, b) => a.sortOrder - b.sortOrder);
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
                {g === 'investments' && <InvestedLine month={month} />}
                <ul className="rows">
                  {rows.map(([c, m]) => (
                    <BudgetRow key={c.id} category={c} m={m} onEdit={() => setEditing(c)} />
                  ))}
                </ul>
              </section>
            );
          })}


        </>
      )}
      {editing && budget && (
        <AssignDialog
          category={editing}
          month={month}
          m={budget.categories.get(editing.id)!}
          onClose={() => setEditing(null)}
          onPlan={() => {
            setPlanning(editing);
            setEditing(null);
          }}
        />
      )}
      {planning && <MonthPlanDialog category={planning} month={month} onClose={() => setPlanning(null)} />}
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

function AssignDialog({ category, month, m, onClose, onPlan }: { category: Category; month: MonthKey; m: CategoryMonth; onClose: () => void; onPlan: () => void }) {
  const vault = useVault();
  const notify = useToast();
  const amount = useMoneyInput(m.assigned);
  const existingNote = vault.list('budgetOverrides').find((o) => o.id === m.overrideId)?.note ?? '';
  const [note, setNote] = useState(existingNote);
  const [busy, setBusy] = useState(false);
  const cents = amount.cents;
  const invalid = cents === null || cents < 0;
  // Free savings fill this category on their own (D-75); a typed amount replaces that for the month.
  const auto = useBudgetInput().availableTargets?.get(category.id)?.has(month) && !m.overrideId;

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
      {auto && <p className="notice">{t('budget.autoFree')}</p>}
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
          {category.groupId !== 'provisions' && category.groupId !== 'events' && !auto && (
            <button type="button" className="button button-quiet" disabled={busy} onClick={onPlan}>
              {t('budget.planAhead')}
            </button>
          )}
        </div>
      </form>
    </Dialog>
  );
}

/** Budget order (D-76): income first, then fixed, variable, provisions; the rest after. */
const BUDGET_ORDER: readonly CategoryGroup[] = ['fixed', 'variable', 'provisions', 'events', 'savings', 'investments'];

/** Income on top: what each income line is expected to bring this month and what came in (D-76). */
function IncomeSection({ month, budget, onPlan }: { month: MonthKey; budget: BudgetMonth; onPlan: (c: Category) => void }) {
  const categories = useStore('categories');
  const defaults = useStore('budgetDefaults');
  const overrides = useStore('budgetOverrides');
  const income = categories.filter((c) => c.isIncome && !c.archivedAt).sort((a, b) => a.sortOrder - b.sortOrder);
  const expected = (id: string) => overrides.find((o) => o.categoryId === id && o.month === month)?.amount ?? defaultFor(defaults, id, month)?.monthlyAmount ?? 0;
  return (
    <section className="group" aria-labelledby="income-h">
      <div className="group-head">
        <h2 id="income-h">{t('budget.incomeTitle')}</h2>
        <span className="muted">{t('budget.received')} <Money cents={budget.income} /></span>
      </div>
      {income.length > 0 && (
        <ul className="rows">
          {income.map((c) => {
            const got = budget.incomeByCategory.get(c.id) ?? 0;
            const exp = expected(c.id);
            const special = overrides.some((o) => o.categoryId === c.id && o.month === month);
            return (
              <li key={c.id}>
                <button type="button" className="row-button" onClick={() => onPlan(c)} aria-label={t('budget.planIncome', { name: c.name })}>
                  <span className="row-main">
                    <span className="row-title">
                      {c.name}
                      {special && <span className="badge">{t('budget.overrideBadge')}</span>}
                    </span>
                    <span className="row-sub">
                      {t('budget.expected')} <Money cents={exp} />
                      {c.nextMonthFromDay ? <> · {t('budget.forNextShort')}</> : null}
                    </span>
                    <span className="row-bar" aria-hidden="true"><span style={{ width: `${exp > 0 ? Math.min(100, Math.round((got / exp) * 100)) : got > 0 ? 100 : 0}%` }} /></span>
                  </span>
                  <span className="row-end"><Money cents={got} className="row-amount" /></span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
      <ul className="plain-list facts income-facts">
        {budget.heldForNextMonth !== 0 && (
          <li className="split-row"><span>{t('budget.heldForNext')}</span><Money cents={budget.heldForNextMonth} /></li>
        )}
        <li className="split-row"><span>{t('budget.assignedThisMonth')}</span><Money cents={-budget.assignedTotal} /></li>
        {budget.returnedFromLastMonth !== 0 && (
          <li className="split-row"><span>{t('budget.returned')}</span><Money cents={budget.returnedFromLastMonth} plusSign /></li>
        )}
        {budget.uncategorised !== 0 && (
          <li className="split-row">
            <span>{t('budget.uncategorised')} <a href={href('inbox')}>{t('budget.review')}</a></span>
            <Money cents={budget.uncategorised} />
          </li>
        )}
      </ul>
    </section>
  );
}

/**
 * Optional month-by-month plan for one budget line (D-77). By default every
 * month has the usual amount; change any month (a 13th-month salary, the
 * insurance in March) and only that month gets its own amount.
 */
function MonthPlanDialog({ category, month, onClose }: { category: Category; month: MonthKey; onClose: () => void }) {
  const vault = useVault();
  const notify = useToast();
  const settings = useSettings();
  const defaults = useStore('budgetDefaults');
  const overrides = useStore('budgetOverrides');
  const [year, setYear] = useState(Number(month.slice(0, 4)));
  const months = Array.from({ length: 12 }, (_, i) => `${year}-${String(i + 1).padStart(2, '0')}`).filter((m) => compareMonths(m, settings.budgetStartMonth) >= 0);
  const usual = (m: MonthKey) => defaultFor(defaults, category.id, m)?.monthlyAmount ?? 0;
  const initial = (m: MonthKey) => overrides.find((o) => o.categoryId === category.id && o.month === m)?.amount ?? usual(m);
  const [texts, setTexts] = useState<Record<string, string>>({});
  const [all, setAll] = useState('');
  const [busy, setBusy] = useState(false);
  const textOf = (m: MonthKey) => texts[m] ?? formatMoneyInput(initial(m));
  const cents = (m: MonthKey) => parseMoney(textOf(m));
  const invalid = months.some((m) => {
    const c = cents(m);
    return c === null || c < 0;
  });
  const total = months.reduce((s, m) => s + Math.max(0, cents(m) ?? 0), 0);

  async function save() {
    if (invalid) return;
    setBusy(true);
    try {
      const amounts = months.map((m) => cents(m)!);
      // The same every month: that is the usual amount from the first month on, not twelve exceptions.
      if (amounts.every((a) => a === amounts[0]) && amounts[0] !== usual(months[0]!)) await setDefaultFrom(vault, category.id, amounts[0]!, months[0]!);
      const n = await saveMonthPlan(vault, category.id, new Map(months.map((m, i) => [m, amounts[i]!])));
      notify(n === 1 ? t('budget.planSavedOne', { name: category.name }) : n ? t('budget.planSaved', { name: category.name, n }) : t('budget.planSame', { name: category.name }));
      onClose();
    } catch {
      notify(t('common.unexpectedError'), 'error');
      setBusy(false);
    }
  }

  return (
    <Dialog open title={t('budget.planTitle', { name: category.name })} onClose={onClose}>
      <ChangesAhead category={category} />
      <h3 className="plan-h">{t('budget.byMonthTitle')}</h3>
      <p className="hint">{category.isIncome ? t('budget.planIncomeHint') : t('budget.planHint')}</p>
      <div className="row plan-year">
        <button type="button" className="button button-quiet button-small" aria-label={t('budget.prevYear')} onClick={() => { setTexts({}); setYear(year - 1); }}>‹</button>
        <strong>{year}</strong>
        <button type="button" className="button button-quiet button-small" aria-label={t('budget.nextYear')} onClick={() => { setTexts({}); setYear(year + 1); }}>›</button>
      </div>
      <div className="plan-all">
        <input inputMode="decimal" placeholder={t('budget.sameEveryMonth')} aria-label={t('budget.sameEveryMonth')} value={all} onChange={(e) => setAll(e.target.value)} />
        <button
          type="button"
          className="button button-small"
          disabled={parseMoney(all) === null}
          onClick={() => setTexts(Object.fromEntries(months.map((m) => [m, all])))}
        >
          {t('budget.applyAllMonths')}
        </button>
      </div>
      <ul className="plain-list plan-months">
        {months.map((m) => {
          const c = cents(m);
          const differs = c !== null && c !== usual(m);
          return (
            <li key={m} className={differs ? 'plan-differs' : undefined}>
              <label htmlFor={`pm-${m}`}>{monthName(m)}</label>
              <input
                id={`pm-${m}`}
                inputMode="decimal"
                value={textOf(m)}
                aria-invalid={c === null || (c ?? 0) < 0}
                onChange={(e) => setTexts({ ...texts, [m]: e.target.value })}
              />
            </li>
          );
        })}
      </ul>
      <p className="split-row"><span>{t('budget.planTotal', { year })}</span><strong><Money cents={total} /></strong></p>
      <div className="row">
        <button type="button" className="button button-primary" disabled={busy || invalid || months.length === 0} onClick={() => void save()}>{t('common.save')}</button>
        <button type="button" className="button button-quiet" onClick={onClose}>{t('common.cancel')}</button>
      </div>
    </Dialog>
  );
}

/**
 * Changes ahead for one budget line (D-78): from a month on its usual amount
 * becomes another, or it stops (a loan paid off, a raise, a subscription
 * cancelled). The budget and the forecast follow from that month.
 */
function ChangesAhead({ category }: { category: Category }) {
  const vault = useVault();
  const notify = useToast();
  const categories = useStore('categories');
  const defaults = useStore('budgetDefaults');
  const now = currentMonth();
  const changes = futureChanges(categories, defaults, now).filter((c) => c.categoryId === category.id);
  const months = Array.from({ length: 36 }, (_, i) => addMonths(now, i + 1));
  const [from, setFrom] = useState(months[0]!);
  const [stops, setStops] = useState(false);
  const amount = useMoneyInput();
  const usualNow = defaultFor(defaults, category.id, now)?.monthlyAmount ?? 0;
  const value = stops ? 0 : amount.cents;
  const valid = value !== null && value >= 0 && (stops || amount.text.trim() !== '');

  async function add() {
    if (!valid) return;
    await setDefaultFrom(vault, category.id, value!, from);
    notify(stops ? t('budget.changeStops', { name: category.name, month: monthName(from) }) : t('budget.changeSaved', { name: category.name, month: monthName(from) }));
    amount.setText('');
    setStops(false);
  }

  return (
    <section className="changes-ahead" aria-labelledby="ca-h">
      <h3 id="ca-h" className="plan-h">{t('budget.changesAhead')}</h3>
      <p className="hint">{t('budget.usualNow', { amount: formatMoney(usualNow) })}</p>
      {changes.length > 0 && (
        <ul className="plain-list move-list">
          {changes.map((c) => (
            <li key={c.defaultId} className="split-row">
              <span>
                {t('budget.fromMonth', { month: monthName(c.month) })}: {c.after === 0 ? <strong>{t('budget.stops')}</strong> : <Money cents={c.after} />}
                <span className="muted"> ({t('budget.wasAmount', { amount: formatMoney(c.before) })})</span>
              </span>
              <button type="button" className="link-button" aria-label={t('common.delete')} onClick={() => void removeDefault(vault, c.defaultId)}>✕</button>
            </li>
          ))}
        </ul>
      )}
      <div className="change-form">
        <label>
          <span>{t('budget.fromLabel')}</span>
          <select value={from} onChange={(e) => setFrom(e.target.value)}>
            {months.map((m) => <option key={m} value={m}>{monthName(m)}</option>)}
          </select>
        </label>
        <label>
          <span>{t('budget.newAmount')}</span>
          <input inputMode="decimal" placeholder="0,00" disabled={stops} value={stops ? '' : amount.text} onChange={(e) => amount.setText(e.target.value)} />
        </label>
        <label className="check check-inline">
          <input type="checkbox" checked={stops} onChange={(e) => setStops(e.target.checked)} />
          {category.isIncome ? t('budget.incomeStops') : t('budget.lineStops')}
        </label>
        <button type="button" className="button button-small" disabled={!valid} onClick={() => void add()}>{t('budget.addChange')}</button>
      </div>
    </section>
  );
}
