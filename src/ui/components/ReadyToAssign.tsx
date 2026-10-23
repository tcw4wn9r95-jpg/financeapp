import type { BudgetMonth } from '../../domain/budget';
import { monthName, t } from '../../i18n';
import { Money } from './Money';

/** Ready to assign with a text state, so the meaning never depends on colour. */
export function ReadyToAssign({ month, compact = false }: { month: BudgetMonth; compact?: boolean }) {
  const rta = month.readyToAssign;
  const state = rta === 0 ? 'zero' : rta > 0 ? 'pos' : 'neg';
  const icon = state === 'zero' ? '✓' : state === 'pos' ? '●' : '⚠';
  const message = state === 'zero' ? t('rta.zero') : state === 'pos' ? t('rta.positive') : t('rta.negative');
  return (
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
    </section>
  );
}
