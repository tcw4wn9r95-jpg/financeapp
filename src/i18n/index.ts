import type { MonthKey } from '../domain/types';
import { en } from './en';

/**
 * All UI strings live in one file per language (src/i18n/en.ts). To add French
 * or Spanish, copy en.ts to fr.ts / es.ts, translate the values, and register
 * it in `languages` below. Missing keys fall back to English.
 */
export type MessageKey = keyof typeof en;
export type Messages = Record<MessageKey, string>;

const languages: Record<string, Partial<Messages>> = { en };
let active: Partial<Messages> = en;

export function setLanguage(code: string): void {
  active = languages[code] ?? en;
  document.documentElement.lang = languages[code] ? code : 'en';
}

export function t(key: MessageKey, vars?: Record<string, string | number>): string {
  const text = active[key] ?? en[key];
  if (!vars) return text;
  return text.replace(/\{(\w+)\}/g, (m, name: string) => (name in vars ? String(vars[name]) : m));
}

const MONTH_KEYS = [
  'month.1', 'month.2', 'month.3', 'month.4', 'month.5', 'month.6',
  'month.7', 'month.8', 'month.9', 'month.10', 'month.11', 'month.12',
] as const satisfies readonly MessageKey[];

/** "2026-10" → "October 2026". */
export function monthName(month: MonthKey): string {
  const [y, m] = month.split('-');
  return `${t(MONTH_KEYS[Number(m) - 1]!)} ${y}`;
}

/** "2026-10" → "10/2026". */
export function monthShort(month: MonthKey): string {
  const [y, m] = month.split('-');
  return `${m}/${y}`;
}
