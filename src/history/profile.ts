/**
 * The skill profile: what your games say about you.
 *
 * A pure function over stored games and moves. There is deliberately no
 * incremental "update the profile as you play" path — two ways of computing
 * the same number is how the progress screen ends up disagreeing with the
 * coach. Live coaching reads this snapshot plus an in-memory tally of the
 * current game.
 *
 * Ranking is recency-weighted throughout: a habit you kicked ten games ago
 * should not be the headline.
 */
import type { Phase } from '../game/phase.js';
import type { StoredGame, StoredMove } from './db.js';

/** Below this many games there is no profile — see `hasProfile`. */
export const MIN_GAMES_FOR_PROFILE = 3;
/** A rule must fire at least this often before it counts as a pattern. */
export const MIN_OCCURRENCES_FOR_PATTERN = 3;

/** How much older games are discounted. 0.85 ≈ half-weight after ~4 games. */
const RECENCY_DECAY = 0.85;

export interface RuleStat {
  rule: string;
  /** Raw number of times it has ever fired. */
  count: number;
  /** Recency-weighted count — what ranking actually uses. */
  weight: number;
  /** How many of your last ten games it appeared in. */
  recentGames: number;
  lastSeenGameId: string | null;
  /** Negative means improving: it used to fire more than it does now. */
  trend: number;
}

export interface PhaseStat {
  avgCpLoss: number;
  blunderRate: number;
  moves: number;
}

export interface SkillProfile {
  gamesPlayed: number;
  ruleStats: Record<string, RuleStat>;
  byPhase: Record<Phase, PhaseStat>;
  /** Ranked, recency-weighted. The things to work on. */
  weaknesses: string[];
  /** Rules that used to fire regularly and have gone quiet. */
  strengths: string[];
  /** Per-game accuracy, oldest first, for the chart. */
  accuracyTrend: number[];
  avgAccuracy: number;
}

export function emptyProfile(): SkillProfile {
  return {
    gamesPlayed: 0,
    ruleStats: {},
    byPhase: {
      opening: { avgCpLoss: 0, blunderRate: 0, moves: 0 },
      middlegame: { avgCpLoss: 0, blunderRate: 0, moves: 0 },
      endgame: { avgCpLoss: 0, blunderRate: 0, moves: 0 },
    },
    weaknesses: [],
    strengths: [],
    accuracyTrend: [],
    avgAccuracy: 0,
  };
}

/**
 * True once there is enough history to say anything honest.
 *
 * Under this threshold the coach must behave generically. Inventing a pattern
 * from one game is worse than saying nothing — it teaches the wrong lesson and
 * destroys trust in everything else it says.
 */
export function hasProfile(profile: SkillProfile): boolean {
  return profile.gamesPlayed >= MIN_GAMES_FOR_PROFILE;
}

/** Rules the coach only ever counts against the player. */
const NEGATIVE_RULES = new Set([
  'hangs-piece',
  'allows-capture',
  'allows-fork',
  'allows-pin',
  'trapped-piece',
  'weakens-king',
  'walks-into-check',
  'missed-capture',
]);

export function isNegativeRule(rule: string): boolean {
  return NEGATIVE_RULES.has(rule);
}

