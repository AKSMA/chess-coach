/**
 * Centipawn loss -> a verdict the player can read at a glance.
 *
 * Thresholds follow the Lichess convention, which is what anyone who has used
 * an online analysis board already has calibrated intuitions for.
 */

export type Verdict =
  | 'best'
  | 'excellent'
  | 'good'
  | 'inaccuracy'
  | 'mistake'
  | 'blunder'
  | 'book'
  | 'forced';

export interface VerdictStyle {
  /** Shown in the move list. Never colour alone — this glyph carries the meaning. */
  glyph: string;
  label: string;
  /** CSS custom property holding this verdict's hue. Defined in ui/theme.css. */
  token: string;
}

export const VERDICT_STYLE: Record<Verdict, VerdictStyle> = {
  best: { glyph: '★', label: 'Best move', token: '--verdict-best' },
  excellent: { glyph: '✓', label: 'Excellent', token: '--verdict-excellent' },
  good: { glyph: '✓', label: 'Good', token: '--verdict-good' },
  inaccuracy: { glyph: '?!', label: 'Inaccuracy', token: '--verdict-inaccuracy' },
  mistake: { glyph: '?', label: 'Mistake', token: '--verdict-mistake' },
  blunder: { glyph: '??', label: 'Blunder', token: '--verdict-blunder' },
  book: { glyph: '📖', label: 'Book move', token: '--verdict-book' },
  forced: { glyph: '□', label: 'Only move', token: '--verdict-forced' },
};

/** Loss at or below this is not worth mentioning to a learner. */
export const INACCURACY_THRESHOLD = 50;
/** Loss at or above this triggers the "are you sure?" warning. */
export const MISTAKE_THRESHOLD = 100;
export const BLUNDER_THRESHOLD = 200;

export interface ClassifyContext {
  /** The position was still in a known opening. */
  isBook?: boolean;
  /** There was only one legal move, so quality is not the player's doing. */
  isForced?: boolean;
}

export function classify(cpLoss: number, context: ClassifyContext = {}): Verdict {
  if (context.isForced) return 'forced';
  if (context.isBook) return 'book';

  if (cpLoss <= 10) return 'best';
  if (cpLoss <= 20) return 'excellent';
  if (cpLoss <= INACCURACY_THRESHOLD) return 'good';
  if (cpLoss <= MISTAKE_THRESHOLD) return 'inaccuracy';
  if (cpLoss <= BLUNDER_THRESHOLD) return 'mistake';
  return 'blunder';
}

/** Verdicts the coach should criticise. Book and forced moves are never faults. */
export function isMistakeLike(verdict: Verdict): boolean {
  return verdict === 'inaccuracy' || verdict === 'mistake' || verdict === 'blunder';
}

/** Verdicts worth a warning before the move is committed. */
export function warrantsWarning(verdict: Verdict): boolean {
  return verdict === 'mistake' || verdict === 'blunder';
}
