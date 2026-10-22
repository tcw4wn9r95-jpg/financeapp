import { systemClock, stamp } from '../domain/ledger';
import {
  aiTargets,
  applyDecisions,
  DEFAULT_THRESHOLD,
  examplesFromChanges,
  learn,
  readAiAnswers,
  redact,
  ruleFromProposal,
  type LearnContext,
  type LearnResult,
  type RuleProposal,
  type Target,
} from '../domain/learn';
import { inbox, type Changes } from '../domain/reconcile';
import type { BudgetInput } from '../domain/budget';
import { currentMonth } from '../domain/dates';
import { eventPlans, provisionsMoveByMonth } from '../domain/plan';
import type { Id, Rule, RuleConditions, Transaction } from '../domain/types';
import { askClaude, MAX_BATCH } from '../infra/claude';
import type { Vault, WriteOp } from '../storage/vault';
import { getSettings, saveSettings } from './actions';
import { applyChanges, cleanUpLedger } from './importActions';

/** Writes for the learning layer (M4); the logic lives in /src/domain/learn.ts. */

export function learnContext(vault: Vault): LearnContext {
  const settings = getSettings(vault);
  const ctx: LearnContext = {
    rules: vault.list('rules'),
    examples: vault.list('trainingExamples'),
    accounts: vault.list('accounts'),
    categories: vault.list('categories'),
    threshold: settings.autoApplyThreshold ?? DEFAULT_THRESHOLD,
  };
  if (settings.provisionsAccountId) {
    ctx.provisionsMove = { accountId: settings.provisionsAccountId, byMonth: provisionsMoveByMonth(budgetInputFromVault(vault), currentMonth()) };
  }
  return ctx;
}

/** The budget input as the hooks build it, straight from the vault (for actions outside React). */
export function budgetInputFromVault(vault: Vault): BudgetInput {
  const settings = getSettings(vault);
  return {
    startMonth: settings.budgetStartMonth,
    categories: vault.list('categories'),
    defaults: vault.list('budgetDefaults'),
    overrides: vault.list('budgetOverrides'),
    accounts: vault.list('accounts'),
    transactions: vault.list('transactions'),
    allocations: vault.list('allocations'),
    plans: eventPlans(vault.list('events')),
    ...(settings.sweepTargetCategoryId ? { sweepTargetCategoryId: settings.sweepTargetCategoryId } : {}),
  };
}

/** Apply a classification the user made, and remember it for next time. */
export async function applyUserChanges(vault: Vault, ch: Changes): Promise<void> {
  await applyChanges(vault, ch);
  const examples = examplesFromChanges(ch, systemClock);
  if (examples.length) await vault.write(examples.map((record): WriteOp => ({ type: 'put', store: 'trainingExamples', record })));
}

export async function writeLearn(vault: Vault, r: LearnResult): Promise<void> {
  await vault.write([
    ...r.transactions.map((record): WriteOp => ({ type: 'put', store: 'transactions', record })),
    ...r.allocations.map((record): WriteOp => ({ type: 'put', store: 'allocations', record })),
    ...r.rules.map((record): WriteOp => ({ type: 'put', store: 'rules', record })),
  ]);
}

/** Run rules and history over everything in the inbox. */
export async function learnInbox(vault: Vault): Promise<LearnResult> {
  await cleanUpLedger(vault); // transfers between own accounts first (D-71)
  const r = learn(inbox(vault.list('transactions')), learnContext(vault), systemClock);
  await writeLearn(vault, r);
  return r;
}

// ------------------------------------------------------------------ rules

export interface RuleDraft {
  conditions: RuleConditions;
  action: Target;
}

export async function saveRule(vault: Vault, draft: RuleDraft, existing?: Rule): Promise<void> {
  const rules = vault.list('rules');
  const record: Rule = existing
    ? { ...existing, ...draft, updatedAt: new Date().toISOString() }
    : { ...stamp(systemClock, 'manual'), ...draft, priority: rules.reduce((m, r) => Math.max(m, r.priority), 0) + 10, hits: 0, createdFrom: 'user' };
  await vault.put('rules', record);
}

export async function deleteRule(vault: Vault, id: Id): Promise<void> {
  await vault.write([{ type: 'delete', store: 'rules', id }]);
}

/** Swap a rule with its neighbour in the order rules are tried. */
export async function moveRule(vault: Vault, ordered: readonly Rule[], index: number, by: -1 | 1): Promise<void> {
  const a = ordered[index];
  const b = ordered[index + by];
  if (!a || !b) return;
  const now = new Date().toISOString();
  // Renumber so equal priorities cannot tie.
  const next = ordered.map((r, i) => ({ ...r, priority: (i + 1) * 10 }));
  const pa = next[index]!.priority;
  next[index]!.priority = next[index + by]!.priority;
  next[index + by]!.priority = pa;
  await vault.write(next.map((record): WriteOp => ({ type: 'put', store: 'rules', record: { ...record, updatedAt: now } })));
}

export async function acceptProposal(vault: Vault, p: RuleProposal): Promise<void> {
  await vault.put('rules', ruleFromProposal(p, vault.list('rules'), systemClock));
}

export async function dismissProposal(vault: Vault, merchantNorm: string): Promise<void> {
  const s = getSettings(vault);
  await saveSettings(vault, { dismissedRuleProposals: [...(s.dismissedRuleProposals ?? []), merchantNorm] });
}

// ------------------------------------------------------------- Claude

/** Inbox items nothing recognised yet: what "Ask Claude" sends. */
export function claudeCandidates(transactions: readonly Transaction[]): Transaction[] {
  return inbox(transactions).filter((t) => t.status === 'new' && !t.isMirror).slice(0, MAX_BATCH);
}

export function householdNames(vault: Vault): string[] {
  return (getSettings(vault).members ?? []).map((m) => m.name);
}

export async function askClaudeForInbox(vault: Vault, items: readonly Transaction[]): Promise<LearnResult> {
  const settings = getSettings(vault);
  if (!settings.ai?.enabled || !settings.ai.apiKey) throw new Error('ai-off');
  const targets = aiTargets(vault.list('categories'));
  const answers = await askClaude(settings.ai.apiKey, redact(items, householdNames(vault)), targets);
  // Re-read: the inbox may have changed while waiting.
  const fresh = items.map((t) => vault.get('transactions', t.id)).filter((t): t is Transaction => !!t && t.status === 'new');
  const decisions = readAiAnswers(answers, items, targets, settings.autoApplyThreshold ?? DEFAULT_THRESHOLD);
  const r = applyDecisions(fresh, decisions, systemClock);
  await writeLearn(vault, r);
  return r;
}
