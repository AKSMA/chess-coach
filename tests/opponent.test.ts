import { describe, expect, it } from 'vitest';
import type { PvLine } from '../src/engine/EngineClient.js';
import { LEVELS, levelConfig, selectFromLines } from '../src/engine/opponent.js';

/** A candidate line worth `cp` (white-positive) whose first move is `uci`. */
function line(multipv: number, cp: number, uci: string): PvLine {
  return { multipv, depth: 8, score: { kind: 'cp', cp }, uci: [uci], san: [uci] };
}

const alwaysFirst = () => 0;
const alwaysLast = () => 0.999999;

describe('level configuration', () => {
  it('covers 1..10 densely', () => {
    expect(LEVELS.map((l) => l.level)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });

  it('clamps out-of-range levels rather than returning undefined', () => {
    expect(levelConfig(0).level).toBe(1);
    expect(levelConfig(-5).level).toBe(1);
    expect(levelConfig(99).level).toBe(10);
  });

  it('samples at the bottom and limits strength in the middle', () => {
    expect(levelConfig(1).mode).toBe('sample');
    expect(levelConfig(3).mode).toBe('sample');
    expect(levelConfig(4).mode).toBe('limited');
    expect(levelConfig(8).mode).toBe('limited');
    expect(levelConfig(10).mode).toBe('full');
  });

  it('never asks for an Elo below what the engine supports', () => {
    for (const config of LEVELS) {
      if (config.elo !== undefined) expect(config.elo).toBeGreaterThanOrEqual(1320);
    }
  });

  it('tightens the giveaway allowance as the level rises', () => {
    const allowances = LEVELS.filter((l) => l.mode === 'sample').map((l) => l.maxGiveaway!);
    const sorted = [...allowances].sort((a, b) => b - a);
    expect(allowances).toEqual(sorted);
  });
});

describe('selectFromLines', () => {
  it('plays the best move at full strength regardless of the dice', () => {
    const lines = [line(1, 50, 'e2e4'), line(2, 10, 'd2d4')];
    expect(selectFromLines(lines, levelConfig(10), 'w', alwaysLast)!.uci[0]).toBe('e2e4');
  });

  it('will pick a non-best move at beginner level', () => {
    const lines = [
      line(1, 50, 'e2e4'),
      line(2, 40, 'd2d4'),
      line(3, 30, 'g1f3'),
      line(4, 20, 'b1c3'),
      line(5, 10, 'c2c4'),
    ];
    const chosen = selectFromLines(lines, levelConfig(1), 'w', alwaysLast);
    expect(chosen!.uci[0]).not.toBe('e2e4');
  });

  it('never picks a move that gives away more than the level allows', () => {
    // Second line hangs a queen: 900cp worse than best.
    const lines = [line(1, 50, 'e2e4'), line(2, -850, 'd1h5')];

    for (const level of [1, 2, 3]) {
      // Exhaustively sweep the random space rather than trusting one draw.
      for (let i = 0; i <= 100; i++) {
        const chosen = selectFromLines(lines, levelConfig(level), 'w', () => i / 100);
        expect(chosen!.uci[0]).toBe('e2e4');
      }
    }
  });

  it('reads giveaway from Black’s perspective when Black is choosing', () => {
    // White-positive scores: -50 is good for Black, +850 is catastrophic for Black.
    const lines = [line(1, -50, 'e7e5'), line(2, 850, 'd8h4')];

    for (let i = 0; i <= 100; i++) {
      const chosen = selectFromLines(lines, levelConfig(1), 'b', () => i / 100);
      expect(chosen!.uci[0]).toBe('e7e5');
    }
  });

  it('falls back to the best move when every alternative is too expensive', () => {
    const lines = [line(1, 50, 'e2e4'), line(2, -900, 'd1h5'), line(3, -950, 'g1h3')];
    expect(selectFromLines(lines, levelConfig(1), 'w', alwaysFirst)!.uci[0]).toBe('e2e4');
  });

  it('handles a position with a single legal move', () => {
    const lines = [line(1, 0, 'e1e2')];
    expect(selectFromLines(lines, levelConfig(1), 'w', alwaysLast)!.uci[0]).toBe('e1e2');
  });

  it('returns null when there is nothing to play', () => {
    expect(selectFromLines([], levelConfig(1), 'w')).toBeNull();
  });

  it('spreads its choices across the allowed candidates', () => {
    const lines = [
      line(1, 50, 'a'),
      line(2, 45, 'b'),
      line(3, 40, 'c'),
      line(4, 35, 'd'),
      line(5, 30, 'e'),
    ];

    const seen = new Set<string>();
    for (let i = 0; i < 100; i++) {
      seen.add(selectFromLines(lines, levelConfig(1), 'w', () => i / 100)!.uci[0]!);
    }
    // A beginner opponent that always plays the same move is not a beginner.
    expect(seen.size).toBeGreaterThan(2);
  });
});
