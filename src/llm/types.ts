/**
 * The LLM layer's contract.
 *
 * Model-agnostic by construction: provider, base URL, and model are all
 * runtime configuration. No model name appears in application code, and an
 * unrecognised model must work rather than fail — the quirk table in
 * `coach/prompt.ts` pattern-matches with a conservative default.
 *
 * The layer is strictly optional. Everything here rephrases facts the engine
 * and the rule library already established; it never establishes a fact of its
 * own, and `coach/verify.ts` enforces that before anything reaches the screen.
 */
import type { Verdict } from '../game/classify.js';

/**
 * Everything the model is allowed to talk about.
 *
 * This doubles as the allowlist `verify.ts` checks the output against, which
 * is why it carries the squares, SAN tokens, and piece nouns explicitly rather
 * than leaving them to be re-derived.
 */
export interface ExplainFacts {
  verdict: Verdict;
  mover: 'you' | 'opponent';
  /** The move played, in SAN — for the model's reference, not for the prose. */
  san: string;
  bestSan: string | null;
  /** How the opponent punishes it, in SAN. */
  refutationSan: string[];
  /** Squares that may legitimately appear in the output. */
  allowedSquares: string[];
  /** SAN tokens that may legitimately appear in the output. */
  allowedSan: string[];
  /** Piece nouns that may legitimately appear in the output. */
  allowedPieces: string[];
  /** The rule-based sentences. The floor, and the source of every fact. */
  sentences: string[];
  triggeredRules: string[];
  openingName: string | null;
  /** Centipawns given up. Never shown as a number — only used for phrasing. */
  cpLoss: number;
  /** A short summary of recurring habits, when the profile has one. */
  habitSummary: string | null;
}

export interface ExplainRequest {
  facts: ExplainFacts;
  model: string;
}

export interface ModelInfo {
  id: string;
  label: string;
  /**
   * Where the model actually runs. `localhost` is not the same as private:
   * Ollama's `:cloud` entries are proxied to ollama.com.
   */
  locality: 'on-device' | 'local-daemon' | 'remote';
}

export interface ProviderStatus {
  ok: boolean;
  /** Plain-language explanation, shown verbatim in the settings panel. */
  detail: string;
  models?: ModelInfo[];
}

export interface LlmProvider {
  id: string;
  label: string;
  kind: 'cloud' | 'local';
  /** Prefilled in the settings UI; the user can override it. */
  defaultBaseUrl?: string;
  /** Whether a key is needed at all — local daemons usually need none. */
  needsKey: boolean;

  /** Populates the model dropdown. Absent when the provider can't enumerate. */
  listModels?(config: ProviderConfig): Promise<ModelInfo[]>;
  /** Reachable? Authenticated? Model actually available? */
  probe(config: ProviderConfig): Promise<ProviderStatus>;
  /** Streams polished prose. Rejects on any transport failure. */
  explain(
    request: ExplainRequest,
    config: ProviderConfig,
    onDelta: (text: string) => void,
    signal: AbortSignal,
  ): Promise<string>;
}

export interface ProviderConfig {
  providerId: string;
  baseUrl: string;
  model: string;
  /**
   * Only ever set for providers the user configured in the browser. Cloud keys
   * live in `.env.local` and are read by the proxy — they never come through
   * here.
   */
  apiKey?: string;
  /** Skip the proxy and call the provider directly. Local providers only. */
  direct?: boolean;
}

/** Where the app proxies provider calls so cloud keys stay server-side. */
export const PROXY_PATH = '/api/llm';
