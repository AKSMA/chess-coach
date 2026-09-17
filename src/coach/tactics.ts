/**
 * Tactical motifs — forks, pins, discovered attacks, trapped pieces.
 *
 * These are where beginners actually lose games, so they are what the coach
 * most needs to be able to name. Everything here is a pure function over a
 * position, and every finding carries a stable rule id, because the history
 * layer aggregates on those ids.
 *
 * Detection is geometric rather than search-based: we ask "what lines exist",
 * not "what does the engine think". The engine already supplies the verdict;
 * this supplies the vocabulary to explain it.
 */
import { Chess, type Color, type PieceSymbol, type Square } from 'chess.js';
import { PIECE_VALUE } from './pieces.js';

/** A real piece, as players use the word — not a pawn. */
const PIECE_THRESHOLD = 3;

type Offset = readonly [number, number];

const ROOK_DIRS: Offset[] = [
  [0, 1],
  [0, -1],
  [1, 0],
  [-1, 0],
];
const BISHOP_DIRS: Offset[] = [
  [1, 1],
  [1, -1],
  [-1, 1],
  [-1, -1],
];

function fileOf(square: Square): number {
  return square.charCodeAt(0) - 97;
}

function rankOf(square: Square): number {
  return Number(square[1]) - 1;
}

function toSquare(file: number, rank: number): Square | null {
  if (file < 0 || file > 7 || rank < 0 || rank > 7) return null;
  return `${String.fromCharCode(97 + file)}${rank + 1}` as Square;
}

/** Directions a sliding piece travels, or null if it isn't a slider. */
function sliderDirections(piece: PieceSymbol): Offset[] | null {
  if (piece === 'r') return ROOK_DIRS;
  if (piece === 'b') return BISHOP_DIRS;
  if (piece === 'q') return [...ROOK_DIRS, ...BISHOP_DIRS];
  return null;
}

/** Every occupied square along a ray, in order, until the board edge. */
function scanRay(board: Chess, from: Square, [df, dr]: Offset): Square[] {
  const found: Square[] = [];
  let file = fileOf(from) + df;
  let rank = rankOf(from) + dr;

  while (true) {
    const square = toSquare(file, rank);
    if (!square) break;
    if (board.get(square)) found.push(square);
    file += df;
    rank += dr;
  }

  return found;
}

/** All squares occupied by `color`, with their piece types. */
export function piecesOf(board: Chess, color: Color): { square: Square; type: PieceSymbol }[] {
  const found: { square: Square; type: PieceSymbol }[] = [];
  for (const row of board.board()) {
    for (const entry of row) {
      if (entry && entry.color === color) found.push({ square: entry.square, type: entry.type });
    }
  }
  return found;
}

export function kingSquareOf(board: Chess, color: Color): Square | null {
  return piecesOf(board, color).find((p) => p.type === 'k')?.square ?? null;
}

// ---------------------------------------------------------------------------
// Forks
// ---------------------------------------------------------------------------

export interface Fork {
  /** Where the forking piece stands. */
  square: Square;
  piece: PieceSymbol;
  /** The valuable things it hits at once. */
  targets: { square: Square; piece: PieceSymbol }[];
}

/**
 * A single piece of `byColor` attacking two or more valuable enemy pieces.
 *
 * "Valuable" means a real piece or the king — a knight hitting two pawns is
 * not the thing that loses games, and calling it a fork would train the wrong
 * instinct.
 */
export function findForks(fen: string, byColor: Color): Fork[] {
  const board = new Chess(fen);
  const enemy: Color = byColor === 'w' ? 'b' : 'w';
  const enemies = piecesOf(board, enemy);
  const forks: Fork[] = [];

  for (const attacker of piecesOf(board, byColor)) {
    const targets = enemies.filter(
      (target) =>
        (target.type === 'k' || PIECE_VALUE[target.type] >= PIECE_THRESHOLD) &&
        board.attackers(target.square, byColor).includes(attacker.square),
    );

    // A fork only counts if the forking piece is worth less than what it hits,
    // or hits the king — a queen "forking" two knights is just an attack.
    const worthwhile = targets.filter(
      (t) => t.type === 'k' || PIECE_VALUE[t.type] >= PIECE_VALUE[attacker.type],
    );

    if (targets.length >= 2 && worthwhile.length >= 1) {
      forks.push({
        square: attacker.square,
        piece: attacker.type,
        targets: targets.map((t) => ({ square: t.square, piece: t.type })),
      });
    }
  }

  return forks;
}

