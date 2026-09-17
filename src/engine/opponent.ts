/**
 * The difficulty ladder.
 *
 * Stockfish's own `UCI_Elo` bottoms out at 1320 — confirmed against this
 * build's `uci` output, which reports `min 1320`. That is still a strong club
 * player, so the bottom of the ladder cannot be expressed with it.
 *
 * The obvious alternative — crippling the engine with `depth 1` — is worse than
 * useless for a *coaching* app: it produces bizarre, inhuman blunders that
 * teach nothing, because no opponent you will ever face plays that way.
 *
 * So the bottom rungs search normally but *choose* imperfectly: take the top
 * few moves and pick among them with a bias away from the best, refusing any
 * move that throws away more material than the level allows. That plays weak
 * but sane chess — the kind of mistakes a real beginner makes.
 */
import { centipawnLoss, type Color } from './score.js';
import type { EngineClient, PvLine, SearchLimit } from './EngineClient.js';

export const MIN_LEVEL = 1;
export const MAX_LEVEL = 10;

export type LevelMode = 'sample' | 'limited' | 'full';

export interface LevelConfig {
  level: number;
  label: string;
  blurb: string;
  mode: LevelMode;
  multiPv: number;
  limit: SearchLimit;
  /** Only for `limited`. */
  elo?: number;
  /**
   * Only for `sample`: the most centipawns a chosen move may give up relative
   * to the best one. Keeps weak play *plausible* — a beginner drops a knight,
   * they do not donate a queen for nothing.
   */
  maxGiveaway?: number;
  /** Only for `sample`: sampling weight by rank, best move first. */
  rankWeights?: number[];
}

export const LEVELS: LevelConfig[] = [
  {
    level: 1,
    label: 'Beginner',
    blurb: 'Plays sensible-looking moves but misses a lot.',
    mode: 'sample',
    multiPv: 5,
    limit: { depth: 6 },
    maxGiveaway: 250,
    rankWeights: [1, 3, 4, 4, 3],
  },
  {
    level: 2,
    label: 'Casual',
    blurb: 'Still loose, but punishes obvious mistakes.',
    mode: 'sample',
    multiPv: 5,
    limit: { depth: 7 },
    maxGiveaway: 180,
    rankWeights: [2, 4, 4, 3, 2],
  },
  {
    level: 3,
    label: 'Improving',
    blurb: 'Usually finds a reasonable plan.',
    mode: 'sample',
    multiPv: 5,
    limit: { depth: 8 },
    maxGiveaway: 120,
    rankWeights: [4, 4, 3, 2, 1],
  },
  { level: 4, label: 'Club (1320)', blurb: 'Solid. Will take free material.', mode: 'limited', multiPv: 1, limit: { movetime: 300 }, elo: 1320 },
  { level: 5, label: 'Club (1500)', blurb: 'Punishes tactics reliably.', mode: 'limited', multiPv: 1, limit: { movetime: 350 }, elo: 1500 },
  { level: 6, label: 'Strong club (1700)', blurb: 'Few free gifts.', mode: 'limited', multiPv: 1, limit: { movetime: 400 }, elo: 1700 },
  { level: 7, label: 'Expert (1900)', blurb: 'Positional as well as tactical.', mode: 'limited', multiPv: 1, limit: { movetime: 450 }, elo: 1900 },
  { level: 8, label: 'Master (2200)', blurb: 'You will need a real plan.', mode: 'limited', multiPv: 1, limit: { movetime: 500 }, elo: 2200 },
  { level: 9, label: 'Very strong', blurb: 'Full strength, thinking briefly.', mode: 'full', multiPv: 1, limit: { movetime: 600 } },
  { level: 10, label: 'Maximum', blurb: 'Full strength. Good luck.', mode: 'full', multiPv: 1, limit: { movetime: 1200 } },
];

export function levelConfig(level: number): LevelConfig {
  const clamped = Math.min(MAX_LEVEL, Math.max(MIN_LEVEL, Math.round(level)));
  // LEVELS is dense from 1..10, so this index is always populated.
  return LEVELS[clamped - 1]!;
}

/** Applies the level's engine options. Call when the level changes, not per move. */
export async function configureOpponent(engine: EngineClient, level: number): Promise<void> {
  const config = levelConfig(level);

  if (config.mode === 'limited' && config.elo !== undefined) {
    await engine.setOption('UCI_LimitStrength', true);
    await engine.setOption('UCI_Elo', config.elo);
  } else {
    // MultiPV and LimitStrength interact badly, so the sampling rungs turn
    // strength limiting off and get their weakness from the choice instead.
    await engine.setOption('UCI_LimitStrength', false);
  }

  await engine.setOption('MultiPV', config.multiPv);
}

/** A random source, injectable so the sampler can be tested deterministically. */
export type Rng = () => number;

/**
 * Chooses among candidate lines according to the level's weights, skipping any
 * that give away too much.
 *
 * Exported separately from the engine call so the "never hangs a queen"
 * property can be tested directly.
 */
export function selectFromLines(
  lines: readonly PvLine[],
  config: LevelConfig,
  mover: Color,
  rng: Rng = Math.random,
): PvLine | null {
  if (lines.length === 0) return null;

  const best = lines[0]!;
  if (config.mode !== 'sample') return best;

  const maxGiveaway = config.maxGiveaway ?? 0;
  const weights = config.rankWeights ?? [1];

  const candidates: { line: PvLine; weight: number }[] = [];
  for (const [index, line] of lines.entries()) {
    const giveaway = centipawnLoss(best.score, line.score, mover);
    if (giveaway > maxGiveaway) continue;
    const weight = weights[index] ?? weights[weights.length - 1] ?? 1;
    if (weight > 0) candidates.push({ line, weight });
  }

  // Everything except the best move was too expensive — play the best move.
  if (candidates.length === 0) return best;

  const total = candidates.reduce((sum, c) => sum + c.weight, 0);
  let ticket = rng() * total;
  for (const candidate of candidates) {
    ticket -= candidate.weight;
    if (ticket <= 0) return candidate.line;
  }
  return candidates[candidates.length - 1]!.line;
}

/**
 * Picks the opponent's move for this position, in UCI.
 * Returns null when there is nothing to play (mate or stalemate).
 */
export async function chooseOpponentMove(
  engine: EngineClient,
  fen: string,
  level: number,
  rng: Rng = Math.random,
): Promise<string | null> {
  const config = levelConfig(level);

  if (config.mode !== 'sample') {
    return engine.bestMove(fen, config.limit);
  }

  const analysis = await engine.analyse(fen, {
    multiPv: config.multiPv,
    ...config.limit,
  });

  const chosen = selectFromLines(analysis.lines, config, analysis.sideToMove, rng);
  return chosen?.uci[0] ?? null;
}
