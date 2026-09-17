import { describe, expect, it } from 'vitest';
import { buildHint, hintUnavailableReason } from '../src/coach/hint.js';
import { describeMove, moveFromUci } from '../src/coach/describe.js';
import {
  DEFAULT_HINT_ALLOWANCE,
  hintButtonLabel,
  hintsRemaining,
  normaliseAllowance,
  UNLIMITED,
} from '../src/game/hints.js';

/** 1. e4 e5 2. Nf3 Nc6 3. Bc4 Bc5 — White to move, castling available. */
const ITALIAN = 'r1bqk1nr/pppp1ppp/2n5/2b1p3/2B1P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 4 4';
/** 1. e4 e5 2. Nf3 Nf6 3. Nxe5 Nxe4 — White to move, the black knight on e4 is loose. */
const LOOSE_KNIGHT = 'rnbqkb1r/pppp1ppp/8/4N3/4n3/8/PPPP1PPP/RNBQKB1R w KQkq - 0 4';
/** A black knight on e4, attacked by the d3 pawn and defended by nothing. */
const LOOSE_PIECE = '4k3/8/8/8/4n3/3P4/PP4PP/6K1 w - - 0 1';
/** ... 4... Bxf2+ — White is in check. */
const IN_CHECK = 'r1bqk1nr/pppp1ppp/2n5/4p3/2B1P3/2N2N2/PPPP1bPP/R1BQK2R w KQkq - 0 5';

describe('the nudge — points, without giving it away', () => {
  it('names the piece and the square it stands on', () => {
    const hint = buildHint({ fen: ITALIAN, bestUci: 'e1g1', playerColor: 'w', stage: 'nudge' })!;
    expect(hint.body.join(' ')).toMatch(/your king on e1/);
    expect(hint.highlight).toEqual(['e1']);
  });

  /*
   * The load-bearing property of the whole two-stage design. If the nudge
   * mentions g1, or draws an arrow to it, there is nothing left to look for and
   * the second stage is decoration.
   */
  it('never names the destination square or draws the arrow', () => {
    const hint = buildHint({ fen: ITALIAN, bestUci: 'e1g1', playerColor: 'w', stage: 'nudge' })!;
    expect(hint.body.join(' ')).not.toMatch(/\bg1\b/);
    expect(hint.arrow).toBeNull();
  });

  it('says what the move would achieve', () => {
    const hint = buildHint({ fen: ITALIAN, bestUci: 'e1g1', playerColor: 'w', stage: 'nudge' })!;
    expect(hint.body.join(' ')).toMatch(/tucks your king safely into the corner/);
  });

  it('leads with the check when the king is in check', () => {
    const hint = buildHint({ fen: IN_CHECK, bestUci: 'e1f2', playerColor: 'w', stage: 'nudge' })!;
    expect(hint.body[0]).toMatch(/in check/);
  });

  it('points at the loose piece when the move itself has no story', () => {
    // A quiet pawn push while a black knight stands attacked and undefended:
    // the fallback should name the thing actually worth looking at.
    const hint = buildHint({ fen: LOOSE_PIECE, bestUci: 'a2a3', playerColor: 'w', stage: 'nudge' })!;
    expect(hint.body.join(' ')).toMatch(/knight on e4 is the loose piece/);
  });

  it('claims nothing when there is nothing to claim', () => {
    // No tactic and nothing hanging. Inventing fireworks here would send a
    // beginner hunting for a combination that does not exist.
    const hint = buildHint({ fen: LOOSE_KNIGHT, bestUci: 'h1g1', playerColor: 'w', stage: 'nudge' })!;
    expect(hint.body.join(' ')).toMatch(/nothing flashy/);
  });

  it('keeps the "ask again" line out of the spoken version', () => {
    const hint = buildHint({ fen: ITALIAN, bestUci: 'e1g1', playerColor: 'w', stage: 'nudge' })!;
    expect(hint.body.at(-1)).toMatch(/Ask again/);
    expect(hint.speech.join(' ')).not.toMatch(/Ask again/);
  });
});

