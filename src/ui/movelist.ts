/**
 * The move list, with a quality chip on every move.
 *
 * Each verdict is a glyph *and* a hue. The glyph is what actually carries the
 * meaning — the list has to be readable in greyscale and by anyone who doesn't
 * distinguish the hues.
 */
import { VERDICT_STYLE, type Verdict } from '../game/classify.js';
import type { MoveRecord } from '../game/GameState.js';

export class MoveList {
  #root: HTMLElement;
  #body: HTMLElement;
  #onSelect: ((ply: number) => void) | undefined;

  constructor(container: HTMLElement, onSelect?: (ply: number) => void) {
    container.classList.add('movelist');
    this.#root = container;
    this.#onSelect = onSelect;

    const header = document.createElement('div');
    header.className = 'movelist-header';
    header.textContent = 'Moves';

    this.#body = document.createElement('ol');
    this.#body.className = 'movelist-body';

    container.append(header, this.#body);
  }

  render(records: readonly MoveRecord[]): void {
    this.#body.replaceChildren();

    for (let i = 0; i < records.length; i += 2) {
      const white = records[i];
      const black = records[i + 1];

      const row = document.createElement('li');
      row.className = 'movelist-row';

      const number = document.createElement('span');
      number.className = 'movelist-number';
      number.textContent = `${Math.floor(i / 2) + 1}.`;
      row.append(number);

      if (white) row.append(this.#moveCell(white));
      if (black) row.append(this.#moveCell(black));

      this.#body.append(row);
    }

    this.#body.scrollTop = this.#body.scrollHeight;
  }

  #moveCell(record: MoveRecord): HTMLElement {
    const cell = document.createElement('button');
    cell.type = 'button';
    cell.className = 'movelist-move';
    cell.dataset['ply'] = String(record.ply);

    const san = document.createElement('span');
    san.className = 'movelist-san';
    san.textContent = record.san;
    cell.append(san);

    if (record.verdict) cell.append(verdictChip(record.verdict));

    if (this.#onSelect) {
      cell.addEventListener('click', () => this.#onSelect?.(record.ply));
    }

    return cell;
  }

  highlight(ply: number): void {
    for (const el of this.#root.querySelectorAll('.movelist-move')) {
      el.classList.toggle('is-current', el.getAttribute('data-ply') === String(ply));
    }
  }
}

/** A verdict badge. Exported so the coach panel and review can reuse it. */
export function verdictChip(verdict: Verdict): HTMLElement {
  const style = VERDICT_STYLE[verdict];
  const chip = document.createElement('span');
  chip.className = `verdict-chip verdict-${verdict}`;
  chip.style.setProperty('--chip-hue', `var(${style.token})`);
  chip.textContent = style.glyph;
  // The glyph alone can be ambiguous out of context; name it for assistive tech.
  chip.setAttribute('aria-label', style.label);
  chip.title = style.label;
  return chip;
}
