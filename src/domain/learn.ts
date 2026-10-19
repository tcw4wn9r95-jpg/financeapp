import { stamp, type Clock } from './ledger';
import { looksLikeTransfer, type LedgerChanges } from './import/plan';
import { maskCardNumbers, stripIbans } from './import/text';
import type { Changes } from './reconcile';
import type { Account, Allocation, Category, Cents, Id, Rule, RuleConditions, Suggestion, TargetType, TrainingExample, Transaction } from './types';

/**
 * Learning layer (PRD F6, M4). Pure functions; the UI writes what they return.
 *
 * Order on import and in the inbox: rules (confidence 1, applied), then
 * history (k nearest past decisions; applied at or above the threshold,
 * otherwise suggested), then — only when the user asks — Claude.
 */

export const DEFAULT_THRESHOLD = 0.92;
/** A merchant seen once gives a suggestion, never an automatic decision. */
const SINGLE_EXAMPLE_CONFIDENCE = 0.8;
/** How many recent decisions per merchant count. */
const K = 20;
/** Consistent confirmations before a rule is proposed. */
export const PROPOSAL_MIN = 3;

export interface Target {
  targetType: TargetType;
  targetId: Id;
}

// ------------------------------------------------------------- features

const BUCKETS = [500, 1000, 2500, 5000, 10000, 25000, 50000, 100000];

/** Direction plus an order-of-magnitude band, e.g. "out:25-50". */
export function amountBucket(amount: Cents): string {
  const abs = Math.abs(amount);
  const dir = amount < 0 ? 'out' : 'in';
  let lo = 0;
  for (const b of BUCKETS) {
    if (abs < b) return `${dir}:${lo / 100}-${b / 100}`;
    lo = b;
  }
  return `${dir}:${lo / 100}+`;
}

const COUNTRIES = new Set(['LU', 'FR', 'DE', 'BE', 'NL', 'ES', 'PT', 'IT', 'GB', 'IE', 'US', 'CH', 'AT', 'DK', 'SE', 'NO', 'PL', 'GR', 'JP', 'CA']);

/** Country code at the end of a card description ("DELHAIZE BERTRANGE LU"), if any. */
export function countryOf(t: Pick<Transaction, 'descriptionRaw'>): string {
  const m = /\b([A-Z]{2})\s*$/.exec(t.descriptionRaw.split(' — ')[0]!.trim());
  return m && COUNTRIES.has(m[1]!) ? m[1]! : '';
}

// ------------------------------------------------------------------ rules

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** A pattern the user typed: a regular expression when valid, else literal text. */
export function patternOf(text: string): RegExp {
  try {
    return new RegExp(text, 'i');
  } catch {
    return new RegExp(escapeRegex(text), 'i');
  }
}

export function ruleMatches(c: RuleConditions, t: Transaction): boolean {
  if (c.accountId && c.accountId !== t.accountId) return false;
  const abs = Math.abs(t.amount);
  if (c.amountMin !== undefined && abs < c.amountMin) return false;
  if (c.amountMax !== undefined && abs > c.amountMax) return false;
  if (c.country && c.country.toUpperCase() !== countryOf(t)) return false;
  if (c.merchantRegex) {
    const re = patternOf(c.merchantRegex);
    if (!re.test(t.merchantNorm) && !re.test(t.descriptionRaw)) return false;
  }
  return true;
}

/** Rules in the order they are tried: lower priority number first, then oldest. */
export function orderedRules(rules: readonly Rule[]): Rule[] {
  return [...rules].sort((a, b) => a.priority - b.priority || a.createdAt.localeCompare(b.createdAt));
}

export function matchRule(t: Transaction, rules: readonly Rule[]): Rule | undefined {
  return orderedRules(rules).find((r) => ruleMatches(r.conditions, t));
}

export function describeRule(r: Rule): string {
  return r.conditions.merchantRegex ?? '';
}

// ---------------------------------------------------------------- history

/** The decision recorded for one transaction (one example per transaction; re-deciding replaces it). */
export function exampleFor(t: Transaction, target: Target, clock: Clock): TrainingExample {
  return {
    ...stamp(clock, 'manual'),
    id: `ex:${t.id}`,
    merchantNorm: t.merchantNorm,
    amountBucket: amountBucket(t.amount),
    accountId: t.accountId,
    country: countryOf(t),
    chosenTarget: target,
    timestamp: clock.now(),
  };
}

