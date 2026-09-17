import { describe, expect, it } from 'vitest';
import {
  findDiscoveredAttacks,
  findForks,
  findPins,
  findTrappedPieces,
  kingSafety,
} from '../src/coach/tactics.js';

describe('findForks', () => {
  it('finds a knight forking king and rook', () => {
    // White knight on c7 hits the king on a8 and the rook on e8.
    const fen = 'r3r1k1/2N5/8/8/8/8/8/4K3 b - - 0 1';
    const forks = findForks(fen, 'w');

    expect(forks).toHaveLength(1);
    expect(forks[0]!.piece).toBe('n');
    expect(forks[0]!.square).toBe('c7');
    expect(forks[0]!.targets.map((t) => t.square).sort()).toEqual(['a8', 'e8']);
  });

  it('finds a knight forking two rooks', () => {
    // Rooks on d7 and f7 — both are knight-moves from e5.
    const fen = '8/3r1r2/8/4N3/8/8/8/4K2k w - - 0 1';
    const forks = findForks(fen, 'w');

    expect(forks).toHaveLength(1);
    expect(forks[0]!.targets.map((t) => t.square).sort()).toEqual(['d7', 'f7']);
  });

  it('does not call attacking two pawns a fork', () => {
    const fen = '8/8/3p1p2/4N3/8/8/8/4K2k w - - 0 1';
    expect(findForks(fen, 'w')).toHaveLength(0);
  });

  it('does not call a queen hitting two knights a fork', () => {
    // The queen is worth more than either target, so nothing is won.
    const fen = '8/8/3n1n2/4Q3/8/8/8/4K2k w - - 0 1';
    expect(findForks(fen, 'w')).toHaveLength(0);
  });

  it('finds nothing in the starting position', () => {
    const start = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
    expect(findForks(start, 'w')).toHaveLength(0);
    expect(findForks(start, 'b')).toHaveLength(0);
  });
});

describe('findPins', () => {
  it('finds an absolute pin against the king', () => {
    // Black knight on e5 cannot move: the rook on e1 would hit the king on e8.
    const fen = '4k3/8/8/4n3/8/8/8/4R1K1 b - - 0 1';
    const pins = findPins(fen, 'b');

    expect(pins).toHaveLength(1);
    expect(pins[0]!.square).toBe('e5');
    expect(pins[0]!.piece).toBe('n');
    expect(pins[0]!.absolute).toBe(true);
    expect(pins[0]!.behindPiece).toBe('k');
  });

  it('finds a relative pin against a more valuable piece', () => {
    // Knight on e5 shields the queen on e8 from the rook on e1.
    const fen = '4q1k1/8/8/4n3/8/8/8/4R1K1 b - - 0 1';
    const pins = findPins(fen, 'b');

    expect(pins).toHaveLength(1);
    expect(pins[0]!.absolute).toBe(false);
    expect(pins[0]!.behindPiece).toBe('q');
  });

  it('does not report a pin when the piece behind is worth less', () => {
    // Knight in front, pawn behind: losing the pawn is no threat, so the
    // knight is not meaningfully pinned.
    const fen = '6k1/8/8/4p3/4n3/8/8/4R1K1 b - - 0 1';
    expect(findPins(fen, 'b')).toHaveLength(0);
  });

  it('does report the reverse: a pawn shielding a knight', () => {
    // Pawn in front, knight behind — moving the pawn drops the knight.
    const fen = '6k1/8/8/4n3/4p3/8/8/4R1K1 b - - 0 1';
    const pins = findPins(fen, 'b');

    expect(pins).toHaveLength(1);
    expect(pins[0]!.square).toBe('e4');
    expect(pins[0]!.behindPiece).toBe('n');
  });

  it('does not report a pin through a gap with nothing behind', () => {
    const fen = '6k1/8/8/4n3/8/8/8/4R1K1 b - - 0 1';
    expect(findPins(fen, 'b')).toHaveLength(0);
  });

  it('does not treat a knight as a pinning piece', () => {
    // Knights cannot pin — nothing lies "behind" a knight's attack.
    const fen = '4k3/8/8/4r3/8/3N4/8/6K1 b - - 0 1';
    expect(findPins(fen, 'b')).toHaveLength(0);
  });

  it('finds the classic bishop pin of a knight against the queen', () => {
    // After 1.d4 Nf6 2.Bg5 e6 — the e-pawn has moved, so the bishop's diagonal
    // actually reaches the queen. With the pawn still on e7 there is no pin.
    const fen = 'rnbqkb1r/pppp1ppp/4pn2/6B1/3P4/8/PPP1PPPP/RN1QKBNR b KQkq - 2 2';
    const pins = findPins(fen, 'b');

    expect(pins.map((p) => p.square)).toContain('f6');
    expect(pins.find((p) => p.square === 'f6')!.behindPiece).toBe('q');
  });
});

