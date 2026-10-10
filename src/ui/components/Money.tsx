import { formatMoney } from '../../domain/money';
import type { Cents } from '../../domain/types';

/** An amount. The sign is always written out, so colour is never the only signal. */
export function Money({ cents, plusSign = false, className = '' }: { cents: Cents; plusSign?: boolean; className?: string }) {
  const tone = cents < 0 ? 'neg' : cents > 0 ? 'pos' : 'zero';
  return <span className={`money money-${tone} ${className}`}>{formatMoney(cents, { plusSign })}</span>;
}
