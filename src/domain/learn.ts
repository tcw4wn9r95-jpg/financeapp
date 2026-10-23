import { stamp, type Clock } from './ledger';
import { looksLikeTransfer, recogniseAccount, type LedgerChanges } from './import/plan';
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

// ----------------------------------------------------------- predicting

/** A transaction the user already filed under one target: what predictions learn from (D-80). */
export interface FiledRow {
  tx: Transaction;
  target: Target;
}

/**
 * Filed transactions with a single target (a category, income or a transfer
 * to an own account), from the ledger itself: the full text, exact amount,
 * account and counterparty are all there to compare with.
 */
export function filedHistory(transactions: readonly Transaction[], allocations: readonly Allocation[]): FiledRow[] {
  const byTx = new Map<Id, Allocation[]>();
  for (const a of allocations) byTx.set(a.transactionId, [...(byTx.get(a.transactionId) ?? []), a]);
  const txById = new Map(transactions.map((t) => [t.id, t]));
  const accountIds = new Set(transactions.map((t) => t.accountId));
  const out: FiledRow[] = [];
  for (const t of transactions) {
    if (t.isMirror || (t.status !== 'reconciled' && t.status !== 'locked')) continue;
    const own = byTx.get(t.id) ?? [];
    if (own.length !== 1) continue;
    const a = own[0]!;
    if (a.targetType === 'transfer') {
      const other = txById.get(a.targetId);
      const account = other ? other.accountId : accountIds.has(a.targetId) ? a.targetId : undefined;
      if (account) out.push({ tx: t, target: { targetType: 'transfer', targetId: account } });
    } else {
      out.push({ tx: t, target: { targetType: a.targetType, targetId: a.targetId } });
    }
  }
  return out;
}

/** Evidence needed before the first guess is offered as the one-tap choice (tuned on real filings, D-80). */
export const SURE_SCORE = 3;

/** Words that say nothing about what was bought. */
const NOISE = new Set(
  'card carte debit credit payment paiement purchase achat transfer virement instant sepa tpv pos contactless apple pay google from to the and for des les pour par avec with sarl sa sas gmbh ltd luxembourg lux lu eur net s-net ref ordre order standing favour favor'.split(' '),
);

