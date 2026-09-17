/**
 * Turning a move into a sentence.
 *
 * "Nxe5" tells a beginner nothing. "You took Black's pawn on e5 with your
 * knight" tells them exactly what happened. This module is the difference
 * between notation and explanation.
 */
import { Chess, type Move, type Square } from 'chess.js';
import type { Color } from 'chess.js';
import { PIECE_NAME, possessive, sideName } from './pieces.js';

/** Replays a SAN move on a scratch board to recover the full Move object. */
export function moveFromSan(fen: string, san: string): Move | null {
  try {
    return new Chess(fen).move(san);
  } catch {
    return null;
  }
}

export function moveFromUci(fen: string, uci: string): Move | null {
  const from = uci.slice(0, 2);
  const to = uci.slice(2, 4);
  const promotion = uci.length > 4 ? uci.slice(4, 5) : undefined;
  try {
    return new Chess(fen).move(promotion ? { from, to, promotion } : { from, to });
  } catch {
    return null;
  }
}

export interface DescribeOptions {
  /** Whose eyes we're writing for — decides "your" versus "their". */
  playerColor: Color;
  /** Start the sentence with a subject ("You", "Black"). */
  subject?: boolean;
  /**
   * Write the move as an instruction rather than a report: "take their pawn on
   * e5" instead of "took their pawn on e5".
   *
   * The hint needs this. Telling someone what they *did* is the wrong mood
   * entirely for a move they have not played yet, and paraphrasing the past
   * tense back into an instruction at the call site would mean a second copy of
   * every sentence shape in here.
   */
  imperative?: boolean;
}

/**
 * A full sentence describing the move.
 *
 * Examples:
 *   "You moved your knight to f3"
 *   "You took Black's pawn on e5 with your knight"
 *   "Black castled kingside"
 *   "You promoted your pawn on a8 to a knight, giving check"
 */
export function describeMove(move: Move, options: DescribeOptions): string {
  const { playerColor } = options;
  const isPlayer = move.color === playerColor;
  const actor = options.subject === false ? '' : isPlayer ? 'you ' : `${sideName(move.color)} `;
  const mine = possessive(move.color, playerColor);

  /** Picks the verb form. Only the verbs change between the two moods. */
  const verb = (past: string, instruction: string) => (options.imperative ? instruction : past);

  let core: string;

  if (move.san === 'O-O') {
    core = `${verb('castled', 'castle')} kingside`;
  } else if (move.san === 'O-O-O') {
    core = `${verb('castled', 'castle')} queenside`;
  } else if (move.promotion) {
    core =
      `${verb('pushed', 'push')} ${mine} pawn to ${move.to} and ` +
      `${verb('made', 'make')} it a ${PIECE_NAME[move.promotion]}`;
  } else if (move.captured) {
    const victimOwner: Color = move.color === 'w' ? 'b' : 'w';
    const victim = `${possessive(victimOwner, playerColor)} ${PIECE_NAME[move.captured]}`;
    const enPassant = move.flags.includes('e') ? ' in passing' : '';
    core = `${verb('took', 'take')} ${victim} on ${move.to}${enPassant} with ${mine} ${PIECE_NAME[move.piece]}`;
  } else {
    core = `${verb('moved', 'move')} ${mine} ${PIECE_NAME[move.piece]} from ${move.from} to ${move.to}`;
  }

  const check = move.san.includes('#')
    ? ', which is checkmate'
    : move.san.includes('+')
      ? ', giving check'
      : '';

  return `${actor}${core}${check}`;
}

/**
 * A compact reference to the piece a move brings somewhere, for follow-up
 * sentences: "your knight on f3".
 */
export function describeMovedPiece(move: Move, playerColor: Color): string {
  return `${possessive(move.color, playerColor)} ${PIECE_NAME[move.piece]} on ${move.to}`;
}

/**
 * Renders an engine variation as prose.
 *
 * Rather than "Bxf7+ Ke7 Qxd8", this produces "Black takes your bishop on f7
 * with their knight, you move your king to e7, and then Black takes your
 * queen on d8" — a line a learner can actually follow.
 *
 * Returns an empty array if the line can't be replayed.
 */
export function describeLine(
  fen: string,
  sanMoves: readonly string[],
  playerColor: Color,
  maxPlies = 3,
): string[] {
  const board = new Chess(fen);
  const sentences: string[] = [];

  for (const san of sanMoves.slice(0, maxPlies)) {
    let move: Move;
    try {
      move = board.move(san);
    } catch {
      break;
    }
    sentences.push(describeMove(move, { playerColor }));
  }

  return sentences;
}

/** Squares a variation touches, for the LLM allowlist in Milestone 3. */
export function lineSquares(fen: string, sanMoves: readonly string[]): Square[] {
  const board = new Chess(fen);
  const squares: Square[] = [];

  for (const san of sanMoves) {
    try {
      const move = board.move(san);
      squares.push(move.from, move.to);
    } catch {
      break;
    }
  }

  return squares;
}