const sameTarget = (a: Target, b: Target) => a.targetType === b.targetType && a.targetId === b.targetId;
const targetKey = (x: Target) => `${x.targetType}:${x.targetId}`;

export interface HistoryMatch extends Target {
  confidence: number;
  count: number;
  of: number;
}

/**
 * Nearest past decisions for the same merchant and direction. Prefers
 * examples in the same amount band; confidence is the share that agree.
 */
export function historyMatch(t: Transaction, examples: readonly TrainingExample[]): HistoryMatch | undefined {
  if (!t.merchantNorm) return undefined;
  const bucket = amountBucket(t.amount);
  const dir = bucket.split(':')[0];
  const same = examples
    .filter((e) => e.merchantNorm === t.merchantNorm && e.amountBucket.startsWith(`${dir}:`))
    .sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  if (same.length === 0) return undefined;
  const inBand = same.filter((e) => e.amountBucket === bucket);
  const pool = (inBand.length > 0 ? inBand : same).slice(0, K);
  const votes = new Map<string, { target: Target; n: number }>();
  for (const e of pool) {
    const k = targetKey(e.chosenTarget);
    const v = votes.get(k) ?? { target: e.chosenTarget, n: 0 };
    v.n++;
    votes.set(k, v);
  }
  const best = [...votes.values()].sort((a, b) => b.n - a.n)[0]!;
  let confidence = best.n / pool.length;
  if (pool.length === 1) confidence = Math.min(confidence, SINGLE_EXAMPLE_CONFIDENCE);
  if (inBand.length === 0) confidence *= 0.9; // other amounts only: a little less sure
  return { ...best.target, confidence: Math.round(confidence * 100) / 100, count: best.n, of: pool.length };
}

// ------------------------------------------------------------- deciding

export interface LearnContext {
  rules: readonly Rule[];
  examples: readonly TrainingExample[];
  accounts: readonly Account[];
  categories: readonly Category[];
  threshold: number;
  /** The monthly move to the provisions account, to recognise it (D-55). */
  provisionsMove?: { accountId: Id; byMonth: ReadonlyMap<string, Cents> };
}

export type Decision =
  | { apply: true; target: Target; confidence: number; decidedBy: Allocation['decidedBy']; reason: string; ruleId?: Id }
  | { apply: false; suggestion: Suggestion };

/** Is this target still valid (category exists and is not archived; account open)? */
function usable(target: Target, ctx: LearnContext, t: Transaction): boolean {
  if (target.targetType === 'transfer') {
    const a = ctx.accounts.find((x) => x.id === target.targetId);
    return !!a && !a.closedAt && a.id !== t.accountId;
  }
  const c = ctx.categories.find((x) => x.id === target.targetId);
  return !!c && !c.archivedAt && c.isIncome === (target.targetType === 'income');
}

/**
 * What rules and history say about one open transaction. Transfers are
 * never applied automatically: pairing needs the other side (it is a
 * suggestion instead), and loan repayments also need a category.
 */
export function decide(t: Transaction, ctx: LearnContext): Decision | undefined {
  const rule = matchRule(t, ctx.rules);
  if (rule && usable(rule.action, ctx, t)) {
    const reason = `Rule: ${describeRule(rule)}`;
    if (rule.action.targetType === 'transfer') return { apply: false, suggestion: { ...rule.action, confidence: 1, decidedBy: 'rule', reason } };
    return { apply: true, target: rule.action, confidence: 1, decidedBy: 'rule', reason, ruleId: rule.id };
  }
  const pm = ctx.provisionsMove;
  if (pm && t.amount < 0 && t.accountId !== pm.accountId) {
    const planned = pm.byMonth.get(t.date.slice(0, 7)) ?? 0;
    const target = ctx.accounts.find((a) => a.id === pm.accountId);
    if (target && planned > 0 && Math.abs(-t.amount - planned) <= 100) {
      return { apply: false, suggestion: { targetType: 'transfer', targetId: pm.accountId, confidence: 0.95, decidedBy: 'rule', reason: `Monthly provisions move to ${target.name}` } };
    }
  }
  const h = historyMatch(t, ctx.examples);
  if (h && usable(h, ctx, t)) {
    const target = { targetType: h.targetType, targetId: h.targetId };
    const reason = `Like ${h.count} of ${h.of} earlier`;
    if (h.confidence >= ctx.threshold && target.targetType !== 'transfer') {
      return { apply: true, target, confidence: h.confidence, decidedBy: 'history', reason };
    }
    return { apply: false, suggestion: { ...target, confidence: h.confidence, decidedBy: 'history', reason } };
  }
  return undefined;
}

