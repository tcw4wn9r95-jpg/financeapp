import { describe, expect, it } from 'vitest';
import { formatMoney, formatMoneyInput, parseMoney, sumCents } from './money';

describe('parseMoney', () => {
  it.each([
    ['1.234,56', 123456],
    ['1 234,56', 123456],
    ['1 234,56', 123456],
    ['1234,56', 123456],
    ['1234.56', 123456],
    ['1,234.56', 123456],
    ['12,5', 1250],
    ['12.5', 1250],
    ['1.234', 123400],
    ['1.234.567', 123456700],
    ['-45,10', -4510],
    ['−45,10', -4510],
    ['+3', 300],
    ['€ 12', 1200],
    ['12 €', 1200],
    ['0,99', 99],
    [',5', 50],
    ['650', 65000],
    ['0', 0],
  ])('%s → %i cents', (input, expected) => {
    expect(parseMoney(input)).toBe(expected);
  });

  it.each(['', 'abc', '1,234,56', '12,345', '1.2.3', '12,999', '0.123', '1..2', '--5', '1e5', '12,5.3'])(
    'rejects %j',
    (input) => {
      expect(parseMoney(input)).toBeNull();
    },
  );
});

describe('formatMoney', () => {
  it('uses dot thousands and comma decimals', () => {
    expect(formatMoney(123456)).toBe('1.234,56 €');
    expect(formatMoney(-5)).toBe('−0,05 €');
    expect(formatMoney(100000000, { symbol: false })).toBe('1.000.000,00');
    expect(formatMoney(1200, { plusSign: true })).toBe('+12,00 €');
    expect(formatMoney(0)).toBe('0,00 €');
  });

  it('refuses floats', () => {
    expect(() => formatMoney(12.5)).toThrow();
  });

  it('round-trips through the input format', () => {
    for (const c of [0, 1, 99, 100, 123456, -98765, 1_000_000_00]) {
      expect(parseMoney(formatMoneyInput(c))).toBe(c);
      expect(parseMoney(formatMoney(c))).toBe(c);
    }
  });
});

describe('sumCents', () => {
  it('adds integers without drift', () => {
    expect(sumCents([10, 20, 30])).toBe(60);
    // 0.1 + 0.2 in floats is 0.30000000000000004; in cents it is exact.
    expect(sumCents([10, 20])).toBe(30);
  });
});
