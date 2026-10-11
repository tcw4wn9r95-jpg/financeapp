import { useState, type FormEvent } from 'react';
import { addMonths, monthRange } from '../../domain/dates';
import { defaultFor } from '../../domain/budget';
import { CATEGORY_GROUPS, type Category, type CategoryGroup, type RolloverMode } from '../../domain/types';
import { monthName, t } from '../../i18n';
import { addSuggestedCategories, categoryInUse, defaultStartMonth, deleteCategory, saveCategory, suggestedFromMonth } from '../actions';
import { Dialog } from '../components/Dialog';
import { MoneyField, SelectField, TextField, useMoneyInput } from '../components/fields';
import { Money } from '../components/Money';
import { useToast } from '../components/Toast';
import { useDocumentTitle, useSettings, useStore, useVault } from '../hooks';
import { groupLabel, rolloverHelp, rolloverLabel } from '../labels';

const MODES: RolloverMode[] = ['roll', 'reset', 'sweep'];

export function CategoriesPage() {
  useDocumentTitle(t('nav.categories'));
  const vault = useVault();
  const notify = useToast();
  const categories = useStore('categories');
  const defaults = useStore('budgetDefaults');
  const settings = useSettings();
  const [editing, setEditing] = useState<Category | { isIncome: boolean; groupId: CategoryGroup } | null>(null);
  const month = defaultStartMonth(vault);
  const sorted = [...categories].sort((a, b) => a.sortOrder - b.sortOrder);
  const income = sorted.filter((c) => c.isIncome);
  const sweepTarget = categories.find((c) => c.id === settings.sweepTargetCategoryId);
  const expenseTotal = sorted.filter((c) => !c.isIncome).reduce((s, c) => s + (defaultFor(defaults, c.id, month)?.monthlyAmount ?? 0), 0);

  return (
    <>
      <div className="page-head">
        <h1>{t('nav.categories')}</h1>
        <button type="button" className="button button-primary" onClick={() => setEditing({ isIncome: false, groupId: 'variable' })}>+ {t('categories.add')}</button>
      </div>
      {categories.length === 0 && (
        <p className="notice">
          {t('categories.none')}{' '}
          <button type="button" className="button" onClick={() => void addSuggestedCategories(vault).then(() => notify(t('categories.suggestedAdded')))}>
            {t('categories.addSuggested')}
          </button>
        </p>
      )}
      <p className="summary-line">
        {t('categories.defaultTotal', { month: monthName(month) })} <Money cents={expenseTotal} />
      </p>
      {CATEGORY_GROUPS.map((g) => {
        const cats = sorted.filter((c) => !c.isIncome && c.groupId === g);
        return (
          <section key={g} className="card" aria-labelledby={`cg-${g}`}>
            <div className="split-row">
              <h2 id={`cg-${g}`}>{groupLabel(g)}</h2>
              <button type="button" className="button button-quiet" onClick={() => setEditing({ isIncome: false, groupId: g })}>
                + {t('categories.addTo', { group: groupLabel(g) })}
              </button>
            </div>
            {cats.length === 0 ? <p className="muted">{t('categories.emptyGroup')}</p> : (
              <ul className="plain-list">
                {cats.map((c) => (
                  <li key={c.id} className="split-row">
                    <button type="button" className="link-button" onClick={() => setEditing(c)} aria-label={t('categories.editNamed', { name: c.name })}>
                      {c.name}
                    </button>
                    <span className="muted">
                      {rolloverLabel(c.rolloverMode)}
                      {c.rolloverMode === 'sweep' && sweepTarget && ` → ${sweepTarget.name}`}
                      {' · '}
                      <Money cents={defaultFor(defaults, c.id, month)?.monthlyAmount ?? 0} />
                      {t('categories.perMonth')}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        );
      })}
      <section className="card" aria-labelledby="cg-income">
        <div className="split-row">
          <h2 id="cg-income">{t('categories.income')}</h2>
          <button type="button" className="button button-quiet" onClick={() => setEditing({ isIncome: true, groupId: 'fixed' })}>
            + {t('categories.addIncome')}
          </button>
        </div>
        {income.length === 0 ? <p className="muted">{t('categories.emptyGroup')}</p> : (
          <ul className="plain-list">
            {income.map((c) => (
              <li key={c.id}>
                <button type="button" className="link-button" onClick={() => setEditing(c)} aria-label={t('categories.editNamed', { name: c.name })}>{c.name}</button>
              </li>
            ))}
          </ul>
        )}
      </section>
      {editing && <CategoryDialog existing={'id' in editing ? editing : undefined} preset={editing} onClose={() => setEditing(null)} />}
    </>
  );
}

function CategoryDialog({ existing, preset, onClose }: { existing: Category | undefined; preset: { isIncome: boolean; groupId: CategoryGroup }; onClose: () => void }) {
  const vault = useVault();
  const notify = useToast();
  const settings = useSettings();
  const [fromMonth, setFromMonth] = useState(() => suggestedFromMonth(vault));
  const [until, setUntil] = useState('');
  const thisMonth = defaultStartMonth(vault);
  const current = existing ? defaultFor(vault.list('budgetDefaults'), existing.id, fromMonth)?.monthlyAmount : undefined;
  const [name, setName] = useState(existing?.name ?? '');
  const [isIncome] = useState(existing?.isIncome ?? preset.isIncome);
  const [groupId, setGroupId] = useState<CategoryGroup>(existing?.groupId ?? preset.groupId);
  const [mode, setMode] = useState<RolloverMode>(existing?.rolloverMode ?? 'roll');
  const amount = useMoneyInput(current ?? (existing ? undefined : 0));
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const inUse = existing ? categoryInUse(vault, existing.id) : false;

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!name.trim()) return setError(t('categories.nameRequired'));
    if (amount.text.trim() !== '' && (amount.cents === null || amount.cents < 0)) return setError(t('field.moneyInvalid'));
    setBusy(true);
    const changedDefault = amount.cents !== null && amount.cents !== current && !(current === undefined && amount.cents === 0);
    try {
      await saveCategory(vault, {
        name: name.trim(), groupId, rolloverMode: isIncome ? 'reset' : mode, isIncome,
        ...(changedDefault || until ? { monthlyDefault: amount.cents ?? current ?? 0, fromMonth } : {}),
        ...(until ? { untilMonth: until } : {}),
      }, existing);
      notify(t('categories.saved', { name: name.trim() }));
      onClose();
    } catch {
      setBusy(false);
      setError(t('common.unexpectedError'));
    }
  }

  async function remove() {
    if (!existing) return;
    await deleteCategory(vault, existing.id);
    notify(t('categories.deleted'));
    onClose();
  }

  return (
    <Dialog open title={existing ? t('categories.editTitle') : isIncome ? t('categories.addIncomeTitle') : t('categories.addTitle')} onClose={onClose}>
      <form onSubmit={submit} noValidate>
        <TextField label={t('categories.name')} value={name} onChange={(e) => setName(e.target.value)} required autoFocus />
        {!isIncome && (
          <>
            <SelectField label={t('categories.group')} value={groupId} onChange={(e) => setGroupId(e.target.value as CategoryGroup)}>
              {CATEGORY_GROUPS.map((g) => <option key={g} value={g}>{groupLabel(g)}</option>)}
            </SelectField>
            <fieldset className="radio-list">
              <legend>{t('categories.rollover')}</legend>
              {MODES.map((m) => (
                <label key={m} className="check">
                  <input type="radio" name="mode" value={m} checked={mode === m} onChange={() => setMode(m)} />
                  <span>
                    <strong>{rolloverLabel(m)}</strong> — {rolloverHelp(m)}
                  </span>
                </label>
              ))}
            </fieldset>
            {mode === 'sweep' && !settings.sweepTargetCategoryId && <p className="notice notice-warn">⚠ {t('categories.noSweepTarget')}</p>}
          </>
        )}
        <MoneyField label={isIncome ? t('categories.expectedIncome') : t('categories.defaultAmount')} state={amount} hint={isIncome ? t('categories.expectedIncomeHint') : t('categories.defaultHint')} />
        <SelectField label={t('categories.appliesFrom')} value={fromMonth} onChange={(e) => setFromMonth(e.target.value)} hint={t('categories.appliesFromHint')}>
          {monthRange(settings.budgetStartMonth, addMonths(thisMonth, 12)).map((m) => (
            <option key={m} value={m}>{m === settings.budgetStartMonth ? t('categories.fromStart', { month: monthName(m) }) : m === thisMonth ? t('categories.fromThisMonth', { month: monthName(m) }) : monthName(m)}</option>
          ))}
        </SelectField>
        <SelectField label={t('categories.until')} value={until} onChange={(e) => setUntil(e.target.value)} hint={t('categories.untilHint')}>
          <option value="">{t('categories.noEnd')}</option>
          {monthRange(fromMonth, addMonths(fromMonth, 36)).map((m) => <option key={m} value={m}>{monthName(m)}</option>)}
        </SelectField>
        {existing && <Schedule categoryId={existing.id} />}
        {error && <p className="error" role="alert">⚠ {error}</p>}
        <div className="row">
          <button className="button button-primary" disabled={busy}>{t('common.save')}</button>
          <button type="button" className="button button-quiet" onClick={onClose}>{t('common.cancel')}</button>
          {existing && (
            <button type="button" className="button button-danger push-right" disabled={inUse} onClick={() => void remove()}>{t('common.delete')}</button>
          )}
        </div>
        {existing && inUse && <p className="hint">{t('categories.cannotDelete')}</p>}
      </form>
    </Dialog>
  );
}

/** The dated monthly amounts of a category, oldest first. */
function Schedule({ categoryId }: { categoryId: string }) {
  const defaults = useStore('budgetDefaults')
    .filter((d) => d.categoryId === categoryId)
    .sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom));
  if (defaults.length === 0) return null;
  return (
    <details className="schedule">
      <summary>{t('categories.schedule')}</summary>
      <ul className="plain-list">
        {defaults.map((d) => (
          <li key={d.id} className="split-row">
            <span>{t('categories.fromMonth', { month: monthName(d.effectiveFrom) })}</span>
            <Money cents={d.monthlyAmount} />
          </li>
        ))}
      </ul>
    </details>
  );
}
