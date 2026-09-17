/**
 * Game controls: new game, take back, hint, flip, level, and the training
 * wheels.
 */
import { LEVELS, MAX_LEVEL, MIN_LEVEL, levelConfig } from '../engine/opponent.js';
import { HINT_ALLOWANCES, hintButtonLabel, hintsRemaining, normaliseAllowance } from '../game/hints.js';

export interface ControlsCallbacks {
  onNewGame(): void;
  onUndo(): void;
  /** Flip is the side chooser: it swaps your colour and starts a new game. */
  onSwitchSides(): void;
  onHint(): void;
  onHintAllowanceChange(allowance: number): void;
  onLevelChange(level: number): void;
  onWarningsChange(enabled: boolean): void;
  onSpeechChange(enabled: boolean): void;
  onThemeToggle(): void;
}

export interface ControlsState {
  playerColor: 'w' | 'b';
  level: number;
  warningsEnabled: boolean;
  speechEnabled: boolean;
  hintAllowance: number;
}

export class Controls {
  #levelSelect: HTMLSelectElement;
  #levelBlurb: HTMLElement;
  #warningsToggle: HTMLInputElement;
  #speechToggle: HTMLInputElement;
  #undoButton: HTMLButtonElement;
  #flipButton: HTMLButtonElement;
  #hintButton: HTMLButtonElement;
  #hintSelect: HTMLSelectElement;
  #hintBlurb: HTMLElement;

