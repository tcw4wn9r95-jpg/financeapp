import { addMonths, monthOf } from './dates';
import type { LedgerView } from './reconcile';
import type { Cents, Id, MonthKey } from './types';

/**
 * A loan without its own budget line whose payments can be recognised (D-101):
 * the rows its known payments came from, and every other row with the same
 * amount and the same bank text (dates and numbers aside), wherever they were
 * filed. Making it a line budgets the instalment like a mortgage's and files
 * those payments there, which also lowers the loan (D-93).
 */
export interface LoanLineSuggestion {
  loanId: Id;
  loanName: string;
  /** The instalment, positive. */
  amount: Cents;
  /** The bank text the payments share. */
  payee: string;
  /** The payment rows (on the paying accounts), oldest first. */
  rows: Id[];
  /** Where those rows are filed now: category id (or '' for transfers and unfiled), with counts. */
  filedTo: Record<Id, number>;
  firstMonth: MonthKey;
  /** The last instalment, when the amount owed at the start says so. */
  lastMonth?: MonthKey;
}

/** The bank text without dates, numbers and punctuation: "DIRECT DEBIT BUY WAY SA 07/09/26" → "direct debit buy way sa". */
export function payeeKey(text: string): string {
  return text.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z]+/g, ' ').trim();
}

export function suggestLoanLines(view: LedgerView): LoanLineSuggestion[] {
  const byId = new Map(view.transactions.map((t) => [t.id, t]));
  const accountType = new Map(view.accounts.map((a) => [a.id, a.type]));
  const out: LoanLineSuggestion[] = [];
  for (const loan of view.accounts) {
    if (loan.type !== 'loan' || loan.categoryId || loan.closedAt) continue;
    // The rows known to have paid this loan: the other side of its own rows, or rows filed as a transfer to it.
    const sources = new Set<Id>();
    for (const a of view.allocations) {
      if (a.targetType !== 'transfer') continue;
      const own = byId.get(a.transactionId);
      if (own?.accountId === loan.id && own.amount > 0 && byId.has(a.targetId)) sources.add(a.targetId);
      if (a.targetId === loan.id && own && own.accountId !== loan.id && own.amount < 0) sources.add(own.id);
    }
    const known = [...sources].map((id) => byId.get(id)!).filter((t) => accountType.get(t.accountId) !== 'loan' && t.amount < 0);
    if (!known.length) continue;
    const latest = known.sort((a, b) => b.date.localeCompare(a.date))[0]!;
    const key = payeeKey(latest.descriptionRaw);
    if (!key) continue;
    const rows = view.transactions
      .filter((t) => t.amount === latest.amount && accountType.get(t.accountId) !== 'loan' && payeeKey(t.descriptionRaw) === key && (!loan.openingDate || t.date >= loan.openingDate))
      .sort((a, b) => a.date.localeCompare(b.date));
    if (!rows.length) continue;
    const filedTo: Record<Id, number> = {};
    for (const t of rows) {
      const al = view.allocations.filter((a) => a.transactionId === t.id);
      const target = al.length === 1 && al[0]!.targetType === 'category' ? al[0]!.targetId : '';
      filedTo[target] = (filedTo[target] ?? 0) + 1;
    }
    const amount = -latest.amount;
    const firstMonth = monthOf(rows[0]!.date);
    // What was owed at the start, paid in equal instalments from the first payment.
    const owed = -loan.openingBalance;
    const lastMonth = owed > 0 ? addMonths(firstMonth, Math.ceil(owed / amount) - 1) : undefined;
    out.push({ loanId: loan.id, loanName: loan.name, amount, payee: latest.descriptionRaw.replace(/\s*\d[\d/.]*\s*$/, '').trim(), rows: rows.map((t) => t.id), filedTo, firstMonth, ...(lastMonth ? { lastMonth } : {}) });
  }
  return out;
}
