import { describe, expect, it } from 'vitest';
import { frequentLines, logMonth } from './spendlog';
import type { LogEntry } from './types';

const entry = (id: string, at: string, amount: number, categoryId: string): LogEntry => ({ id, createdAt: '', updatedAt: '', source: 'manual', at, amount, categoryId });

describe('the spending log (D-112)', () => {
  const entries = [entry('a', '2026-11-02T10:00', 2_000, 'food'), entry('b', '2026-11-02T19:00', 1_000, 'out'), entry('c', '2026-11-05T12:00', 3_000, 'food'), entry('old', '2026-10-30T09:00', 9_999, 'food')];
  const planned = (id: string) => ({ food: 40_000, out: 25_000, fun: 10_000 })[id] ?? 0;

  it('adds up the month day by day against an even pace to the plan', () => {
    const m = logMonth(entries, '2026-11', '2026-11-06', planned, ['food', 'out', 'fun']);
    expect(m.total).toBe(6_000);
    expect(m.planned).toBe(75_000);
    expect(m.day).toBe(6);
    expect(m.cumulative).toEqual([0, 3_000, 3_000, 3_000, 6_000, 6_000]);
    expect(m.pace).toBe(Math.round((75_000 * 6) / 30));
    expect(m.projected).toBe(30_000);
    expect(m.lines.map((l) => [l.categoryId, l.logged, l.count])).toEqual([['food', 5_000, 2], ['out', 1_000, 1], ['fun', 0, 0]]);
  });
  it('counts a line logged to outside the day-to-day lines too', () => {
    const m = logMonth([...entries, entry('d', '2026-11-03T08:00', 500, 'party')], '2026-11', '2026-11-06', (id) => (id === 'party' ? 30_000 : planned(id)), ['food']);
    expect(m.lines.map((l) => l.categoryId)).toEqual(['food', 'out', 'party']);
    expect(m.planned).toBe(40_000 + 25_000 + 30_000);
  });
  it('offers the most logged lines first', () => {
    expect(frequentLines(entries, '2026-11-06T10:00', ['out', 'fun', 'food'])).toEqual(['food', 'out', 'fun']);
  });
});
