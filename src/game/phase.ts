/**
 * Game phase, defined once.
 *
 * The profile reports "your average loss per phase", so this needs a single
 * rule rather than a per-call-site guess — otherwise "you're weak in the
 * endgame" is a statement about an undefined term.
 */
import { Chess } from 'chess.js';

export type Phase = 'opening' | 'middlegame' | 'endgame';

/** Non-pawn, non-king material at or below this means the endgame has started. */
const ENDGAME_PIECE_COUNT = 6;
/** Ply after which we stop calling it the opening regardless of development. */
const OPENING_MAX_PLY = 20;

export function phaseOf(fen: string): Phase {
  const board = new Chess(fen);
  let heavyAndMinor = 0;
  let queens = 0;
  let developedMinors = 0;

  for (const row of board.board()) {
    for (const square of row) {
      if (!square) continue;
      if (square.type === 'q') queens++;
      if (square.type !== 'p' && square.type !== 'k') heavyAndMinor++;
    }
  }

  // Endgame: few pieces left, or the queens came off.
  if (heavyAndMinor <= ENDGAME_PIECE_COUNT || queens === 0) return 'endgame';

  const ply = plyOf(fen);
  if (ply >= OPENING_MAX_PLY) return 'middlegame';

  // Still early — it's the opening until the minor pieces have come out.
  developedMinors = countDevelopedMinors(board);
  return developedMinors >= 6 ? 'middlegame' : 'opening';
}

/** Half-moves played, derived from the FEN's move number and side to move. */
export function plyOf(fen: string): number {
  const parts = fen.split(' ');
  const sideToMove = parts[1] ?? 'w';
  const fullmove = Number(parts[5] ?? '1') || 1;
  return (fullmove - 1) * 2 + (sideToMove === 'b' ? 1 : 0);
}

const HOME_SQUARES: Record<'w' | 'b', string[]> = {
  w: ['b1', 'c1', 'f1', 'g1'],
  b: ['b8', 'c8', 'f8', 'g8'],
};

/** Minor pieces no longer sitting on their starting squares, both sides. */
function countDevelopedMinors(board: Chess): number {
  let developed = 0;
  for (const color of ['w', 'b'] as const) {
    for (const square of HOME_SQUARES[color]) {
      const piece = board.get(square as Parameters<Chess['get']>[0]);
      const isHomeMinor = piece && piece.color === color && (piece.type === 'n' || piece.type === 'b');
      if (!isHomeMinor) developed++;
    }
  }
  return developed;
}
