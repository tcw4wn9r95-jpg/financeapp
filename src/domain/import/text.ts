import { daysInMonth } from '../dates';
import type { Cents, IsoDate } from '../types';

/** Parse an amount with a known decimal separator. Returns null when not a number or more than 2 decimals. */
export function parseAmount(raw: string, decimal: 'comma' | 'dot'): Cents | null {
  let s = raw.trim().replace(/[\s  '€]/g, '');
  if (s === '') return null;
  let sign = 1;
  // Trailing sign ("84,37 -", "16.330,98+") or leading sign, or (parentheses).
  const trailing = /^(.*?)([+-])$/.exec(s);
  if (trailing && /\d/.test(trailing[1]!)) {
    s = trailing[1]!;
    if (trailing[2] === '-') sign = -sign;
  }
  if (/^\(.*\)$/.test(s)) {
    s = s.slice(1, -1);
    sign = -sign;
  }
  if (/^[-−]/.test(s)) {
    sign = -sign;
    s = s.slice(1);
  } else if (s.startsWith('+')) s = s.slice(1);
  const [thousands, dec] = decimal === 'comma' ? ['.', ','] : [',', '.'];
  s = s.split(thousands).join('');
  const parts = s.split(dec);
  if (parts.length > 2) return null;
  const [whole = '', frac = ''] = parts;
  if (!/^\d+$/.test(whole === '' ? '0' : whole) || !/^\d{0,2}$/.test(frac)) return null;
  const cents = Number(whole || '0') * 100 + Number(frac.padEnd(2, '0'));
  if (!Number.isSafeInteger(cents)) return null;
  return sign * cents || 0;
}

function iso(y: number, m: number, d: number): IsoDate | null {
  if (y < 1900 || y > 2200 || m < 1 || m > 12 || d < 1 || d > daysInMonth(y, m)) return null;
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/**
 * Parse a date as banks print it, ignoring a time part.
 * order 'auto': yyyy-mm-dd if it starts with a 4-digit year, else day first.
 */
export function parseBankDate(raw: string, order: 'auto' | 'dmy' | 'ymd' | 'mdy' = 'auto'): IsoDate | null {
  const s = raw.trim().split(/[ T]/)[0] ?? '';
  const parts = s.split(/[./-]/).map((p) => p.trim());
  if (parts.length !== 3 || parts.some((p) => !/^\d+$/.test(p))) return null;
  const [a, b, c] = parts.map(Number) as [number, number, number];
  const year = (n: number, len: number) => (len === 2 ? 2000 + n : n);
  if (order === 'ymd' || (order === 'auto' && parts[0]!.length === 4)) return iso(a, b, c);
  if (order === 'mdy') return iso(year(c, parts[2]!.length), a, b);
  return iso(year(c, parts[2]!.length), b, a);
}

/**
 * Replace card numbers by "••1234": 16 digits in groups of four, or 15 to 19
 * contiguous digits. Shorter references (ticket numbers) are left alone.
 */
export function maskCardNumbers(text: string): string {
  return text
    .replace(/\b\d{4}[ -]\d{4}[ -]\d{4}[ -]\d{4}(?:[ -]\d{1,3})?\b/g, (m) => `••${m.replace(/\D/g, '').slice(-4)}`)
    .replace(/\b\d{15,19}\b/g, (m) => `••${m.slice(-4)}`);
}

/** An IBAN written after the word "IBAN", with or without spaces. */
const IBAN_RE = /IBAN:?\s*([A-Z]{2}\d{2}(?: ?[A-Z0-9]{4}){2,7}(?: ?[A-Z0-9]{1,3})?)(?![A-Za-z0-9])/;

/** Find an IBAN ("IBAN LU28 0019 …") in a text and return its last 4 characters. */
export function ibanLast4(text: string): string | undefined {
  const m = IBAN_RE.exec(text);
  if (!m) return undefined;
  const compact = m[1]!.replace(/\s/g, '');
  return compact.length >= 15 ? compact.slice(-4) : undefined;
}

/** Shorten IBANs to their last 4 characters: they never need to be stored in full. */
export function stripIbans(text: string): string {
  return text.replace(new RegExp(IBAN_RE.source, 'g'), (_m, iban: string) => `IBAN ••${iban.replace(/\s/g, '').slice(-4)}`);
}

/** Collapse whitespace. */
export function squash(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}
