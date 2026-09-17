/**
 * Position detectors — what the coach can actually see.
 *
 * These are what let it say "you left your knight on e5 undefended and the
 * pawn on d6 takes it" instead of "the engine disagrees". Pure functions over
 * chess.js; every finding carries a stable rule id, because those ids are also
 * the keys the history layer will aggregate on.
 */
import { Chess, type Color, type PieceSymbol, type Square } from 'chess.js';
import { CENTRE_SQUARES, MINOR_HOME, PIECE_VALUE } from './pieces.js';
import { findDiscoveredAttacks, findForks, findPins, findTrappedPieces, kingSafety } from './tactics.js';

export type RuleId =
  | 'hangs-piece'
  | 'allows-capture'
  | 'missed-capture'
  | 'walks-into-check'
  | 'weakens-king'
  | 'develops'
  | 'controls-centre'
  | 'creates-threat'
  | 'creates-fork'
  | 'creates-pin'
  | 'discovered-attack'
  | 'allows-fork'
  | 'allows-pin'
  | 'trapped-piece'
  | 'gives-check'
  | 'wins-material'
  | 'castles'
  | 'moves-same-piece-twice'
  | 'blocks-own-pawn';

export interface HangingPiece {
  square: Square;
  piece: PieceSymbol;
  /** The cheapest enemy piece that can take it. */
  attackerSquare: Square;
  attackerPiece: PieceSymbol;
  defended: boolean;
}

/**
 * Is the piece on `square` available for free, or for profit?
 *
 * A lightweight static-exchange approximation: undefended and attacked counts,
 * and so does "defended, but the cheapest attacker is worth less than it" —
 * a queen defended by a king is still lost to a pawn.
 */
export function hangingAt(board: Chess, square: Square): HangingPiece | null {
  const piece = board.get(square);
  if (!piece || piece.type === 'k') return null;

  const enemy: Color = piece.color === 'w' ? 'b' : 'w';
  const attackerSquares = board.attackers(square, enemy);
  if (attackerSquares.length === 0) return null;

  const defenders = board.attackers(square, piece.color);
  const attackers = attackerSquares
    .map((sq) => ({ square: sq, piece: board.get(sq)?.type ?? 'p' }))
    .sort((a, b) => PIECE_VALUE[a.piece] - PIECE_VALUE[b.piece]);

  const cheapest = attackers[0]!;
  const defended = defenders.length > 0;

  // Free, or a favourable trade for the attacker.
  const winnable = !defended || PIECE_VALUE[cheapest.piece] < PIECE_VALUE[piece.type];
  if (!winnable) return null;

  return {
    square,
    piece: piece.type,
    attackerSquare: cheapest.square,
    attackerPiece: cheapest.piece,
    defended,
  };
}

/** Every piece of `color` that is currently available to the opponent. */
export function hangingPieces(fen: string, color: Color): HangingPiece[] {
  const board = new Chess(fen);
  const found: HangingPiece[] = [];

  for (const row of board.board()) {
    for (const entry of row) {
      if (!entry || entry.color !== color) continue;
      const hanging = hangingAt(board, entry.square);
      if (hanging) found.push(hanging);
    }
  }

  // Most valuable first — that's the one worth talking about.
  return found.sort((a, b) => PIECE_VALUE[b.piece] - PIECE_VALUE[a.piece]);
}

/**
 * Pieces that became loose *because of* this move — the workhorse behind
 * "you just left that undefended".
 */
export function newlyHanging(fenBefore: string, fenAfter: string, color: Color): HangingPiece[] {
  const before = new Set(hangingPieces(fenBefore, color).map((h) => h.square));
  return hangingPieces(fenAfter, color).filter((h) => !before.has(h.square));
}

/** The most valuable thing the side to move can simply take. */
export function bestFreeCapture(fen: string): HangingPiece | null {
  const board = new Chess(fen);
  const enemy: Color = board.turn() === 'w' ? 'b' : 'w';
  return hangingPieces(fen, enemy)[0] ?? null;
}

export interface PositiveEffect {
  rule: RuleId;
  /** A fragment that slots into "It ..." — e.g. "develops your knight". */
  phrase: string;
}

/**
 * What the move accomplished, regardless of whether it was a good idea.
 *
 * Every move gets described before it gets criticised — a learner needs to
 * know what they were trying to do before being told why it failed.
 */
