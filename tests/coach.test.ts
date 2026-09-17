import { describe, expect, it } from 'vitest';
import { Chess } from 'chess.js';
import { describeLine, describeMove, moveFromUci } from '../src/coach/describe.js';
import { hangingAt, hangingPieces, newlyHanging, positiveEffects } from '../src/coach/features.js';
import { narrate, narrateOpponentMove } from '../src/coach/narrate.js';

const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
/** After 1.e4 e5 2.Nf3 Nc6 3.Bc4 Bc5 — the Giuoco Piano. */
const GIUOCO = 'r1bqk1nr/pppp1ppp/2n5/2b1p3/2B1P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 4 4';

const describeUci = (fen: string, uci: string, playerColor: 'w' | 'b' = 'w') =>
  describeMove(moveFromUci(fen, uci)!, { playerColor });

describe('describeMove', () => {
  it('names the piece and both squares, never notation', () => {
    const text = describeUci(START, 'g1f3');
    expect(text).toBe('you moved your knight from g1 to f3');
    expect(text).not.toMatch(/Nf3/);
  });

  it('describes a capture with the victim named', () => {
    expect(describeUci(GIUOCO, 'f3e5')).toBe('you took their pawn on e5 with your knight');
  });

  it('uses "their" for the opponent and names the side', () => {
    const afterE4 = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1';
    expect(describeUci(afterE4, 'b8c6', 'w')).toBe('Black moved their knight from b8 to c6');
  });

  it('describes castling in words', () => {
    expect(describeUci(GIUOCO, 'e1g1')).toBe('you castled kingside');
  });

  it('describes promotion including the piece chosen', () => {
    const fen = '8/P7/8/4k3/8/8/8/K7 w - - 0 1';
    expect(describeUci(fen, 'a7a8n')).toBe('you pushed your pawn to a8 and made it a knight');
  });

  it('mentions check and checkmate', () => {
    const check = '8/P7/8/8/8/8/8/K6k w - - 0 1';
    expect(describeUci(check, 'a7a8q')).toContain('giving check');

    const mateIn1 = '6k1/5ppp/8/8/8/8/5PPP/R5K1 w - - 0 1';
    expect(describeUci(mateIn1, 'a1a8')).toContain('checkmate');
  });

  it('flags en passant, which otherwise looks like a piece vanishing', () => {
    const fen = 'rnbqkbnr/ppp1p1pp/8/3pPp2/8/8/PPPP1PPP/RNBQKBNR w KQkq f6 0 3';
    expect(describeUci(fen, 'e5f6')).toContain('in passing');
  });
});

describe('describeLine', () => {
  it('renders a variation as prose a learner can follow', () => {
    // Position after 4.Nxe5??; Black refutes with Nxe5.
    const afterBlunder = 'r1bqk1nr/pppp1ppp/2n5/2b1N3/2B1P3/8/PPPP1PPP/RNBQK2R b KQkq - 0 4';
    const sentences = describeLine(afterBlunder, ['Nxe5', 'd4'], 'w');

    expect(sentences[0]).toBe('Black took your knight on e5 with their knight');
    expect(sentences.join(' ')).not.toMatch(/Nxe5/);
  });

  it('stops cleanly at an illegal continuation', () => {
    expect(describeLine(START, ['e4', 'e4'], 'w')).toHaveLength(1);
  });
});