describe('the reveal — the move, spelled out', () => {
  it('gives the move as an instruction, not as a report', () => {
    const hint = buildHint({ fen: ITALIAN, bestUci: 'e1g1', playerColor: 'w', stage: 'reveal' })!;
    expect(hint.body[0]).toBe('Castle kingside.');
    expect(hint.arrow).toEqual({ from: 'e1', to: 'g1' });
  });

  it('names the capture in the player’s own terms', () => {
    const hint = buildHint({ fen: LOOSE_KNIGHT, bestUci: 'f1e2', playerColor: 'w', stage: 'reveal' })!;
    expect(hint.body[0]).toMatch(/^Move your bishop from f1 to e2/);
  });

  it('gives the reason alongside the move', () => {
    const hint = buildHint({ fen: LOOSE_KNIGHT, bestUci: 'd2d3', playerColor: 'w', stage: 'reveal' })!;
    expect(hint.body.join(' ')).toMatch(/attacks their knight on e4/);
  });

  it('returns null rather than inventing a move it cannot replay', () => {
    expect(buildHint({ fen: ITALIAN, bestUci: 'a1a8', playerColor: 'w', stage: 'reveal' })).toBeNull();
  });
});

describe('imperative descriptions', () => {
  const imperative = (fen: string, uci: string) =>
    describeMove(moveFromUci(fen, uci)!, { playerColor: 'w', subject: false, imperative: true });

  it('turns a capture into an instruction', () => {
    expect(imperative(LOOSE_KNIGHT, 'd1e2')).toBe('move your queen from d1 to e2');
    expect(imperative(LOOSE_KNIGHT, 'd2d3')).toBe('move your pawn from d2 to d3');
  });

  it('handles castling and promotion', () => {
    expect(imperative(ITALIAN, 'e1g1')).toBe('castle kingside');
    expect(imperative('8/P7/8/8/8/8/8/K6k w - - 0 1', 'a7a8n')).toBe(
      'push your pawn to a8 and make it a knight',
    );
  });

  it('still reports in the past tense by default', () => {
    expect(describeMove(moveFromUci(ITALIAN, 'e1g1')!, { playerColor: 'w', subject: false })).toBe(
      'castled kingside',
    );
  });
});

describe('the hint budget', () => {
  it('counts down and stops at zero', () => {
    expect(hintsRemaining(3, 0)).toBe(3);
    expect(hintsRemaining(3, 3)).toBe(0);
  });

  /*
   * Lowering the allowance mid-game after spending more than the new limit
   * must leave you with none, not a negative count that formats as "-2 left".
   */
  it('never goes negative when the allowance is lowered mid-game', () => {
    expect(hintsRemaining(1, 3)).toBe(0);
    expect(hintButtonLabel(1, 3)).toBe('No hints left');
  });

  it('treats unlimited as unlimited', () => {
    expect(hintsRemaining(UNLIMITED, 40)).toBe(Infinity);
    expect(hintButtonLabel(UNLIMITED, 40)).toBe('Hint');
  });

  it('labels the button with what is left', () => {
    expect(hintButtonLabel(3, 1)).toBe('Hint (2)');
    expect(hintButtonLabel(0, 0)).toBe('Hints off');
  });

  it('falls back to the default for an allowance that is not on offer', () => {
    expect(normaliseAllowance(7)).toBe(DEFAULT_HINT_ALLOWANCE);
    expect(normaliseAllowance(NaN)).toBe(DEFAULT_HINT_ALLOWANCE);
    expect(normaliseAllowance(UNLIMITED)).toBe(UNLIMITED);
  });
});

describe('when a hint cannot be given', () => {
  it('is silent when everything is fine', () => {
    expect(hintUnavailableReason({ gameOver: false, playersTurn: true, remaining: 1 })).toBeNull();
  });

  it('explains each refusal in plain language', () => {
    expect(hintUnavailableReason({ gameOver: true, playersTurn: true, remaining: 3 })).toMatch(
      /game is over/,
    );
    expect(hintUnavailableReason({ gameOver: false, playersTurn: false, remaining: 3 })).toMatch(
      /Wait for your turn/,
    );
    expect(hintUnavailableReason({ gameOver: false, playersTurn: true, remaining: 0 })).toMatch(
      /used all your hints/,
    );
  });
});
