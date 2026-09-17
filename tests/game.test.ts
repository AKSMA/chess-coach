import { describe, expect, it } from 'vitest';
import { GameState } from '../src/game/GameState.js';
import { classify, warrantsWarning } from '../src/game/classify.js';
import { gameAccuracy, moveAccuracy } from '../src/game/accuracy.js';
import { phaseOf, plyOf } from '../src/game/phase.js';
import { isBookPosition, openingFromHistory, openingName, positionKey } from '../src/game/openings.js';
import type { Score } from '../src/engine/score.js';

const cp = (n: number): Score => ({ kind: 'cp', cp: n });

describe('classify', () => {
  it('places each band on the right side of its boundary', () => {
    expect(classify(0)).toBe('best');
    expect(classify(10)).toBe('best');
    expect(classify(11)).toBe('excellent');
    expect(classify(20)).toBe('excellent');
    expect(classify(21)).toBe('good');
    expect(classify(50)).toBe('good');
    expect(classify(51)).toBe('inaccuracy');
    expect(classify(100)).toBe('inaccuracy');
    expect(classify(101)).toBe('mistake');
    expect(classify(200)).toBe('mistake');
    expect(classify(201)).toBe('blunder');
  });

  it('never blames the player for theory or for a forced move', () => {
    expect(classify(400, { isBook: true })).toBe('book');
    expect(classify(400, { isForced: true })).toBe('forced');
    // Forced wins over book: having no choice is the more specific fact.
    expect(classify(400, { isBook: true, isForced: true })).toBe('forced');
  });

  it('warns only on mistakes and blunders', () => {
    expect(warrantsWarning('inaccuracy')).toBe(false);
    expect(warrantsWarning('mistake')).toBe(true);
    expect(warrantsWarning('blunder')).toBe(true);
    expect(warrantsWarning('book')).toBe(false);
  });
});

describe('accuracy', () => {
  it('is ~100 for a move that holds the evaluation', () => {
    expect(moveAccuracy(cp(30), cp(30), 'w')).toBeGreaterThan(99);
  });

  it('does not punish improving the position', () => {
    expect(moveAccuracy(cp(0), cp(200), 'w')).toBeGreaterThan(99);
    expect(moveAccuracy(cp(0), cp(-200), 'b')).toBeGreaterThan(99);
  });

  it('falls as the mover throws more away', () => {
    const small = moveAccuracy(cp(0), cp(-50), 'w');
    const large = moveAccuracy(cp(0), cp(-600), 'w');
    expect(small).toBeGreaterThan(large);
    expect(large).toBeLessThan(60);
  });

  it('reads Black’s losses in the right direction', () => {
    // Black to move at 0; position becomes +600 for White. Bad for Black.
    expect(moveAccuracy(cp(0), cp(600), 'b')).toBeLessThan(60);
  });

  it('stays within 0..100', () => {
    for (const after of [-9000, -300, 0, 300, 9000]) {
      const a = moveAccuracy(cp(0), cp(after), 'w');
      expect(a).toBeGreaterThanOrEqual(0);
      expect(a).toBeLessThanOrEqual(100);
    }
  });

  it('averages a game, and treats an empty game as perfect', () => {
    expect(gameAccuracy([])).toBe(100);
    expect(gameAccuracy([100, 90, 80])).toBe(90);
  });
});

describe('phase', () => {
  const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

  it('counts ply from the FEN counters', () => {
    expect(plyOf(START)).toBe(0);
    expect(plyOf('rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1')).toBe(1);
    expect(plyOf('r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 2 3')).toBe(4);
  });

  it('calls the starting position the opening', () => {
    expect(phaseOf(START)).toBe('opening');
  });

  it('calls a queenless position an endgame regardless of ply', () => {
    expect(phaseOf('r3k2r/pppppppp/8/8/8/8/PPPPPPPP/R3K2R w KQkq - 0 5')).toBe('endgame');
  });

  it('calls a bare-bones position an endgame', () => {
    expect(phaseOf('4k3/8/8/8/8/8/4P3/4K3 w - - 0 40')).toBe('endgame');
  });

  it('calls a developed, queens-on position a middlegame', () => {
    const fen = 'r2q1rk1/ppp2ppp/2np1n2/2b1p1B1/2B1P3/2NP1N2/PPP2PPP/R2Q1RK1 w - - 0 11';
    expect(phaseOf(fen)).toBe('middlegame');
  });
});

describe('openings', () => {
  it('keys on position only, ignoring the move counters', () => {
    const a = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
    const b = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 7 25';
    expect(positionKey(a)).toBe(positionKey(b));
  });

  it('names a position reached by transposition', () => {
    // 1. e4 e5 2. Nf3 Nc6 3. Bc4 Bc5 — the Giuoco Piano.
    const fen = 'r1bqk1nr/pppp1ppp/2n5/2b1p3/2B1P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 4 4';
    expect(openingName(fen)).toBe('Italian Game, Giuoco Piano');
  });

  it('returns null for a position outside the book', () => {
    expect(openingName('8/8/8/4k3/8/4K3/8/8 w - - 0 60')).toBeNull();
  });

  it('reports the most specific opening seen along the game', () => {
    const fens = [
      'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
      // ... 1.e4 e5 (King's Pawn Game)
      'rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2',
      // ... 3.Bc4 Bc5 (Giuoco Piano)
      'r1bqk1nr/pppp1ppp/2n5/2b1p3/2B1P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 4 4',
      // a position with no name of its own
      'r1bqk1nr/pppp1ppp/2n5/2b1p3/2B1P3/3P1N2/PPP2PPP/RNBQK2R b KQkq - 0 4',
    ];
    expect(openingFromHistory(fens)).toBe('Italian Game, Giuoco Piano');
  });

  it('stops calling positions book after the opening window', () => {
    const fen = 'rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2';
    expect(isBookPosition(fen, 2)).toBe(true);
    expect(isBookPosition(fen, 40)).toBe(false);
  });
});

