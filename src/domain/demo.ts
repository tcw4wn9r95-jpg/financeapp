import { addMonths, daysInMonth, monthOf } from './dates';
import type { IsoDate, MonthKey, StoreSnapshot } from './types';

/**
 * The demo household is generated around a fixed anchor month. When it is
 * loaded, every date moves by whole months so the demo's "current month" is
 * the user's current month.
 */
export const DEMO_ANCHOR_MONTH: MonthKey = '2026-10';

function shiftDate(iso: IsoDate, n: number): IsoDate {
  const month = addMonths(monthOf(iso), n);
  const [y, m] = month.split('-').map(Number) as [number, number];
  const day = Math.min(Number(iso.slice(8, 10)), daysInMonth(y, m));
  return `${month}-${day.toString().padStart(2, '0')}`;
}

export function shiftSnapshotMonths(snapshot: StoreSnapshot, n: number): StoreSnapshot {
  const s = structuredClone(snapshot);
  if (n === 0) return s;
  for (const t of s.transactions) {
    t.date = shiftDate(t.date, n);
    if (t.valueDate) t.valueDate = shiftDate(t.valueDate, n);
  }
  for (const d of s.budgetDefaults) d.effectiveFrom = addMonths(d.effectiveFrom, n);
  for (const o of s.budgetOverrides) o.month = addMonths(o.month, n);
  for (const p of s.provisions) p.dueDate = shiftDate(p.dueDate, n);
  for (const e of s.events) e.targetDate = shiftDate(e.targetDate, n);
  for (const sc of s.scenarios) {
    for (const c of sc.changes) {
      c.start = addMonths(c.start, n);
      if (c.end) c.end = addMonths(c.end, n);
    }
  }
  for (const st of s.settings) st.budgetStartMonth = addMonths(st.budgetStartMonth, n);
  return s;
}
