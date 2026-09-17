/**
 * A single Stockfish worker, wrapped so the rest of the app can `await` it.
 *
 * Two things this class exists to guarantee:
 *
 * 1. **Strict serialisation.** UCI is a stateful protocol over one stream.
 *    Interleaving two `go` commands doesn't give you two answers, it gives you
 *    one corrupted one. Every request goes through a promise queue.
 *
 * 2. **Cancellation.** The user can play a move before analysis of the previous
 *    one finishes. Superseded searches are stopped and their output discarded,
 *    rather than arriving late and rendering a stale explanation into the coach
 *    panel.
 */
import { Chess } from 'chess.js';
import { normalise, type Color, type Score } from './score.js';

/** Where `scripts/fetch-engine.mjs` puts the engine. Served verbatim from public/. */
const ENGINE_URL = '/engine/stockfish-18-lite-single.js';

export interface PvLine {
  /** 1-based rank of this line among the MultiPV results. */
  multipv: number;
  /** White-positive evaluation after this line. */
  score: Score;
  depth: number;
  /** The principal variation in UCI (`e2e4`), starting with the move itself. */
  uci: string[];
  /** The same line in SAN (`e4`), which is what humans read. */
  san: string[];
}

export interface Analysis {
  fen: string;
  sideToMove: Color;
  depth: number;
  /** Ranked best-first. Always at least one line for a legal, non-terminal position. */
  lines: PvLine[];
}

export interface SearchLimit {
  /** Search for a fixed wall-clock budget. Preferred — it bounds latency. */
  movetime?: number;
  /** Search to a fixed depth. Use for reproducible tests, not for UI paths. */
  depth?: number;
}

export interface AnalyseOptions extends SearchLimit {
  multiPv?: number;
}

/** Thrown when a search is superseded by a newer one. Callers normally ignore it. */
export class SearchCancelled extends Error {
  constructor() {
    super('search cancelled');
    this.name = 'SearchCancelled';
  }
}

type LineHandler = (line: string) => void;

export class EngineClient {
  #worker: Worker | null = null;
  #listeners = new Set<LineHandler>();

  /** Serialisation point: every request chains onto this. */
  #tail: Promise<unknown> = Promise.resolve();

  /** Bumped on cancellation so in-flight results can be identified as stale. */
  #generation = 0;

  /** True between `go` and the matching `bestmove`. */
  #searching = false;

  #ready: Promise<void> | null = null;

  /** Boots the worker and completes the UCI handshake. Idempotent. */
  init(): Promise<void> {
    this.#ready ??= this.#boot();
    return this.#ready;
  }

  async #boot(): Promise<void> {
    // A *classic* worker from a plain string URL. Deliberately not
    // `new URL(..., import.meta.url)` and not `?worker`: those make Vite try to
    // bundle the engine, which breaks its relative lookup of the .wasm sibling.
    this.#worker = new Worker(ENGINE_URL);
    this.#worker.onmessage = (ev: MessageEvent) => {
      const text = typeof ev.data === 'string' ? ev.data : String(ev.data ?? '');
      for (const line of text.split('\n')) {
        if (line.length > 0) for (const l of this.#listeners) l(line);
      }
    };

