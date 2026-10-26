import { useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { explainReady, type BudgetMonth } from '../../domain/budget';
import { addMonths, currentMonth } from '../../domain/dates';
import { monthCashFlow } from '../../domain/flows';
import { monthCashPlan } from '../../domain/forecast';
import { formatMoney, formatWholeEuros } from '../../domain/money';
import type { Cents } from '../../domain/types';
import { monthName, t, type MessageKey } from '../../i18n';
import { saveSettings } from '../actions';
import { useBudgetInput, useSettings, useVault } from '../hooks';
import { Money } from './Money';
import { ReadyExplainDialog } from './ReadyExplain';

/**
 * Your money this month (D-92): what the budget accounts hold, split into what
 * the budget lines hold, income held for next month, and the money with no
 * plan yet ("unplanned money", the budget's Ready to assign). The split is a
 * bar with a legend; the meaning never depends on colour alone.
 */
export function ReadyToAssign({ month, compact = false }: { month: BudgetMonth; compact?: boolean }) {
  const [explain, setExplain] = useState(false);
  const [unplannedOpen, setUnplannedOpen] = useState(false);
  const input = useBudgetInput();
  const vault = useVault();
  const basis = useSettings().forecastBasis ?? 'plan';
  const x = useMemo(() => explainReady(input, month.month), [input, month.month]);
  const flow = useMemo(() => monthCashFlow(input, month.month), [input, month.month]);
  const rta = month.readyToAssign;
  const state = rta === 0 ? 'zero' : rta > 0 ? 'pos' : 'neg';
  const cash = x?.cash ?? 0;
  const lines = x?.inCategories ?? 0;
  const held = month.heldForNextMonth;
  // Bar: each part's share of whichever is larger, the money or what is planned with it.
  const whole = Math.max(cash, Math.max(0, lines) + held, 1);
  const pct = (v: number) => `${Math.max(0, (v / whole) * 100)}%`;
  const next = monthName(addMonths(month.month, 1));
  const plan = useMemo(
    () => monthCashPlan(input, month.month, basis, (id) => month.categories.get(id)?.assigned, (id) => month.incomeByCategory.get(id) ?? 0, currentMonth()),
    [input, month, basis],
  );
  const tone = plan.net === 0 ? 'zero' : plan.net > 0 ? 'pos' : 'neg';
  const row = (label: string, amount: Cents, sign: 1 | -1) => (
    <li className="split-row"><span>{label}</span><Money cents={sign * amount} plusSign={sign > 0} /></li>
  );
  return (
    <>
      <section className={`rta rta-${tone} ${compact ? 'rta-compact' : ''}`} aria-labelledby="rta-label">
        <div className="rta-head">
          <p id="rta-label" className="rta-label">
            {t('flow.title', { month: monthName(month.month) })}
          </p>
          <div className="chips rta-basis" role="group" aria-label={t('plan.basis')}>
            {(['plan', 'recent'] as const).map((b) => (
              <button
                key={b}
                type="button"
                className="chip"
                aria-pressed={basis === b}
                onClick={(e) => {
                  // On the dashboard the card is a link to the budget.
                  e.preventDefault();
                  e.stopPropagation();
                  void saveSettings(vault, { forecastBasis: b });
                }}
              >
                {t(`plan.basis.${b}` as MessageKey)}
              </button>
            ))}
          </div>
        </div>
        <p className="rta-amount">
          <Money cents={plan.net} plusSign />
        </p>
        <ul className="plain-list flow-list">
          {row(t('flow.income'), plan.income, 1)}
          {row(t('flow.fixed'), plan.fixed, -1)}
          {row(t('flow.variable'), plan.variable, -1)}
          {row(t('flow.provisions'), plan.provisions, -1)}
          {plan.oneOffs > 0 && row(t('flow.oneOffs'), plan.oneOffs, -1)}
          {plan.invested > 0 && row(t('flow.invested'), plan.invested, -1)}
          <li className="split-row flow-total"><strong>{t('flow.net')}</strong><strong><Money cents={plan.net} plusSign /></strong></li>
        </ul>
        <p className="cash-flow-sub">{basis === 'recent' ? t('flow.recentHint', { n: plan.paced }) : t('flow.planHint')}</p>
        {month.month <= currentMonth() && (
        <p className="cash-flow-sub">
          {t('flow.bank', { net: formatMoney(flow.net, { plusSign: true }), in: formatWholeEuros(flow.in), out: formatWholeEuros(flow.out) })}
        </p>
        )}
        <details className="rta-unplanned" open={unplannedOpen}>
          <summary
            onClick={(e) => {
              // The card can sit inside a link (dashboard): open here, do not follow it.
              e.preventDefault();
              e.stopPropagation();
              setUnplannedOpen(!unplannedOpen);
            }}
          >
            {t('rta.label')}:{' '}<Money cents={rta} /> ›
          </summary>
          <p className="rta-message">
            <span aria-hidden="true">{state === 'zero' ? '✓' : state === 'pos' ? '●' : '⚠'} </span>
            {state === 'zero' ? t('money.zero') : state === 'pos' ? t('money.positive') : held > 0 ? t('money.negativeHeld', { amount: formatWholeEuros(-rta), month: next }) : t('money.negative', { amount: formatWholeEuros(-rta) })}
          </p>
          {x && (
            <div className="money-split">
              <div className="money-bar" aria-hidden="true">
                <span className="money-seg money-lines" style={{ width: pct(lines) }} />
                <span className="money-seg money-held" style={{ width: pct(held) }} />
                <span className="money-seg money-free" style={{ width: pct(rta) }} />
              </div>
              <ul className="plain-list money-legend">
                <li className="split-row"><span>{t('money.cash')}</span><strong><Money cents={cash} /></strong></li>
                <li className="split-row"><span><span className="money-key money-lines" aria-hidden="true" />{t('money.lines')}</span><Money cents={lines} /></li>
                {held !== 0 && (
                  <li className="split-row"><span><span className="money-key money-held" aria-hidden="true" />{t('money.held', { month: next })}</span><Money cents={held} /></li>
                )}
                <li className="split-row"><span><span className="money-key money-free" aria-hidden="true" />{t('rta.label')}</span><strong><Money cents={rta} /></strong></li>
              </ul>
            </div>
          )}
        <p className="rta-why">
          <button
            type="button"
            className="link-button"
            onClick={(e) => {
              // On the dashboard the card is a link to the budget.
              e.preventDefault();
              e.stopPropagation();
              setExplain(true);
            }}
          >
            {t('explain.open')}
          </button>
        </p>
        </details>
      </section>
      {/* Outside the card: on the dashboard the card sits inside a link. */}
      {explain && createPortal(<ReadyExplainDialog month={month.month} onClose={() => setExplain(false)} />, document.body)}
    </>
  );
}