export function positiveEffects(fenBefore: string, fenAfter: string, uci: string): PositiveEffect[] {
  const before = new Chess(fenBefore);
  const from = uci.slice(0, 2) as Square;
  const to = uci.slice(2, 4) as Square;

  const moving = before.get(from);
  if (!moving) return [];

  const effects: PositiveEffect[] = [];
  const after = new Chess(fenAfter);

  // Castling.
  const isCastle = moving.type === 'k' && Math.abs(from.charCodeAt(0) - to.charCodeAt(0)) > 1;
  if (isCastle) {
    effects.push({ rule: 'castles', phrase: 'tucks your king safely into the corner' });
  }

  // Development: a minor piece leaving its home square.
  const homes = MINOR_HOME[moving.color];
  if ((moving.type === 'n' || moving.type === 'b') && homes.includes(from)) {
    effects.push({ rule: 'develops', phrase: `brings your ${moving.type === 'n' ? 'knight' : 'bishop'} into the game` });
  }

  // Central influence.
  if (CENTRE_SQUARES.includes(to)) {
    effects.push({ rule: 'controls-centre', phrase: 'takes space in the centre' });
  } else if (attacksAnyCentre(after, to)) {
    effects.push({ rule: 'controls-centre', phrase: 'eyes the centre' });
  }

  // Check.
  if (after.inCheck()) {
    effects.push({ rule: 'gives-check', phrase: 'puts the enemy king in check' });
  }

  // Material won.
  const captured = before.get(to);
  if (captured) {
    // "picks up", not "wins": this slot describes what the move did, before
    // any judgement. A move that grabs a pawn and drops a knight has not won
    // anything, and saying so here would contradict the verdict beside it.
    effects.push({
      rule: 'wins-material',
      phrase: `picks up ${captured.type === 'p' ? 'a pawn' : `a ${pieceWord(captured.type)}`}`,
    });
  }

  // Tactics the move creates. These come first among threats because they are
  // the concrete thing worth learning to see.
  const fork = findForks(fenAfter, moving.color).find((f) => f.square === to);
  if (fork) {
    const targets = fork.targets.map((t) => `${pieceWord(t.piece)} on ${t.square}`);
    effects.push({
      rule: 'creates-fork',
      phrase: `forks their ${joinTwo(targets)} — one piece attacking both at once`,
    });
  }

  const pin = findPins(fenAfter, enemyOf(moving.color)).find((p) => p.bySquare === to);
  if (pin) {
    effects.push({
      rule: 'creates-pin',
      phrase:
        `pins their ${pieceWord(pin.piece)} on ${pin.square} against the ` +
        `${pieceWord(pin.behindPiece)} behind it`,
    });
  }

  const discovery = findDiscoveredAttacks(fenBefore, fenAfter, moving.color, from)[0];
  if (discovery) {
    effects.push({
      rule: 'discovered-attack',
      phrase:
        `opens your ${pieceWord(discovery.fromPiece)} on ${discovery.fromSquare} onto their ` +
        `${pieceWord(discovery.targetPiece)} on ${discovery.targetSquare}`,
    });
  }

  // A new threat created by the piece that just moved.
  const threat = threatCreatedBy(after, to, moving.color);
  if (threat && !fork) {
    effects.push({
      rule: 'creates-threat',
      phrase: `attacks their ${pieceWord(threat.piece)} on ${threat.square}`,
    });
  }

  return effects;
}

function enemyOf(color: Color): Color {
  return color === 'w' ? 'b' : 'w';
}

