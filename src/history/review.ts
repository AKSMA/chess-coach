/**
 * The end-of-game review model.
 *
 * This is the moment the lesson lands — the game is over, nothing is at stake,
 * and the player is willing to look back. So it gets a real model rather than
 * a stats dump: the few moments that actually decided the game, and one
 * honest answer to "what should I work on".
 *
 * Pure functions over stored moves, so every judgement here is testable.
 */
import { toCp, type Score } from '../engine/score.js';
import type { Verdict } from '../game/classify.js';
import type { Color } from '../game/GameState.js';
import type { StoredMove } from './db.js';
import { isNegativeRule, labelFor, type SkillProfile } from './profile.js';

export interface TurningPoint {
  ply: number;
  san: string;
  verdict: Verdict | null;
  /** Centipawns thrown away on this move. */
  cpLoss: number;
  explanation: string | null;
}

export interface TimelineEntry {
  ply: number;
  san: string;
  color: Color;
  verdict: Verdict | null;
  cpLoss: number;
}

export interface GameReview {
  accuracy: number;
  moveCount: number;
  /** Your moves only, in order — the strip you can click through. */
  timeline: TimelineEntry[];
  /** The three moves that cost the most, worst first. */
  turningPoints: TurningPoint[];
  /** Counts of each negative rule that fired in this game. */
  mistakeMix: { rule: string; label: string; count: number }[];
  /** Plain-language advice, at most three items. */
  workOn: string[];
  bestMoveCount: number;
  blunderCount: number;
}

/** A move has to cost at least this much to count as a turning point. */
const TURNING_POINT_THRESHOLD = 100;
const MAX_TURNING_POINTS = 3;

export function buildReview(
  moves: readonly StoredMove[],
  playerColor: Color,
  accuracy: number,
  profile: SkillProfile,
): GameReview {
  const mine = moves.filter((m) => m.color === playerColor);

  const timeline: TimelineEntry[] = mine.map((m) => ({
    ply: m.ply,
    san: m.san,
    color: m.color,
    verdict: m.verdict,
    cpLoss: m.cpLoss ?? 0,
  }));

  const turningPoints: TurningPoint[] = mine
    .filter((m) => (m.cpLoss ?? 0) >= TURNING_POINT_THRESHOLD)
    .sort((a, b) => (b.cpLoss ?? 0) - (a.cpLoss ?? 0))
    .slice(0, MAX_TURNING_POINTS)
    .map((m) => ({
      ply: m.ply,
      san: m.san,
      verdict: m.verdict,
      cpLoss: m.cpLoss ?? 0,
      explanation: m.explanation,
    }));

  const counts = new Map<string, number>();
  for (const move of mine) {
    for (const rule of move.triggeredRules) {
      if (isNegativeRule(rule)) counts.set(rule, (counts.get(rule) ?? 0) + 1);
    }
  }

  const mistakeMix = [...counts.entries()]
    .map(([rule, count]) => ({ rule, label: labelFor(rule), count }))
    .sort((a, b) => b.count - a.count);

  return {
    accuracy,
    moveCount: mine.length,
    timeline,
    turningPoints,
    mistakeMix,
    workOn: buildAdvice(mistakeMix, profile, timeline),
    bestMoveCount: timeline.filter((t) => t.verdict === 'best' || t.verdict === 'excellent').length,
    blunderCount: timeline.filter((t) => t.verdict === 'blunder').length,
  };
}

/**
 * What to work on, in plain language.
 *
 * Prefers this game's actual mistakes over the long-run profile — advice about
 * a game you just played is easier to act on than a lifetime average. The
 * profile fills in only when this game was clean.
 */
function buildAdvice(
  mistakeMix: { rule: string; label: string; count: number }[],
  profile: SkillProfile,
  timeline: TimelineEntry[],
): string[] {
  const advice: string[] = [];

  for (const entry of mistakeMix.slice(0, 2)) {
    advice.push(
      entry.count > 1
        ? `${capitalise(entry.label)} — that happened ${entry.count} times this game.`
        : `${capitalise(entry.label)}.`,
    );
  }

  for (const rule of profile.weaknesses) {
    if (advice.length >= 3) break;
    if (mistakeMix.some((m) => m.rule === rule)) continue;
    advice.push(`${capitalise(labelFor(rule))} — a recurring theme across your games.`);
  }

  if (advice.length === 0) {
    const clean = timeline.every((t) => (t.cpLoss ?? 0) < TURNING_POINT_THRESHOLD);
    advice.push(
      clean
        ? 'Nothing serious went wrong here. Try a higher level for a sterner test.'
        : 'Keep going — no single pattern stands out yet.',
    );
  }

  return advice.slice(0, 3);
}

/**
 * The evaluation after each of the player's moves, for the review chart.
 * Values are clamped so a forced mate does not flatten the rest of the line.
 */
export function evalSeries(moves: readonly StoredMove[], evals: readonly (Score | null)[]): number[] {
  return moves.map((_, index) => {
    const score = evals[index];
    if (!score) return 0;
    return Math.max(-1000, Math.min(1000, toCp(score)));
  });
}

function capitalise(text: string): string {
  return text.length === 0 ? text : text[0]!.toUpperCase() + text.slice(1);
}
