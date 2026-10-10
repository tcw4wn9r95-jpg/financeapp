import type { Cents } from './types';

/**
 * Money helpers. All amounts are integer cents; these functions never produce
 * a float and refuse input that would need rounding.
 */

export function assertCents(value: number): asserts value is Cents {
  if (!Number.isSafeInteger(value)) {
    throw new Error(`Amount must be integer cents, got ${value}`);
  }
}

export function sumCents(values: Iterable<Cents>): Cents {
  let total = 0;
  for (const v of values) {
    assertCents(v);
    total += v;
  }
  assertCents(total);
  return total;
}

/**
 * Parse a user-typed amount into cents. Accepts European and plain formats:
 * "1.234,56", "1 234,56", "1234,56", "1234.56", "-12,5", "€ 12", "12 €".
 * Returns null when the input is not a valid amount or has more than 2 decimals.
 *
 * Separator rules (DECISIONS.md D-07):
 * - Both "." and "," present: the last one is the decimal separator.
 * - The same separator more than once: it is a thousands separator.
 * - A single ",": decimal separator.
 * - A single ".": thousands separator when followed by exactly 3 digits and the
 *   integer part is 1 to 3 digits not starting with 0 ("1.234" = 1234,00);
 *   otherwise decimal ("12.5" = 12,50).
 */
export function parseMoney(input: string): Cents | null {
  let s = input.trim().replace(/[\s  '€]/g, '').replace(/^EUR|EUR$/i, '');
  if (s === '') return null;

  let negative = false;
  if (/^[-−]/.test(s)) {
    negative = true;
    s = s.slice(1);
  } else if (s.startsWith('+')) {
    s = s.slice(1);
  }
  if (!/^[\d.,]+$/.test(s)) return null;

  const commas = (s.match(/,/g) ?? []).length;
  const dots = (s.match(/\./g) ?? []).length;
  let intPart = '';
  let fracPart = '';

  const splitOn = (decimal: string, thousands: string): boolean => {
    const at = s.lastIndexOf(decimal);
    const head = s.slice(0, at);
    fracPart = s.slice(at + 1);
    if (fracPart.includes(thousands)) return false;
    intPart = stripGrouping(head, thousands);
    return intPart !== '';
  };

  if (commas > 0 && dots > 0) {
    const ok = s.lastIndexOf(',') > s.lastIndexOf('.') ? splitOn(',', '.') : splitOn('.', ',');
    if (!ok) return null;
  } else if (commas > 1 || dots > 1) {
    const sep = commas > 1 ? ',' : '.';
    intPart = stripGrouping(s, sep);
    if (intPart === '') return null;
  } else if (commas === 1) {
    if (!splitOn(',', '.')) return null;
  } else if (dots === 1) {
    const [head = '', tail = ''] = s.split('.');
    if (tail.length === 3 && /^[1-9]\d{0,2}$/.test(head)) {
      intPart = head + tail;
    } else {
      intPart = head === '' ? '0' : head;
      fracPart = tail;
    }
  } else {
    intPart = s;
  }

  const whole = intPart;
  if (!/^\d+$/.test(whole) || !/^\d{0,2}$/.test(fracPart)) return null;
  const cents = Number(whole) * 100 + Number(fracPart.padEnd(2, '0'));
  if (!Number.isSafeInteger(cents)) return null;
  return negative ? -cents : cents;
}

/** Remove a thousands separator, checking that groups are 3 digits. Returns '' when malformed. */
function stripGrouping(s: string, sep: string): string {
  if (!s.includes(sep)) return s === '' ? '0' : s;
  const groups = s.split(sep);
  const [first = '', ...rest] = groups;
  if (!/^\d{1,3}$/.test(first) || rest.some((g) => !/^\d{3}$/.test(g))) return '';
  return groups.join('');
}

export interface FormatOptions {
  /** Append the currency symbol (default true). */
  symbol?: boolean;
  /** Show "+" for positive amounts (default false). */
  plusSign?: boolean;
}

/** Format cents as "1.234,56 €" (Luxembourg style: dot thousands, comma decimals). */
export function formatMoney(cents: Cents, opts: FormatOptions = {}): string {
  assertCents(cents);
  const { symbol = true, plusSign = false } = opts;
  const abs = Math.abs(cents);
  const whole = Math.floor(abs / 100).toString().replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  const frac = (abs % 100).toString().padStart(2, '0');
  const sign = cents < 0 ? '−' : plusSign && cents > 0 ? '+' : '';
  return `${sign}${whole},${frac}${symbol ? ' €' : ''}`;
}

/** Plain editable form of an amount: "1234,56" (no grouping, no symbol). */
export function formatMoneyInput(cents: Cents): string {
  assertCents(cents);
  const abs = Math.abs(cents);
  return `${cents < 0 ? '-' : ''}${Math.floor(abs / 100)},${(abs % 100).toString().padStart(2, '0')}`;
}
