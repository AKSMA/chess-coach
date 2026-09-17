/**
 * Assembling the fact bag the LLM layer is allowed to talk about.
 *
 * Built from the narrator's output plus the engine's, so the LLM is a pure
 * consumer: it receives only what the rule library already established, and
 * `verify.ts` checks its prose back against exactly this allowlist.
 */
import { Chess } from 'chess.js';
import type { Verdict } from '../game/classify.js';
import type { ExplainFacts } from '../llm/types.js';
import { lineSquares } from './describe.js';
import { PIECE_NAME } from './pieces.js';
import type { Narration } from './narrate.js';

export interface FactsInput {
  narration: Narration;
  verdict: Verdict;
  mover: 'you' | 'opponent';
  san: string;
  uci: string;
  fenBefore: string;
  fenAfter: string;
  bestSan: string | null;
  bestUci: string | null;
  refutationSan: readonly string[];
  openingName: string | null;
  cpLoss: number;
  habitSummary: string | null;
}

export function buildFacts(input: FactsInput): ExplainFacts {
  const squares = new Set<string>();
  const san = new Set<string>();
  const pieces = new Set<string>();

  const add = (square: string | undefined) => {
    if (square && /^[a-h][1-8]$/.test(square)) squares.add(square);
  };

  // The move itself.
  add(input.uci.slice(0, 2));
  add(input.uci.slice(2, 4));
  san.add(input.san);

  if (input.bestSan) san.add(input.bestSan);
  if (input.bestUci) {
    add(input.bestUci.slice(0, 2));
    add(input.bestUci.slice(2, 4));
  }

  // The refutation line, and every square it touches.
  for (const move of input.refutationSan) san.add(move);
  for (const square of lineSquares(input.fenAfter, input.refutationSan)) add(square);

  // Squares the narrator chose to highlight.
  for (const square of input.narration.highlight) add(square);

  // Any square named in the rule-based sentences is fair game by definition —
  // the model is rephrasing those sentences.
  const body = input.narration.body.join(' ');
  for (const square of body.match(/\b[a-h][1-8]\b/g) ?? []) add(square);

  // Pieces actually on the squares in play, plus any the narrator named.
  const board = new Chess(input.fenBefore);
  for (const square of squares) {
    const piece = board.get(square as Parameters<Chess['get']>[0]);
    if (piece) pieces.add(PIECE_NAME[piece.type]);
  }
  for (const noun of Object.values(PIECE_NAME)) {
    if (new RegExp(`\\b${noun}s?\\b`, 'i').test(body)) pieces.add(noun);
  }

  return {
    verdict: input.verdict,
    mover: input.mover,
    san: input.san,
    bestSan: input.bestSan,
    refutationSan: [...input.refutationSan],
    allowedSquares: [...squares],
    allowedSan: [...san],
    allowedPieces: [...pieces],
    sentences: input.narration.body,
    triggeredRules: input.narration.triggeredRules,
    openingName: input.openingName,
    cpLoss: input.cpLoss,
    habitSummary: input.habitSummary,
  };
}
