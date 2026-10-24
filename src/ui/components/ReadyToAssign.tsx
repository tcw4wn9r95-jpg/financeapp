import { useState } from 'react';
import { createPortal } from 'react-dom';
import type { BudgetMonth } from '../../domain/budget';
import { monthName, t } from '../../i18n';
import { Money } from './Money';
import { ReadyExplainDialog } from './ReadyExplain';

/** Ready to assign with a text state, so the meaning never depends on colour. */
export function ReadyToAssign({ month, compact = false }: { month: BudgetMonth; compact?: boolean }) {
  const [explain, setExplain] = useState(false);
  const rta = month.readyToAssign;
  const state = rta === 0 ? 'zero' : rta > 0 ? 'pos' : 'neg';
  const icon = state === 'zero' ? '✓' : state === 'pos' ? '●' : '⚠';
  const message = state === 'zero' ? t('rta.zero') : state === 'pos' ? t('rta.positive') : t('rta.negative');
  return (
    <>
      <section className={`rta rta-${state} ${compact ? 'rta-compact' : ''}`} aria-labelledby="rta-label">
        <p id="rta-label" className="rta-label">
          {t('rta.label')} · {monthName(month.month)}
        </p>
        <p className="rta-amount">
          <Money cents={rta} />
        </p>
        <p className="rta-message">
          <span aria-hidden="true">{icon} </span>
          {message}
        </p>
        {month.heldForNextMonth > 0 && (
          <p className="rta-held">
            {t('rta.held')} <Money cents={month.heldForNextMonth} />
          </p>
        )}
        <p className="rta-why">
          <button type="button" className="link-button" onClick={(e) => {
            // On the dashboard the card is a link to the budget.
            e.preventDefault();
            e.stopPropagation();
            setExplain(true);
          }}>{t('explain.open')}</button>
        </p>
      </section>
      {/* Outside the card: on the dashboard the card sits inside a link. */}
      {explain && createPortal(<ReadyExplainDialog month={month.month} onClose={() => setExplain(false)} />, document.body)}
    </>
  );
}
