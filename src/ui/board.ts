/**
 * The board: chessground rendering a view of GameState.
 *
 * The board holds no game state of its own. Every move attempt is offered to
 * the caller, which validates it against chess.js and then tells the board what
 * the position now is. Trying to keep two mutable boards in step is how you get
 * a UI that disagrees with the rules.
 */
import { Chessground } from '@lichess-org/chessground';
import type { Api } from '@lichess-org/chessground/api';
import type { Config } from '@lichess-org/chessground/config';
import type { Key } from '@lichess-org/chessground/types';
import type { DrawShape } from '@lichess-org/chessground/draw';
import type { Square } from 'chess.js';
import type { GameState } from '../game/GameState.js';

export type PromotionPiece = 'q' | 'r' | 'b' | 'n';

export interface BoardCallbacks {
  /**
   * A legal-looking move was attempted. Returning false snaps the piece back.
   * Async so the caller can run the pre-move warning check before committing.
   */
  onMove(from: Square, to: Square, promotion?: PromotionPiece): Promise<boolean>;
}

/**
 * Glyphs rather than chessground's sprite classes: the piece images are
 * base64-embedded inside cburnett.css and not addressable as standalone URLs,
 * and the tray already uses these same glyphs.
 */
const PROMOTION_CHOICES: { piece: PromotionPiece; label: string; white: string; black: string }[] = [
  { piece: 'q', label: 'Queen', white: '♕', black: '♛' },
  { piece: 'r', label: 'Rook', white: '♖', black: '♜' },
  { piece: 'b', label: 'Bishop', white: '♗', black: '♝' },
  { piece: 'n', label: 'Knight', white: '♘', black: '♞' },
];

export class Board {
  #ground: Api;
  #game: GameState;
  #callbacks: BoardCallbacks;
  #orientation: 'white' | 'black' = 'white';
  #promotionOverlay: HTMLElement | null = null;
  #container: HTMLElement;

  constructor(container: HTMLElement, game: GameState, callbacks: BoardCallbacks) {
    this.#game = game;
    this.#callbacks = callbacks;
    this.#container = container;
    container.classList.add('board-host');

    this.#ground = Chessground(container, {
      fen: game.fen,
      orientation: this.#orientation,
      coordinates: true,
      // Castling arrives as a two-square king move; let chessground move the rook.
      movable: {
        free: false,
        showDests: true,
        rookCastle: true,
        events: { after: (from, to) => void this.#handleMove(from, to) },
      },
      animation: { enabled: true, duration: 200 },
      highlight: { lastMove: true, check: true },
      drawable: { enabled: true, visible: true },
    });

    // Dev-only handle so the browser harness can inspect chessground's state.
    if (import.meta.env?.DEV) (window as unknown as Record<string, unknown>)['__cg'] = this.#ground;