export interface LearnResult {
  transactions: Transaction[];
  allocations: Allocation[];
  /** Rules with updated hit counts. */
  rules: Rule[];
  applied: number;
  suggested: number;
}

/**
 * Run rules and history over open transactions (status "new", or
 * "suggested" by an earlier history/AI guess). Rule and loan suggestions
 * from the import step are left alone.
 */
export function learn(open: readonly Transaction[], ctx: LearnContext, clock: Clock, source: Transaction['source'] = 'manual'): LearnResult {
  const out: LearnResult = { transactions: [], allocations: [], rules: [], applied: 0, suggested: 0 };
  const hits = new Map<Id, number>();
  for (const t of open) {
    if (t.isMirror || t.status === 'locked' || t.status === 'reconciled') continue;
    if (t.status === 'suggested' && t.suggestion?.decidedBy === 'rule') continue;
    const d = decide(t, ctx);
    if (!d) continue;
    const { suggestion: _s, ...plain } = t;
    if (d.apply) {
      out.transactions.push({ ...plain, status: 'reconciled', updatedAt: clock.now() });
      out.allocations.push({
        ...stamp(clock, source),
        transactionId: t.id,
        targetType: d.target.targetType,
        targetId: d.target.targetId,
        amount: t.amount,
        confidence: d.confidence,
        decidedBy: d.decidedBy,
        reason: d.reason,
      });
      if (d.ruleId) hits.set(d.ruleId, (hits.get(d.ruleId) ?? 0) + 1);
      out.applied++;
    } else if (!t.suggestion || t.suggestion.targetType !== d.suggestion.targetType || t.suggestion.targetId !== d.suggestion.targetId) {
      out.transactions.push({ ...plain, status: 'suggested', suggestion: d.suggestion, updatedAt: clock.now() });
      out.suggested++;
    }
  }
  for (const [id, n] of hits) {
    const r = ctx.rules.find((x) => x.id === id)!;
    out.rules.push({ ...r, hits: r.hits + n, updatedAt: clock.now() });
  }
  return out;
}

/** Rules and history over the rows an import just created. */
export function learnOnImport(ch: LedgerChanges, ctx: LearnContext, clock: Clock): { changes: LedgerChanges; rules: Rule[] } {
  const open = ch.transactions.filter((t) => t.importBatchId === ch.batch.id && t.status === 'new');
  const r = learn(open, ctx, clock, ch.batch.source);
  if (r.transactions.length === 0) return { changes: ch, rules: [] };
  const replaced = new Map(r.transactions.map((t) => [t.id, t]));
  const report = { ...ch.batch.report, autoApplied: r.applied, suggestions: ch.batch.report.suggestions + r.suggested };
  return {
    changes: {
      ...ch,
      transactions: ch.transactions.map((t) => replaced.get(t.id) ?? t),
      allocations: [...ch.allocations, ...r.allocations],
      batch: { ...ch.batch, report },
    },
    rules: r.rules,
  };
}

// ------------------------------------------------------- recording choices

/**
 * Training examples from a classification the user made or confirmed:
 * one per non-mirror transaction with a single allocation. Splits teach
 * nothing (no single answer); automatic decisions are not fed back.
 */
export function examplesFromChanges(ch: Changes, clock: Clock): TrainingExample[] {
  const out: TrainingExample[] = [];
  const txById = new Map(ch.putTransactions.map((t) => [t.id, t]));
  for (const t of ch.putTransactions) {
    if (t.isMirror || t.status !== 'reconciled') continue;
    const own = ch.putAllocations.filter((a) => a.transactionId === t.id);
    if (own.length !== 1) continue;
    const a = own[0]!;
    if (a.decidedBy !== 'user' && !a.reason.startsWith('Accepted:')) continue;
    let target: Target;
    if (a.targetType === 'transfer') {
      // The paired row, or the account itself when its own statement covers it (D-68).
      const other = txById.get(a.targetId);
      target = { targetType: 'transfer', targetId: other ? other.accountId : a.targetId };
    } else {
      target = { targetType: a.targetType, targetId: a.targetId };
    }
    out.push(exampleFor(t, target, clock));
  }
  return out;
}

