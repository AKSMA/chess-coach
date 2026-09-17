/**
 * A small opening book, used to name positions ("This is the Italian Game")
 * and to suppress criticism of moves that are simply theory.
 *
 * Two implementation notes:
 *
 * - Openings are written as move sequences and the FEN keys are derived at load
 *   time. Hand-writing 40 FENs is a reliable way to introduce typos that fail
 *   silently as "no opening matched".
 * - The key is the **first four FEN fields only**. The halfmove clock and
 *   fullmove number differ between transpositions into the same position, so
 *   matching on a full FEN essentially never hits.
 */
import { Chess } from 'chess.js';

/** Positions in the book at or before this ply count as "book moves". */
export const BOOK_MAX_PLY = 16;

interface OpeningDef {
  name: string;
  /** SAN moves, space-separated. */
  moves: string;
}

const OPENINGS: OpeningDef[] = [
  { name: 'Italian Game', moves: 'e4 e5 Nf3 Nc6 Bc4' },
  { name: 'Italian Game, Giuoco Piano', moves: 'e4 e5 Nf3 Nc6 Bc4 Bc5' },
  { name: 'Two Knights Defence', moves: 'e4 e5 Nf3 Nc6 Bc4 Nf6' },
  { name: 'Ruy Lopez', moves: 'e4 e5 Nf3 Nc6 Bb5' },
  { name: 'Ruy Lopez, Morphy Defence', moves: 'e4 e5 Nf3 Nc6 Bb5 a6' },
  { name: 'Ruy Lopez, Berlin Defence', moves: 'e4 e5 Nf3 Nc6 Bb5 Nf6' },
  { name: 'Scotch Game', moves: 'e4 e5 Nf3 Nc6 d4' },
  { name: "King's Gambit", moves: 'e4 e5 f4' },
  { name: 'Vienna Game', moves: 'e4 e5 Nc3' },
  { name: 'Petrov Defence', moves: 'e4 e5 Nf3 Nf6' },
  { name: 'Philidor Defence', moves: 'e4 e5 Nf3 d6' },
  { name: "King's Pawn Game", moves: 'e4 e5' },
  { name: 'Sicilian Defence', moves: 'e4 c5' },
  { name: 'Sicilian Defence, Open', moves: 'e4 c5 Nf3 d6 d4 cxd4 Nxd4' },
  { name: 'Sicilian Defence, Najdorf', moves: 'e4 c5 Nf3 d6 d4 cxd4 Nxd4 Nf6 Nc3 a6' },
  { name: 'Sicilian Defence, Dragon', moves: 'e4 c5 Nf3 d6 d4 cxd4 Nxd4 Nf6 Nc3 g6' },
  { name: 'Sicilian Defence, Closed', moves: 'e4 c5 Nc3' },
  { name: 'French Defence', moves: 'e4 e6' },
  { name: 'French Defence, Advance', moves: 'e4 e6 d4 d5 e5' },
  { name: 'French Defence, Exchange', moves: 'e4 e6 d4 d5 exd5' },
  { name: 'Caro-Kann Defence', moves: 'e4 c6' },
  { name: 'Caro-Kann, Advance', moves: 'e4 c6 d4 d5 e5' },
  { name: 'Scandinavian Defence', moves: 'e4 d5' },
  { name: 'Pirc Defence', moves: 'e4 d6 d4 Nf6 Nc3' },
  { name: 'Modern Defence', moves: 'e4 g6' },
  { name: 'Alekhine Defence', moves: 'e4 Nf6' },
  { name: "Queen's Gambit", moves: 'd4 d5 c4' },
  { name: "Queen's Gambit Declined", moves: 'd4 d5 c4 e6' },
  { name: "Queen's Gambit Accepted", moves: 'd4 d5 c4 dxc4' },
  { name: 'Slav Defence', moves: 'd4 d5 c4 c6' },
  { name: 'London System', moves: 'd4 d5 Nf3 Nf6 Bf4' },
  { name: 'Indian Defence', moves: 'd4 Nf6' },
  { name: "King's Indian Defence", moves: 'd4 Nf6 c4 g6 Nc3 Bg7' },
  { name: 'Nimzo-Indian Defence', moves: 'd4 Nf6 c4 e6 Nc3 Bb4' },
  { name: "Queen's Indian Defence", moves: 'd4 Nf6 c4 e6 Nf3 b6' },
  { name: 'Grünfeld Defence', moves: 'd4 Nf6 c4 g6 Nc3 d5' },
  { name: 'Benoni Defence', moves: 'd4 Nf6 c4 c5' },
  { name: 'Dutch Defence', moves: 'd4 f5' },
  { name: 'English Opening', moves: 'c4' },
  { name: 'Réti Opening', moves: 'Nf3 d5 c4' },
  { name: 'Bird Opening', moves: 'f4' },
  { name: "King's Knight Opening", moves: 'e4 e5 Nf3' },
];

/**
 * Position key: piece placement, side to move, castling rights, en passant.
 * Deliberately excludes the two counters.
 */
export function positionKey(fen: string): string {
  return fen.split(' ').slice(0, 4).join(' ');
}

const BOOK: Map<string, string> = buildBook();

function buildBook(): Map<string, string> {
  const book = new Map<string, string>();

  for (const { name, moves } of OPENINGS) {
    const board = new Chess();
    let valid = true;

    for (const san of moves.split(/\s+/)) {
      try {
        board.move(san);
      } catch {
        // A typo in the table above should be loud in dev, not a silent miss.
        if (import.meta.env?.DEV) {
          console.warn(`openings.ts: illegal move "${san}" in "${name}"`);
        }
        valid = false;
        break;
      }
    }

    // Longer, more specific names win when two entries reach the same position.
    if (valid) book.set(positionKey(board.fen()), name);
  }

  return book;
}

/** The opening name for this exact position, if we know one. */
export function openingName(fen: string): string | null {
  return BOOK.get(positionKey(fen)) ?? null;
}

/**
 * The most specific opening name reached along a line of play.
 *
 * A game that is currently in an unnamed position is still "a Sicilian" if it
 * passed through one, which is what the coach and the history layer want.
 */
export function openingFromHistory(fens: readonly string[]): string | null {
  let best: string | null = null;
  for (const fen of fens) {
    const name = openingName(fen);
    if (name) best = name;
  }
  return best;
}

/** True while the position is still theory, so a "mistake" here isn't the player's. */
export function isBookPosition(fen: string, ply: number): boolean {
  return ply <= BOOK_MAX_PLY && BOOK.has(positionKey(fen));
}
