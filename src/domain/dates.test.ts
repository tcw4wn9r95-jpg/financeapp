import { describe, expect, it } from 'vitest';
import {
  addDays,
  addMonths,
  formatDate,
  isoWeekday,
  lastDayOfMonth,
  monthDiff,
  monthRange,
  parseDate,
  startOfWeek,
  todayIso,
} from './dates';

describe('parseDate', () => {
  it.each([
    ['03/10/2026', '2026-10-03'],
    ['3/10/2026', '2026-10-03'],
    ['03.10.2026', '2026-10-03'],
    ['03-10-2026', '2026-10-03'],
    ['03/10/26', '2026-10-03'],
    ['2026-10-03', '2026-10-03'],
    ['29/02/2028', '2028-02-29'],
  ])('%s → %s', (input, iso) => {
    expect(parseDate(input)).toBe(iso);
  });

  it.each(['31/02/2026', '29/02/2027', '00/01/2026', '12/13/2026', '2026-13-01', 'tomorrow', ''])('rejects %j', (s) => {
    expect(parseDate(s)).toBeNull();
  });

  it('day comes first (dd/mm/yyyy, not US order)', () => {
    expect(parseDate('05/04/2026')).toBe('2026-04-05');
  });
});

describe('formatDate', () => {
  it('shows dd/mm/yyyy', () => {
    expect(formatDate('2026-10-03')).toBe('03/10/2026');
  });
});

describe('months', () => {
  it('adds across years', () => {
    expect(addMonths('2026-11', 3)).toBe('2027-02');
    expect(addMonths('2026-01', -1)).toBe('2025-12');
    expect(monthDiff('2026-04', '2027-03')).toBe(11);
    expect(monthRange('2026-11', '2027-01')).toEqual(['2026-11', '2026-12', '2027-01']);
    expect(monthRange('2026-11', '2026-10')).toEqual([]);
    expect(lastDayOfMonth('2028-02')).toBe('2028-02-29');
  });
});

describe('weeks start on Monday', () => {
  it('computes ISO weekday and week start', () => {
    expect(isoWeekday('2026-10-12')).toBe(1); // Monday
    expect(isoWeekday('2026-10-11')).toBe(7); // Sunday
    expect(startOfWeek('2026-10-11')).toBe('2026-10-05');
    expect(startOfWeek('2026-10-12')).toBe('2026-10-12');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
  });

  it('uses the local calendar for today', () => {
    expect(todayIso(new Date(2026, 9, 10, 23, 59))).toBe('2026-10-10');
  });
});