// ---------------------------------------------------------- rule proposals

export interface RuleProposal {
  merchantNorm: string;
  target: Target;
  count: number;
}

/**
 * After {@link PROPOSAL_MIN} consistent confirmations for a merchant (the
 * latest ones all agree) and no rule covering it, propose a rule.
 */
export function ruleProposals(examples: readonly TrainingExample[], rules: readonly Rule[], dismissed: readonly string[] = []): RuleProposal[] {
  const byMerchant = new Map<string, TrainingExample[]>();
  for (const e of examples) {
    if (!e.merchantNorm || dismissed.includes(e.merchantNorm)) continue;
    const list = byMerchant.get(e.merchantNorm) ?? [];
    list.push(e);
    byMerchant.set(e.merchantNorm, list);
  }
  const out: RuleProposal[] = [];
  for (const [merchantNorm, list] of byMerchant) {
    if (list.length < PROPOSAL_MIN) continue;
    const recent = [...list].sort((a, b) => b.timestamp.localeCompare(a.timestamp)).slice(0, PROPOSAL_MIN);
    const target = recent[0]!.chosenTarget;
    if (!recent.every((e) => sameTarget(e.chosenTarget, target))) continue;
    const covered = rules.some((r) => r.conditions.merchantRegex && patternOf(r.conditions.merchantRegex).test(merchantNorm));
    if (covered) continue;
    out.push({ merchantNorm, target, count: list.filter((e) => sameTarget(e.chosenTarget, target)).length });
  }
  return out.sort((a, b) => b.count - a.count || a.merchantNorm.localeCompare(b.merchantNorm));
}

/** The rule a proposal creates ("hardened" from history). */
export function ruleFromProposal(p: RuleProposal, rules: readonly Rule[], clock: Clock): Rule {
  return {
    ...stamp(clock, 'manual'),
    priority: rules.reduce((m, r) => Math.max(m, r.priority), 0) + 10,
    conditions: { merchantRegex: `^${escapeRegex(p.merchantNorm)}$` },
    action: p.target,
    hits: 0,
    createdFrom: 'hardened',
  };
}

// --------------------------------------------------------- Claude fallback

/**
 * What leaves the device when the user asks Claude (D-37): merchant text
 * without IBANs, card numbers, long references or household names;
 * transfers become "PERSONAL TRANSFER". No account names, no balances.
 */
export interface RedactedItem {
  ref: string;
  merchant: string;
  amount: number;
  date: string;
  country: string;
}

export function redactMerchant(t: Transaction, names: readonly string[]): string {
  if (looksLikeTransfer(t)) return 'PERSONAL TRANSFER';
  let text = maskCardNumbers(stripIbans(t.merchantNorm || t.descriptionRaw)).toUpperCase();
  for (const n of names) {
    for (const part of n.split(/\s+/).filter((p) => p.length >= 3)) {
      text = text.replace(new RegExp(`\\b${escapeRegex(part.toUpperCase())}\\b`, 'g'), 'PERSON');
    }
  }
  return text
    .replace(/\b[A-Z]{2}\d{2}[A-Z0-9]{10,30}\b/g, '') // IBAN-like without the keyword
    .replace(/[\d*X]{6,}/g, '') // references, masked numbers
    .replace(/\s+/g, ' ')
    .trim() || 'UNKNOWN';
}

export function redact(items: readonly Transaction[], names: readonly string[]): RedactedItem[] {
  return items.map((t, i) => ({
    ref: String(i + 1),
    merchant: redactMerchant(t, names),
    amount: t.amount / 100,
    date: t.date,
    country: countryOf(t),
  }));
}

export interface AiTarget {
  key: string;
  name: string;
  kind: 'expense' | 'income';
  group: string;
  target: Target;
}

/** Categories offered to Claude, under short keys so no ids leave the device. */
export function aiTargets(categories: readonly Category[]): AiTarget[] {
  return categories
    .filter((c) => !c.archivedAt)
    .map((c, i) => ({
      key: `c${i + 1}`,
      name: c.name,
      kind: c.isIncome ? ('income' as const) : ('expense' as const),
      group: c.isIncome ? 'income' : c.groupId,
      target: { targetType: c.isIncome ? ('income' as const) : ('category' as const), targetId: c.id },
    }));
}

