import type { IsoDate, MonthKey } from './types';

/**
 * Calendar helpers. Dates are plain "YYYY-MM-DD" strings with no time zone so a
 * transaction never moves to another day when the device changes zone.
 * UI format is dd/mm/yyyy; weeks start on Monday.
 */

const ISO_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const MONTH_RE = /^(\d{4})-(\d{2})$/;

function pad(n: number, width = 2): string {
  return n.toString().padStart(width, '0');
}

function isValidYmd(y: number, m: number, d: number): boolean {
  if (y < 1900 || y > 2200 || m < 1 || m > 12 || d < 1) return false;
  return d <= daysInMonth(y, m);
}

export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

export function isIsoDate(s: string): s is IsoDate {
  const m = ISO_RE.exec(s);
  return !!m && isValidYmd(Number(m[1]), Number(m[2]), Number(m[3]));
}

export function isMonthKey(s: string): s is MonthKey {
  const m = MONTH_RE.exec(s);
  return !!m && Number(m[2]) >= 1 && Number(m[2]) <= 12;
}

/**
 * Parse a user-typed date. Accepts dd/mm/yyyy, d/m/yyyy, dd.mm.yyyy, dd-mm-yyyy,
 * dd/mm/yy (20yy) and ISO yyyy-mm-dd. Returns null when invalid.
 */
export function parseDate(input: string): IsoDate | null {
  const s = input.trim();
  if (isIsoDate(s)) return s;
  const m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2}|\d{4})$/.exec(s);
  if (!m) return null;
  const d = Number(m[1]);
  const mo = Number(m[2]);
  let y = Number(m[3]);
  if (m[3]!.length === 2) y += 2000;
  if (!isValidYmd(y, mo, d)) return null;
  return `${y}-${pad(mo)}-${pad(d)}`;
}

/** "2026-10-03" → "03/10/2026". */
export function formatDate(iso: IsoDate): string {
  const m = ISO_RE.exec(iso);
  if (!m) return iso;
  return `${m[3]}/${m[2]}/${m[1]}`;
}

export function monthOf(iso: IsoDate): MonthKey {
  return iso.slice(0, 7);
}

export function addMonths(month: MonthKey, n: number): MonthKey {
  const m = MONTH_RE.exec(month);
  if (!m) throw new Error(`Invalid month ${month}`);
  const index = Number(m[1]) * 12 + (Number(m[2]) - 1) + n;
  return `${Math.floor(index / 12)}-${pad((index % 12) + 1)}`;
}

/** Number of months from a to b (b − a). */
export function monthDiff(a: MonthKey, b: MonthKey): number {
  const [ay, am] = a.split('-').map(Number) as [number, number];
  const [by, bm] = b.split('-').map(Number) as [number, number];
  return (by - ay) * 12 + (bm - am);
}

/** Inclusive list of months from a to b. Empty when b is before a. */
export function monthRange(a: MonthKey, b: MonthKey): MonthKey[] {
  const out: MonthKey[] = [];
  for (let i = 0; i <= monthDiff(a, b); i++) out.push(addMonths(a, i));
  return out;
}

export function compareMonths(a: MonthKey, b: MonthKey): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Today's date on the device's local calendar. */
export function todayIso(now: Date = new Date()): IsoDate {
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

export function currentMonth(now: Date = new Date()): MonthKey {
  return monthOf(todayIso(now));
}

export function addDays(iso: IsoDate, n: number): IsoDate {
  const [y, m, d] = iso.split('-').map(Number) as [number, number, number];
  const dt = new Date(Date.UTC(y, m - 1, d + n));
  return `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`;
}

/** ISO weekday: Monday = 1 … Sunday = 7. */
export function isoWeekday(iso: IsoDate): number {
  const [y, m, d] = iso.split('-').map(Number) as [number, number, number];
  const day = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return day === 0 ? 7 : day;
}

/** Monday of the week containing the date (weeks start on Monday). */
export function startOfWeek(iso: IsoDate): IsoDate {
  return addDays(iso, 1 - isoWeekday(iso));
}

export function lastDayOfMonth(month: MonthKey): IsoDate {
  const [y, m] = month.split('-').map(Number) as [number, number];
  return `${month}-${pad(daysInMonth(y, m))}`;
}
