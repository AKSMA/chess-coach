/**
 * The authoritative game. Wraps chess.js and records, per move, everything the
 * coach and the history layer need later.
 *
 * The board UI is a *view* of this — it never holds state of its own. Anything
 * that needs to know what happened asks here.
 */
import { Chess, type Move, type Square } from 'chess.js';
import type { Score } from '../engine/score.js';
import type { Verdict } from './classify.js';
import { phaseOf, type Phase } from './phase.js';
import { openingFromHistory } from './openings.js';

export type Color = 'w' | 'b';

export type GameResult =
  | 'white-wins'
  | 'black-wins'
  | 'draw-stalemate'
  | 'draw-repetition'
  | 'draw-fifty-move'
  | 'draw-insufficient-material'
  | 'draw'
  | null;

export interface MoveRecord {
  ply: number;
  /** Position *before* the move — what the detectors compare against. */
  fenBefore: string;
  fenAfter: string;
  san: string;
  uci: string;
  color: Color;
  phase: Phase;
  /** Filled in once analysis completes; null while still pending. */
  cpLoss: number | null;
  verdict: Verdict | null;
  evalAfter: Score | null;
  bestMoveSan: string | null;
  /** Rule ids that fired on this move. Aggregated by the profile. */
  triggeredRules: string[];
  /** Rendered coach text, persisted so replay needs no re-analysis. */
  explanation: string | null;
}

export interface ProposedMove {
  from: Square;
  to: Square;
  promotion?: 'q' | 'r' | 'b' | 'n';
}

export class GameState {
  #chess = new Chess();
  #records: MoveRecord[] = [];

  get fen(): string {
    return this.#chess.fen();
  }

  get turn(): Color {
    return this.#chess.turn();
  }

  get ply(): number {
    return this.#records.length;
  }

  get records(): readonly MoveRecord[] {
    return this.#records;
  }

  get isGameOver(): boolean {
    return this.#chess.isGameOver();
  }

  /** Every position seen, starting position first. Used for opening detection. */
  get fenHistory(): string[] {
    const fens = this.#records.map((r) => r.fenBefore);
    fens.push(this.fen);
    return fens;
  }

  get openingName(): string | null {
    return openingFromHistory(this.fenHistory);
  }

  /** Legal destinations per origin square, in the shape chessground wants. */
  legalDests(): Map<string, string[]> {
    const dests = new Map<string, string[]>();
    for (const move of this.#chess.moves({ verbose: true })) {
      const existing = dests.get(move.from);
      if (existing) existing.push(move.to);
      else dests.set(move.from, [move.to]);
    }
    return dests;
  }

  /** True when this move would put a pawn on the back rank. */
  isPromotion(from: Square, to: Square): boolean {
    return this.#chess
      .moves({ verbose: true })
      .some((m) => m.from === from && m.to === to && m.promotion !== undefined);
  }

  /**
   * Plays a move on a *scratch* copy and returns the resulting position without
   * touching real state.
   *
   * This is what makes the warnings toggle cheap: we can evaluate "what if" and
   * then discard it, so "Take it back" is genuinely free rather than an undo
   * that has to unwind side effects.
   */
  peek(move: ProposedMove): { fen: string; san: string; uci: string } | null {
    const scratch = new Chess(this.fen);
    try {
      const played = scratch.move(move);
      return {
        fen: scratch.fen(),
        san: played.san,
        uci: toUci(played),
      };
    } catch {
      return null;
    }
  }

  /** Commits a move. Returns the record, or null if the move was illegal. */
  play(move: ProposedMove): MoveRecord | null {
    const fenBefore = this.fen;
    let played: Move;
    try {
      played = this.#chess.move(move);
    } catch {
      return null;
    }

    const record: MoveRecord = {
      ply: this.#records.length + 1,
      fenBefore,
      fenAfter: this.#chess.fen(),
      san: played.san,
      uci: toUci(played),
      color: played.color,
      phase: phaseOf(fenBefore),
      cpLoss: null,
      verdict: null,
      evalAfter: null,
      bestMoveSan: null,
      triggeredRules: [],
      explanation: null,
    };

    this.#records.push(record);
    return record;
  }

  /** Takes back the last move. Returns it, or null at the start of the game. */
  undo(): MoveRecord | null {
    const undone = this.#chess.undo();
    if (!undone) return null;
    return this.#records.pop() ?? null;
  }

  /**
   * Takes back far enough that the player faces their own decision again.
   *
   * That means retracting the player's own last move *and* any opponent reply
   * to it — undoing a single ply would just hand the position back with the
   * opponent still to move.
   */
  undoToPlayerTurn(playerColor: Color): void {
    let retractedOwnMove = false;
    while (this.#records.length > 0 && !(retractedOwnMove && this.turn === playerColor)) {
      const undone = this.undo();
      if (undone?.color === playerColor) retractedOwnMove = true;
    }
  }

  reset(): void {
    this.#chess = new Chess();
    this.#records = [];
  }

  /** Loads a position, e.g. from the `?fen=` debug parameter. */
  loadFen(fen: string): boolean {
    try {
      this.#chess = new Chess(fen);
      this.#records = [];
      return true;
    } catch {
      return false;
    }
  }

  get pgn(): string {
    return this.#chess.pgn();
  }

  /**
   * How the game ended, distinguishing the draw types — "you drew" and "you
   * were stalemated with an extra queen" are very different lessons.
   */
  get result(): GameResult {
    if (!this.#chess.isGameOver()) return null;
    if (this.#chess.isCheckmate()) return this.turn === 'w' ? 'black-wins' : 'white-wins';
    if (this.#chess.isStalemate()) return 'draw-stalemate';
    if (this.#chess.isThreefoldRepetition()) return 'draw-repetition';
    if (this.#chess.isInsufficientMaterial()) return 'draw-insufficient-material';
    if (this.#chess.isDraw()) return 'draw-fifty-move';
    return 'draw';
  }

  /** Squares of the king in check, for the board's check indicator. */
  get checkedKingSquare(): Square | null {
    if (!this.#chess.inCheck()) return null;
    const turn = this.turn;
    for (const row of this.#chess.board()) {
      for (const square of row) {
        if (square && square.type === 'k' && square.color === turn) return square.square;
      }
    }
    return null;
  }
}

export function toUci(move: Move): string {
  return `${move.from}${move.to}${move.promotion ?? ''}`;
}

/** Human-readable result, for the review screen and the games list. */
export function describeResult(result: GameResult, playerColor: Color): string {
  switch (result) {
    case 'white-wins':
      return playerColor === 'w' ? 'You won' : 'You lost';
    case 'black-wins':
      return playerColor === 'b' ? 'You won' : 'You lost';
    case 'draw-stalemate':
      return 'Draw by stalemate';
    case 'draw-repetition':
      return 'Draw by repetition';
    case 'draw-fifty-move':
      return 'Draw by the fifty-move rule';
    case 'draw-insufficient-material':
      return 'Draw — not enough material to mate';
    case 'draw':
      return 'Draw';
    default:
      return 'In progress';
  }
}