export function words(text: string): string[] {
  return [...new Set(text.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').split(/[^a-z]+/).filter((w) => w.length >= 3 && !NOISE.has(w)))];
}

/**
 * How telling each word is: words in many filed transactions (visa, card,
 * debit…) say nothing; a shop name says a lot (D-81). Cached per history.
 */
const idfCache = new WeakMap<readonly FiledRow[], { weight: (w: string) => number; words: Map<Id, string[]> }>();
function textModel(history: readonly FiledRow[]) {
  let m = idfCache.get(history);
  if (m) return m;
  const df = new Map<string, number>();
  const perTx = new Map<Id, string[]>();
  for (const h of history) {
    const ws = words(`${h.tx.descriptionRaw} ${h.tx.counterparty}`);
    perTx.set(h.tx.id, ws);
    for (const w of ws) df.set(w, (df.get(w) ?? 0) + 1);
  }
  const N = Math.max(1, history.length);
  m = {
    // 0 for a word in more than 3% of filed transactions, up to ~5 for a word seen once.
    weight: (w) => {
      const d = df.get(w) ?? 0;
      return d / N > 0.03 ? 0 : Math.log((N + 1) / (d + 1));
    },
    words: perTx,
  };
  idfCache.set(history, m);
  return m;
}

/** Common merchants and words, for when nothing like it was filed yet: a hint matched against category names. */
const KEYWORDS: [RegExp, RegExp][] = [
  [/\b(auchan|cactus|delhaize|aldi|lidl|carrefour|match|colruyt|naturata|supermarch|grocer|alima|pall center)/i, /grocer|food|supermarket|courses|aliment/i],
  [/\b(restaurant|resto|cafe|coffee|bistro|pizza|burger|mcdonald|starbucks|bakery|boulangerie|brasserie|deliveroo|wedely|ubereats|kebab|sushi)/i, /eating|restaurant|food out|dining|sortie/i],
  [/\b(shell|aral|total|esso|q8|gulf|fuel|essence|parking|cfl|luxtram|uber|bolt|sncf|bus)/i, /transport|car|fuel|mobility/i],
  [/\b(pharmac|apotheke|doctor|docteur|medecin|dentist|hospital|hopital|chl|laborato|kine|clinic|optic)/i, /health|sant|medical|doctor/i],
  [/\b(netflix|spotify|disney|apple\.com|icloud|prime|youtube|claude|openai)/i, /netflix|spotify|subscript|icloud|prime|streaming|claude|apple/i],
  [/\b(ikea|leroy|hornbach|bauhaus|brico|maisons du monde)/i, /home|house|maison/i],
  [/\b(zara|h&m|primark|decathlon|zalando|uniqlo|mango)/i, /cloth|shopping|fashion/i],
  [/\b(easyjet|ryanair|luxair|lufthansa|booking|airbnb|hotel|tap air|klm)/i, /travel|holiday|trip|vacation/i],
  [/\b(salaire|salary|lohn|gehalt|payroll)/i, /salary|salaire|wage/i],
];

/**
 * The likeliest targets for an open transaction, best first (D-80): a sure
 * suggestion, then transactions filed before that look like it (same or
 * similar merchant text, counterparty account, exact or close amount, same
 * account; recent ones count more), then common merchant words matched to
 * category names. Only the same direction (money in or out) is compared.
 */
export function predictTargets(
  t: Transaction,
  history: readonly FiledRow[],
  categories: readonly Pick<Category, 'id' | 'name' | 'isIncome' | 'archivedAt'>[],
  usable: (target: Target) => boolean,
  n = 4,
  accounts: readonly Account[] = [],
): Target[] & { sure: boolean; score: number } {
  const scores = new Map<string, { target: Target; score: number }>();
  const add = (target: Target, score: number) => {
    if (score <= 0 || !usable(target)) return;
    const k = targetKey(target);
    const v = scores.get(k) ?? { target, score: 0 };
    v.score += score;
    scores.set(k, v);
  };
  if (t.suggestion) add({ targetType: t.suggestion.targetType, targetId: t.suggestion.targetId }, 50 * t.suggestion.confidence);

  // A transfer to an own account is only guessed when something says so (D-81): the text names the
  // account, or an earlier row with the very same counterparty went there. A card purchase is not one.
  const named = recogniseAccount(t, accounts);
  if (named) add({ targetType: 'transfer', targetId: named.id }, 8);

  const model = textModel(history);
  const mine = words(`${t.descriptionRaw} ${t.counterparty}`);
  const myWeight = mine.reduce((sum, w) => sum + model.weight(w), 0);
  const now = Date.parse(t.date);
  const neighbours: { target: Target; s: number }[] = [];
  for (const h of history) {
    const x = h.tx;
    if (x.id === t.id || Math.sign(x.amount) !== Math.sign(t.amount)) continue;
    const sameMerchant = !!t.merchantNorm && x.merchantNorm === t.merchantNorm;
    const sameIban = !!t.counterpartyIbanLast4 && x.counterpartyIbanLast4 === t.counterpartyIbanLast4;
    if (h.target.targetType === 'transfer' && !sameMerchant && !sameIban) continue;
    let s = 0;
    if (sameMerchant) s += 6;
    else if (myWeight > 0) {
      const theirs = model.words.get(x.id) ?? [];
      let common = 0;
      for (const w of mine) if (theirs.includes(w)) common += model.weight(w);
      s += (5 * common) / Math.max(myWeight, 1e-9);
    }
    if (sameIban) s += 4;
    if (s < 0.5) continue; // nothing telling in common
    if (x.amount === t.amount) s += 2;
    else if (Math.abs(x.amount - t.amount) <= Math.abs(t.amount) * 0.15) s += 0.75;
    if (x.accountId === t.accountId) s += 0.5;
    const days = Math.abs(now - Date.parse(x.date)) / 86_400_000;
    neighbours.push({ target: h.target, s: s * Math.pow(0.5, days / 365) });
  }
  neighbours.sort((a, b) => b.s - a.s);
  for (const nb of neighbours.slice(0, 25)) add(nb.target, nb.s);

  // Nothing alike yet: merchant words → category names.
  for (const [merchant, name] of KEYWORDS) {
    if (!merchant.test(`${t.descriptionRaw} ${t.counterparty}`)) continue;
    for (const c of categories) if (!c.archivedAt && !c.isIncome && t.amount < 0 && name.test(c.name)) add({ targetType: 'category', targetId: c.id }, 1.5);
    for (const c of categories) if (!c.archivedAt && c.isIncome && t.amount > 0 && name.test(c.name)) add({ targetType: 'income', targetId: c.id }, 1.5);
  }
  const evidence = new Set(scores.keys());
  // Still room: what is used most lately for money going the same way.
  if (scores.size < n) {
    const recent = history
      // Transfers between own accounts are paired on their own (D-71): not a fallback guess.
      .filter((h) => h.tx.id !== t.id && h.target.targetType !== 'transfer' && Math.sign(h.tx.amount) === Math.sign(t.amount) && h.tx.date <= t.date)
      .sort((a, b) => b.tx.date.localeCompare(a.tx.date))
      .slice(0, 200);
    const freq = new Map<string, { target: Target; n: number }>();
    for (const h of recent) {
      const k = targetKey(h.target);
      const v = freq.get(k) ?? { target: h.target, n: 0 };
      v.n++;
      freq.set(k, v);
    }
    for (const v of [...freq.values()].sort((a, b) => b.n - a.n)) if (!scores.has(targetKey(v.target))) add(v.target, 0.01 * v.n / Math.max(1, recent.length));
  }
  const ranked = [...scores.values()].sort((a, b) => b.score - a.score).slice(0, n);
  return Object.assign(
    ranked.map((v) => v.target),
    // Whether the first guess rests on something (a suggestion, similar filings, a known merchant word).
    { sure: ranked.length > 0 && evidence.has(targetKey(ranked[0]!.target)) && ranked[0]!.score >= SURE_SCORE, score: ranked[0]?.score ?? 0 },
  );
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

/**
 * Automatic decisions still in effect, newest first (the "applied automatically" log): categories filed
 * by a rule, history or Claude, and transfers between own accounts recognised on their own (one row per
 * transfer, from the side where money leaves; D-83).
 */
export function autoApplied(allocations: readonly Allocation[], transactions: readonly Transaction[]): { allocation: Allocation; transaction: Transaction }[] {
  const byId = new Map(transactions.map((t) => [t.id, t]));
  return allocations
    .filter((a) => a.decidedBy === 'rule' || a.decidedBy === 'history' || a.decidedBy === 'ai')
    .filter((a) => !a.reason.startsWith('Accepted:'))
    .map((a) => ({ allocation: a, transaction: byId.get(a.transactionId)! }))
    .filter((x) => x.transaction && x.transaction.status === 'reconciled' && !x.transaction.isMirror)
    // A transfer shows once, on the row where money leaves (or on a row pointing at an account).
    .filter((x) => x.allocation.targetType !== 'transfer' || x.transaction.amount < 0 || !byId.has(x.allocation.targetId))
    .sort((a, b) => b.allocation.createdAt.localeCompare(a.allocation.createdAt));
}

export type LogSort = 'filed' | 'date' | 'confidence' | 'amount' | 'merchant';

/** Search, filter and order the automatic-filing log (D-83). */
export function filterLog(
  log: readonly { allocation: Allocation; transaction: Transaction }[],
  f: { text?: string; by?: Allocation['decidedBy'] | ''; accountId?: Id | ''; targetKey?: string; sort?: LogSort },
  targetName: (a: Allocation) => string,
  /** What the "filed under" filter compares: a category id, or the account of a transfer. */
  targetKeyOf: (a: Allocation) => string = (a) => `${a.targetType === 'income' ? 'category' : a.targetType}:${a.targetId}`,
): { allocation: Allocation; transaction: Transaction }[] {
  const needle = (f.text ?? '').trim().toLowerCase();
  const out = log.filter(({ allocation: a, transaction: t }) => {
    if (f.by && a.decidedBy !== f.by) return false;
    if (f.accountId && t.accountId !== f.accountId) return false;
    if (f.targetKey && targetKeyOf(a) !== f.targetKey) return false;
    if (needle && !`${t.descriptionRaw} ${t.counterparty} ${targetName(a)} ${a.reason}`.toLowerCase().includes(needle)) return false;
    return true;
  });
  const by = f.sort ?? 'filed';
  const cmp: Record<LogSort, (x: (typeof out)[number], y: (typeof out)[number]) => number> = {
    filed: (x, y) => y.allocation.createdAt.localeCompare(x.allocation.createdAt),
    date: (x, y) => y.transaction.date.localeCompare(x.transaction.date),
    // Least sure first: the ones worth checking.
    confidence: (x, y) => x.allocation.confidence - y.allocation.confidence || y.transaction.date.localeCompare(x.transaction.date),
    amount: (x, y) => Math.abs(y.transaction.amount) - Math.abs(x.transaction.amount),
    merchant: (x, y) => x.transaction.merchantNorm.localeCompare(y.transaction.merchantNorm) || y.transaction.date.localeCompare(x.transaction.date),
  };
  return [...out].sort(cmp[by]);
}
