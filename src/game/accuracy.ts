/**
 * One accuracy formula, in one place.
 *
 * The progress screen plots accuracy over time, so the number has to mean the
 * same thing in every game ever recorded. Defining it ad hoc at two call sites
 * is how that chart quietly becomes meaningless.
 *
 * This is the Lichess model: convert both evaluations to win probability, then
 * map the drop through an exponential so that losing 10% of your winning
 * chances from a balanced position costs the same as losing 10% from a winning
 * one.
 */
import { winProbability, type Score } from '../engine/score.js';

/** Accuracy for a single move, 0..100. */
export function moveAccuracy(before: Score, after: Score, mover: 'w' | 'b'): number {
  // Both are white-positive; express them as "how well is the mover doing".
  const winBefore = moverWinPercent(before, mover);
  const winAfter = moverWinPercent(after, mover);

  // Only drops count. A move that improves the evaluation is fully accurate.
  const drop = Math.max(0, winBefore - winAfter);

  const raw = 103.1668 * Math.exp(-0.04354 * drop) - 3.1669;
  return clamp(raw, 0, 100);
}

/** Mean of per-move accuracies, 0..100. Returns 100 for a game with no moves. */
export function gameAccuracy(moveAccuracies: readonly number[]): number {
  if (moveAccuracies.length === 0) return 100;
  const total = moveAccuracies.reduce((sum, a) => sum + a, 0);
  return round1(total / moveAccuracies.length);
}

function moverWinPercent(score: Score, mover: 'w' | 'b'): number {
  const whiteWin = winProbability(score) * 100;
  return mover === 'w' ? whiteWin : 100 - whiteWin;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}