function joinTwo(items: string[]): string {
  return items.length <= 1 ? (items[0] ?? '') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

/**
 * Everything bad about the position for `color`, ranked by how much it costs.
 *
 * This is what the narrator reaches for when a move is criticised: it wants
 * the single most damaging fact, not a list.
 */
export interface Problem {
  rule: RuleId;
  /** A full sentence, already written from the reader's point of view. */
  sentence: string;
  /** Squares to highlight on the board. */
  squares: string[];
  /** Higher wins when several problems apply. */
  severity: number;
}

export function findProblems(
  fenBefore: string,
  fenAfter: string,
  color: Color,
  playerColor: Color,
): Problem[] {
  const mine = color === playerColor ? 'your' : 'their';
  const theirs = color === playerColor ? 'their' : 'your';
  const problems: Problem[] = [];

  // Hanging material — the most common and most expensive beginner mistake.
  const loose = newlyHanging(fenBefore, fenAfter, color);
  const stillLoose = loose.length > 0 ? loose : hangingPieces(fenAfter, color);
  const worst = stillLoose[0];
  if (worst) {
    const defence = worst.defended
      ? 'and the piece defending it is worth less than what they win'
      : 'and nothing is defending it';
    problems.push({
      rule: 'hangs-piece',
      sentence:
        `${capitaliseFirst(mine)} ${pieceWord(worst.piece)} on ${worst.square} can be taken by ` +
        `${theirs} ${pieceWord(worst.attackerPiece)} on ${worst.attackerSquare}, ${defence}.`,
      squares: [worst.square],
      severity: 100 + PIECE_VALUE[worst.piece],
    });
  }

  // Being forked.
  const fork = findForks(fenAfter, enemyOf(color))[0];
  if (fork) {
    const targets = fork.targets.map((t) => `${pieceWord(t.piece)} on ${t.square}`);
    problems.push({
      rule: 'allows-fork',
      sentence:
        `${capitaliseFirst(theirs)} ${pieceWord(fork.piece)} on ${fork.square} now forks ` +
        `${mine} ${joinTwo(targets)} — one piece attacking both at once.`,
      squares: [fork.square, ...fork.targets.map((t) => t.square)],
      severity: 95,
    });
  }

  // Being pinned.
  const pin = findPins(fenAfter, color)[0];
  if (pin) {
    problems.push({
      rule: 'allows-pin',
      sentence:
        `${capitaliseFirst(mine)} ${pieceWord(pin.piece)} on ${pin.square} is pinned by ` +
        `${theirs} ${pieceWord(pin.byPiece)} on ${pin.bySquare}` +
        (pin.absolute
          ? ' — it cannot legally move while the king is behind it.'
          : `, and moving it drops the ${pieceWord(pin.behindPiece)} behind it.`),
      squares: [pin.square],
      severity: 70,
    });
  }

  // A piece with nowhere to go.
  const trapped = findTrappedPieces(fenAfter, color)[0];
  if (trapped) {
    problems.push({
      rule: 'trapped-piece',
      sentence:
        `${capitaliseFirst(mine)} ${pieceWord(trapped.piece)} on ${trapped.square} is attacked ` +
        'and has no safe square to run to.',
      squares: [trapped.square],
      severity: 80,
    });
  }

  // The king.
  const safety = kingSafety(fenAfter, color);
  if (safety?.exposed) {
    problems.push({
      rule: 'weakens-king',
      sentence:
        `${capitaliseFirst(mine)} king on ${safety.square} is short of cover — ` +
        `${safety.shieldPawns === 0 ? 'no pawns' : 'only ' + safety.shieldPawns + ' pawn(s)'} ` +
        'in front of it, with enemy pieces bearing down.',
      squares: [safety.square],
      severity: 60,
    });
  }

  return problems.sort((a, b) => b.severity - a.severity);
}

function capitaliseFirst(text: string): string {
  return text.length === 0 ? text : text[0]!.toUpperCase() + text.slice(1);
}

/** Does the piece now on `square` attack something loose? */
export function threatCreatedBy(
  board: Chess,
  square: Square,
  color: Color,
): HangingPiece | null {
  const enemy: Color = color === 'w' ? 'b' : 'w';

  for (const row of board.board()) {
    for (const entry of row) {
      if (!entry || entry.color !== enemy) continue;
      if (!board.attackers(entry.square, color).includes(square)) continue;
      const hanging = hangingAt(board, entry.square);
      if (hanging) return hanging;
    }
  }

  return null;
}

function attacksAnyCentre(board: Chess, from: Square): boolean {
  return CENTRE_SQUARES.some((centre) => {
    const piece = board.get(from);
    if (!piece) return false;
    return board.attackers(centre, piece.color).includes(from);
  });
}

export function pieceWord(piece: PieceSymbol): string {
  return { p: 'pawn', n: 'knight', b: 'bishop', r: 'rook', q: 'queen', k: 'king' }[piece];
}

/** True when the enemy king has lost its pawn cover, roughly. */
export function kingIsExposed(fen: string, color: Color): boolean {
  const board = new Chess(fen);
  let kingSquare: Square | null = null;

  for (const row of board.board()) {
    for (const entry of row) {
      if (entry && entry.type === 'k' && entry.color === color) kingSquare = entry.square;
    }
  }
  if (!kingSquare) return false;

  const enemy: Color = color === 'w' ? 'b' : 'w';
  return board.attackers(kingSquare, enemy).length > 0;
}
