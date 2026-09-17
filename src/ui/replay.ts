/**
 * Walking back through a finished game.
 *
 * Every explanation was written to storage as it was produced, so replay is a
 * pure read: no engine, no re-analysis, no waiting. That is the whole reason
 * the rendered text is persisted alongside the move.
 */
import { Chessground } from '@lichess-org/chessground';
import type { Api } from '@lichess-org/chessground/api';
import type { Config } from '@lichess-org/chessground/config';
import { VERDICT_STYLE } from '../game/classify.js';
import type { StoredGame, StoredMove } from '../history/db.js';
import { verdictChip } from './movelist.js';

export interface ReplayCallbacks {
  onClose(): void;
}

export class ReplayView {
  #container: HTMLElement;
  #ground: Api | null = null;
  #moves: StoredMove[] = [];
  #index = -1;
  #explanation!: HTMLElement;
  #counter!: HTMLElement;
  #prev!: HTMLButtonElement;
  #next!: HTMLButtonElement;

  constructor(container: HTMLElement) {
    this.#container = container;
  }

  render(game: StoredGame, moves: StoredMove[], callbacks: ReplayCallbacks): void {
    this.#moves = [...moves].sort((a, b) => a.ply - b.ply);
    this.#index = -1;

    this.#container.replaceChildren();
    this.#container.className = 'replay';

    const header = document.createElement('header');
    header.className = 'progress-header';

    const title = document.createElement('h2');
    title.className = 'progress-title';
    title.textContent = game.openingName ?? 'Replay';

    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'btn btn-ghost';
    close.textContent = 'Back to progress';
    close.addEventListener('click', callbacks.onClose);

    header.append(title, close);

    const layout = document.createElement('div');
    layout.className = 'replay-layout';

    const boardHost = document.createElement('div');
    boardHost.className = 'replay-board';

    const side = document.createElement('div');
    side.className = 'replay-side';

    // Verdict strip: the shape of the game at a glance, clickable.
    const strip = document.createElement('div');
    strip.className = 'verdict-strip';
    strip.setAttribute('role', 'list');

    this.#moves.forEach((move, index) => {
      if (move.color !== game.playerColor) return;
      const cell = document.createElement('button');
      cell.type = 'button';
      cell.className = 'verdict-cell';
      cell.dataset['ply'] = String(move.ply);
      const style = move.verdict ? VERDICT_STYLE[move.verdict] : null;
      if (style) {
        cell.style.setProperty('--chip-hue', `var(${style.token})`);
        cell.textContent = style.glyph;
        cell.title = `Move ${Math.ceil(move.ply / 2)}: ${move.san} — ${style.label}`;
      } else {
        cell.textContent = '·';
        cell.title = `Move ${Math.ceil(move.ply / 2)}: ${move.san}`;
      }
      cell.addEventListener('click', () => this.#goTo(index));
      strip.append(cell);
    });

    this.#explanation = document.createElement('div');
    this.#explanation.className = 'replay-explanation';

    const controls = document.createElement('div');
    controls.className = 'replay-controls';

    this.#prev = navButton('‹ Back', () => this.#goTo(this.#index - 1));
    this.#next = navButton('Forward ›', () => this.#goTo(this.#index + 1));
    this.#counter = document.createElement('span');
    this.#counter.className = 'replay-counter';

    controls.append(this.#prev, this.#counter, this.#next);

    side.append(strip, this.#explanation, controls);
    layout.append(boardHost, side);
    this.#container.append(header, layout);

    this.#ground = Chessground(boardHost, {
      fen: this.#moves[0]?.fenBefore ?? undefined,
      orientation: game.playerColor === 'w' ? 'white' : 'black',
      viewOnly: true,
      coordinates: true,
      animation: { enabled: true, duration: 180 },
      highlight: { lastMove: true },
    } as Config);
    boardHost.classList.add('board-host');

    this.#goTo(-1);
    document.addEventListener('keydown', this.#onKey);
  }

  destroy(): void {
    document.removeEventListener('keydown', this.#onKey);
    this.#ground?.destroy();
    this.#ground = null;
  }

  #onKey = (event: KeyboardEvent): void => {
    if (event.key === 'ArrowLeft') this.#goTo(this.#index - 1);
    if (event.key === 'ArrowRight') this.#goTo(this.#index + 1);
  };

  #goTo(index: number): void {
    const clamped = Math.max(-1, Math.min(this.#moves.length - 1, index));
    this.#index = clamped;

    const move = clamped >= 0 ? this.#moves[clamped] : null;
    const fen = move ? move.fenAfter : (this.#moves[0]?.fenBefore ?? null);

    if (fen && this.#ground) {
      // Same clearing rule as the live board: chessground only drops the
      // highlight when `lastMove` is present and falsy.
      this.#ground.set({ fen, lastMove: undefined } as unknown as Config);
    }

    this.#prev.disabled = clamped <= -1;
    this.#next.disabled = clamped >= this.#moves.length - 1;
    // Counts stored entries rather than assuming both colours are present:
    // dividing by two is wrong for any game where they are not.
    this.#counter.textContent =
      clamped < 0 ? 'Start' : `${clamped + 1} of ${this.#moves.length}`;

    this.#explanation.replaceChildren();

    if (!move) {
      const hint = document.createElement('p');
      hint.className = 'coach-text';
      hint.textContent = 'Step forward to walk through the game with the coaching you were given.';
      this.#explanation.append(hint);
      return;
    }

    const heading = document.createElement('div');
    heading.className = 'coach-verdict';
    if (move.verdict) heading.append(verdictChip(move.verdict));

    const san = document.createElement('span');
    san.className = 'coach-verdict-label';
    if (move.verdict) {
      san.style.setProperty('--chip-hue', `var(${VERDICT_STYLE[move.verdict].token})`);
    }
    san.textContent = move.san;
    heading.append(san);
    this.#explanation.append(heading);

    const text = document.createElement('p');
    text.className = 'coach-text';
    // Saved at the time it was said — no engine is running here.
    text.textContent = move.explanation ?? 'No coaching was recorded for this move.';
    this.#explanation.append(text);

    for (const cell of this.#container.querySelectorAll('.verdict-cell')) {
      cell.classList.toggle('is-current', cell.getAttribute('data-ply') === String(move.ply));
    }
  }
}

function navButton(label: string, onClick: () => void): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'btn btn-ghost';
  button.textContent = label;
  button.addEventListener('click', onClick);
  return button;
}
