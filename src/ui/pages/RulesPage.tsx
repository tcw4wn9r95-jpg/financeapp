import { useState, type FormEvent } from 'react';
import { formatMoney } from '../../domain/money';
import { orderedRules, patternOf } from '../../domain/learn';
import type { Rule } from '../../domain/types';
import { t } from '../../i18n';
import { decodeTarget, encodeTarget, TargetOptions } from '../components/Classify';
import { Dialog } from '../components/Dialog';
import { MoneyField, SelectField, TextField, useMoneyInput } from '../components/fields';
import { useToast } from '../components/Toast';
import { useDocumentTitle, useStore, useVault } from '../hooks';
import { deleteRule, learnInbox, moveRule, saveRule } from '../learnActions';

/** Rules: "when the merchant matches …, file it under …" (PRD F6). */
export function RulesPage() {
  useDocumentTitle(t('nav.rules'));
  const vault = useVault();
  const notify = useToast();
  const rules = orderedRules(useStore('rules'));
  const categories = useStore('categories');
  const accounts = useStore('accounts');
  const [editing, setEditing] = useState<Rule | 'new' | null>(null);

  const targetName = (r: Rule) =>
    r.action.targetType === 'transfer'
      ? t('rules.transferTo', { name: accounts.find((a) => a.id === r.action.targetId)?.name ?? '?' })
      : categories.find((c) => c.id === r.action.targetId)?.name ?? '?';

  return (
    <>
      <div className="page-head">
        <h1>{t('nav.rules')}</h1>
        <button type="button" className="button button-primary" onClick={() => setEditing('new')}>+ {t('rules.add')}</button>
      </div>
      <p className="hint">{t('rules.intro')}</p>
      {rules.length === 0 ? (
        <p className="notice">{t('rules.none')}</p>
      ) : (
        <>
          <ol className="rows rule-list">
            {rules.map((r, i) => (
              <li key={r.id} className="row-item">
                <button type="button" className="row-button" onClick={() => setEditing(r)} aria-label={t('rules.edit', { name: r.conditions.merchantRegex ?? '' })}>
                  <span className="row-main">
                    <span className="row-title"><code>{r.conditions.merchantRegex || t('rules.anyMerchant')}</code> → {targetName(r)}</span>
                    <span className="row-sub">
                      {[
                        r.conditions.accountId && accounts.find((a) => a.id === r.conditions.accountId)?.name,
                        r.conditions.amountMin !== undefined && `≥ ${formatMoney(r.conditions.amountMin)}`,
                        r.conditions.amountMax !== undefined && `≤ ${formatMoney(r.conditions.amountMax)}`,
                        r.createdFrom === 'hardened' && t('rules.fromHistory'),
                        t('rules.hits', { n: r.hits }),
                      ].filter(Boolean).join(' · ')}
                    </span>
                  </span>
                </button>
                <span className="row-end order-buttons">
                  <button type="button" className="icon-button" disabled={i === 0} onClick={() => void moveRule(vault, rules, i, -1)} aria-label={t('rules.up')}>↑</button>
                  <button type="button" className="icon-button" disabled={i === rules.length - 1} onClick={() => void moveRule(vault, rules, i, 1)} aria-label={t('rules.down')}>↓</button>
                </span>
              </li>
            ))}
          </ol>
          <button
            type="button"
            className="button button-block"
            onClick={() => void learnInbox(vault).then((r) => notify(t('learn.ran', { a: r.applied, s: r.suggested })))}
          >
            {t('rules.applyInbox')}
          </button>
        </>
      )}
      {editing && <RuleDialog existing={editing === 'new' ? undefined : editing} onClose={() => setEditing(null)} />}
    </>
  );
}

function RuleDialog({ existing, onClose }: { existing: Rule | undefined; onClose: () => void }) {
  const vault = useVault();
  const notify = useToast();
  const categories = useStore('categories');
  const accounts = useStore('accounts');
  const transactions = useStore('transactions');
  const c = existing?.conditions ?? {};
  const [pattern, setPattern] = useState(c.merchantRegex ?? '');
  const [accountId, setAccountId] = useState(c.accountId ?? '');
  const min = useMoneyInput(c.amountMin);
  const max = useMoneyInput(c.amountMax);
  const [target, setTarget] = useState(existing ? encodeTarget(existing.action.targetType === 'transfer' ? { kind: 'transfer', accountId: existing.action.targetId } : existing.action.targetType === 'income' ? { kind: 'income', categoryId: existing.action.targetId } : { kind: 'category', categoryId: existing.action.targetId }) : '');
  const [error, setError] = useState('');
  const decoded = decodeTarget(target);
  const re = pattern ? patternOf(pattern) : undefined;
  const matching = re ? transactions.filter((x) => re.test(x.merchantNorm) || re.test(x.descriptionRaw)).length : 0;

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!pattern.trim() && !accountId) return setError(t('rules.needCondition'));
    if (!decoded || decoded.kind === 'split') return setError(t('rules.needTarget'));
    const action =
      decoded.kind === 'transfer' ? { targetType: 'transfer' as const, targetId: decoded.accountId }
      : { targetType: decoded.kind, targetId: decoded.categoryId };
    await saveRule(
      vault,
      {
        conditions: {
          ...(pattern.trim() ? { merchantRegex: pattern.trim() } : {}),
          ...(accountId ? { accountId } : {}),
          ...(min.cents !== null && min.text ? { amountMin: Math.abs(min.cents) } : {}),
          ...(max.cents !== null && max.text ? { amountMax: Math.abs(max.cents) } : {}),
        },
        action,
      },
      existing,
    );
    notify(t('rules.saved'));
    onClose();
  }

  return (
    <Dialog open title={existing ? t('rules.editTitle') : t('rules.addTitle')} onClose={onClose}>
      <form onSubmit={submit} className="form">
        <TextField
          label={t('rules.pattern')}
          hint={pattern ? t('rules.matchesN', { n: matching }) : t('rules.patternHint')}
          value={pattern}
          onChange={(e) => setPattern(e.target.value)}
          autoCapitalize="characters"
          autoComplete="off"
        />
        <SelectField label={t('rules.target')} value={target} onChange={(e) => setTarget(e.target.value)}>
          <TargetOptions tx={{ accountId: '', amount: -1 }} categories={categories} accounts={accounts} />
        </SelectField>
        <details>
          <summary>{t('rules.more')}</summary>
          <SelectField label={t('rules.account')} value={accountId} onChange={(e) => setAccountId(e.target.value)}>
            <option value="">{t('tx.allAccounts')}</option>
            {accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
          </SelectField>
          <MoneyField label={t('rules.min')} state={min} />
          <MoneyField label={t('rules.max')} state={max} />
        </details>
        {error && <p className="field-error" role="alert">{error}</p>}
        <div className="row">
          <button className="button button-primary">{t('common.save')}</button>
          {existing && (
            <button
              type="button"
              className="button button-danger"
              onClick={() => void deleteRule(vault, existing.id).then(() => { notify(t('rules.deleted')); onClose(); })}
            >
              {t('common.delete')}
            </button>
          )}
        </div>
      </form>
    </Dialog>
  );
}
