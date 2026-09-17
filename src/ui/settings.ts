/**
 * The LLM settings panel.
 *
 * Deliberately honest: it says where each model actually runs, what it costs,
 * and that the profile summary is included in the payload. "Test connection"
 * runs the adapter's real probe so a wrong key or an unpulled model produces a
 * clear sentence rather than a silent failure at move one.
 */
import {
  PRESETS,
  loadLlmSettings,
  presetFor,
  saveLlmSettings,
  type LlmSettings,
} from '../llm/registry.js';
import { configFrom } from '../llm/registry.js';
import type { ModelInfo } from '../llm/types.js';

export interface SettingsCallbacks {
  onClose(): void;
  onChange(settings: LlmSettings): void;
}

const LOCALITY_LABEL: Record<ModelInfo['locality'], string> = {
  'on-device': 'on this Mac',
  'local-daemon': 'on this machine',
  remote: 'sent to a remote server',
};

export function renderSettings(
  container: HTMLElement,
  callbacks: SettingsCallbacks,
): void {
  let settings = loadLlmSettings();

  container.replaceChildren();
  container.className = 'settings';

  const header = document.createElement('header');
  header.className = 'progress-header';

  const title = document.createElement('h2');
  title.className = 'progress-title';
  title.textContent = 'Coach voice & wording';

  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'btn btn-ghost';
  close.textContent = 'Back to the board';
  close.addEventListener('click', callbacks.onClose);

  header.append(title, close);
  container.append(header);

  const intro = document.createElement('p');
  intro.className = 'settings-intro';
  intro.textContent =
    'Optional. A language model can reword the coach’s explanations more warmly. ' +
    'It only ever rephrases facts the engine already worked out, and anything it ' +
    'gets wrong is discarded before you see it — so the chess is identical either way.';
  container.append(intro);

  const form = document.createElement('div');
  form.className = 'settings-form';

  // --- Enable ------------------------------------------------------------
  const enableField = document.createElement('label');
  enableField.className = 'controls-toggle';

  const enableBox = document.createElement('input');
  enableBox.type = 'checkbox';
  enableBox.id = 'llm-enabled';
  enableBox.checked = settings.enabled;

  const enableText = document.createElement('span');
  enableText.className = 'controls-toggle-text';
  enableText.innerHTML =
    '<strong>Let a language model reword explanations</strong>' +
    '<small>Off by default. The app is fully playable without it.</small>';

  enableField.append(enableBox, enableText);
  form.append(enableField);

  // --- Provider ----------------------------------------------------------
  const providerField = field('Provider');
  const providerSelect = document.createElement('select');
  providerSelect.className = 'controls-select';
  providerSelect.id = 'llm-provider';

  for (const preset of PRESETS) {
    const option = document.createElement('option');
    option.value = preset.id;
    option.textContent = preset.label;
    providerSelect.append(option);
  }
  providerSelect.value = settings.providerId;

  const providerNote = document.createElement('p');
  providerNote.className = 'controls-blurb';
  providerNote.id = 'llm-note';

  providerField.append(providerSelect, providerNote);
  form.append(providerField);

  // --- Base URL ----------------------------------------------------------
  const urlField = field('Base URL');
  const urlInput = document.createElement('input');
  urlInput.type = 'text';
  urlInput.className = 'controls-select';
  urlInput.id = 'llm-base-url';
  urlInput.value = settings.baseUrl;
  urlField.append(urlInput);
  form.append(urlField);

  // --- Model -------------------------------------------------------------
  const modelField = field('Model');
  const modelInput = document.createElement('input');
  modelInput.type = 'text';
  modelInput.className = 'controls-select';
  modelInput.id = 'llm-model';
  modelInput.setAttribute('list', 'llm-model-options');
  modelInput.value = settings.model;
  modelInput.placeholder = 'Type any model name';

  // A datalist rather than a fixed dropdown: a model released after this was
  // written must still be usable by typing its name.
  const modelOptions = document.createElement('datalist');
  modelOptions.id = 'llm-model-options';

  modelField.append(modelInput, modelOptions);
  form.append(modelField);

  // --- Key ---------------------------------------------------------------
  const keyField = field('API key (optional)');
  const keyInput = document.createElement('input');
  keyInput.type = 'password';
  keyInput.className = 'controls-select';
  keyInput.id = 'llm-key';
  keyInput.value = settings.apiKey;
  keyInput.placeholder = 'Prefer .env.local';

  const keyNote = document.createElement('p');
  keyNote.className = 'controls-blurb';
  keyNote.textContent =
    'Leave this blank and put the key in .env.local instead — that keeps it out of the browser entirely. ' +
    'A key typed here is stored in this browser’s local storage.';

  keyField.append(keyInput, keyNote);
  form.append(keyField);

  // --- Mode --------------------------------------------------------------
  const modeField = field('When to use it');
  const modeSelect = document.createElement('select');
  modeSelect.className = 'controls-select';
  modeSelect.id = 'llm-mode';

  for (const [value, label] of [
    ['on-demand', 'Only when I ask (recommended for paid providers)'],
    ['always', 'Every move'],
  ] as const) {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = label;
    modeSelect.append(option);
  }
  modeSelect.value = settings.mode === 'off' ? 'on-demand' : settings.mode;

  const modeNote = document.createElement('p');
  modeNote.className = 'controls-blurb';
  modeNote.textContent =
    'A game is around 40 moves and the coach comments on both sides, so “every move” means roughly 80 calls per game.';

  modeField.append(modeSelect, modeNote);
  form.append(modeField);

  // --- Privacy note ------------------------------------------------------
  const privacy = document.createElement('p');
  privacy.className = 'settings-privacy';
  privacy.textContent =
    'What gets sent: the move, the engine’s verdict, the rule-based sentences, and a one-line summary of your recurring habits. ' +
    'Your game history never leaves this machine.';
  form.append(privacy);

  // --- Test --------------------------------------------------------------
  const actions = document.createElement('div');
  actions.className = 'controls-row';

  const testButton = document.createElement('button');
  testButton.type = 'button';
  testButton.className = 'btn btn-primary';
  testButton.id = 'llm-test';
  testButton.textContent = 'Test connection';

  const status = document.createElement('p');
  status.className = 'settings-status';
  status.id = 'llm-status';

  actions.append(testButton);
  form.append(actions, status);
  container.append(form);

  // --- Behaviour ---------------------------------------------------------

  const applyPreset = (id: string) => {
    const preset = presetFor(id);
    if (!preset) return;
    providerNote.textContent = preset.note;
    if (preset.baseUrl) urlInput.value = preset.baseUrl;
    if (preset.suggestedModel && !modelInput.value) modelInput.value = preset.suggestedModel;
    keyField.hidden = !preset.needsKey;
  };

  const persist = () => {
    settings = {
      enabled: enableBox.checked,
      providerId: providerSelect.value,
      baseUrl: urlInput.value.trim(),
      model: modelInput.value.trim(),
      apiKey: keyInput.value,
      mode: modeSelect.value as LlmSettings['mode'],
      direct: settings.direct,
    };
    saveLlmSettings(settings);
    callbacks.onChange(settings);
  };

  for (const element of [enableBox, providerSelect, urlInput, modelInput, keyInput, modeSelect]) {
    element.addEventListener('change', () => {
      if (element === providerSelect) applyPreset(providerSelect.value);
      persist();
    });
  }

  testButton.addEventListener('click', async () => {
    const preset = presetFor(providerSelect.value);
    if (!preset) return;

    persist();
    status.textContent = 'Testing…';
    status.className = 'settings-status';

    try {
      const result = await preset.adapter.probe(configFrom(settings));
      status.textContent = result.detail;
      status.className = `settings-status ${result.ok ? 'is-ok' : 'is-bad'}`;

      modelOptions.replaceChildren();
      for (const model of result.models ?? []) {
        const option = document.createElement('option');
        option.value = model.id;
        // Locality is stated per model: a `:cloud` entry on localhost is remote.
        option.label = `${model.label} — ${LOCALITY_LABEL[model.locality]}`;
        modelOptions.append(option);
      }
    } catch (error) {
      status.textContent = String(error);
      status.className = 'settings-status is-bad';
    }
  });

  applyPreset(settings.providerId);
}

function field(label: string): HTMLElement {
  const wrapper = document.createElement('div');
  wrapper.className = 'controls-field';

  const text = document.createElement('span');
  text.className = 'controls-field-label';
  text.textContent = label;

  wrapper.append(text);
  return wrapper;
}
