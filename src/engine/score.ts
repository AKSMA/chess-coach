/**
 * Score sign normalisation.
 *
 * Stockfish reports `cp` and `mate` from the *side to move's* perspective:
 * "score cp 50" means "the player about to move is up half a pawn", whoever
 * that is. Every other part of this app wants one fixed frame of reference, so
 * everything here is stored **white-positive**: positive is good for White,
 * negative is good for Black, always.
 *
 * Getting this wrong produces a coach that confidently praises blunders, which
 * is why it lives in its own module with its own tests.
 */

export type Color = 'w' | 'b';

export type Score =
  | { kind: 'cp'; cp: number }
  | { kind: 'mate'; moves: number };

/**
 * Mate scores are mapped into centipawn space so that losses are comparable
 * with ordinary evaluations. Mate-in-1 is worth more than mate-in-8, and every
 * mate outranks every material advantage.
 */
export const MATE_VALUE = 10_000;

/** Anything at or above this is a forced mate rather than an evaluation. */
export const MATE_THRESHOLD = MATE_VALUE - 1000;

/**
 * Converts a raw engine score into the white-positive frame.
 *
 * @param raw       the number following `cp` or `mate` in the UCI info line
 * @param kind      which of the two it was
 * @param sideToMove the side to move *in the position that was analysed*
 */
export function normalise(raw: number, kind: 'cp' | 'mate', sideToMove: Color): Score {
  const sign = sideToMove === 'w' ? 1 : -1;
  return kind === 'cp'
    ? { kind: 'cp', cp: raw * sign }
    : { kind: 'mate', moves: raw * sign };
}

/**
 * Collapses a Score to a single comparable centipawn number, still
 * white-positive. Mate info is preserved on the Score itself for narration —
 * this is only for arithmetic.
 */
export function toCp(score: Score): number {
  if (score.kind === 'cp') return score.cp;

  // A mate score of 0 means "mate on the board". Keep the sign meaningful:
  // mate for White is +MATE_VALUE, mate for Black is -MATE_VALUE.
  if (score.moves === 0) return MATE_VALUE;

  const magnitude = MATE_VALUE - Math.abs(score.moves);
  return score.moves > 0 ? magnitude : -magnitude;
}

/** True when this score represents a forced mate rather than an evaluation. */
export function isMate(score: Score): boolean {
  return score.kind === 'mate';
}

/**
 * How much the mover threw away, in centipawns, never negative.
 *
 * Both evaluations must already be white-positive. A drop in White's favour is
 * a loss for White and a gain for Black, hence the flip.
 *
 * Clamping at zero matters: the engine searching deeper after the move than
 * before it can make a *good* move look microscopically negative, and a coach
 * that reports "you gained 4 centipawns" is noise.
 */
export function centipawnLoss(
  bestEvalWhitePov: Score,
  actualEvalWhitePov: Score,
  mover: Color,
): number {
  const best = toCp(bestEvalWhitePov);
  const actual = toCp(actualEvalWhitePov);
  const delta = (best - actual) * (mover === 'w' ? 1 : -1);
  return Math.max(0, delta);
}

/**
 * Win probability for White, 0..1, using the Lichess logistic model.
 * Used by the accuracy formula and the eval bar, both of which need a bounded
 * quantity rather than an unbounded centipawn count.
 */
export function winProbability(score: Score): number {
  const cp = toCp(score);
  if (Math.abs(cp) >= MATE_THRESHOLD) return cp > 0 ? 1 : 0;
  return 1 / (1 + Math.exp(-0.00368208 * cp));
}

/** Human-facing sign, for "White is better" style copy. */
export function favours(score: Score): Color | 'equal' {
  const cp = toCp(score);
  if (Math.abs(cp) < 50) return 'equal';
  return cp > 0 ? 'w' : 'b';
}
