/**
 * The coach's memory: coaching from *your* history, not just this position.
 *
 * This is what makes it a teacher rather than a commentator. It is also the
 * single easiest thing in the app to make insufferable, so the guardrails are
 * the feature, not an afterthought:
 *
 *   - a rule must have fired at least three times before it is called a pattern
 *   - at most two recurrence callouts per game
 *   - never the same callout twice in one game
 *   - criticism is always paired with the concrete check that prevents it
 *   - with fewer than three games stored there is no profile at all, and the
 *     coach must behave generically rather than inventing history
 *
 * A coach that invents a pattern from one game teaches the wrong lesson and
 * costs you trust in everything else it says.
 */
import {
  MIN_OCCURRENCES_FOR_PATTERN,
  hasProfile,
  isNegativeRule,
  labelFor,
  type SkillProfile,
} from '../history/profile.js';

/** Recurrence callouts allowed in a single game. */
export const MAX_CALLOUTS_PER_GAME = 2;

export type RecallKind = 'recurrence' | 'reinforcement' | 'nudge';

export interface RecallLine {
  kind: RecallKind;
  rule: string;
  text: string;
}

/** Per-game state. Reset on a new game, not shared between them. */
export class RecallTracker {
  #callouts = 0;
  #seen = new Set<string>();
  /** Rules the player has triggered *in this game*, for reinforcement checks. */
  #triggeredThisGame = new Set<string>();

  reset(): void {
    this.#callouts = 0;
    this.#seen.clear();
    this.#triggeredThisGame.clear();
  }

  noteTriggered(rules: readonly string[]): void {
    for (const rule of rules) this.#triggeredThisGame.add(rule);
  }

  get triggeredThisGame(): ReadonlySet<string> {
    return this.#triggeredThisGame;
  }

  /**
   * A callout for a mistake the player keeps making, or null when a guardrail
   * says stay quiet.
   */
  recurrence(profile: SkillProfile, triggeredRules: readonly string[]): RecallLine | null {
    if (!hasProfile(profile)) return null;
    if (this.#callouts >= MAX_CALLOUTS_PER_GAME) return null;

    // Only the top weaknesses are worth interrupting for.
    const topWeaknesses = profile.weaknesses.slice(0, 3);
    const rule = triggeredRules.find(
      (r) => isNegativeRule(r) && topWeaknesses.includes(r) && !this.#seen.has(r),
    );
    if (!rule) return null;

    const stat = profile.ruleStats[rule];
    if (!stat || stat.count < MIN_OCCURRENCES_FOR_PATTERN) return null;

    this.#seen.add(rule);
    this.#callouts++;

    const rank = profile.weaknesses.indexOf(rule);
    const emphasis =
      rank === 0
        ? ' It is the pattern costing you the most games right now.'
        : '';

    return {
      kind: 'recurrence',
      rule,
      // Always paired with the check that prevents it — a criticism without a
      // remedy is just a complaint.
      text:
        `That is the ${ordinal(stat.count)} time you have made this mistake — ` +
        `${labelFor(rule)}.${emphasis} ${remedyFor(rule)}`,
    };
  }

  /**
   * Praise for avoiding a mistake the player has repeatedly made.
   *
   * Fires at the end of a game, so it is a judgement about the whole game
   * rather than a running commentary.
   */
  reinforcement(profile: SkillProfile): RecallLine | null {
    if (!hasProfile(profile)) return null;

    const avoided = profile.weaknesses.find((rule) => !this.#triggeredThisGame.has(rule));
    if (!avoided) return null;

    const stat = profile.ruleStats[avoided];
    if (!stat || stat.count < MIN_OCCURRENCES_FOR_PATTERN) return null;

    return {
      kind: 'reinforcement',
      rule: avoided,
      text:
        `You got through that game without ${labelFor(avoided)} — ` +
        `something that had shown up ${stat.count} times before. That is real progress.`,
    };
  }

  /**
   * A quiet note before you move, when the position matches a known weakness.
   * Counts against the same budget, because a nudge interrupts just as much.
   */
  nudge(profile: SkillProfile, positionRules: readonly string[]): RecallLine | null {
    if (!hasProfile(profile)) return null;
    if (this.#callouts >= MAX_CALLOUTS_PER_GAME) return null;

    const rule = positionRules.find(
      (r) => profile.weaknesses.slice(0, 2).includes(r) && !this.#seen.has(r),
    );
    if (!rule) return null;

    this.#seen.add(rule);
    this.#callouts++;

    return {
      kind: 'nudge',
      rule,
      text: `Worth a look before you move: ${remedyFor(rule)}`,
    };
  }
}

/** The concrete check that prevents each mistake. */
function remedyFor(rule: string): string {
  switch (rule) {
    case 'hangs-piece':
      return 'Check the square you are landing on — is anything defending it?';
    case 'allows-fork':
      return 'Look for squares where one enemy piece could touch two of yours at once.';
    case 'allows-pin':
      return 'Watch for your pieces lining up in front of something more valuable.';
    case 'trapped-piece':
      return 'Count the retreat squares before sending a piece deep.';
    case 'weakens-king':
      return 'Get castled, and leave the pawns in front of your king alone.';
    case 'walks-into-check':
      return 'Scan for checks against your own king first.';
    case 'missed-capture':
      return 'Look for free material before anything else.';
    default:
      return 'Take one more look at their most forcing reply.';
  }
}

function ordinal(n: number): string {
  const suffix =
    n % 100 >= 11 && n % 100 <= 13
      ? 'th'
      : n % 10 === 1
        ? 'st'
        : n % 10 === 2
          ? 'nd'
          : n % 10 === 3
            ? 'rd'
            : 'th';
  return `${n}${suffix}`;
}
