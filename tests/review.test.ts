import { describe, expect, it } from 'vitest';
import type { StoredMove } from '../src/history/db.js';
import { buildReview } from '../src/history/review.js';
import { emptyProfile, recomputeProfile } from '../src/history/profile.js';

function move(ply: number, over: Partial<StoredMove> = {}): StoredMove {
  return {
    id: `g:${ply}`,
    gameId: 'g',
    ply,
    fenBefore: '',
    fenAfter: '',
    san: 'e4',
    color: ply % 2 === 1 ? 'w' : 'b',
    phase: 'middlegame',
    verdict: 'good',
    cpLoss: 20,
    triggeredRules: [],
    bestMoveSan: null,
    explanation: null,
    ...over,
  };
}

describe('buildReview', () => {
  it('counts only your own moves', () => {
    const moves = [move(1), move(2), move(3), move(4)];
    const review = buildReview(moves, 'w', 90, emptyProfile());

    expect(review.moveCount).toBe(2);
    expect(review.timeline.every((t) => t.color === 'w')).toBe(true);
  });

  it('picks the three costliest moves, worst first', () => {
    const moves = [
      move(1, { cpLoss: 400, san: 'Nxe5' }),
      move(3, { cpLoss: 150, san: 'Bb5' }),
      move(5, { cpLoss: 900, san: 'Qh5' }),
      move(7, { cpLoss: 250, san: 'Ng5' }),
      move(9, { cpLoss: 10, san: 'O-O' }),
    ];
    const review = buildReview(moves, 'w', 60, emptyProfile());

    expect(review.turningPoints.map((t) => t.san)).toEqual(['Qh5', 'Nxe5', 'Ng5']);
  });

  it('ignores moves that cost almost nothing', () => {
    const moves = [move(1, { cpLoss: 10 }), move(3, { cpLoss: 30 })];
    expect(buildReview(moves, 'w', 98, emptyProfile()).turningPoints).toHaveLength(0);
  });

  it('summarises the mistake mix from negative rules only', () => {
    const moves = [
      move(1, { triggeredRules: ['hangs-piece', 'develops'] }),
      move(3, { triggeredRules: ['hangs-piece'] }),
      move(5, { triggeredRules: ['allows-fork'] }),
    ];
    const review = buildReview(moves, 'w', 70, emptyProfile());

    expect(review.mistakeMix[0]).toEqual({
      rule: 'hangs-piece',
      label: 'leaving pieces undefended',
      count: 2,
    });
    expect(review.mistakeMix.map((m) => m.rule)).not.toContain('develops');
  });

  it('leads its advice with this game’s mistakes', () => {
    const moves = [
      move(1, { triggeredRules: ['allows-pin'] }),
      move(3, { triggeredRules: ['allows-pin'] }),
    ];
    const review = buildReview(moves, 'w', 70, emptyProfile());

    expect(review.workOn[0]).toMatch(/getting pinned/i);
    expect(review.workOn[0]).toMatch(/2 times/);
  });

  it('says something useful about a clean game', () => {
    const review = buildReview([move(1, { cpLoss: 5 })], 'w', 99, emptyProfile());
    expect(review.workOn[0]).toMatch(/Nothing serious went wrong/);
  });

  it('caps advice at three items', () => {
    const moves = [
      move(1, { triggeredRules: ['hangs-piece'] }),
      move(3, { triggeredRules: ['allows-fork'] }),
      move(5, { triggeredRules: ['allows-pin'] }),
      move(7, { triggeredRules: ['weakens-king'] }),
    ];
    expect(buildReview(moves, 'w', 50, emptyProfile()).workOn.length).toBeLessThanOrEqual(3);
  });

  it('counts best moves and blunders for the headline', () => {
    const moves = [
      move(1, { verdict: 'best' }),
      move(3, { verdict: 'excellent' }),
      move(5, { verdict: 'blunder', cpLoss: 500 }),
    ];
    const review = buildReview(moves, 'w', 55, emptyProfile());

    expect(review.bestMoveCount).toBe(2);
    expect(review.blunderCount).toBe(1);
  });

  it('falls back to profile weaknesses when the game itself was clean', () => {
    const games = [1, 2, 3].map((i) => ({
      id: `g${i}`,
      startedAt: i,
      endedAt: i,
      playerColor: 'w' as const,
      level: 3,
      result: 'draw' as const,
      pgn: '',
      moveCount: 10,
      accuracy: 80,
      avgCpLoss: 30,
      openingName: null,
    }));
    const history = games.flatMap((g) => [
      { ...move(1, { triggeredRules: ['weakens-king'] }), id: `${g.id}:1`, gameId: g.id },
    ]);
    const profile = recomputeProfile(games, history);

    const review = buildReview([move(1, { cpLoss: 5 })], 'w', 97, profile);
    expect(review.workOn.join(' ')).toMatch(/king exposed|recurring theme/i);
  });
});