// ---------------------------------------------------------------------------
// Pins and skewers
// ---------------------------------------------------------------------------

export interface Pin {
  /** The piece that cannot move freely. */
  square: Square;
  piece: PieceSymbol;
  /** The slider doing the pinning. */
  bySquare: Square;
  byPiece: PieceSymbol;
  /** What sits behind it, and is therefore protected by the pin. */
  behindSquare: Square;
  behindPiece: PieceSymbol;
  /** A pin against the king is absolute: the piece legally cannot move. */
  absolute: boolean;
}

/**
 * Pieces of `color` that are pinned by an enemy slider.
 *
 * Walks each enemy slider's rays: the first piece found is the candidate, and
 * if the next piece along the same ray is more valuable, the candidate is
 * pinned to it.
 */
export function findPins(fen: string, color: Color): Pin[] {
  const board = new Chess(fen);
  const enemy: Color = color === 'w' ? 'b' : 'w';
  const pins: Pin[] = [];

  for (const slider of piecesOf(board, enemy)) {
    const directions = sliderDirections(slider.type);
    if (!directions) continue;

    for (const direction of directions) {
      const ray = scanRay(board, slider.square, direction);
      const front = ray[0];
      const behind = ray[1];
      if (!front || !behind) continue;

      const frontPiece = board.get(front);
      const behindPiece = board.get(behind);
      if (!frontPiece || !behindPiece) continue;
      if (frontPiece.color !== color || behindPiece.color !== color) continue;

      const absolute = behindPiece.type === 'k';
      const worthMore = PIECE_VALUE[behindPiece.type] > PIECE_VALUE[frontPiece.type];
      if (!absolute && !worthMore) continue;

      pins.push({
        square: front,
        piece: frontPiece.type,
        bySquare: slider.square,
        byPiece: slider.type,
        behindSquare: behind,
        behindPiece: behindPiece.type,
        absolute,
      });
    }
  }

  return pins;
}

// ---------------------------------------------------------------------------
// Discovered attacks
// ---------------------------------------------------------------------------

export interface DiscoveredAttack {
  /** The slider whose line was opened. */
  fromSquare: Square;
  fromPiece: PieceSymbol;
  targetSquare: Square;
  targetPiece: PieceSymbol;
}

/**
 * Lines opened by vacating a square.
 *
 * Compares what each of the mover's sliders attacks before and after: anything
 * newly hit through the square that was just left is a discovery.
 */
export function findDiscoveredAttacks(
  fenBefore: string,
  fenAfter: string,
  byColor: Color,
  vacated: Square,
): DiscoveredAttack[] {
  const before = new Chess(fenBefore);
  const after = new Chess(fenAfter);
  const enemy: Color = byColor === 'w' ? 'b' : 'w';
  const discoveries: DiscoveredAttack[] = [];

  for (const target of piecesOf(after, enemy)) {
    if (target.type !== 'k' && PIECE_VALUE[target.type] < PIECE_THRESHOLD) continue;

    const attackersAfter = after.attackers(target.square, byColor);
    const attackersBefore = before.attackers(target.square, byColor);

    for (const attacker of attackersAfter) {
      // The piece that moved is doing an ordinary attack, not a discovery.
      if (attacker === vacated) continue;
      if (attackersBefore.includes(attacker)) continue;

      const piece = after.get(attacker);
      if (!piece || !sliderDirections(piece.type)) continue;

      discoveries.push({
        fromSquare: attacker,
        fromPiece: piece.type,
        targetSquare: target.square,
        targetPiece: target.type,
      });
    }
  }

  return discoveries;
}

