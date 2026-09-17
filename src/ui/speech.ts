/**
 * The coach's actual voice, via the Web Speech API.
 *
 * Two things this has to get right:
 *
 * 1. **It always finishes.** The suggestion arrow stays on the board until the
 *    coach stops talking, so if `onend` never fires — no voices installed, a
 *    headless browser, a synthesiser that drops the event — the arrow would be
 *    stranded forever. Every utterance therefore resolves either on `onend` or
 *    on a duration estimate, whichever lands first.
 *
 * 2. **It never talks over itself.** A new move cancels whatever is being said
 *    about the previous one.
 */

/** Words per minute of a typical synthesised voice, used to estimate duration. */
const WORDS_PER_MINUTE = 165;
const MIN_DURATION = 1400;
/** Safety margin over the estimate before we give up waiting for `onend`. */
const OVERRUN_ALLOWANCE = 2500;
/**
 * How long the board pauses when the coach is muted, or has no voice.
 *
 * A fixed beat rather than a scaled-down speech estimate: with nothing being
 * spoken there is no length to match, and a predictable four seconds to read
 * the explanation and see the arrow beats a pause that varies per move.
 */
const SILENT_HOLD = 4000;

export interface SpeakHandle {
  /** Resolves when the coach has finished, however that happens. */
  finished: Promise<void>;
  cancel(): void;
}

export class Speaker {
  #enabled: boolean;
  #synth: SpeechSynthesis | null;
  #voice: SpeechSynthesisVoice | null = null;
  #current: { utterance: SpeechSynthesisUtterance | null; timer: number | null } | null = null;

  constructor(enabled: boolean) {
    this.#enabled = enabled;
    this.#synth = typeof window !== 'undefined' && 'speechSynthesis' in window
      ? window.speechSynthesis
      : null;

    // Voices load asynchronously in most browsers; the first call often
    // returns an empty list.
    if (this.#synth) {
      this.#pickVoice();
      this.#synth.addEventListener?.('voiceschanged', () => this.#pickVoice());
    }
  }

  /** True when a real voice is available to speak with. */
  get available(): boolean {
    return this.#synth !== null && this.#voice !== null;
  }

  get enabled(): boolean {
    return this.#enabled;
  }

  setEnabled(enabled: boolean): void {
    this.#enabled = enabled;
    if (!enabled) this.cancel();
  }

  /**
   * Speaks the sentences in order.
   *
   * Returns immediately with a handle; `finished` resolves when the coach has
   * stopped talking, which is what the board waits on before moving the
   * position along.
   */
  speak(sentences: readonly string[]): SpeakHandle {
    this.cancel();

    const text = sentences.join(' ').trim();
    const estimate = estimateDuration(text);

    if (text.length === 0) {
      return { finished: Promise.resolve(), cancel: () => {} };
    }

    // Muted, or nothing to speak with: still hold for a readable beat so the
    // arrow and the explanation stay up long enough to be taken in.
    if (!this.#enabled || !this.#synth || !this.#voice) {
      return this.#holdSilently(SILENT_HOLD);
    }

    const utterance = new SpeechSynthesisUtterance(text);
    utterance.voice = this.#voice;
    utterance.rate = 1.02;
    utterance.pitch = 1;
    utterance.volume = 1;

    let settle: () => void;
    const finished = new Promise<void>((resolve) => {
      settle = resolve;
    });

    const done = () => {
      if (this.#current?.timer !== null && this.#current?.timer !== undefined) {
        clearTimeout(this.#current.timer);
      }
      this.#current = null;
      settle();
    };

    utterance.onend = done;
    utterance.onerror = done;

    // The backstop. Some synthesisers simply never deliver `onend`.
    const timer = window.setTimeout(done, estimate + OVERRUN_ALLOWANCE);
    this.#current = { utterance, timer };

    this.#synth.speak(utterance);
    return { finished, cancel: () => this.cancel() };
  }

  cancel(): void {
    if (this.#current?.timer !== null && this.#current?.timer !== undefined) {
      clearTimeout(this.#current.timer);
    }
    this.#current = null;
    try {
      this.#synth?.cancel();
    } catch {
      // Cancelling an idle synthesiser is not an error worth surfacing.
    }
  }

  #holdSilently(duration: number): SpeakHandle {
    let settle: () => void;
    const finished = new Promise<void>((resolve) => {
      settle = resolve;
    });
    const timer = window.setTimeout(() => {
      this.#current = null;
      settle();
    }, duration);
    this.#current = { utterance: null, timer };
    return { finished, cancel: () => this.cancel() };
  }

  /** Prefers a natural-sounding English voice, falling back to whatever exists. */
  #pickVoice(): void {
    const voices = this.#synth?.getVoices() ?? [];
    if (voices.length === 0) return;

    const english = voices.filter((v) => v.lang.startsWith('en'));
    const pool = english.length > 0 ? english : voices;

    // Named voices tend to be the higher-quality ones on macOS.
    const preferred = ['Samantha', 'Daniel', 'Karen', 'Google UK English Female', 'Google US English'];
    this.#voice = pool.find((v) => preferred.includes(v.name)) ?? pool[0] ?? null;
  }
}

/** How long this text should take to say, in milliseconds. */
export function estimateDuration(text: string): number {
  const words = text.split(/\s+/).filter(Boolean).length;
  const ms = (words / WORDS_PER_MINUTE) * 60_000;
  return Math.max(MIN_DURATION, Math.round(ms));
}
