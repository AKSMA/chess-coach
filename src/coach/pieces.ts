/**
 * Piece vocabulary.
 *
 * The coach speaks in piece names and squares — "your knight on f3" — never in
 * notation. SAN belongs in the move list, not in an explanation aimed at
 * someone still learning what the letters mean.
 */
import type { Color, PieceSymbol, Square } from 'chess.js';

export const PIECE_NAME: Record<PieceSymbol, string> = {
  p: 'pawn',
  n: 'knight',
  b: 'bishop',
  r: 'rook',
  q: 'queen',
  k: 'king',
};

/** Rough material worth, in pawns. Used for hanging/exchange judgements. */
export const PIECE_VALUE: Record<PieceSymbol, number> = {
  p: 1,
  n: 3,
  b: 3,
  r: 5,
  q: 9,
  k: 100,
};

export const CENTRE_SQUARES: Square[] = ['d4', 'd5', 'e4', 'e5'];
export const EXTENDED_CENTRE: Square[] = [
  'c3', 'c4', 'c5', 'c6',
  'd3', 'd4', 'd5', 'd6',
  'e3', 'e4', 'e5', 'e6',
  'f3', 'f4', 'f5', 'f6',
];

/** Home squares of the minor pieces, for development checks. */
export const MINOR_HOME: Record<Color, Square[]> = {
  w: ['b1', 'c1', 'f1', 'g1'],
  b: ['b8', 'c8', 'f8', 'g8'],
};

/**
 * Possessive for a piece, from the reader's point of view.
 * The reader is always the player, so their own pieces are "your".
 */
export function possessive(owner: Color, playerColor: Color): string {
  return owner === playerColor ? 'your' : 'their';
}

/** Capitalised side name, for sentences that need a subject. */
export function sideName(color: Color): string {
  return color === 'w' ? 'White' : 'Black';
}

/** "your knight on f3" */
export function namePieceAt(
  piece: PieceSymbol,
  square: Square,
  owner: Color,
  playerColor: Color,
): string {
  return `${possessive(owner, playerColor)} ${PIECE_NAME[piece]} on ${square}`;
}

/** Joins a list the way a person would: "a, b and c". */
export function joinWords(items: string[]): string {
  if (items.length === 0) return '';
  if (items.length === 1) return items[0]!;
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

/** Sentence-cases a fragment. */
export function capitalise(text: string): string {
  return text.length === 0 ? text : text[0]!.toUpperCase() + text.slice(1);
}

/**
 * Glossary for terms a beginner may not know. The narrator adds the
 * parenthetical the first time a term appears in a given explanation, so the
 * coach never uses unexplained jargon.
 */
export const GLOSSARY: Record<string, string> = {
  fork: 'one piece attacking two things at once',
  pin: 'a piece that cannot move without exposing something more valuable behind it',
  develop: 'bring a piece off its starting square into the game',
  undefended: 'no other piece is protecting it',
  hanging: 'it can be captured for free',
  castle: 'tuck your king into the corner behind its pawns',
};
