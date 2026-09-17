import { describe, expect, it } from 'vitest';
import {
  MATE_VALUE,
  centipawnLoss,
  favours,
  normalise,
  toCp,
  winProbability,
  type Score,
} from '../src/engine/score.js';

const cp = (n: number): Score => ({ kind: 'cp', cp: n });
const mate = (n: number): Score => ({ kind: 'mate', moves: n });

describe('normalise', () => {
  it('leaves white-to-move scores alone', () => {
    expect(normalise(50, 'cp', 'w')).toEqual(cp(50));
    expect(normalise(-120, 'cp', 'w')).toEqual(cp(-120));
  });

  it('negates black-to-move scores, because the engine speaks from the mover POV', () => {
    // "Black to move, score cp 50" means Black is up half a pawn,
    // which is -50 in the white-positive frame.
    expect(normalise(50, 'cp', 'b')).toEqual(cp(-50));
    expect(normalise(-120, 'cp', 'b')).toEqual(cp(120));
  });

  it('applies the same flip to mate scores', () => {
    expect(normalise(3, 'mate', 'w')).toEqual(mate(3));
    expect(normalise(3, 'mate', 'b')).toEqual(mate(-3));
    expect(normalise(-2, 'mate', 'b')).toEqual(mate(2));
  });
});

describe('toCp', () => {
  it('passes centipawn scores through', () => {
    expect(toCp(cp(0))).toBe(0);
    expect(toCp(cp(-340))).toBe(-340);
  });

  it('ranks faster mates above slower ones', () => {
    expect(toCp(mate(1))).toBeGreaterThan(toCp(mate(8)));
    expect(toCp(mate(-1))).toBeLessThan(toCp(mate(-8)));
  });

  it('puts every mate beyond every material advantage', () => {
    expect(toCp(mate(30))).toBeGreaterThan(toCp(cp(5000)));
    expect(toCp(mate(-30))).toBeLessThan(toCp(cp(-5000)));
  });

  it('keeps mate-on-the-board signed rather than collapsing to zero', () => {
    expect(toCp(mate(0))).toBe(MATE_VALUE);
  });
});

describe('centipawnLoss', () => {
  it('is zero for the best move', () => {
    expect(centipawnLoss(cp(30), cp(30), 'w')).toBe(0);
    expect(centipawnLoss(cp(30), cp(30), 'b')).toBe(0);
  });

  it('measures how far White dropped the evaluation', () => {
    // Best kept +50; White played into -250. That is 300 thrown away.
    expect(centipawnLoss(cp(50), cp(-250), 'w')).toBe(300);
  });

  it('measures Black losses in the opposite direction', () => {
    // Best kept -50 (good for Black); Black played into +250.
    expect(centipawnLoss(cp(-50), cp(250), 'b')).toBe(300);
  });

  it('never reports a negative loss, even when the deeper search disagrees', () => {
    expect(centipawnLoss(cp(30), cp(45), 'w')).toBe(0);
    expect(centipawnLoss(cp(-30), cp(-45), 'b')).toBe(0);
  });

  it('treats missing a forced mate as a large loss', () => {
    const loss = centipawnLoss(mate(2), cp(100), 'w');
    expect(loss).toBeGreaterThan(9000);
  });

  it('treats walking into a forced mate as a large loss', () => {
    const loss = centipawnLoss(cp(0), mate(-3), 'w');
    expect(loss).toBeGreaterThan(9000);
  });

  it('does not punish converting a winning position into mate', () => {
    expect(centipawnLoss(mate(3), mate(3), 'w')).toBe(0);
    // Finding a faster mate than the "best" line is not a loss.
    expect(centipawnLoss(mate(4), mate(2), 'w')).toBe(0);
  });
});

describe('winProbability', () => {
  it('is even at a dead equal evaluation', () => {
    expect(winProbability(cp(0))).toBeCloseTo(0.5, 5);
  });

  it('is monotonic in White’s favour', () => {
    expect(winProbability(cp(200))).toBeGreaterThan(winProbability(cp(50)));
    expect(winProbability(cp(-200))).toBeLessThan(winProbability(cp(-50)));
  });

  it('saturates at forced mate', () => {
    expect(winProbability(mate(2))).toBe(1);
    expect(winProbability(mate(-2))).toBe(0);
  });

  it('stays within bounds', () => {
    for (const v of [-9999, -500, 0, 500, 9999]) {
      const p = winProbability(cp(v));
      expect(p).toBeGreaterThanOrEqual(0);
      expect(p).toBeLessThanOrEqual(1);
    }
  });
});

describe('favours', () => {
  it('calls small edges equal', () => {
    expect(favours(cp(20))).toBe('equal');
    expect(favours(cp(-49))).toBe('equal');
  });

  it('names the better side once the edge is real', () => {
    expect(favours(cp(150))).toBe('w');
    expect(favours(cp(-150))).toBe('b');
    expect(favours(mate(1))).toBe('w');
    expect(favours(mate(-1))).toBe('b');
  });
});