export const AI_SCHEMA = {
  type: 'object',
  properties: {
    results: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          ref: { type: 'string' },
          target: { type: 'string', description: 'A category key such as "c3", or "none" when unsure.' },
          confidence: { type: 'number', description: 'Between 0 and 1.' },
          reason: { type: 'string', description: 'A few words.' },
        },
        required: ['ref', 'target', 'confidence', 'reason'],
        additionalProperties: false,
      },
    },
  },
  required: ['results'],
  additionalProperties: false,
} as const;

export function aiPrompt(items: readonly RedactedItem[], targets: readonly AiTarget[]): string {
  return [
    'You categorise bank transactions for a household budget in Luxembourg (amounts in EUR; negative = money out).',
    'Pick the best category key for each transaction from the list. Use "none" with a low confidence when the merchant is ambiguous; do not guess.',
    'Income categories only fit money in. A refund (money in from a shop) belongs to the expense category of that shop.',
    '',
    'Categories:',
    ...targets.map((x) => `${x.key}: ${x.name} (${x.kind}${x.kind === 'expense' ? `, ${x.group}` : ''})`),
    '',
    'Transactions (JSON):',
    JSON.stringify(items),
  ].join('\n');
}

export interface AiAnswer {
  ref: string;
  target: string;
  confidence: number;
  reason: string;
}

/** Turn Claude's answer into suggestions or decisions; anything malformed is dropped. */
export function readAiAnswers(answers: readonly AiAnswer[], items: readonly Transaction[], targets: readonly AiTarget[], threshold: number): Map<Id, Decision> {
  const out = new Map<Id, Decision>();
  for (const a of answers) {
    const t = items[Number(a.ref) - 1];
    const target = targets.find((x) => x.key === a.target);
    if (!t || !target || out.has(t.id)) continue;
    if (target.kind === 'income' && t.amount < 0) continue;
    const confidence = Math.max(0, Math.min(1, Math.round(Number(a.confidence) * 100) / 100));
    if (!Number.isFinite(confidence)) continue;
    const reason = `Claude: ${String(a.reason).slice(0, 80)}`;
    out.set(
      t.id,
      confidence >= threshold
        ? { apply: true, target: target.target, confidence, decidedBy: 'ai', reason }
        : { apply: false, suggestion: { ...target.target, confidence, decidedBy: 'ai', reason } },
    );
  }
  return out;
}

/** Apply decisions (from Claude) to open transactions. */
export function applyDecisions(items: readonly Transaction[], decisions: Map<Id, Decision>, clock: Clock): LearnResult {
  const out: LearnResult = { transactions: [], allocations: [], rules: [], applied: 0, suggested: 0 };
  for (const t of items) {
    const d = decisions.get(t.id);
    if (!d || t.status === 'locked' || t.status === 'reconciled') continue;
    const { suggestion: _s, ...plain } = t;
    if (d.apply) {
      out.transactions.push({ ...plain, status: 'reconciled', updatedAt: clock.now() });
      out.allocations.push({
        ...stamp(clock, 'manual'),
        transactionId: t.id,
        targetType: d.target.targetType,
        targetId: d.target.targetId,
        amount: t.amount,
        confidence: d.confidence,
        decidedBy: d.decidedBy,
        reason: d.reason,
      });
      out.applied++;
    } else {
      out.transactions.push({ ...plain, status: 'suggested', suggestion: d.suggestion, updatedAt: clock.now() });
      out.suggested++;
    }
  }
  return out;
}

/** Automatic decisions still in effect, newest first (the "applied automatically" log). */
export function autoApplied(allocations: readonly Allocation[], transactions: readonly Transaction[]): { allocation: Allocation; transaction: Transaction }[] {
  const byId = new Map(transactions.map((t) => [t.id, t]));
  return allocations
    .filter((a) => a.decidedBy === 'rule' || a.decidedBy === 'history' || a.decidedBy === 'ai')
    .filter((a) => a.targetType !== 'transfer' && !a.reason.startsWith('Accepted:'))
    .map((a) => ({ allocation: a, transaction: byId.get(a.transactionId)! }))
    .filter((x) => x.transaction && x.transaction.status === 'reconciled')
    .sort((a, b) => b.allocation.createdAt.localeCompare(a.allocation.createdAt));
}
