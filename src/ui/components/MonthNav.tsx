import { addMonths, currentMonth } from '../../domain/dates';
import type { MonthKey } from '../../domain/types';
import { monthName, t } from '../../i18n';

export function MonthNav({ month, onChange }: { month: MonthKey; onChange: (m: MonthKey) => void }) {
  const now = currentMonth();
  return (
    <div className="month-nav" role="group" aria-label={t('month.navLabel')}>
      <button type="button" className="icon-button" onClick={() => onChange(addMonths(month, -1))} aria-label={t('month.previous')}>
        ‹
      </button>
      <h2 className="month-title" aria-live="polite">{monthName(month)}</h2>
      <button type="button" className="icon-button" onClick={() => onChange(addMonths(month, 1))} aria-label={t('month.next')}>
        ›
      </button>
      {month !== now && (
        <button type="button" className="link-button" onClick={() => onChange(now)}>
          {t('month.thisMonth')}
        </button>
      )}
    </div>
  );
}
