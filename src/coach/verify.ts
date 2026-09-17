/**
 * Validating LLM prose against the facts, before it reaches the screen.
 *
 * This is the piece that makes weak models safe. A 3B model will occasionally
 * invent a square, name the wrong piece, or congratulate you on a blunder —
 * and a coach that states a wrong chess fact is worse than no coach at all.
 *
 * Every check is an allowlist derived from `ExplainFacts`. On any failure the
 * caller falls back to the rule-based text, so the worst case for a bad model
 * is plainer prose, never wrong chess. There is no trusted provider: this runs
 * on a frontier cloud model's output exactly as it runs on a local 3B's.
 */
import { isMistakeLike } from '../game/classify.js';
import type { ExplainFacts } from '../llm/types.js';

export type RejectionReason =
  | 'empty'
  | 'too-long'
  | 'too-many-sentences'
  | 'invented-square'
  | 'invented-move'
  | 'invented-piece'
  | 'contradicts-verdict'
  | 'leaked-markup';

export interface VerifyResult {
  ok: boolean;
  /** The text to display — the LLM's on success, unchanged. */
  text: string;
  reason?: RejectionReason;
  /** What tripped the check, for the dev-only panel. */
  detail?: string;
}

const MAX_CHARS = 700;
const MAX_SENTENCES = 6;

const SQUARE_PATTERN = /\b[a-h][1-8]\b/g;
/** Matches SAN-looking tokens: Nxe5, Bb5+, O-O, e4, a8=Q. */
const SAN_PATTERN = /\b(?:O-O(?:-O)?|[KQRBN][a-h1-8]?x?[a-h][1-8](?:=[QRBN])?[+#]?|[a-h]x?[a-h][1-8](?:=[QRBN])?[+#]?)\b/g;

const PIECE_NOUNS = ['pawn', 'knight', 'bishop', 'rook', 'queen', 'king'];

/** Words that congratulate. Saying these about a blunder is a contradiction. */
const POSITIVE_LEXICON = [
  'great move',
  'excellent move',
  'nicely played',
  'well played',
  'good move',
  'strong move',
  'brilliant',
  'perfect move',
  'best move',
];

/** Words that criticise. Saying these about the engine's own choice is wrong. */
const NEGATIVE_LEXICON = [
  'blunder',
  'mistake',
  'bad move',
  'poor move',
  'terrible',
  'losing move',
  'inaccuracy',
];

/**
 * Reasoning and markup that some models emit despite instructions.
 * Chain-of-thought in the coach panel is a leak, not a coaching line.
 */
const MARKUP_PATTERN = /<\/?(?:think|thinking|reasoning|scratchpad|answer)\b|^\s*```/im;

export function verify(text: string, facts: ExplainFacts): VerifyResult {
  const trimmed = text.trim();
  const fallback = facts.sentences.join(' ');

  if (trimmed.length === 0) {
    return { ok: false, text: fallback, reason: 'empty' };
  }

  if (MARKUP_PATTERN.test(trimmed)) {
    return { ok: false, text: fallback, reason: 'leaked-markup' };
  }

  if (trimmed.length > MAX_CHARS) {
    return {
      ok: false,
      text: fallback,
      reason: 'too-long',
      detail: `${trimmed.length} chars`,
    };
  }

  const sentences = trimmed.split(/[.!?]+\s/).filter((s) => s.trim().length > 0);
  if (sentences.length > MAX_SENTENCES) {
    return {
      ok: false,
      text: fallback,
      reason: 'too-many-sentences',
      detail: `${sentences.length} sentences`,
    };
  }

  // --- Squares -----------------------------------------------------------
  const allowedSquares = new Set(facts.allowedSquares.map((s) => s.toLowerCase()));
  for (const square of trimmed.toLowerCase().match(SQUARE_PATTERN) ?? []) {
    if (!allowedSquares.has(square)) {
      return { ok: false, text: fallback, reason: 'invented-square', detail: square };
    }
  }

  // --- SAN tokens --------------------------------------------------------
  const allowedSan = new Set(facts.allowedSan);
  for (const token of trimmed.match(SAN_PATTERN) ?? []) {
    // A bare pawn move like "e4" is also a square reference, already cleared above.
    if (/^[a-h][1-8]$/.test(token)) continue;
    if (!allowedSan.has(token)) {
      return { ok: false, text: fallback, reason: 'invented-move', detail: token };
    }
  }

  // --- Piece nouns -------------------------------------------------------
  //
  // The square and SAN checks both miss "this loses your queen" when the move
  // actually lost a pawn — that sentence contains neither. This is the check
  // that catches it.
  const allowedPieces = new Set(facts.allowedPieces.map((p) => p.toLowerCase()));
  const lower = trimmed.toLowerCase();
  for (const noun of PIECE_NOUNS) {
    if (!new RegExp(`\\b${noun}s?\\b`).test(lower)) continue;
    if (!allowedPieces.has(noun)) {
      return { ok: false, text: fallback, reason: 'invented-piece', detail: noun };
    }
  }

  // --- Sentiment ---------------------------------------------------------
  const isBad = isMistakeLike(facts.verdict);
  const praised = POSITIVE_LEXICON.find((phrase) => lower.includes(phrase));
  const criticised = NEGATIVE_LEXICON.find((phrase) => lower.includes(phrase));

  if (isBad && praised && !criticised) {
    return { ok: false, text: fallback, reason: 'contradicts-verdict', detail: praised };
  }

  if (!isBad && criticised && facts.mover === 'you') {
    return { ok: false, text: fallback, reason: 'contradicts-verdict', detail: criticised };
  }

  return { ok: true, text: trimmed };
}

/** Human-readable rejection, for the dev-only panel. */
export function describeRejection(result: VerifyResult): string {
  if (result.ok) return 'accepted';
  const detail = result.detail ? ` (${result.detail})` : '';
  switch (result.reason) {
    case 'empty':
      return 'model returned nothing';
    case 'too-long':
      return `too long${detail}`;
    case 'too-many-sentences':
      return `too many sentences${detail}`;
    case 'invented-square':
      return `mentioned a square not in the position${detail}`;
    case 'invented-move':
      return `mentioned a move that was never played or suggested${detail}`;
    case 'invented-piece':
      return `named a piece that isn't involved${detail}`;
    case 'contradicts-verdict':
      return `sentiment contradicts the verdict${detail}`;
    case 'leaked-markup':
      return 'leaked reasoning or markup';
    default:
      return 'rejected';
  }
}