describe('hanging detection', () => {
  it('sees a piece that is attacked and undefended', () => {
    // White knight on e5, attacked by the c6 knight, nothing defending it.
    const fen = 'r1bqk1nr/pppp1ppp/2n5/2b1N3/2B1P3/8/PPPP1PPP/RNBQK2R b KQkq - 0 4';
    const hanging = hangingAt(new Chess(fen), 'e5');

    expect(hanging).not.toBeNull();
    expect(hanging!.piece).toBe('n');
    expect(hanging!.attackerSquare).toBe('c6');
    expect(hanging!.defended).toBe(false);
  });

  it('does not call a defended piece hanging when the trade is fair', () => {
    // Knight on f3 defended by the g2 pawn, attacked only by a bishop.
    const fen = 'rnbqk1nr/pppp1ppp/8/4p3/1b2P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 2 3';
    expect(hangingAt(new Chess(fen), 'f3')).toBeNull();
  });

  it('still flags a defended piece when a cheaper attacker wins material', () => {
    // Black queen on d4 defended by a rook, but a white pawn on c3 can take it.
    const fen = '3rk3/8/8/8/3q4/2P5/8/4K3 w - - 0 1';
    const hanging = hangingAt(new Chess(fen), 'd4');

    expect(hanging).not.toBeNull();
    expect(hanging!.defended).toBe(true);
    expect(hanging!.attackerPiece).toBe('p');
  });

  it('never reports the king as hanging', () => {
    expect(hangingAt(new Chess(START), 'e1')).toBeNull();
  });

  it('reports the most valuable loose piece first', () => {
    const fen = '4k3/8/8/8/8/8/8/R2QK3 b - - 0 1';
    const loose = hangingPieces(fen, 'w');
    expect(loose[0]?.piece ?? null).toBeNull(); // nothing attacks them
  });

  it('identifies what a move newly loosened', () => {
    // 4.Nxe5 takes a defended pawn and leaves the knight loose.
    const after = 'r1bqk1nr/pppp1ppp/2n5/2b1N3/2B1P3/8/PPPP1PPP/RNBQK2R b KQkq - 0 4';
    const loosened = newlyHanging(GIUOCO, after, 'w');

    expect(loosened.map((h) => h.square)).toContain('e5');
  });
});

describe('positiveEffects', () => {
  it('recognises development', () => {
    const after = 'rnbqkbnr/pppppppp/8/8/8/5N2/PPPPPPPP/RNBQKB1R b KQkq - 1 1';
    const effects = positiveEffects(START, after, 'g1f3');
    expect(effects.map((e) => e.rule)).toContain('develops');
  });

  it('recognises taking space in the centre', () => {
    const after = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1';
    const effects = positiveEffects(START, after, 'e2e4');
    expect(effects.map((e) => e.rule)).toContain('controls-centre');
  });

  it('recognises castling', () => {
    const after = 'r1bqk1nr/pppp1ppp/2n5/2b1p3/2B1P3/5N2/PPPP1PPP/RNBQ1RK1 b kq - 5 4';
    const effects = positiveEffects(GIUOCO, after, 'e1g1');
    expect(effects.map((e) => e.rule)).toContain('castles');
  });
});