describe('findDiscoveredAttacks', () => {
  it('finds a line opened by moving a piece out of the way', () => {
    // Rook on e1, own knight on e4 blocking, black queen on e8.
    // The knight steps to d6 and the rook's line opens onto the queen.
    const before = '4q1k1/8/8/8/4N3/8/8/4R1K1 w - - 0 1';
    const after = '4q1k1/8/3N4/8/8/8/8/4R1K1 b - - 1 1';
    const found = findDiscoveredAttacks(before, after, 'w', 'e4');

    expect(found).toHaveLength(1);
    expect(found[0]!.fromSquare).toBe('e1');
    expect(found[0]!.targetSquare).toBe('e8');
  });

  it('does not count the moved piece’s own new attack as a discovery', () => {
    const before = '4q1k1/8/8/8/4N3/8/8/6K1 w - - 0 1';
    const after = '4q1k1/8/4N3/8/8/8/8/6K1 b - - 1 1';
    expect(findDiscoveredAttacks(before, after, 'w', 'e4')).toHaveLength(0);
  });

  it('ignores attacks that already existed', () => {
    const before = '4q1k1/8/8/8/8/8/8/4R1K1 w - - 0 1';
    const after = '4q1k1/8/8/8/8/8/6K1/4R3 b - - 1 1';
    expect(findDiscoveredAttacks(before, after, 'w', 'g1')).toHaveLength(0);
  });
});

describe('findTrappedPieces', () => {
  it('finds a bishop with no safe square', () => {
    // The classic: Bxa7 grabs a pawn and the bishop is trapped by b6.
    const fen = 'rnbqkbnr/Bpp1pppp/1p6/8/8/8/PPPPPPPP/RN1QKBNR w KQkq - 0 3';
    const trapped = findTrappedPieces(fen, 'w');
    expect(trapped.map((t) => t.square)).toContain('a7');
  });

  it('does not report a piece that can simply step away', () => {
    const fen = '4k3/8/8/3b4/8/8/8/4K3 w - - 0 1';
    expect(findTrappedPieces(fen, 'b')).toHaveLength(0);
  });

  it('ignores pieces nothing is attacking', () => {
    const start = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
    expect(findTrappedPieces(start, 'w')).toHaveLength(0);
    expect(findTrappedPieces(start, 'b')).toHaveLength(0);
  });
});

describe('kingSafety', () => {
  it('reports a full pawn shield in the starting position', () => {
    const start = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
    const safety = kingSafety(start, 'w')!;

    expect(safety.square).toBe('e1');
    expect(safety.shieldPawns).toBe(3);
    expect(safety.attackerCount).toBe(0);
    expect(safety.exposed).toBe(false);
  });

  it('recognises a castled king', () => {
    const fen = 'r1bqk2r/pppp1ppp/2n2n2/2b1p3/2B1P3/2N2N2/PPPP1PPP/R1BQ1RK1 b kq - 5 5';
    const safety = kingSafety(fen, 'w')!;

    expect(safety.square).toBe('g1');
    expect(safety.castled).toBe(true);
    expect(safety.shieldPawns).toBe(3);
  });

  it('flags a king stripped of its pawns and under fire', () => {
    const fen = '6k1/8/8/8/8/8/5q2/6K1 w - - 0 1';
    const safety = kingSafety(fen, 'w')!;

    expect(safety.shieldPawns).toBe(0);
    expect(safety.attackerCount).toBeGreaterThan(0);
    expect(safety.exposed).toBe(true);
  });

  it('does not call a quiet uncastled king exposed', () => {
    const fen = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
    expect(kingSafety(fen, 'b')!.exposed).toBe(false);
  });
});