  constructor(container: HTMLElement, state: ControlsState, callbacks: ControlsCallbacks) {
    container.classList.add('controls');

    // --- Primary actions -------------------------------------------------
    const actions = document.createElement('div');
    actions.className = 'controls-row';

    const newGame = button('New game', 'primary', callbacks.onNewGame, 'new-game-button');
    this.#undoButton = button('Take back', 'ghost', callbacks.onUndo, 'undo-button');
    this.#hintButton = button('Hint', 'hint', callbacks.onHint, 'hint-button');
    this.#flipButton = button('Flip', 'ghost', callbacks.onSwitchSides, 'flip-button');
    const theme = button('Theme', 'ghost', callbacks.onThemeToggle, 'theme-button');
    theme.setAttribute('aria-label', 'Switch between light and dark');

    actions.append(newGame, this.#undoButton, this.#hintButton, this.#flipButton, theme);

    // --- Level -----------------------------------------------------------
    const levelField = document.createElement('div');
    levelField.className = 'controls-field';

    const levelLabel = document.createElement('label');
    levelLabel.textContent = 'Opponent';
    levelLabel.htmlFor = 'level-select';

    this.#levelSelect = document.createElement('select');
    this.#levelSelect.id = 'level-select';
    this.#levelSelect.className = 'controls-select';

    for (const config of LEVELS) {
      const option = document.createElement('option');
      option.value = String(config.level);
      option.textContent = `${config.level}. ${config.label}`;
      this.#levelSelect.append(option);
    }
    this.#levelSelect.value = String(clampLevel(state.level));

    this.#levelBlurb = document.createElement('p');
    this.#levelBlurb.className = 'controls-blurb';
    this.#levelBlurb.textContent = levelConfig(state.level).blurb;

    this.#levelSelect.addEventListener('change', () => {
      const level = clampLevel(Number(this.#levelSelect.value));
      this.#levelBlurb.textContent = levelConfig(level).blurb;
      callbacks.onLevelChange(level);
    });

    levelField.append(levelLabel, this.#levelSelect, this.#levelBlurb);

    // --- Hints -------------------------------------------------------------
    const hintField = document.createElement('div');
    hintField.className = 'controls-field';

    const hintLabel = document.createElement('label');
    hintLabel.textContent = 'Hints per game';
    hintLabel.htmlFor = 'hint-select';

    this.#hintSelect = document.createElement('select');
    this.#hintSelect.id = 'hint-select';
    this.#hintSelect.className = 'controls-select';

    for (const option of HINT_ALLOWANCES) {
      const element = document.createElement('option');
      element.value = String(option.value);
      element.textContent = option.label;
      this.#hintSelect.append(element);
    }
    this.#hintSelect.value = String(normaliseAllowance(state.hintAllowance));

    this.#hintBlurb = document.createElement('p');
    this.#hintBlurb.className = 'controls-blurb';

    this.#hintSelect.addEventListener('change', () => {
      callbacks.onHintAllowanceChange(normaliseAllowance(Number(this.#hintSelect.value)));
    });

    hintField.append(hintLabel, this.#hintSelect, this.#hintBlurb);

    // --- Training wheels --------------------------------------------------
    const warningsField = document.createElement('label');
    warningsField.className = 'controls-toggle';

    this.#warningsToggle = document.createElement('input');
    this.#warningsToggle.type = 'checkbox';
    this.#warningsToggle.checked = state.warningsEnabled;
    this.#warningsToggle.addEventListener('change', () => {
      callbacks.onWarningsChange(this.#warningsToggle.checked);
    });

    const warningsText = document.createElement('span');
    warningsText.className = 'controls-toggle-text';
    warningsText.innerHTML =
      '<strong>Warn me about blunders</strong>' +
      '<small>Training wheels — asks before you play a losing move.</small>';

    warningsField.append(this.#warningsToggle, warningsText);

    // --- Voice ------------------------------------------------------------
    const speechField = document.createElement('label');
    speechField.className = 'controls-toggle';

    this.#speechToggle = document.createElement('input');
    this.#speechToggle.type = 'checkbox';
    this.#speechToggle.checked = state.speechEnabled;
    this.#speechToggle.addEventListener('change', () => {
      callbacks.onSpeechChange(this.#speechToggle.checked);
    });

    const speechText = document.createElement('span');
    speechText.className = 'controls-toggle-text';
    speechText.innerHTML =
      '<strong>Coach speaks out loud</strong>' +
      '<small>Reads each explanation aloud as you play.</small>';

    speechField.append(this.#speechToggle, speechText);

    container.append(actions, levelField, hintField, warningsField, speechField);

    this.setPlayerColor(state.playerColor);
    this.setHints(state.hintAllowance, 0, false);
  }

  /**
   * Reflects the hint budget in the button and the blurb.
   *
   * The count lives on the button rather than in a separate badge: the number
   * only matters at the moment you are deciding whether to spend one.
   */
  setHints(allowance: number, used: number, available: boolean): void {
    const left = hintsRemaining(allowance, used);
    this.#hintSelect.value = String(normaliseAllowance(allowance));
    this.#hintButton.textContent = hintButtonLabel(allowance, used);
    this.#hintButton.disabled = !available || left <= 0;
    this.#hintButton.dataset['remaining'] = left === Infinity ? 'unlimited' : String(left);

    this.#hintBlurb.textContent =
      allowance === 0
        ? 'Hints are switched off. Turn them on here if you get stuck.'
        : left === Infinity
          ? `Hints used this game: ${used}. Ask twice for the same position and the second one names the move.`
          : `${left} left this game. Ask twice for the same position and the second one names the move.`;
  }

  /**
   * The flip button is labelled with what it will do, not with what you are.
   * "Flip" on its own gives no clue that it changes which colour you play.
   */
  setPlayerColor(color: 'w' | 'b'): void {
    const other = color === 'w' ? 'Black' : 'White';
    this.#flipButton.textContent = `Play as ${other}`;
    this.#flipButton.title = `Switch sides and start a new game as ${other}`;
    this.#flipButton.setAttribute('aria-label', this.#flipButton.title);
    this.#flipButton.dataset['playing'] = color;
  }

  setUndoEnabled(enabled: boolean): void {
    this.#undoButton.disabled = !enabled;
  }

  setLevel(level: number): void {
    this.#levelSelect.value = String(clampLevel(level));
    this.#levelBlurb.textContent = levelConfig(level).blurb;
  }
}

function button(
  label: string,
  variant: string,
  onClick: () => void,
  id: string,
): HTMLButtonElement {
  const element = document.createElement('button');
  element.type = 'button';
  // Ids so the browser harness can name a button instead of counting along the
  // row — adding one control in the middle used to silently retarget its checks.
  element.id = id;
  element.className = `btn btn-${variant}`;
  element.textContent = label;
  element.addEventListener('click', onClick);
  return element;
}

function clampLevel(level: number): number {
  return Math.min(MAX_LEVEL, Math.max(MIN_LEVEL, Math.round(level) || MIN_LEVEL));
}