export function recomputeProfile(
  games: readonly StoredGame[],
  moves: readonly StoredMove[],
): SkillProfile {
  const profile = emptyProfile();
  if (games.length === 0) return profile;

  const ordered = [...games].sort((a, b) => a.startedAt - b.startedAt);
  profile.gamesPlayed = ordered.length;
  profile.accuracyTrend = ordered.map((g) => g.accuracy);
  profile.avgAccuracy =
    Math.round((profile.accuracyTrend.reduce((s, a) => s + a, 0) / ordered.length) * 10) / 10;

  // Newest game has index 0, so weight = decay^age.
  const ageOf = new Map<string, number>();
  ordered.forEach((game, index) => ageOf.set(game.id, ordered.length - 1 - index));

  // The profile is about *your* play. Both sides' moves are stored so replay
  // can step ply by ply, so the opponent's have to be filtered out here — left
  // in, they would halve every phase average with moves you never chose.
  const playerColorOf = new Map<string, string>();
  for (const game of ordered) playerColorOf.set(game.id, game.playerColor);

  const recentGameIds = new Set(ordered.slice(-10).map((g) => g.id));
  const olderHalf = new Set(ordered.slice(0, Math.floor(ordered.length / 2)).map((g) => g.id));
  const newerHalf = new Set(ordered.slice(Math.floor(ordered.length / 2)).map((g) => g.id));

  const perRuleRecentGames = new Map<string, Set<string>>();
  const olderCounts = new Map<string, number>();
  const newerCounts = new Map<string, number>();

  const phaseTotals: Record<Phase, { loss: number; blunders: number; moves: number }> = {
    opening: { loss: 0, blunders: 0, moves: 0 },
    middlegame: { loss: 0, blunders: 0, moves: 0 },
    endgame: { loss: 0, blunders: 0, moves: 0 },
  };

  for (const move of moves) {
    const age = ageOf.get(move.gameId);
    if (age === undefined) continue; // orphaned move from a deleted game
    if (move.color !== playerColorOf.get(move.gameId)) continue; // their move

    const phase = phaseTotals[move.phase];
    if (phase) {
      phase.moves++;
      phase.loss += move.cpLoss ?? 0;
      if (move.verdict === 'blunder') phase.blunders++;
    }

    for (const rule of move.triggeredRules) {
      if (!isNegativeRule(rule)) continue;

      const stat = (profile.ruleStats[rule] ??= {
        rule,
        count: 0,
        weight: 0,
        recentGames: 0,
        lastSeenGameId: null,
        trend: 0,
      });

      stat.count++;
      stat.weight += RECENCY_DECAY ** age;
      stat.lastSeenGameId = move.gameId;

      if (recentGameIds.has(move.gameId)) {
        const seen = perRuleRecentGames.get(rule) ?? new Set<string>();
        seen.add(move.gameId);
        perRuleRecentGames.set(rule, seen);
      }
      if (olderHalf.has(move.gameId)) olderCounts.set(rule, (olderCounts.get(rule) ?? 0) + 1);
      if (newerHalf.has(move.gameId)) newerCounts.set(rule, (newerCounts.get(rule) ?? 0) + 1);
    }
  }

  for (const [rule, stat] of Object.entries(profile.ruleStats)) {
    stat.recentGames = perRuleRecentGames.get(rule)?.size ?? 0;
    stat.weight = Math.round(stat.weight * 100) / 100;

    // Normalised so a longer half doesn't look worse purely for being longer.
    const olderRate = (olderCounts.get(rule) ?? 0) / Math.max(1, olderHalf.size);
    const newerRate = (newerCounts.get(rule) ?? 0) / Math.max(1, newerHalf.size);
    stat.trend = Math.round((newerRate - olderRate) * 100) / 100;
  }

  for (const phase of ['opening', 'middlegame', 'endgame'] as const) {
    const totals = phaseTotals[phase];
    profile.byPhase[phase] = {
      moves: totals.moves,
      avgCpLoss: totals.moves === 0 ? 0 : Math.round(totals.loss / totals.moves),
      blunderRate: totals.moves === 0 ? 0 : Math.round((totals.blunders / totals.moves) * 100) / 100,
    };
  }

  const stats = Object.values(profile.ruleStats);

  profile.weaknesses = stats
    .filter((s) => s.count >= MIN_OCCURRENCES_FOR_PATTERN && s.recentGames > 0)
    .sort((a, b) => b.weight - a.weight)
    .map((s) => s.rule);

  // A strength is a habit that used to be frequent and has stopped. This is
  // what makes positive reinforcement possible at all.
  profile.strengths = stats
    .filter((s) => s.count >= MIN_OCCURRENCES_FOR_PATTERN && s.recentGames === 0 && s.trend < 0)
    .sort((a, b) => a.trend - b.trend)
    .map((s) => s.rule);

  return profile;
}

/** Plain-language names for rule ids, for anything the player reads. */
export const RULE_LABEL: Record<string, string> = {
  'hangs-piece': 'leaving pieces undefended',
  'allows-capture': 'allowing captures you had not seen',
  'allows-fork': 'walking into forks',
  'allows-pin': 'getting pinned',
  'trapped-piece': 'pushing pieces somewhere they cannot come back from',
  'weakens-king': 'leaving your king exposed',
  'walks-into-check': 'moving into checks',
  'missed-capture': 'missing free material',
};

export function labelFor(rule: string): string {
  return RULE_LABEL[rule] ?? rule.replace(/-/g, ' ');
}
