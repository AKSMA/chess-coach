/**
 * The coach's voice.
 *
 * Composes an explanation from ordered slots. Not every slot fires on every
 * move, and the order is deliberate:
 *
 *   what you did  ->  what it achieved  ->  what went wrong
 *   ->  how they punish it  ->  what was better  ->  the takeaway
 *
 * "What you did" always comes first, even on a blunder. Being told what you
 * were trying to do before being told why it failed is the difference between
 * coaching and scolding.
 */
import { Chess, type Color } from 'chess.js';
import type { Verdict } from '../game/classify.js';
import { isMistakeLike } from '../game/classify.js';
import { describeLine, describeMove, moveFromSan, moveFromUci } from './describe.js';
import { findProblems, hangingPieces, pieceWord, positiveEffects, type RuleId } from './features.js';
import { capitalise, joinWords, PIECE_VALUE } from './pieces.js';

function lowerFirst(text: string): string {
  return text.length === 0 ? text : text[0]!.toLowerCase() + text.slice(1);
}

export interface NarrationInput {
  fenBefore: string;
  fenAfter: string;
  san: string;
  uci: string;
  mover: Color;
  playerColor: Color;
  verdict: Verdict;
  cpLoss: number;
  /** The engine's preferred move in the position before this one. */
  bestUci: string | null;
  bestSan: string | null;
  /** How the opponent punishes the move played, in SAN, from fenAfter. */
  refutationSan: readonly string[];
  openingName: string | null;
}

export interface Narration {
  headline: string;
  body: string[];
  /**
   * The condensed version read aloud.
   *
   * Deliberately shorter than `body`: the full explanation takes about half a
   * minute to speak, and the board is held while the coach talks. Speech gets
   * the verdict, what you did, what went wrong, and the better move — the
   * refutation line and the principle stay on screen to be read.
   */
  speech: string[];
  takeaway?: string;
  /** Rule ids that fired, for the history layer to aggregate. */
  triggeredRules: RuleId[];
  /** Squares worth highlighting on the board. */
  highlight: string[];
}

/** Reusable principles, keyed to the rule that triggered them. */
const LESSONS: Partial<Record<RuleId, string>> = {
  'hangs-piece':
    'Before you commit to a move, check the square you are leaving and the square you are landing on: is anything of yours now attacked without a defender?',
  'allows-capture':
    'After every move you consider, ask what their most forcing reply is — captures and checks first.',
  'allows-fork':
    'Knights fork by landing where they touch two of your pieces at once. Before moving, glance at the squares a knight could reach and see whether two of your pieces already share one.',
  'allows-pin':
    'A piece standing between an enemy line-piece and something more valuable is stuck. Break the pin early — block it, or move the valuable piece off the line.',
  'trapped-piece':
    'Before grabbing a distant pawn, count the squares your piece can retreat to. A piece with no way home is as good as lost.',
  'missed-capture':
    'Scan for free material before anything else. If a piece can be taken for nothing, take it.',
  'weakens-king':
    'Get castled early, and keep the pawns in front of your king where they are unless there is a concrete reason to push them.',
  'walks-into-check':
    'Look for checks against your own king before moving a defender away.',
};

export function narrate(input: NarrationInput): Narration {
  const {
    fenBefore,
    fenAfter,
    uci,
    mover,
    playerColor,
    verdict,
    bestUci,
    refutationSan,
    openingName,
  } = input;

  const isPlayer = mover === playerColor;
  const body: string[] = [];
  const triggeredRules: RuleId[] = [];
  const highlight: string[] = [];

  const speech: string[] = [];

  const move = moveFromUci(fenBefore, uci) ?? moveFromSan(fenBefore, input.san);
  if (!move) {
    return { headline: 'Move played', body: [], speech: [], triggeredRules: [], highlight: [] };
  }

  // --- Slot 1: what the move actually was -------------------------------
  const opening = `${capitalise(describeMove(move, { playerColor }))}.`;
  body.push(opening);
  if (!isMistakeLike(verdict)) speech.push(opening);

  // --- Slot 2: what it achieved -----------------------------------------
  const effects = positiveEffects(fenBefore, fenAfter, uci);
  if (effects.length > 0) {
    const phrases = effects.slice(0, 2).map((e) => e.phrase);
    triggeredRules.push(...effects.slice(0, 2).map((e) => e.rule));
    body.push(`That ${joinWords(phrases)}.`);
  }

  // --- Book move ---------------------------------------------------------
  if (verdict === 'book' && openingName) {
    body.push(`This is standard theory — the position is a ${openingName}.`);
  }

  // --- Slot 3: what went wrong ------------------------------------------
  // Ranked by cost, so the single most damaging fact leads — a learner given
  // a list of five problems takes away none of them.
  const problems = isMistakeLike(verdict)
    ? findProblems(fenBefore, fenAfter, mover, playerColor)
    : [];
  const problem = problems[0];

  if (problem) {
    const sentence = `The problem: ${lowerFirst(problem.sentence)}`;
    body.push(sentence);
    speech.push(sentence);
    triggeredRules.push(problem.rule);
    highlight.push(...problem.squares);

    // A second, unrelated problem is worth one more line but never a third.
    const second = problems[1];
    if (second && second.severity >= 70) {
      body.push(second.sentence);
      triggeredRules.push(second.rule);
    }
  } else if (isMistakeLike(verdict)) {
    const problem =
      verdict === 'blunder'
        ? 'The problem is what it allows in reply.'
        : 'It lets the position slip a little; there was something more testing available.';
    body.push(problem);
    speech.push(problem);
    triggeredRules.push('allows-capture');
  }

  // --- Slot 4: the refutation -------------------------------------------
  if (isMistakeLike(verdict) && refutationSan.length > 0) {
    // Two plies. The third is almost always noise the learner cannot use, and
    // it makes the sentence read like a transcript rather than an explanation.
    const line = describeLine(fenAfter, refutationSan, playerColor, 2);
    if (line.length > 0) {
      body.push(`In reply, ${joinWords(line)}.`);
    }
  }

  // --- Slot 5: what was better, and why ---------------------------------
  if (isPlayer && bestUci && isMistakeLike(verdict)) {
    const better = describeBetterMove(fenBefore, bestUci, playerColor);
    if (better) {
      body.push(better);
      speech.push(better);
    }
  }

  // --- Slot 6: the takeaway ---------------------------------------------
  const takeaway = triggeredRules.map((rule) => LESSONS[rule]).find(Boolean);

  const headline = headlineFor(verdict, isPlayer, openingName);

  return {
    headline,
    body,
    speech: [`${headline}.`, ...speech],
    ...(isMistakeLike(verdict) && takeaway ? { takeaway } : {}),
    triggeredRules,
    highlight,
  };
}