    this.#send('uci');
    await this.#await((l) => l.trim() === 'uciok');
    this.#send('isready');
    await this.#await((l) => l.trim() === 'readyok');
  }

  #send(cmd: string): void {
    this.#worker?.postMessage(cmd);
  }

  /** Resolves with the first line satisfying `pred`. */
  #await(pred: (line: string) => boolean): Promise<string> {
    return new Promise((resolve) => {
      const handler: LineHandler = (line) => {
        if (pred(line)) {
          this.#listeners.delete(handler);
          resolve(line);
        }
      };
      this.#listeners.add(handler);
    });
  }

  /** Queues `fn` so it cannot overlap any other engine request. */
  #enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.#tail.then(fn, fn);
    // Keep the chain alive regardless of individual failures.
    this.#tail = result.catch(() => undefined);
    return result;
  }

  /**
   * Abandons any in-flight search and invalidates its result.
   *
   * Safe to call at any time — if nothing is searching this is a no-op, and the
   * generation bump still causes any queued-but-not-started work to bail.
   */
  cancel(): void {
    this.#generation++;
    if (this.#searching) this.#send('stop');
  }

  async setOption(name: string, value: string | number | boolean): Promise<void> {
    await this.init();
    await this.#enqueue(async () => {
      this.#send(`setoption name ${name} value ${value}`);
      this.#send('isready');
      await this.#await((l) => l.trim() === 'readyok');
    });
  }

  /** Clears the transposition table and search history. Call between games. */
  async newGame(): Promise<void> {
    await this.init();
    await this.#enqueue(async () => {
      this.#send('ucinewgame');
      this.#send('isready');
      await this.#await((l) => l.trim() === 'readyok');
    });
  }

  /**
   * Analyses `fen` and returns the ranked lines.
   *
   * @throws {SearchCancelled} if `cancel()` is called before it completes.
   */
  async analyse(fen: string, options: AnalyseOptions = {}): Promise<Analysis> {
    await this.init();

    const multiPv = options.multiPv ?? 1;
    const generation = this.#generation;

    return this.#enqueue(async () => {
      // Bail without touching the engine if we were superseded while queued.
      if (generation !== this.#generation) throw new SearchCancelled();

      const sideToMove = sideToMoveOf(fen);
      const collected = new Map<number, PvLine>();
      let depth = 0;

      const collector: LineHandler = (line) => {
        if (!line.startsWith('info ')) return;
        const parsed = parseInfoLine(line, fen, sideToMove);
        if (parsed) {
          collected.set(parsed.multipv, parsed);
          depth = Math.max(depth, parsed.depth);
        }
      };

      this.#listeners.add(collector);
      this.#searching = true;
      try {
        this.#send(`setoption name MultiPV value ${multiPv}`);
        this.#send(`position fen ${fen}`);
        this.#send(`go ${limitToUci(options)}`);
        await this.#await((l) => l.startsWith('bestmove'));
      } finally {
        this.#searching = false;
        this.#listeners.delete(collector);
      }

      if (generation !== this.#generation) throw new SearchCancelled();

      const lines = [...collected.values()].sort((a, b) => a.multipv - b.multipv);
      return { fen, sideToMove, depth, lines };
    });
  }

  /** Convenience for the opponent: just the move it wants to play, in UCI. */
  async bestMove(fen: string, limit: SearchLimit = {}): Promise<string | null> {
    await this.init();
    const generation = this.#generation;

    return this.#enqueue(async () => {
      if (generation !== this.#generation) throw new SearchCancelled();

      this.#searching = true;
      let line: string;
      try {
        this.#send(`position fen ${fen}`);
        this.#send(`go ${limitToUci(limit)}`);
        line = await this.#await((l) => l.startsWith('bestmove'));
      } finally {
        this.#searching = false;
      }

      if (generation !== this.#generation) throw new SearchCancelled();

      const move = line.split(/\s+/)[1];
      return move && move !== '(none)' ? move : null;
    });
  }

  dispose(): void {
    this.cancel();
    this.#listeners.clear();
    this.#worker?.terminate();
    this.#worker = null;
    this.#ready = null;
  }
}

function limitToUci(limit: SearchLimit): string {
  if (limit.movetime !== undefined) return `movetime ${limit.movetime}`;
  if (limit.depth !== undefined) return `depth ${limit.depth}`;
  return 'movetime 500';
}

function sideToMoveOf(fen: string): Color {
  return fen.split(' ')[1] === 'b' ? 'b' : 'w';
}

/**
 * Parses one `info` line into a PvLine, or null if it isn't a scored PV line
 * (the engine also emits `info string ...`, `info currmove ...`, and depth-only
 * lines, none of which carry a variation).
 */
export function parseInfoLine(line: string, fen: string, sideToMove: Color): PvLine | null {
  const tokens = line.split(/\s+/);

  const readNumber = (key: string): number | undefined => {
    const i = tokens.indexOf(key);
    if (i === -1) return undefined;
    const value = Number(tokens[i + 1]);
    return Number.isFinite(value) ? value : undefined;
  };

  const depth = readNumber('depth');
  if (depth === undefined) return null;

  const scoreIndex = tokens.indexOf('score');
  if (scoreIndex === -1) return null;
  const scoreKind = tokens[scoreIndex + 1];
  const scoreValue = Number(tokens[scoreIndex + 2]);
  if ((scoreKind !== 'cp' && scoreKind !== 'mate') || !Number.isFinite(scoreValue)) return null;

  // A "lowerbound"/"upperbound" score is a search artefact, not an evaluation.
  if (tokens.includes('lowerbound') || tokens.includes('upperbound')) return null;

  const pvIndex = tokens.indexOf('pv');
  if (pvIndex === -1) return null;
  const uci = tokens.slice(pvIndex + 1).filter((t) => /^[a-h][1-8][a-h][1-8][qrbn]?$/.test(t));
  if (uci.length === 0) return null;

  return {
    multipv: readNumber('multipv') ?? 1,
    depth,
    score: normalise(scoreValue, scoreKind, sideToMove),
    uci,
    san: uciLineToSan(fen, uci),
  };
}

/**
 * Replays a UCI variation on a scratch board to recover SAN.
 *
 * The narrator needs SAN ("Nxe5"), and so does the move list — UCI ("g1f3") is
 * unreadable. Stops early on an illegal move rather than throwing: a truncated
 * line is still useful, and a PV can legitimately run past the point where our
 * replay diverges.
 */
export function uciLineToSan(fen: string, uci: string[]): string[] {
  const board = new Chess(fen);
  const san: string[] = [];

  for (const move of uci) {
    const from = move.slice(0, 2);
    const to = move.slice(2, 4);
    const promotion = move.length > 4 ? move.slice(4, 5) : undefined;
    try {
      const played = board.move(
        promotion ? { from, to, promotion } : { from, to },
      );
      san.push(played.san);
    } catch {
      break;
    }
  }

  return san;
}
