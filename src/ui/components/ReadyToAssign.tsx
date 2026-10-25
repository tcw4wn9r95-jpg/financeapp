import { useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { explainReady, type BudgetMonth } from '../../domain/budget';
import { addMonths } from '../../domain/dates';
import { monthCashFlow } from '../../domain/flows';
import { formatWholeEuros } from '../../domain/money';
import { monthName, t } from '../../i18n';
import { useBudgetInput } from '../hooks';
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
  const input = useBudgetInput();
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
  return (
    <>
      <section className={`rta rta-${state} ${compact ? 'rta-compact' : ''}`} aria-labelledby="rta-label">
        <p id="rta-label" className="rta-label">
          {t('money.title', { month: monthName(month.month) })}
        </p>
        <p className="rta-amount">
          <Money cents={rta} />
        </p>
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
        <div className="cash-flow">
          <div className="split-row">
            <span>{t('money.netFlow', { month: monthName(month.month) })}</span>
            <strong><Money cents={flow.net} plusSign /></strong>
          </div>
          <p className="cash-flow-sub">
            {t('money.flowInOut', { in: formatWholeEuros(flow.in), out: formatWholeEuros(flow.out) })}
          </p>
        </div>
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
      </section>
      {/* Outside the card: on the dashboard the card sits inside a link. */}
      {explain && createPortal(<ReadyExplainDialog month={month.month} onClose={() => setExplain(false)} />, document.body)}
    </>
  );
}

