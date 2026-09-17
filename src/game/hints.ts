/**
 * How many hints you get, and how many are left.
 *
 * Small enough to inline, kept separate because it is the one part of the hint
 * feature with arithmetic worth testing: an unlimited allowance and a spent
 * allowance both have to behave sensibly when the setting changes mid-game.
 */

/** Sentinel for "as many as you like". */
export const UNLIMITED = -1;

export interface HintAllowanceOption {
  value: number;
  label: string;
}

/**
 * The choices offered. Three is the default: enough to get unstuck in a game
 * without turning the engine into an autopilot.
 */
export const HINT_ALLOWANCES: HintAllowanceOption[] = [
  { value: 0, label: 'None — I want no help' },
  { value: 1, label: '1 hint' },
  { value: 3, label: '3 hints' },
  { value: 5, label: '5 hints' },
  { value: 10, label: '10 hints' },
  { value: UNLIMITED, label: 'Unlimited' },
];

export const DEFAULT_HINT_ALLOWANCE = 3;

/** Rounds an arbitrary stored value onto one of the offered allowances. */
export function normaliseAllowance(value: number): number {
  return HINT_ALLOWANCES.some((option) => option.value === value)
    ? value
    : DEFAULT_HINT_ALLOWANCE;
}

/**
 * Hints still available. `Infinity` when unlimited.
 *
 * Never negative: lowering the allowance below what you have already spent
 * leaves you with none, not a debt.
 */
export function hintsRemaining(allowance: number, used: number): number {
  if (allowance === UNLIMITED) return Infinity;
  return Math.max(0, allowance - used);
}

/** The button's label, which is also where the count is shown. */
export function hintButtonLabel(allowance: number, used: number): string {
  if (allowance === UNLIMITED) return 'Hint';
  const left = hintsRemaining(allowance, used);
  if (allowance === 0) return 'Hints off';
  return left === 0 ? 'No hints left' : `Hint (${left})`;
}