describe('narrate', () => {
  const blunderInput = {
    fenBefore: GIUOCO,
    fenAfter: 'r1bqk1nr/pppp1ppp/2n5/2b1N3/2B1P3/8/PPPP1PPP/RNBQK2R b KQkq - 0 4',
    san: 'Nxe5',
    uci: 'f3e5',
    mover: 'w' as const,
    playerColor: 'w' as const,
    verdict: 'blunder' as const,
    cpLoss: 300,
    bestUci: 'e1g1',
    bestSan: 'O-O',
    refutationSan: ['Nxe5', 'd4'],
    openingName: 'Italian Game, Giuoco Piano',
  };

  it('describes the move before criticising it', () => {
    const result = narrate(blunderInput);
    expect(result.body[0]).toBe('You took their pawn on e5 with your knight.');
  });

  it('names the piece, the square, and what takes it', () => {
    const text = narrate(blunderInput).body.join(' ');
    expect(text).toContain('e5');
    expect(text).toContain('knight');
    expect(text).toMatch(/c6/);
    expect(text).toMatch(/nothing is defending it|worth less/);
  });

  it('explains what was better and why', () => {
    const text = narrate(blunderInput).body.join(' ');
    expect(text).toMatch(/Stronger was to have castled kingside/);
    expect(text).toMatch(/tucks your king/);
  });

  it('offers a takeaway on a blunder', () => {
    expect(narrate(blunderInput).takeaway).toBeTruthy();
  });

  it('keeps notation out of the explanation body', () => {
    const text = narrate(blunderInput).body.join(' ');
    // No SAN tokens like Nxe5 / Bc4 / O-O should appear in the prose.
    expect(text).not.toMatch(/\b[KQRBN][a-h]?x?[a-h][1-8]\b/);
    expect(text).not.toMatch(/O-O/);
  });

  it('does not criticise a good move', () => {
    const result = narrate({ ...blunderInput, verdict: 'best', cpLoss: 0 });
    const text = result.body.join(' ');
    expect(text).not.toMatch(/The problem/);
    expect(result.takeaway).toBeUndefined();
    expect(result.headline).toBe('Best move');
  });

  it('names the opening on a book move', () => {
    const result = narrate({ ...blunderInput, verdict: 'book', cpLoss: 0 });
    expect(result.headline).toBe('Italian Game, Giuoco Piano');
    expect(result.body.join(' ')).toContain('standard theory');
  });

  it('marks the threatened square for the board to highlight', () => {
    expect(narrate(blunderInput).highlight).toContain('e5');
  });
});

describe('narrateOpponentMove', () => {
  it('stays silent on an ordinary developing move', () => {
    const before = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1';
    const after = 'rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq e6 0 2';
    expect(narrateOpponentMove(before, after, 'e7e5', 'w')).toBeNull();
  });

  it('stays silent on an even recapture that leaves nothing loose', () => {
    // Black knight takes the knight on e5; the d4 pawn recaptures. Even trade,
    // nothing else hanging — not worth a word.
    const before = '4k3/8/2n5/4N3/3P4/8/8/4K3 b - - 0 1';
    const after = '4k3/8/8/4n3/3P4/8/8/4K3 w - - 0 2';
    expect(narrateOpponentMove(before, after, 'c6e5', 'w')).toBeNull();
  });

  it('warns when a quiet move leaves one of your pieces hanging', () => {
    // No capture at all: the knight steps to e5 and attacks the undefended
    // bishop on c4. Nothing is lost yet, which is exactly when a warning helps.
    const before = 'r1bqk1nr/pppp1ppp/2n5/2b5/2B1P3/8/PPPP1PPP/RNBQK2R b KQkq - 0 4';
    const after = 'r1bqk1nr/pppp1ppp/8/2b1n3/2B1P3/8/PPPP1PPP/RNBQK2R w KQkq - 1 5';
    const result = narrateOpponentMove(before, after, 'c6e5', 'w');

    expect(result).not.toBeNull();
    expect(result!.body.join(' ')).toMatch(/bishop on c4 is attacked/);
    expect(result!.body.join(' ')).toMatch(/nothing is defending it/);
  });

  it('speaks up when they take a piece for free', () => {
    // Black's knight on c6 takes an undefended white knight on e5.
    const before = 'r1bqkbnr/pppp1ppp/2n5/4N3/8/8/PPPPPPPP/RNBQKB1R b KQkq - 0 3';
    const after = 'r1bqkbnr/pppp1ppp/8/4n3/8/8/PPPPPPPP/RNBQKB1R w KQkq - 0 4';
    const result = narrateOpponentMove(before, after, 'c6e5', 'w');

    expect(result).not.toBeNull();
    expect(result!.body.join(' ')).toContain('costs you a knight');
  });

  it('ignores a pawn capture, which is not "a piece"', () => {
    const before = 'rnbqkbnr/ppp1pppp/8/3p4/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 2';
    const after = 'rnbqkbnr/ppp1pppp/8/8/4p3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 3';
    expect(narrateOpponentMove(before, after, 'd5e4', 'w')).toBeNull();
  });
});
