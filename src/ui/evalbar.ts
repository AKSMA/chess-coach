/**
 * The evaluation bar: how the position stands, felt rather than read.
 *
 * Driven by win probability rather than raw centipawns, so the movement is
 * proportional to how much the *result* changed. A swing from +1 to +2 barely
 * moves it; a swing from 0 to +2 moves it a lot. That matches how much the
 * player should care.
 */
import { winProbability, toCp, type Score } from '../engine/score.js';

export class EvalBar {
  #fill: HTMLElement;
  #label: HTMLElement;
  #root: HTMLElement;
  #showNumbers = false;

  constructor(container: HTMLElement) {
    container.classList.add('evalbar');
    container.setAttribute('role', 'img');
    container.setAttribute('aria-label', 'Evaluation: even');

    this.#root = container;
    this.#fill = document.createElement('div');
    this.#fill.className = 'evalbar-fill';
    this.#label = document.createElement('span');
    this.#label.className = 'evalbar-label';

    container.append(this.#fill, this.#label);
    this.set(null);
  }

  /** Pass null while no evaluation is available yet. */
  set(score: Score | null): void {
    if (!score) {
      this.#fill.style.height = '50%';
      this.#label.textContent = '';
      this.#root.setAttribute('aria-label', 'Evaluation: unknown');
      return;
    }

    const whiteShare = winProbability(score);
    this.#fill.style.height = `${(whiteShare * 100).toFixed(1)}%`;
    this.#label.textContent = this.#showNumbers ? formatScore(score) : '';
    this.#root.setAttribute('aria-label', `Evaluation: ${describeScore(score)}`);
  }

  /** The "show engine eval" toggle. Off by default — numbers aren't the lesson. */
  setShowNumbers(show: boolean): void {
    this.#showNumbers = show;
    this.#root.classList.toggle('is-numeric', show);
  }
}

/** Engine-style notation, e.g. "+1.4" or "M3". Only shown behind the toggle. */
export function formatScore(score: Score): string {
  if (score.kind === 'mate') {
    return score.moves === 0 ? '#' : `M${Math.abs(score.moves)}`;
  }
  const pawns = score.cp / 100;
  return `${pawns >= 0 ? '+' : ''}${pawns.toFixed(1)}`;
}

/** Plain language, for screen readers and for the coach's prose. */
export function describeScore(score: Score): string {
  if (score.kind === 'mate') {
    const side = score.moves > 0 ? 'White' : 'Black';
    return `${side} has forced mate in ${Math.abs(score.moves)}`;
  }

  const cp = toCp(score);
  const side = cp > 0 ? 'White' : 'Black';
  const magnitude = Math.abs(cp);

  if (magnitude < 30) return 'level';
  if (magnitude < 90) return `${side} is slightly better`;
  if (magnitude < 250) return `${side} is clearly better`;
  if (magnitude < 600) return `${side} is winning`;
  return `${side} is completely winning`;
}

/**
 * Translates a centipawn amount into material the player recognises.
 * Used by the coach so it can say "about a knight" instead of "310 centipawns".
 */
export function describeMaterial(cpLoss: number): string {
  if (cpLoss >= 850) return 'about the value of a queen';
  if (cpLoss >= 450) return 'about the value of a rook';
  if (cpLoss >= 280) return 'about the value of a piece';
  if (cpLoss >= 150) return 'more than a pawn';
  if (cpLoss >= 60) return 'about a pawn';
  return 'a little';
}
