/**
 * One shared prompt for every provider, plus the per-model quirk table.
 *
 * The prompt is identical across providers and model sizes — capability hints
 * tune the *request*, never the instructions. The quirk table is
 * pattern-matched with a conservative default rather than an allowlist: a
 * model released after this was written still has to work, and an unknown
 * model must never be a hard failure.
 */
import type { ExplainFacts } from '../llm/types.js';

/**
 * Bumped whenever the prompt or the fact shape changes.
 * Part of the cache key, so stale prose can't outlive a narrator change.
 */
export const PROMPT_VERSION = 1;

export const SYSTEM_PROMPT = `You are a warm, plain-spoken chess coach talking to a beginner.

You will be given a JSON bag of FACTS that a chess engine and a rule library
have already established about one move. Your only job is to rewrite those
facts as 2-3 short sentences of natural coaching prose.

Absolute rules:
- Never add a chess claim that is not in the facts. No new squares, no new
  moves, no new pieces, no evaluations of your own.
- Never contradict the verdict. If the verdict says blunder, do not praise it.
- Name pieces and squares in words ("your knight on f3"), never in notation
  ("Nf3").
- No move numbers, no centipawn numbers, no engine jargon.
- Write only the coaching text. No preamble, no headings, no markup, no
  reasoning, no bullet points.
- Keep it under 60 words.

Tone: encouraging and concrete. You are helping someone understand what
happened, not grading them.`;

/**
 * Per-model request quirks.
 *
 * Pattern-matched with a conservative default. An unrecognised model gets the
 * safe settings — `max_tokens`, no temperature, no caching — and works.
 */
export interface Capabilities {
  /** OpenAI renamed this on newer models. */
  maxTokensField: 'max_tokens' | 'max_completion_tokens';
  /** Reasoning models reject a temperature outright. */
  acceptsTemperature: boolean;
  /** Whether a cached system prompt is worth marking. */
  supportsCaching: boolean;
}

const CONSERVATIVE: Capabilities = {
  maxTokensField: 'max_tokens',
  acceptsTemperature: false,
  supportsCaching: false,
};

const QUIRKS: { pattern: RegExp; capabilities: Partial<Capabilities> }[] = [
  // OpenAI reasoning models: renamed token field, no temperature.
  { pattern: /^(o[1-9]|gpt-5)/i, capabilities: { maxTokensField: 'max_completion_tokens' } },
  // Older OpenAI chat models accept a temperature.
  { pattern: /^gpt-4/i, capabilities: { acceptsTemperature: true } },
  // Most local models are plain chat completions and take a temperature.
  { pattern: /^(llama|qwen|mistral|gemma|phi|deepseek)/i, capabilities: { acceptsTemperature: true } },
];

export function capabilitiesFor(model: string): Capabilities {
  const match = QUIRKS.find((entry) => entry.pattern.test(model));
  return { ...CONSERVATIVE, ...(match?.capabilities ?? {}) };
}

/** The user-turn payload: the facts, and nothing else. */
export function buildUserMessage(facts: ExplainFacts): string {
  const payload = {
    verdict: facts.verdict,
    whoMoved: facts.mover,
    openingName: facts.openingName,
    whatTheRulesFound: facts.sentences,
    betterMove: facts.bestSan,
    yourRecurringHabit: facts.habitSummary,
    // Deliberately included so the model knows its own boundaries.
    youMayOnlyMentionTheseSquares: facts.allowedSquares,
    youMayOnlyMentionThesePieces: facts.allowedPieces,
  };

  return `FACTS:\n${JSON.stringify(payload, null, 2)}\n\nRewrite these facts as 2-3 sentences of coaching prose.`;
}
