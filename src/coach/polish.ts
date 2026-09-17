/**
 * The optional polish pass.
 *
 * Renders the rule-based text immediately, then streams the model's rewrite
 * over it — the panel is never blank, and any failure degrades to the rules
 * rather than leaving the user with nothing.
 *
 * Nothing here can introduce a chess fact: the model receives only the fact
 * bag, and `verify.ts` checks its output back against that bag before a word
 * is shown.
 */
import { PROMPT_VERSION } from './prompt.js';
import { describeRejection, verify } from './verify.js';
import { adapterFor, configFrom, type LlmSettings } from '../llm/registry.js';
import type { ExplainFacts } from '../llm/types.js';

export interface PolishResult {
  /** What to display. The rule text when anything went wrong. */
  text: string;
  used: 'llm' | 'rules';
  /** Why the model's text was not used, for the dev-only panel. */
  note?: string;
}

/** Cache key. The prompt version is in it so stale prose can't outlive a change. */
export function cacheKey(facts: ExplainFacts, settings: LlmSettings): string {
  return [
    facts.san,
    facts.verdict,
    settings.providerId,
    settings.model,
    PROMPT_VERSION,
  ].join('|');
}

const cache = new Map<string, string>();

export function clearPolishCache(): void {
  cache.clear();
}

/**
 * Rewrites the rule text, or returns it unchanged.
 *
 * `onDelta` receives partial text as it streams, but only the verified final
 * result is authoritative — a caller showing deltas must be ready to replace
 * them with the fallback if verification fails.
 */
export async function polish(
  facts: ExplainFacts,
  settings: LlmSettings,
  onDelta: (partial: string) => void,
  signal: AbortSignal,
): Promise<PolishResult> {
  const fallback = facts.sentences.join(' ');

  if (!settings.enabled || settings.mode === 'off' || !settings.model) {
    return { text: fallback, used: 'rules' };
  }

  const adapter = adapterFor(settings);
  if (!adapter) return { text: fallback, used: 'rules', note: 'no provider configured' };

  const key = cacheKey(facts, settings);
  const cached = cache.get(key);
  if (cached) return { text: cached, used: 'llm' };

  let raw: string;
  try {
    raw = await adapter.explain(
      { facts, model: settings.model },
      configFrom(settings),
      onDelta,
      signal,
    );
  } catch (error) {
    if (signal.aborted) return { text: fallback, used: 'rules', note: 'superseded' };
    return { text: fallback, used: 'rules', note: String(error) };
  }

  // Every provider's output is checked, frontier and 3B alike.
  const verdict = verify(raw, facts);
  if (!verdict.ok) {
    return { text: fallback, used: 'rules', note: describeRejection(verdict) };
  }

  cache.set(key, verdict.text);
  return { text: verdict.text, used: 'llm' };
}
