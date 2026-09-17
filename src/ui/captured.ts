/**
 * Captured pieces and the material differential.
 *
 * Derived from the current position rather than tracked incrementally: counting
 * what's missing from a FEN can't drift out of sync, whereas an incremental
 * tally silently breaks the first time a move is taken back.
 */
import { Chess } from 'chess.js';

export type PieceType = 'p' | 'n' | 'b' | 'r' | 'q';

export const PIECE_VALUE: Record<PieceType, number> = {
  p: 1,
  n: 3,
  b: 3,
  r: 5,
  q: 9,
};

const STARTING_COUNTS: Record<PieceType, number> = { p: 8, n: 2, b: 2, r: 2, q: 1 };
const ORDER: PieceType[] = ['q', 'r', 'b', 'n', 'p'];

export interface MaterialState {
  /** Pieces White has lost, i.e. captured by Black. */
  whiteLost: PieceType[];
  blackLost: PieceType[];
  /** Positive means White is ahead. */
  differential: number;
}

export function materialFromFen(fen: string): MaterialState {
  const board = new Chess(fen);
  const remaining = {
    w: { p: 0, n: 0, b: 0, r: 0, q: 0 } as Record<PieceType, number>,
    b: { p: 0, n: 0, b: 0, r: 0, q: 0 } as Record<PieceType, number>,
  };

  for (const row of board.board()) {
    for (const square of row) {
      if (!square || square.type === 'k') continue;
      remaining[square.color][square.type as PieceType]++;
    }
  }

  const whiteLost: PieceType[] = [];
  const blackLost: PieceType[] = [];
  let differential = 0;

  for (const type of ORDER) {
    // Promotion can leave *more* than the starting count, so clamp at zero.
    const whiteMissing = Math.max(0, STARTING_COUNTS[type] - remaining.w[type]);
    const blackMissing = Math.max(0, STARTING_COUNTS[type] - remaining.b[type]);

    for (let i = 0; i < whiteMissing; i++) whiteLost.push(type);
    for (let i = 0; i < blackMissing; i++) blackLost.push(type);

    differential += (remaining.w[type] - remaining.b[type]) * PIECE_VALUE[type];
  }

  return { whiteLost, blackLost, differential };
}

const GLYPH: Record<PieceType, { w: string; b: string }> = {
  q: { w: '♕', b: '♛' },
  r: { w: '♖', b: '♜' },
  b: { w: '♗', b: '♝' },
  n: { w: '♘', b: '♞' },
  p: { w: '♙', b: '♟' },
};

export class CapturedTray {
  #top: HTMLElement;
  #bottom: HTMLElement;
  #orientation: 'w' | 'b' = 'w';

  constructor(top: HTMLElement, bottom: HTMLElement) {
    top.classList.add('captured');
    bottom.classList.add('captured');
    this.#top = top;
    this.#bottom = bottom;
  }

  setOrientation(color: 'w' | 'b'): void {
    this.#orientation = color;
  }

  render(fen: string): void {
    const material = materialFromFen(fen);

    // The tray next to a player shows what they have *taken* from the opponent.
    const bottomIsWhite = this.#orientation === 'w';
    const bottomCaptures = bottomIsWhite ? material.blackLost : material.whiteLost;
    const topCaptures = bottomIsWhite ? material.whiteLost : material.blackLost;
    const bottomColor: 'w' | 'b' = bottomIsWhite ? 'b' : 'w';
    const topColor: 'w' | 'b' = bottomIsWhite ? 'w' : 'b';

    const diff = material.differential;
    const bottomLead = bottomIsWhite ? diff : -diff;

    this.#paint(this.#bottom, bottomCaptures, bottomColor, bottomLead);
    this.#paint(this.#top, topCaptures, topColor, -bottomLead);
  }

  #paint(element: HTMLElement, pieces: PieceType[], color: 'w' | 'b', lead: number): void {
    element.replaceChildren();

    const glyphs = document.createElement('span');
    glyphs.className = 'captured-pieces';
    glyphs.textContent = pieces.map((p) => GLYPH[p][color]).join('');
    element.append(glyphs);

    if (lead > 0) {
      const badge = document.createElement('span');
      badge.className = 'captured-lead';
      badge.textContent = `+${lead}`;
      element.append(badge);
    }
  }
}