/** "Castling was stronger — it tucks your king away and connects your rooks." */
function describeBetterMove(fenBefore: string, bestUci: string, playerColor: Color): string | null {
  const move = moveFromUci(fenBefore, bestUci);
  if (!move) return null;

  const scratch = new Chess(fenBefore);
  let fenAfterBest: string;
  try {
    scratch.move({ from: move.from, to: move.to, ...(move.promotion ? { promotion: move.promotion } : {}) });
    fenAfterBest = scratch.fen();
  } catch {
    return null;
  }

  const description = describeMove(move, { playerColor, subject: false });
  const effects = positiveEffects(fenBefore, fenAfterBest, bestUci);

  if (effects.length === 0) {
    return `Stronger was to have ${description}.`;
  }

  const reasons = joinWords(effects.slice(0, 2).map((e) => e.phrase));
  return `Stronger was to have ${description} — that ${reasons}.`;
}

function headlineFor(verdict: Verdict, isPlayer: boolean, openingName: string | null): string {
  if (!isPlayer) return 'Their move';

  switch (verdict) {
    case 'best':
      return 'Best move';
    case 'excellent':
      return 'Excellent';
    case 'good':
      return 'Good move';
    case 'inaccuracy':
      return 'Inaccuracy';
    case 'mistake':
      return 'Mistake';
    case 'blunder':
      return 'Blunder';
    case 'forced':
      return 'Only move';
    case 'book':
      return openingName ?? 'Book move';
    default:
      return 'Move played';
  }
}

/** A real piece, as players use the word — not a pawn. */
const PIECE_THRESHOLD = 3;

/**
 * Did the opponent's move actually cost the player a piece?
 *
 * The coach used to comment on every reply, which turns constant narration
 * into background noise you stop listening to. It now speaks about their move
 * only when it matters: they took a real piece for free, or they have set up
 * to win one next move.
 *
 * An even recapture is deliberately *not* costly — being told "they took your
 * knight" right after you took theirs is noise, not coaching.
 */
export function opponentMoveCost(
  fenBefore: string,
  fenAfter: string,
  uci: string,
  playerColor: Color,
): { kind: 'captured'; piece: string } | { kind: 'threatens'; square: string; piece: string } | null {
  const move = moveFromUci(fenBefore, uci);
  if (!move) return null;

  // (a) They took a real piece, and it was not a fair trade.
  if (move.captured && PIECE_VALUE[move.captured] >= PIECE_THRESHOLD) {
    const board = new Chess(fenAfter);
    const canRecapture = board.attackers(move.to, playerColor).length > 0;
    const wonMaterial = PIECE_VALUE[move.piece] < PIECE_VALUE[move.captured];

    if (!canRecapture || wonMaterial) {
      return { kind: 'captured', piece: pieceWord(move.captured) };
    }
  }

  // (b) A real piece of the player's is now hanging.
  const loose = hangingPieces(fenAfter, playerColor).filter(
    (h) => PIECE_VALUE[h.piece] >= PIECE_THRESHOLD,
  );
  const worst = loose[0];
  if (worst) {
    return { kind: 'threatens', square: worst.square, piece: pieceWord(worst.piece) };
  }

  return null;
}

/**
 * The opponent's move, narrated only when it costs the player something.
 *
 * Returns null for ordinary replies — the caller then leaves the coaching on
 * the player's own move on screen, undisturbed.
 */
export function narrateOpponentMove(
  fenBefore: string,
  fenAfter: string,
  uci: string,
  playerColor: Color,
): Narration | null {
  const cost = opponentMoveCost(fenBefore, fenAfter, uci, playerColor);
  if (!cost) return null;

  const move = moveFromUci(fenBefore, uci);
  if (!move) return null;

  const body = [`${capitalise(describeMove(move, { playerColor }))}.`];
  const highlight: string[] = [];
  const triggeredRules: RuleId[] = [];

  if (cost.kind === 'threatens') {
    const loose = hangingPieces(fenAfter, playerColor);
    const worst = loose[0];
    if (worst) {
      body.push(
        `Careful — your ${cost.piece} on ${cost.square} is attacked by their ` +
          `${pieceWord(worst.attackerPiece)} on ${worst.attackerSquare}` +
          `${worst.defended ? '' : ' and nothing is defending it'}.`,
      );
      highlight.push(worst.square);
    }
    triggeredRules.push('allows-capture');
  } else {
    body.push(`That costs you a ${cost.piece}.`);
    triggeredRules.push('hangs-piece');
  }

  return { headline: 'Their move', body, speech: body, triggeredRules, highlight };
}
