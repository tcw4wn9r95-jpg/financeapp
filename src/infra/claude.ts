import { AI_SCHEMA, aiPrompt, type AiAnswer, type AiTarget, type RedactedItem } from '../domain/learn';

/**
 * Optional Claude fallback (D-37). Runs only when the user turned it on,
 * entered their own API key and pressed "Ask Claude". The request goes
 * straight from the browser to api.anthropic.com (the only host the CSP
 * allows); it carries the redacted batch built in /src/domain/learn.ts.
 */

export const CLAUDE_MODEL = 'claude-opus-5-5';
export const MAX_BATCH = 50;

export class ClaudeError extends Error {
  constructor(public readonly code: 'auth' | 'rateLimit' | 'refusal' | 'network' | 'invalid' | 'other') {
    super(code);
  }
}

export async function askClaude(apiKey: string, items: readonly RedactedItem[], targets: readonly AiTarget[]): Promise<AiAnswer[]> {
  // The SDK is only loaded when someone actually asks.
  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  // The user's own key, kept in the encrypted vault and used from their own device.
  const client = new Anthropic({ apiKey, dangerouslyAllowBrowser: true, maxRetries: 2 });
  try {
    const message = await client.beta.messages
      .stream({
        model: CLAUDE_MODEL,
        max_tokens: 16000,
        // If the request is declined, the API retries it on its recommended fallback model.
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
        output_config: { effort: 'low', format: { type: 'json_schema', schema: AI_SCHEMA as unknown as Record<string, unknown> } },
        messages: [{ role: 'user', content: aiPrompt(items, targets) }],
      })
      .finalMessage();
    if (message.stop_reason === 'refusal') throw new ClaudeError('refusal');
    const text = message.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('');
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new ClaudeError('invalid');
    }
    const results = (parsed as { results?: unknown }).results;
    if (!Array.isArray(results)) throw new ClaudeError('invalid');
    return results as AiAnswer[];
  } catch (e) {
    if (e instanceof ClaudeError) throw e;
    if (e instanceof Anthropic.AuthenticationError || e instanceof Anthropic.PermissionDeniedError) throw new ClaudeError('auth');
    if (e instanceof Anthropic.RateLimitError) throw new ClaudeError('rateLimit');
    if (e instanceof Anthropic.APIConnectionError) throw new ClaudeError('network');
    throw new ClaudeError('other');
  }
}
