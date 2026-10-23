import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { aiTargets, chatOpening, chatSystemPrompt, readChatTurn, redact, type ChatTurn } from '../../domain/learn';
import type { Transaction } from '../../domain/types';
import { chatWithClaude, ClaudeError, type ChatMessage } from '../../infra/claude';
import { t, type MessageKey } from '../../i18n';
import { useSettings, useStore, useVault } from '../hooks';
import { householdNames } from '../learnActions';
import { href } from '../router';
import { Dialog } from './Dialog';
import { Money } from './Money';

/** At most this many questions from Claude before it has to decide. */
const MAX_QUESTIONS = 3;

interface Line {
  from: 'claude' | 'you';
  text: string;
}

/**
 * "Ask Claude" about one transaction (D-84): a short conversation in a popup.
 * Claude names a category with its reason, or asks a clarifying question with
 * replies to tap (or type). The result is filed with one tap, like any choice.
 */
export function AskClaudeDialog({
  tx,
  onPick,
  onOther,
  onClose,
}: {
  tx: Transaction;
  /** A target value as the classify control encodes it (cat:…, inc:…). */
  onPick: (value: string) => void;
  /** Open the full list instead (for a transfer, or when nothing fits). */
  onOther: () => void;
  onClose: () => void;
}) {
  const vault = useVault();
  const settings = useSettings();
  const categories = useStore('categories');
  const names = useMemo(() => householdNames(vault), [vault]);
  const targets = useMemo(() => aiTargets(categories, names), [categories, names]);
  const item = useMemo(() => redact([tx], names)[0]!, [tx, names]);
  const enabled = !!settings.ai?.enabled && !!settings.ai.apiKey;
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [lines, setLines] = useState<Line[]>([]);
  const [turn, setTurn] = useState<ChatTurn | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [reply, setReply] = useState('');
  const [last, setLast] = useState<ChatMessage[]>([]);
  const started = useRef(false);
  const questions = lines.filter((l) => l.from === 'claude').length;

  async function send(history: ChatMessage[]) {
    setLast(history);
    setBusy(true);
    setError('');
    try {
      const { raw, text } = await chatWithClaude(settings.ai!.apiKey, chatSystemPrompt(targets), history);
      const next = readChatTurn(raw, targets, tx.amount);
      if (!next) throw new ClaudeError('invalid');
      setMessages([...history, { role: 'assistant', content: text }]);
      setTurn(next);
      if (next.kind === 'question') setLines((l) => [...l, { from: 'claude', text: next.question }]);
    } catch (e) {
      setError(e instanceof ClaudeError ? t(`learn.err.${e.code}` as MessageKey) : t('common.unexpectedError'));
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    if (!enabled || started.current) return;
    started.current = true;
    void send([{ role: 'user', content: chatOpening(item) }]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled]);

  function answer(text: string) {
    const said = text.trim();
    if (!said || busy) return;
    setLines((l) => [...l, { from: 'you', text: said }]);
    setReply('');
    setTurn(null);
    // Past the limit, ask for a decision.
    const note = questions >= MAX_QUESTIONS ? `${said}\n(Please decide now.)` : said;
    void send([...messages, { role: 'user', content: note }]);
  }

  const valueOf = (key: string): string | undefined => {
    const tg = targets.find((x) => x.key === key);
    if (!tg) return undefined;
    return tg.target.targetType === 'income' ? `inc:${tg.target.targetId}` : `cat:${tg.target.targetId}`;
  };
  // On screen the real category name, not the masked one sent to Claude.
  const nameOf = (key: string) => {
    const tg = targets.find((x) => x.key === key);
    return categories.find((c) => c.id === tg?.target.targetId)?.name ?? tg?.name ?? key;
  };

  return (
    <Dialog open title={t('askClaude.title')} onClose={onClose}>
      <div className="picker-head">
        <span className="tx-desc">{tx.descriptionRaw}</span>
        <Money cents={tx.amount} plusSign className="tx-amount" />
      </div>
      {!enabled ? (
        <p className="notice">
          {t('askClaude.off')} <a href={href('settings', { section: 'learning' })} onClick={onClose}>{t('askClaude.turnOn')}</a>
        </p>
      ) : (
        <>
          <p className="hint">{t('askClaude.privacy')}</p>
          <div className="chat" aria-live="polite">
            {lines.map((l, i) => (
              <p key={i} className={`chat-line chat-${l.from}`}>{l.text}</p>
            ))}
            {busy && <p className="chat-line chat-claude chat-busy">{t('askClaude.thinking')}</p>}
          </div>
          {error && (
            <p className="error" role="alert">
              ⚠ {error}{' '}
              <button type="button" className="link-button" onClick={() => void send(last)}>
                {t('askClaude.retry')}
              </button>
            </p>
          )}
          {turn?.kind === 'question' && !busy && (
            <>
              <div className="quick-targets">
                {turn.options.map((o) => (
                  <button key={o} type="button" className="chip" onClick={() => answer(o)}>{o}</button>
                ))}
              </div>
              <form
                className="chat-reply"
                onSubmit={(e: FormEvent) => {
                  e.preventDefault();
                  answer(reply);
                }}
              >
                <input value={reply} onChange={(e) => setReply(e.target.value)} placeholder={t('askClaude.reply')} aria-label={t('askClaude.reply')} />
                <button className="button button-small" disabled={!reply.trim()}>{t('askClaude.send')}</button>
              </form>
            </>
          )}
          {turn?.kind === 'answer' && !busy && (
            <div className="chat-answer">
              {turn.target === 'transfer' ? (
                <>
                  <p>{t('askClaude.isTransfer')}</p>
                  <button type="button" className="button button-primary predict-main" onClick={onOther}>{t('askClaude.chooseAccount')}</button>
                </>
              ) : turn.target === 'none' || !valueOf(turn.target) ? (
                <>
                  <p>{t('askClaude.unsure')}</p>
                  <button type="button" className="button predict-main" onClick={onOther}>{t('askClaude.chooseMyself')}</button>
                </>
              ) : (
                <>
                  <button type="button" className="button predict-main" onClick={() => onPick(valueOf(turn.target)!)}>
                    <span aria-hidden="true">✓ </span>
                    {t('askClaude.fileAs', { name: nameOf(turn.target) })}
                  </button>
                  {turn.reason && <p className="predict-why">{turn.reason}</p>}
                  <div className="quick-targets">
                    {turn.alternatives.map((k) => valueOf(k) && (
                      <button key={k} type="button" className="chip" onClick={() => onPick(valueOf(k)!)}>{nameOf(k)}</button>
                    ))}
                    <button type="button" className="chip chip-more" onClick={onOther}>{t('inbox.other')}</button>
                  </div>
                </>
              )}
            </div>
          )}
        </>
      )}
    </Dialog>
  );
}
