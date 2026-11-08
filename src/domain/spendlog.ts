import { daysInMonth } from './dates';
import type { Cents, Id, LogEntry, MonthKey } from './types';

/**
 * The spending log (D-112): what was logged by hand in a month, against the
 * plan of the lines it was logged to (and of the day-to-day lines), at an
 * even pace through the month. It never touches the ledger or the budget.
 */

export interface LogLine {
  categoryId: Id;
  logged: Cents;
  planned: Cents;
  count: number;
}

export interface LogMonth {
  month: MonthKey;
  days: number;
  /** The day reached: today in the current month, the last day of a past month, 0 ahead. */
  day: number;
  total: Cents;
  /** Plan of the day-to-day lines plus any other line logged to. */
  planned: Cents;
  /** Logged so far, day by day (cumulative), up to `day`. */
  cumulative: Cents[];
  /** Where the even pace to the plan stands on `day`. */
  pace: Cents;
  /** The month's total if it goes on as so far. */
  projected: Cents;
  lines: LogLine[];
  entries: LogEntry[];
}

export function logMonth(entries: readonly LogEntry[], month: MonthKey, today: string, plannedFor: (id: Id) => Cents, dayToDay: readonly Id[]): LogMonth {
  const [y, m] = month.split('-').map(Number) as [number, number];
  const days = daysInMonth(y, m);
  const thisMonth = today.slice(0, 7);
  const day = month < thisMonth ? days : month === thisMonth ? Number(today.slice(8, 10)) : 0;
  const mine = entries.filter((e) => e.at.startsWith(month)).sort((a, b) => b.at.localeCompare(a.at));
  const byLine = new Map<Id, LogLine>();
  for (const id of dayToDay) byLine.set(id, { categoryId: id, logged: 0, planned: plannedFor(id), count: 0 });
  const perDay = new Array<Cents>(days).fill(0);
  for (const e of mine) {
    const l = byLine.get(e.categoryId) ?? { categoryId: e.categoryId, logged: 0, planned: plannedFor(e.categoryId), count: 0 };
    l.logged += e.amount;
    l.count++;
    byLine.set(e.categoryId, l);
    const d = Number(e.at.slice(8, 10));
    if (d >= 1 && d <= days) perDay[d - 1]! += e.amount;
  }
  const cumulative: Cents[] = [];
  let run = 0;
  for (let d = 0; d < day; d++) cumulative.push((run += perDay[d]!));
  const total = mine.reduce((s, e) => s + e.amount, 0);
  const lines = [...byLine.values()].filter((l) => l.logged > 0 || l.planned > 0).sort((a, b) => b.logged - a.logged || b.planned - a.planned);
  const planned = lines.reduce((s, l) => s + l.planned, 0);
  return {
    month,
    days,
    day,
    total,
    planned,
    cumulative,
    pace: Math.round((planned * day) / days),
    projected: day > 0 ? Math.round((total * days) / day) : 0,
    lines,
    entries: mine,
  };
}

/** Lines to offer first when logging: the most logged in the last 60 days, then the rest. */
export function frequentLines(entries: readonly LogEntry[], today: string, candidates: readonly Id[]): Id[] {
  const from = new Date(`${today.slice(0, 10)}T00:00:00`);
  from.setDate(from.getDate() - 60);
  const since = from.toISOString().slice(0, 10);
  const counts = new Map<Id, number>();
  for (const e of entries) if (e.at.slice(0, 10) >= since) counts.set(e.categoryId, (counts.get(e.categoryId) ?? 0) + 1);
  return [...candidates].sort((a, b) => (counts.get(b) ?? 0) - (counts.get(a) ?? 0));
}
