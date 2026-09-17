/**
 * The coach card.
 *
 * Milestone 1 populates this with the verdict and the engine's preferred move.
 * Milestone 2 replaces the body with real narration from `coach/narrate.ts` —
 * the slots are already here so that change is additive.
 */
import { VERDICT_STYLE, type Verdict } from '../game/classify.js';
import { verdictChip } from './movelist.js';

export interface CoachMessage {
  verdict?: Verdict;
  /** Who the message is about. */
  mover?: 'you' | 'opponent';
  /** Short heading, e.g. "Blunder" or "Italian Game". */
  headline?: string;
  /** Sentences, rendered as separate paragraphs. */
  body?: string[];
  /** The reusable principle, styled apart from the commentary. */
  takeaway?: string;
}

export class CoachPanel {
  #root: HTMLElement;
  #status: HTMLElement;
  #card: HTMLElement;
  #voice: HTMLElement;

  constructor(container: HTMLElement) {
    container.classList.add('coach');
    this.#root = container;

    const header = document.createElement('div');
    header.className = 'coach-header';

    const title = document.createElement('h2');
    title.className = 'coach-title';
    title.textContent = 'Coach';

    this.#status = document.createElement('span');
    this.#status.className = 'coach-status';

    // A small equaliser that animates only while the coach is speaking.
    this.#voice = document.createElement('span');
    this.#voice.className = 'coach-voice';
    this.#voice.setAttribute('aria-hidden', 'true');
    for (let i = 0; i < 4; i++) this.#voice.append(document.createElement('i'));

    header.append(title, this.#voice, this.#status);

    this.#card = document.createElement('div');
    this.#card.className = 'coach-card';
    // Coach text arrives asynchronously; announce it rather than leaving it silent.
    this.#card.setAttribute('aria-live', 'polite');

    container.append(header, this.#card);
    this.welcome();
  }

  welcome(): void {
    this.render({
      headline: 'Ready when you are',
      body: [
        'Play a move and I’ll tell you what it did to the position, and what would have been better.',
      ],
    });
  }

  /**
   * Marks the coach as talking. Drives the waveform beside the title, which is
   * the only cue that audio is playing if the volume happens to be down.
   */
  setSpeaking(speaking: boolean): void {
    this.#root.classList.toggle('is-speaking', speaking);
    this.#voice.setAttribute('aria-hidden', String(!speaking));
  }

  /** Transient state, e.g. "Thinking…". Kept out of the card so it never blanks. */
  setStatus(text: string): void {
    this.#status.textContent = text;
    this.#root.classList.toggle('is-busy', text.length > 0);
  }

  render(message: CoachMessage): void {
    this.#card.replaceChildren();

    if (message.verdict) {
      const line = document.createElement('div');
      line.className = 'coach-verdict';
      line.append(verdictChip(message.verdict));

      const label = document.createElement('span');
      label.className = 'coach-verdict-label';
      label.style.setProperty('--chip-hue', `var(${VERDICT_STYLE[message.verdict].token})`);
      label.textContent = message.headline ?? VERDICT_STYLE[message.verdict].label;
      line.append(label);

      if (message.mover) {
        const who = document.createElement('span');
        who.className = 'coach-mover';
        who.textContent = message.mover === 'you' ? 'your move' : 'their move';
        line.append(who);
      }

      this.#card.append(line);
    } else if (message.headline) {
      const heading = document.createElement('p');
      heading.className = 'coach-headline';
      heading.textContent = message.headline;
      this.#card.append(heading);
    }

    for (const sentence of message.body ?? []) {
      const paragraph = document.createElement('p');
      paragraph.className = 'coach-text';
      paragraph.textContent = sentence;
      this.#card.append(paragraph);
    }

    if (message.takeaway) {
      const takeaway = document.createElement('p');
      takeaway.className = 'coach-takeaway';
      takeaway.textContent = message.takeaway;
      this.#card.append(takeaway);
    }
  }

  /**
   * Swaps the explanation text for a reworded version, leaving the verdict,
   * the opponent's follow-up, and the takeaway in place.
   *
   * Used by the optional LLM layer, which arrives after the rule text is
   * already on screen — the panel is never blank waiting for a model.
   */
  replaceBody(text: string): void {
    const paragraphs = this.#card.querySelectorAll('.coach-text');
    const first = paragraphs[0];
    if (!first) return;

    first.textContent = text;
    // The rewrite replaces every rule sentence, so drop the rest.
    for (let i = 1; i < paragraphs.length; i++) {
      const paragraph = paragraphs[i];
      if (paragraph && !paragraph.closest('.coach-followup')) paragraph.remove();
    }
  }

  /**
   * Adds the opponent's reply *below* the current message instead of replacing
   * it.
   *
   * Replacing it is the obvious implementation and it is wrong: the engine
   * answers in a few hundred milliseconds, so the coaching on your own move
   * would be wiped off the screen before you could read a word of it.
   */
  appendFollowUp(message: CoachMessage): void {
    const section = document.createElement('div');
    section.className = 'coach-followup';

    const label = document.createElement('p');
    label.className = 'coach-followup-label';
    label.textContent = message.headline ?? 'Their move';
    section.append(label);

    for (const sentence of message.body ?? []) {
      const paragraph = document.createElement('p');
      paragraph.className = 'coach-text';
      paragraph.textContent = sentence;
      section.append(paragraph);
    }

    // A takeaway belongs at the very bottom, after the reply.
    const takeaway = this.#card.querySelector('.coach-takeaway');
    if (takeaway) this.#card.insertBefore(section, takeaway);
    else this.#card.append(section);
  }
}

/**
 * The pre-move warning: "are you sure?", with both paths cheap because the move
 * has not been committed to the real game yet.
 *
 * Resolves true to play anyway, false to take it back.
 */
export function confirmRiskyMove(
  container: HTMLElement,
  options: { san: string; verdict: Verdict; reason: string },
): Promise<boolean> {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'warning-overlay';

    const dialog = document.createElement('div');
    dialog.className = 'warning-dialog';
    dialog.setAttribute('role', 'alertdialog');
    dialog.setAttribute('aria-modal', 'true');
    dialog.setAttribute('aria-label', 'Move warning');

    const heading = document.createElement('h3');
    heading.className = 'warning-title';
    heading.append(verdictChip(options.verdict));
    heading.append(
      document.createTextNode(
        options.verdict === 'blunder' ? ' Are you sure?' : ' That looks risky',
      ),
    );

    const reason = document.createElement('p');
    reason.className = 'warning-reason';
    reason.textContent = options.reason;

    const actions = document.createElement('div');
    actions.className = 'warning-actions';

    const takeBack = document.createElement('button');
    takeBack.type = 'button';
    takeBack.className = 'btn btn-primary';
    takeBack.textContent = 'Take it back';

    const playAnyway = document.createElement('button');
    playAnyway.type = 'button';
    playAnyway.className = 'btn btn-ghost';
    playAnyway.textContent = `Play ${options.san} anyway`;

    const finish = (accepted: boolean) => {
      document.removeEventListener('keydown', onKey);
      overlay.remove();
      resolve(accepted);
    };

    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') finish(false);
    };

    takeBack.addEventListener('click', () => finish(false));
    playAnyway.addEventListener('click', () => finish(true));
    document.addEventListener('keydown', onKey);

    actions.append(takeBack, playAnyway);
    dialog.append(heading, reason, actions);
    overlay.append(dialog);
    container.append(overlay);

    takeBack.focus();
  });
}
