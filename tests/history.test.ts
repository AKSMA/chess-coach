import { describe, expect, it } from 'vitest';
import type { StoredGame, StoredMove } from '../src/history/db.js';
import {
  emptyProfile,
  hasProfile,
  labelFor,
  recomputeProfile,
} from '../src/history/profile.js';
import { MAX_CALLOUTS_PER_GAME, RecallTracker } from '../src/coach/recall.js';

let clock = 1_000;

function game(id: string, accuracy = 80): StoredGame {
  clock += 1000;
  return {
    id,
    startedAt: clock,
    endedAt: clock + 500,
    playerColor: 'w',
    level: 3,
    result: 'draw',
    pgn: '',
    moveCount: 20,
    accuracy,
    avgCpLoss: 40,
    openingName: null,
  };
}

function move(gameId: string, ply: number, rules: string[], extra: Partial<StoredMove> = {}): StoredMove {
  return {
    id: `${gameId}:${ply}`,
    gameId,
    ply,
    fenBefore: '',
    fenAfter: '',
    san: 'e4',
    color: 'w',
    phase: 'middlegame',
    verdict: 'mistake',
    cpLoss: 150,
    triggeredRules: rules,
    bestMoveSan: null,
    explanation: null,
    ...extra,
  };
}

describe('recomputeProfile', () => {
  it('returns an empty profile with no games', () => {
    expect(recomputeProfile([], [])).toEqual(emptyProfile());
  });

  it('counts only negative rules — praise is not a weakness', () => {
    const games = [game('g1'), game('g2'), game('g3')];
    const moves = [
      move('g1', 1, ['hangs-piece', 'develops']),
      move('g2', 1, ['hangs-piece', 'controls-centre']),
      move('g3', 1, ['hangs-piece', 'castles']),
    ];
    const profile = recomputeProfile(games, moves);

    expect(Object.keys(profile.ruleStats)).toEqual(['hangs-piece']);
    expect(profile.ruleStats['hangs-piece']!.count).toBe(3);
  });

  it('requires three occurrences before something is a weakness', () => {
    const games = [game('g1'), game('g2'), game('g3')];
    const moves = [move('g1', 1, ['allows-fork']), move('g2', 1, ['allows-fork'])];
    expect(recomputeProfile(games, moves).weaknesses).not.toContain('allows-fork');

    const more = [...moves, move('g3', 1, ['allows-fork'])];
    expect(recomputeProfile(games, more).weaknesses).toContain('allows-fork');
  });

  it('ranks by recency, not raw count', () => {
    // 'old-habit' fired more often, but only long ago.
    const games = [game('g1'), game('g2'), game('g3'), game('g4'), game('g5'), game('g6')];
    const moves = [
      ...[1, 2, 3, 4, 5].map((p) => move('g1', p, ['weakens-king'])),
      ...[1, 2, 3].map((p) => move('g6', p, ['hangs-piece'])),
      move('g5', 9, ['hangs-piece']),
    ];
    const profile = recomputeProfile(games, moves);

    expect(profile.ruleStats['weakens-king']!.count).toBeGreaterThan(
      profile.ruleStats['hangs-piece']!.count - 2,
    );
    // Recent beats frequent.
    expect(profile.weaknesses[0]).toBe('hangs-piece');
  });

  it('moves a fixed habit from weaknesses to strengths', () => {
    // Fired three times early, then never again across many recent games.
    const games = Array.from({ length: 14 }, (_, i) => game(`g${i + 1}`));
    const moves = [
      move('g1', 1, ['allows-pin']),
      move('g2', 1, ['allows-pin']),
      move('g3', 1, ['allows-pin']),
    ];
    const profile = recomputeProfile(games, moves);

    expect(profile.weaknesses).not.toContain('allows-pin');
    expect(profile.strengths).toContain('allows-pin');
  });

  it('aggregates loss and blunder rate per phase', () => {
    const games = [game('g1')];
    const moves = [
      move('g1', 1, [], { phase: 'opening', cpLoss: 10, verdict: 'good' }),
      move('g1', 2, [], { phase: 'endgame', cpLoss: 300, verdict: 'blunder' }),
      move('g1', 3, [], { phase: 'endgame', cpLoss: 100, verdict: 'mistake' }),
    ];
    const profile = recomputeProfile(games, moves);

    expect(profile.byPhase.opening.avgCpLoss).toBe(10);
    expect(profile.byPhase.endgame.avgCpLoss).toBe(200);
    expect(profile.byPhase.endgame.blunderRate).toBe(0.5);
    expect(profile.byPhase.middlegame.moves).toBe(0);
  });

  it('tracks accuracy over time', () => {
    const profile = recomputeProfile([game('g1', 70), game('g2', 80), game('g3', 90)], []);
    expect(profile.accuracyTrend).toEqual([70, 80, 90]);
    expect(profile.avgAccuracy).toBe(80);
  });

  it('ignores the opponent’s moves, which are stored only for replay', () => {
    const games = [game('g1'), game('g2'), game('g3')];
    const moves = [
      move('g1', 1, ['hangs-piece'], { color: 'w' }),
      // Black is the engine here; its moves must not count against you.
      move('g1', 2, ['hangs-piece'], { color: 'b' }),
      move('g2', 2, ['hangs-piece'], { color: 'b' }),
      move('g3', 2, ['hangs-piece'], { color: 'b' }),
    ];
    const profile = recomputeProfile(games, moves);

    expect(profile.ruleStats['hangs-piece']!.count).toBe(1);
    expect(profile.weaknesses).not.toContain('hangs-piece');
  });

  it('does not let the opponent’s moves dilute the phase averages', () => {
    const games = [game('g1')];
    const moves = [
      move('g1', 1, [], { color: 'w', phase: 'opening', cpLoss: 100 }),
      move('g1', 2, [], { color: 'b', phase: 'opening', cpLoss: 0 }),
    ];
    const profile = recomputeProfile(games, moves);

    expect(profile.byPhase.opening.moves).toBe(1);
    expect(profile.byPhase.opening.avgCpLoss).toBe(100);
  });

  it('ignores moves whose game has been deleted', () => {
    const profile = recomputeProfile([game('g1')], [move('ghost', 1, ['hangs-piece'])]);
    expect(profile.ruleStats['hangs-piece']).toBeUndefined();
  });
});

