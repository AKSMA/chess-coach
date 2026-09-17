/**
 * The hint — for when you are stuck.
 *
 * Deliberately two-staged. Handing over the engine's move the instant someone
 * asks answers the position but teaches nothing: the player never has to look
 * for anything. So the first stage points at the piece and says what its move
 * achieves, and only the second stage names the move itself.
 *
 * Both stages cost one hint between them — the reveal is the same hint,
 * escalated. Charging for it would push people to spend two hints just to be
 * sure, which is the opposite of what the budget is for.
 *
 * Everything here is derived from the analysis the app already ran for the
 * warning check, so a hint costs no extra engine time.
 */
import { Chess, type Color, type Move, type PieceSymbol } from 'chess.js';
import { describeMove, moveFromUci } from './describe.js';
import { bestFreeCapture, pieceWord, positiveEffects } from './features.js';
import { capitalise, joinWords, PIECE_NAME } from './pieces.js';

/** `nudge` points at the piece; `reveal` names the move. */
export type HintStage = 'nudge' | 'reveal';

export interface HintInput {
  /** The position the player is stuck in. */
  fen: string;
  /** The engine's preferred move from that position. */
  bestUci: string;
  playerColor: Color;
  stage: HintStage;
}

export interface Hint {
  headline: string;
  body: string[];
  /** The spoken version — shorter, as everywhere else in the coach. */
  speech: string[];
  /**
   * The square to ring. A nudge highlights the piece to look at and nothing
   * else: lighting the destination as well would give the move away and make
   * the second stage pointless.
   */
  highlight: string[];
  /** The arrow. Reveal only, for the same reason. */
  arrow: { from: string; to: string } | null;
}

export function buildHint({ fen, bestUci, playerColor, stage }: HintInput): Hint | null {
  const move = moveFromUci(fen, bestUci);
  if (!move) return null;

  const board = new Chess(fen);
  const inCheck = board.inCheck();

  // The position after the suggested move, so the reasons come from the same
  // detectors the narrator uses rather than a second, drifting description.
  const scratch = new Chess(fen);
  try {
    scratch.move({
      from: move.from,
      to: move.to,
      ...(move.promotion ? { promotion: move.promotion } : {}),
    });
  } catch {
    return null;
  }

  const reasons = positiveEffects(fen, scratch.fen(), bestUci)
    .slice(0, 2)
    .map((effect) => effect.phrase);

  return stage === 'nudge'
    ? nudge(fen, move.piece, move.from, inCheck, reasons)
    : reveal(move, playerColor, reasons);
}

/** Stage one: where to look, and what there is to find. */
function nudge(
  fen: string,
  piece: PieceSymbol,
  from: string,
  inCheck: boolean,
  reasons: string[],
): Hint {
  const subject = `your ${PIECE_NAME[piece]} on ${from}`;
  const body: string[] = [];

  if (inCheck) {
    body.push('Your king is in check, so the only legal moves are the ones that answer it.');
  }

  body.push(`Have a look at ${subject}.`);

  if (reasons.length > 0) {
    body.push(`It has a move that ${joinWords(reasons)}.`);
  } else {
    // No tactic to point at. Say what is actually available rather than
    // implying fireworks that are not there.
    const loose = bestFreeCapture(fen);
    body.push(
      loose
        ? `Their ${pieceWord(loose.piece)} on ${loose.square} is the loose piece worth looking at.`
        : 'There is nothing flashy here — the strongest move just improves that piece quietly.',
    );
  }

  body.push('Ask again if you would like the move itself; it costs you nothing more.');

  return {
    headline: 'Hint',
    body,
    // The last line is a UI instruction, not coaching. Reading it aloud every
    // time turns the hint into an advert for itself.
    speech: body.slice(0, -1),
    highlight: [from],
    arrow: null,
  };
}

/** Stage two: the move, spelled out. */
function reveal(
  move: Move,
  playerColor: Color,
  reasons: string[],
): Hint {
  const instruction = `${capitalise(describeMove(move, { playerColor, subject: false, imperative: true }))}.`;
  const body = [instruction];

  if (reasons.length > 0) body.push(`That ${joinWords(reasons)}.`);

  return {
    headline: 'The move',
    body,
    speech: body,
    highlight: [],
    arrow: { from: move.from, to: move.to },
  };
}

/**
 * A one-line reason a hint is unavailable, or null when one can be given.
 *
 * Kept beside the hint itself so the button and the coach panel cannot drift
 * into disagreeing about whether a hint is possible.
 */
export function hintUnavailableReason(options: {
  gameOver: boolean;
  playersTurn: boolean;
  remaining: number;
}): string | null {
  if (options.gameOver) return 'The game is over — start a new one for a fresh set of hints.';
  if (!options.playersTurn) return 'Wait for your turn, then I can point you at something.';
  if (options.remaining <= 0) {
    return 'You have used all your hints for this game. You can change the allowance below.';
  }
  return null;
}