// ---------------------------------------------------------------------------
// Trapped pieces
// ---------------------------------------------------------------------------

export interface TrappedPiece {
  square: Square;
  piece: PieceSymbol;
}

/**
 * Pieces of `color` that are attacked and have nowhere safe to go.
 *
 * Only checked for real pieces: a trapped pawn is rarely the lesson, and the
 * king has its own rules.
 */
export function findTrappedPieces(fen: string, color: Color): TrappedPiece[] {
  const board = new Chess(fen);
  const enemy: Color = color === 'w' ? 'b' : 'w';
  const trapped: TrappedPiece[] = [];

  // Legal moves are only available for the side to move, so a scratch board
  // with the turn forced is needed to ask "where could this piece go".
  const scratch = forceTurn(fen, color);
  if (!scratch) return trapped;

  for (const piece of piecesOf(board, color)) {
    if (piece.type === 'k' || piece.type === 'p') continue;
    if (PIECE_VALUE[piece.type] < PIECE_THRESHOLD) continue;
    if (board.attackers(piece.square, enemy).length === 0) continue;

    const moves = scratch.moves({ square: piece.square, verbose: true });
    if (moves.length === 0) {
      trapped.push({ square: piece.square, piece: piece.type });
      continue;
    }

    const hasSafeSquare = moves.some((move) => {
      const next = new Chess(scratch.fen());
      try {
        next.move({ from: move.from, to: move.to });
      } catch {
        return false;
      }
      const attackedBy = next.attackers(move.to, enemy);
      if (attackedBy.length === 0) return true;
      // Defended and only attacked by something at least as valuable is fine.
      const cheapest = Math.min(...attackedBy.map((sq) => PIECE_VALUE[next.get(sq)?.type ?? 'p']));
      return cheapest >= PIECE_VALUE[piece.type] && next.attackers(move.to, color).length > 0;
    });

    if (!hasSafeSquare) trapped.push({ square: piece.square, piece: piece.type });
  }

  return trapped;
}

/** A copy of the position with `color` to move, or null if that is illegal. */
function forceTurn(fen: string, color: Color): Chess | null {
  const parts = fen.split(' ');
  if (parts[1] === color) return new Chess(fen);

  parts[1] = color;
  // Side-to-move changes invalidate the en-passant square.
  parts[3] = '-';
  try {
    return new Chess(parts.join(' '));
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// King safety
// ---------------------------------------------------------------------------

export interface KingSafety {
  square: Square;
  /** Enemy pieces bearing down on the king's immediate surroundings. */
  attackerCount: number;
  /** Friendly pawns still standing directly in front of the king. */
  shieldPawns: number;
  castled: boolean;
  exposed: boolean;
}

export function kingSafety(fen: string, color: Color): KingSafety | null {
  const board = new Chess(fen);
  const square = kingSquareOf(board, color);
  if (!square) return null;

  const enemy: Color = color === 'w' ? 'b' : 'w';
  const file = fileOf(square);
  const rank = rankOf(square);
  const forward = color === 'w' ? 1 : -1;

  let attackerCount = board.attackers(square, enemy).length;
  for (let df = -1; df <= 1; df++) {
    for (let dr = -1; dr <= 1; dr++) {
      if (df === 0 && dr === 0) continue;
      const neighbour = toSquare(file + df, rank + dr);
      if (neighbour) attackerCount += board.attackers(neighbour, enemy).length;
    }
  }

  let shieldPawns = 0;
  for (let df = -1; df <= 1; df++) {
    const ahead = toSquare(file + df, rank + forward);
    const piece = ahead ? board.get(ahead) : undefined;
    if (piece && piece.type === 'p' && piece.color === color) shieldPawns++;
  }

  // A king on the g- or c-file back rank has almost certainly castled.
  const homeRank = color === 'w' ? 0 : 7;
  const castled = rank === homeRank && (file === 6 || file === 2);

  return {
    square,
    attackerCount,
    shieldPawns,
    castled,
    exposed: attackerCount > 0 && shieldPawns < 2,
  };
}