describe('hasProfile', () => {
  it('is false until three games are stored', () => {
    expect(hasProfile(recomputeProfile([game('a')], []))).toBe(false);
    expect(hasProfile(recomputeProfile([game('a'), game('b')], []))).toBe(false);
    expect(hasProfile(recomputeProfile([game('a'), game('b'), game('c')], []))).toBe(true);
  });
});

describe('RecallTracker guardrails', () => {
  const buildProfile = (gameCount = 4) => {
    const games = Array.from({ length: gameCount }, (_, i) => game(`h${i + 1}`));
    const moves = games.flatMap((g, i) =>
      i < 3 ? [move(g.id, 1, ['hangs-piece']), move(g.id, 2, ['allows-fork'])] : [],
    );
    return recomputeProfile(games, moves);
  };

  it('says nothing at all on a cold profile', () => {
    const cold = recomputeProfile([game('only')], [move('only', 1, ['hangs-piece'])]);
    const tracker = new RecallTracker();

    expect(tracker.recurrence(cold, ['hangs-piece'])).toBeNull();
    expect(tracker.reinforcement(cold)).toBeNull();
    expect(tracker.nudge(cold, ['hangs-piece'])).toBeNull();
  });

  it('calls out a genuine recurring pattern', () => {
    const tracker = new RecallTracker();
    const line = tracker.recurrence(buildProfile(), ['hangs-piece']);

    expect(line).not.toBeNull();
    expect(line!.kind).toBe('recurrence');
    expect(line!.text).toMatch(/3rd time/);
  });

  it('always pairs the criticism with a concrete check', () => {
    const tracker = new RecallTracker();
    const line = tracker.recurrence(buildProfile(), ['hangs-piece'])!;
    expect(line.text).toMatch(/Check the square you are landing on/);
  });

  it('never repeats the same callout within a game', () => {
    const profile = buildProfile();
    const tracker = new RecallTracker();

    expect(tracker.recurrence(profile, ['hangs-piece'])).not.toBeNull();
    expect(tracker.recurrence(profile, ['hangs-piece'])).toBeNull();
  });

  it('stops after two callouts in one game', () => {
    const profile = buildProfile();
    const tracker = new RecallTracker();

    expect(tracker.recurrence(profile, ['hangs-piece'])).not.toBeNull();
    expect(tracker.recurrence(profile, ['allows-fork'])).not.toBeNull();
    // A third distinct weakness must still stay quiet.
    expect(tracker.recurrence(profile, ['weakens-king'])).toBeNull();
    expect(MAX_CALLOUTS_PER_GAME).toBe(2);
  });

  it('ignores rules that are not among the top weaknesses', () => {
    const tracker = new RecallTracker();
    expect(tracker.recurrence(buildProfile(), ['missed-capture'])).toBeNull();
  });

  it('resets between games', () => {
    const profile = buildProfile();
    const tracker = new RecallTracker();

    tracker.recurrence(profile, ['hangs-piece']);
    tracker.recurrence(profile, ['allows-fork']);
    tracker.reset();

    expect(tracker.recurrence(profile, ['hangs-piece'])).not.toBeNull();
  });

  it('praises avoiding a habitual mistake', () => {
    const profile = buildProfile();
    const tracker = new RecallTracker();
    tracker.noteTriggered(['allows-fork']);

    const line = tracker.reinforcement(profile);
    expect(line).not.toBeNull();
    expect(line!.rule).toBe('hangs-piece');
    expect(line!.text).toMatch(/real progress/);
  });

  it('does not praise a mistake that was made this game', () => {
    const profile = buildProfile();
    const tracker = new RecallTracker();
    tracker.noteTriggered(profile.weaknesses);

    expect(tracker.reinforcement(profile)).toBeNull();
  });

  it('counts a pre-move nudge against the same budget', () => {
    const profile = buildProfile();
    const tracker = new RecallTracker();

    expect(tracker.nudge(profile, ['hangs-piece'])).not.toBeNull();
    expect(tracker.recurrence(profile, ['allows-fork'])).not.toBeNull();
    expect(tracker.nudge(profile, ['weakens-king'])).toBeNull();
  });
});

describe('labelFor', () => {
  it('gives plain language for known rules', () => {
    expect(labelFor('hangs-piece')).toBe('leaving pieces undefended');
    expect(labelFor('allows-fork')).toBe('walking into forks');
  });

  it('degrades readably for an unknown rule', () => {
    expect(labelFor('some-new-rule')).toBe('some new rule');
  });
});