describe('GameState', () => {
  it('records both sides and tracks ply', () => {
    const game = new GameState();
    game.play({ from: 'e2', to: 'e4' });
    game.play({ from: 'e7', to: 'e5' });

    expect(game.ply).toBe(2);
    expect(game.records.map((r) => r.san)).toEqual(['e4', 'e5']);
    expect(game.records[0]!.color).toBe('w');
    expect(game.records[1]!.color).toBe('b');
    expect(game.turn).toBe('w');
  });

  it('keeps the pre-move position, which the detectors compare against', () => {
    const game = new GameState();
    const before = game.fen;
    const record = game.play({ from: 'e2', to: 'e4' })!;

    expect(record.fenBefore).toBe(before);
    expect(record.fenAfter).toBe(game.fen);
    expect(record.fenBefore).not.toBe(record.fenAfter);
  });

  it('rejects an illegal move without disturbing the game', () => {
    const game = new GameState();
    const before = game.fen;

    expect(game.play({ from: 'e2', to: 'e5' })).toBeNull();
    expect(game.fen).toBe(before);
    expect(game.ply).toBe(0);
  });

  it('peeks without committing, which is what makes "take it back" free', () => {
    const game = new GameState();
    const before = game.fen;

    const peeked = game.peek({ from: 'e2', to: 'e4' });
    expect(peeked!.san).toBe('e4');
    expect(peeked!.uci).toBe('e2e4');
    // Real state untouched.
    expect(game.fen).toBe(before);
    expect(game.ply).toBe(0);
  });

  it('reports promotion targets so the picker can be shown', () => {
    const game = new GameState();
    game.loadFen('8/P7/8/4k3/8/8/8/K7 w - - 0 1');
    expect(game.isPromotion('a7', 'a8')).toBe(true);
    expect(game.isPromotion('a1', 'a2')).toBe(false);
  });

  it('undoes cleanly', () => {
    const game = new GameState();
    const before = game.fen;
    game.play({ from: 'e2', to: 'e4' });
    game.undo();

    expect(game.fen).toBe(before);
    expect(game.ply).toBe(0);
    expect(game.undo()).toBeNull();
  });

  it('gives the player back the move after the opponent replied', () => {
    const game = new GameState();
    game.play({ from: 'e2', to: 'e4' });
    game.play({ from: 'e7', to: 'e5' });
    game.play({ from: 'g1', to: 'f3' });
    game.play({ from: 'b8', to: 'c6' });

    game.undoToPlayerTurn('w');

    expect(game.turn).toBe('w');
    expect(game.records.map((r) => r.san)).toEqual(['e4', 'e5']);
  });

  it('distinguishes the ways a game can end', () => {
    const game = new GameState();

    game.loadFen('rnb1kbnr/pppp1ppp/8/4p3/6Pq/5P2/PPPPP2P/RNBQKBNR w KQkq - 1 3');
    expect(game.result).toBe('black-wins');

    game.loadFen('7k/5Q2/6K1/8/8/8/8/8 b - - 0 1');
    expect(game.result).toBe('draw-stalemate');

    game.loadFen('4k3/8/8/8/8/8/8/4K3 w - - 0 1');
    expect(game.result).toBe('draw-insufficient-material');

    game.loadFen('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1');
    expect(game.result).toBeNull();
  });

  it('exposes legal destinations for the board', () => {
    const game = new GameState();
    const dests = game.legalDests();

    expect(dests.get('e2')).toEqual(['e3', 'e4']);
    expect(dests.get('g1')).toEqual(['f3', 'h3']);
    expect(dests.has('e1')).toBe(false);
  });

  it('locates the checked king for the board indicator', () => {
    const game = new GameState();
    expect(game.checkedKingSquare).toBeNull();

    game.loadFen('rnbqkbnr/ppp2ppp/3p4/1B2p3/4P3/5N2/PPPP1PPP/RNBQK2R b KQkq - 1 4');
    expect(game.checkedKingSquare).toBe('e8');
  });

  it('names the opening it is in', () => {
    const game = new GameState();
    for (const m of [
      { from: 'e2', to: 'e4' },
      { from: 'e7', to: 'e5' },
      { from: 'g1', to: 'f3' },
      { from: 'b8', to: 'c6' },
      { from: 'f1', to: 'c4' },
      { from: 'f8', to: 'c5' },
    ] as const) {
      game.play(m);
    }
    expect(game.openingName).toBe('Italian Game, Giuoco Piano');
  });
});