    this.sync();
  }

  /**
   * Re-reads the position from GameState. Called after every commit.
   *
   * Deliberately a full re-sync from FEN rather than an incremental patch:
   * en passant and castling both move a piece the user never dragged, and
   * patching those by hand is a reliable source of ghost pieces.
   */
  sync(options: { lastMove?: [Square, Square] } = {}): void {
    const turn = this.#game.turn === 'w' ? 'white' : 'black';
    // chessground wants the *colour* in check and finds the king itself.
    const check = this.#game.checkedKingSquare ? turn : false;

    this.#ground.set({
      fen: this.#game.fen,
      turnColor: turn,
      check,
      /*
       * Always send the key, and send `undefined` when there is nothing to
       * highlight.
       *
       * Chessground clears the highlight only on `'lastMove' in config &&
       * !config.lastMove`. Omitting the key leaves the old highlight in place,
       * and an empty array is *truthy*, so it slips past that check into the
       * branch meant for Crazyhouse drops and the squares stay lit. Only an
       * explicitly undefined value takes the clearing path.
       *
       * The cast is needed because `exactOptionalPropertyTypes` distinguishes
       * an absent key from one set to undefined, while chessground relies on
       * exactly that distinction.
       */
      lastMove: options.lastMove as Key[] | undefined,
      // `movable.color` is omitted rather than set to undefined: under
      // exactOptionalPropertyTypes an explicit undefined is not the same as absent.
      movable: this.#game.isGameOver
        ? { dests: new Map() }
        : { color: turn, dests: this.#game.legalDests() as Map<Key, Key[]> },
    } as Config);
  }

  /** Locks the board, e.g. while the opponent is thinking. */
  setInteractive(interactive: boolean): void {
    const playable = interactive && !this.#game.isGameOver;
    this.#ground.set({
      movable: playable
        ? {
            color: this.#game.turn === 'w' ? 'white' : 'black',
            dests: this.#game.legalDests() as Map<Key, Key[]>,
          }
        : { dests: new Map() },
    });
  }

  setOrientation(color: 'w' | 'b'): void {
    this.#orientation = color === 'w' ? 'white' : 'black';
    this.#ground.set({ orientation: this.#orientation });
  }

  /** Coach arrows. Auto-shapes are cleared by the board on the next move. */
  setShapes(shapes: DrawShape[]): void {
    this.#ground.setAutoShapes(shapes);
  }

  clearShapes(): void {
    this.#ground.setAutoShapes([]);
  }

  destroy(): void {
    this.#dismissPromotion();
    this.#ground.destroy();
  }

  async #handleMove(from: Key, to: Key): Promise<void> {
    const origin = from as Square;
    const destination = to as Square;

    // chessground reports a pawn reaching the back rank as an ordinary move —
    // it has no concept of promotion. Ask before committing.
    let promotion: PromotionPiece | undefined;
    if (this.#game.isPromotion(origin, destination)) {
      const chosen = await this.#askPromotion(destination);
      if (chosen === null) {
        // Cancelled: put the pawn back where it came from.
        this.sync();
        return;
      }
      promotion = chosen;
    }

    const accepted = await this.#callbacks.onMove(origin, destination, promotion);
    // Whether accepted or rejected, GameState is authoritative — re-read it.
    if (!accepted) this.sync();
  }

  /** Resolves with the chosen piece, or null if the player backed out. */
  #askPromotion(destination: Square): Promise<PromotionPiece | null> {
    return new Promise((resolve) => {
      this.#dismissPromotion();

      const overlay = document.createElement('div');
      overlay.className = 'promotion-overlay';
      overlay.setAttribute('role', 'dialog');
      overlay.setAttribute('aria-label', 'Choose a piece to promote to');

      const panel = document.createElement('div');
      panel.className = 'promotion-panel';
      // Colour of the promoting side is whoever is to move right now.
      const colorClass = this.#game.turn === 'w' ? 'white' : 'black';

      const finish = (piece: PromotionPiece | null) => {
        this.#dismissPromotion();
        document.removeEventListener('keydown', onKey);
        resolve(piece);
      };

      const onKey = (event: KeyboardEvent) => {
        if (event.key === 'Escape') finish(null);
      };

      for (const { piece, label, white, black } of PROMOTION_CHOICES) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = `promotion-choice ${colorClass}`;
        button.dataset['piece'] = piece;
        button.textContent = colorClass === 'white' ? white : black;
        button.setAttribute('aria-label', label);
        button.title = label;
        button.addEventListener('click', (event) => {
          event.stopPropagation();
          finish(piece);
        });
        panel.append(button);
      }

      // Clicking away is a cancel, not an accidental queen.
      overlay.addEventListener('click', () => finish(null));
      document.addEventListener('keydown', onKey);

      overlay.append(panel);
      overlay.dataset['square'] = destination;
      this.#container.append(overlay);
      this.#promotionOverlay = overlay;
    });
  }

  #dismissPromotion(): void {
    this.#promotionOverlay?.remove();
    this.#promotionOverlay = null;
  }
}

/** A labelled arrow, used to show the move the player should have made. */
export function suggestionArrow(from: string, to: string, brush = 'green'): DrawShape {
  return { orig: from as Key, dest: to as Key, brush };
}

/** A highlight ring on a single square, for "this piece is hanging". */
export function highlightSquare(square: string, brush = 'red'): DrawShape {
  return { orig: square as Key, brush };
}
