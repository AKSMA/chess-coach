/**
 * App shell and the move flow.
 *
 * The flow, per player move:
 *
 *   1. On the player's turn, analyse the position at MultiPV 3. That one result
 *      powers the warning check, the hint, and (in Milestone 2) the "better
 *      move" line.
 *   2. The player drags a move. Evaluate it — usually for free, by reusing the
 *      analysis from step 1 when the move is one of the top three.
 *   3. If warnings are on and the loss is bad enough, ask before committing.
 *      Nothing has been written to GameState yet, so "take it back" is free.
 *   4. Commit, classify, render.
 *   5. Opponent replies.
 */
import '@lichess-org/chessground/assets/chessground.base.css';
import '@lichess-org/chessground/assets/chessground.cburnett.css';
import './ui/theme.css';
import './ui/app.css';

import type { Square } from 'chess.js';
import { EngineClient, SearchCancelled, type Analysis } from './engine/EngineClient.js';
import { centipawnLoss, type Score } from './engine/score.js';
import { chooseOpponentMove, configureOpponent, levelConfig } from './engine/opponent.js';
import { GameState, describeResult, type Color, type MoveRecord } from './game/GameState.js';
import { classify, warrantsWarning } from './game/classify.js';
import { narrate, narrateOpponentMove, type Narration } from './coach/narrate.js';
import { isBookPosition } from './game/openings.js';
import { Board, highlightSquare, suggestionArrow, type PromotionPiece } from './ui/board.js';
import { CapturedTray } from './ui/captured.js';
import { Controls } from './ui/controls.js';
import { EvalBar, describeMaterial } from './ui/evalbar.js';
import { MoveList } from './ui/movelist.js';
import { CoachPanel, confirmRiskyMove } from './ui/panel.js';
import { gameAccuracy, moveAccuracy } from './game/accuracy.js';
import { RecallTracker } from './coach/recall.js';
import { emptyProfile, hasProfile, labelFor, recomputeProfile, type SkillProfile } from './history/profile.js';
import * as history from './history/db.js';
import { buildReview } from './history/review.js';
import { renderProgress } from './ui/progress.js';
import { renderSettings } from './ui/settings.js';
import { buildFacts } from './coach/facts.js';
import { polish } from './coach/polish.js';
import { loadLlmSettings, type LlmSettings } from './llm/registry.js';
import { ReplayView } from './ui/replay.js';
import { VERDICT_STYLE } from './game/classify.js';
import { Speaker, type SpeakHandle } from './ui/speech.js';
import { buildHint, hintUnavailableReason, type HintStage } from './coach/hint.js';
import {
  DEFAULT_HINT_ALLOWANCE,
  hintsRemaining,
  normaliseAllowance,
} from './game/hints.js';

/**
 * A deterministic opponent, for reproducing a game.
 *
 * Levels 1-3 sample randomly among the top moves, which makes any bug in the
 * ladder a dice roll to reproduce. `?seed=N` fixes the sequence so a run can
 * be replayed exactly — the browser harness relies on this, and it is the
 * difference between a real finding and noise.
 */
function seededRng(seed: number): () => number {
  let state = seed >>> 0 || 1;
  return () => {
    state = (state * 1103515245 + 12345) >>> 0;
    return state / 4294967296;
  };
}

/** Everything the narrator needs about a played move. */
interface Evaluation {
  bestScore: Score;
  scoreAfter: Score;
  bestSan: string | null;
  bestUci: string | null;
  /** How the opponent punishes it, in SAN, from the position after the move. */
  refutationSan: string[];
}

/** Budget for the pre-move warning check. Must resolve before the move lands. */
const WARNING_MOVETIME = 400;

/**
 * Hard cap on how long the game waits for the coach to stop talking. A
 * synthesiser that stalls must not be able to freeze the game.
 */
const MAX_SPEECH_WAIT = 20_000;
/** Budget for the richer analysis backing the coach panel. */
const COACH_MOVETIME = 700;

const STORAGE_KEY = 'chess-coach/settings';

interface Settings {
  playerColor: Color;
  level: number;
  warningsEnabled: boolean;
  speechEnabled: boolean;
  /** Hints allowed per game. `UNLIMITED` for no limit, 0 to switch them off. */
  hintAllowance: number;
  theme: 'light' | 'dark' | 'system';
}

function loadSettings(): Settings {
  const fallback: Settings = {
    playerColor: 'w',
    level: 3,
    warningsEnabled: true,
    speechEnabled: true,
    hintAllowance: DEFAULT_HINT_ALLOWANCE,
    theme: 'system',
  };
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const stored = raw ? { ...fallback, ...(JSON.parse(raw) as Partial<Settings>) } : fallback;
    // A stored allowance from an older build (or an edited localStorage) has to
    // land on one of the offered options, or the select shows nothing selected.
    return { ...stored, hintAllowance: normaliseAllowance(stored.hintAllowance) };
  } catch {
    return fallback;
  }
}

function saveSettings(settings: Settings): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // Private browsing or a full quota — settings simply don't persist.
  }
}

class App {
  #game = new GameState();
  #settings = loadSettings();
  #playerColor: Color;

  #analysisEngine = new EngineClient();
  #opponentEngine = new EngineClient();

  #board: Board;
  #evalBar: EvalBar;
  #moveList: MoveList;
  #captured: CapturedTray;
  #coach: CoachPanel;
  #controls: Controls;

  /** Analysis of the position the player is currently looking at. */
  #currentAnalysis: Analysis | null = null;
  #busy = false;
  /**
   * Bumped whenever the game is replaced or rewound. Async work started under
   * an older epoch must not touch the board when it lands.
   */
  #epoch = 0;
  #speaker: Speaker;
  /** Fixed by `?seed=`, otherwise Math.random. */
  #opponentRng: (() => number) | null = null;

  // --- History -----------------------------------------------------------
  #gameId = history.newGameId();
  #gameStartedAt = Date.now();
  #profile: SkillProfile = emptyProfile();
  #recall = new RecallTracker();
  /** Per-move accuracy for the game in progress. */
  #moveAccuracies: number[] = [];
  #gameRecorded = false;
  /*
   * Constructed in the constructor body, not here: field initialisers run
   * before the constructor appends the layout, so looking up #overlay at this
   * point throws and takes the whole app down with it.
   */
  #replay!: ReplayView;
  #view: 'play' | 'progress' | 'replay' | 'settings' = 'play';
  #llm: LlmSettings = loadLlmSettings();
  /** Aborts an in-flight polish when a newer move supersedes it. */
  #polishing: AbortController | null = null;
  /** The narration currently on screen, reused by the polish pass. */
  #lastNarration: Narration | null = null;
  /** The coach's current utterance. The board waits on this before moving on. */
  #speaking: SpeakHandle | null = null;

  // --- Hints ---------------------------------------------------------------
  /** Hints spent this game. Reset only by a new game, never by a take-back. */
  #hintsUsed = 0;
  /**
   * The position the hint on screen was given for, and how far it went.
   *
   * Both are needed to decide whether the next press escalates the same hint to
   * a reveal (free) or starts a new one (paid).
   */
  #hintFen: string | null = null;
  #hintStage: HintStage | null = null;
  /** True while a hint is waiting on the engine, so presses don't stack. */
  #hintPending = false;

  constructor(root: HTMLElement) {
    this.#playerColor = this.#settings.playerColor;
    root.append(this.#buildLayout());

    this.#board = new Board(query('#board'), this.#game, {
      onMove: (from, to, promotion) => this.#onPlayerMove(from, to, promotion),
    });
    this.#evalBar = new EvalBar(query('#evalbar'));
    this.#moveList = new MoveList(query('#movelist'));
    this.#captured = new CapturedTray(query('#captured-top'), query('#captured-bottom'));
    this.#coach = new CoachPanel(query('#coach'));
    this.#controls = new Controls(
      query('#controls'),
      {
        playerColor: this.#playerColor,
        level: this.#settings.level,
        warningsEnabled: this.#settings.warningsEnabled,
        speechEnabled: this.#settings.speechEnabled,
        hintAllowance: this.#settings.hintAllowance,
      },
      {
        onNewGame: () => void this.#newGame(),
        onUndo: () => void this.#undo(),
        onSwitchSides: () =>
          void this.#setPlayerColor(this.#playerColor === 'w' ? 'b' : 'w'),
        onHint: () => void this.#giveHint(),
        onHintAllowanceChange: (allowance) => {
          this.#settings.hintAllowance = normaliseAllowance(allowance);
          saveSettings(this.#settings);
          this.#updateHintControl();
        },
        onLevelChange: (level) => void this.#setLevel(level),
        onWarningsChange: (enabled) => {
          this.#settings.warningsEnabled = enabled;
          saveSettings(this.#settings);
        },
        onSpeechChange: (enabled) => {
          this.#settings.speechEnabled = enabled;
          this.#speaker.setEnabled(enabled);
          saveSettings(this.#settings);
        },
        onThemeToggle: () => this.#toggleTheme(),
      },
    );

    this.#replay = new ReplayView(query('#overlay'));

    const seed = Number(new URLSearchParams(location.search).get('seed'));
    if (Number.isFinite(seed) && seed > 0) this.#opponentRng = seededRng(seed);

    query<HTMLButtonElement>('#progress-button').addEventListener('click', () => {
      void this.#showProgress();
    });
    query<HTMLButtonElement>('#settings-button').addEventListener('click', () => {
      this.#showSettings();
    });

    this.#speaker = new Speaker(this.#settings.speechEnabled);
    this.#applyTheme();
    void this.#start();
  }

  async #start(): Promise<void> {
    this.#coach.setStatus('Loading engine');
    try {
      await Promise.all([this.#analysisEngine.init(), this.#opponentEngine.init()]);
      await this.#analysisEngine.setOption('MultiPV', 3);
      await configureOpponent(this.#opponentEngine, this.#settings.level);
    } catch (error) {
      this.#coach.setStatus('');
      this.#coach.render({
        headline: 'The engine could not start',
        body: [
          'Analysis is unavailable, so moves will not be scored. Run `npm run engine:fetch` and reload.',
          String(error),
        ],
      });
      return;
    }

    await this.#loadHistory();

    this.#coach.setStatus('');
    this.#applyPlayerColor();
    this.#loadFenFromUrl();
    this.#refresh();
    void this.#startTurn();
  }

  /**
   * Rebuilds the skill profile from stored games.
   *
   * History is optional throughout: private browsing and some webviews expose
   * `indexedDB` and then throw on use, and a coach that cannot remember is far
   * better than one that refuses to start.
   */
  async #loadHistory(): Promise<void> {
    if (!history.isAvailable()) return;
    try {
      const [games, moves] = await Promise.all([history.allGames(), history.allMoves()]);
      this.#profile = recomputeProfile(games, moves);
    } catch {
      this.#profile = emptyProfile();
    }
  }

  /** Writes one move as it is played, so a crash mid-game loses nothing. */
  #persistMove(record: MoveRecord): void {
    if (!history.isAvailable()) return;
    void history
      .putMove({
        id: `${this.#gameId}:${record.ply}`,
        gameId: this.#gameId,
        ply: record.ply,
        fenBefore: record.fenBefore,
        fenAfter: record.fenAfter,
        san: record.san,
        color: record.color,
        phase: record.phase,
        verdict: record.verdict,
        cpLoss: record.cpLoss,
        triggeredRules: record.triggeredRules,
        bestMoveSan: record.bestMoveSan,
        explanation: record.explanation,
      })
      .catch(() => undefined);
  }

  /**
   * Finalises the game record and rebuilds the profile.
   *
   * One pure `recomputeProfile` over everything stored, rather than an
   * incremental update: two ways of computing the same number is how the
   * progress view ends up disagreeing with the coach.
   */
  async #recordGameEnd(): Promise<void> {
    if (this.#gameRecorded || !history.isAvailable()) return;
    this.#gameRecorded = true;

    const playerMoves = this.#game.records.filter((r) => r.color === this.#playerColor);
    const losses = playerMoves.map((r) => r.cpLoss ?? 0);

    try {
      await history.putGame({
        id: this.#gameId,
        startedAt: this.#gameStartedAt,
        endedAt: Date.now(),
        playerColor: this.#playerColor,
        level: this.#settings.level,
        result: this.#game.result,
        pgn: this.#game.pgn,
        moveCount: this.#game.ply,
        accuracy: gameAccuracy(this.#moveAccuracies),
        avgCpLoss:
          losses.length === 0 ? 0 : Math.round(losses.reduce((a, b) => a + b, 0) / losses.length),
        openingName: this.#game.openingName,
      });
      await this.#loadHistory();
    } catch {
      // A failed write must not interrupt the game.
    }
  }

  /** `?fen=...` for repeatable manual checks of a known position. */
  #loadFenFromUrl(): void {
    const fen = new URLSearchParams(location.search).get('fen');
    if (!fen) return;

    if (this.#game.loadFen(fen)) {
      this.#playerColor = this.#game.turn;
      this.#board.setOrientation(this.#playerColor);
      this.#captured.setOrientation(this.#playerColor);
      // The board was built from the starting position; without this it keeps
      // showing it while GameState holds the loaded one, and every click misses.
      this.#board.sync();
    } else {
      this.#coach.render({
        headline: 'That FEN could not be loaded',
        body: ['Starting a normal game instead.'],
      });
    }
  }

  #buildLayout(): DocumentFragment {
    const template = document.createElement('template');
    template.innerHTML = `
      <div class="app">
        <header class="app-header">
          <h1 class="app-title">Chess Coach</h1>
          <p class="app-subtitle">Every move explained, as you play.</p>
          <button type="button" id="progress-button" class="btn btn-ghost">Progress</button>
          <button type="button" id="settings-button" class="btn btn-ghost">Coach voice</button>
        </header>
        <section id="overlay" hidden></section>
        <main class="app-main">
          <div class="board-column">
            <div id="captured-top"></div>
            <div class="board-row">
              <div id="evalbar"></div>
              <div id="board"></div>
            </div>
            <div id="captured-bottom"></div>
          </div>
          <div class="side-column">
            <section id="coach"></section>
            <section id="controls"></section>
            <section id="movelist"></section>
          </div>
        </main>
      </div>
    `;
    return template.content;
  }

  // --- Move flow ---------------------------------------------------------

  /** Pre-analyses the position the player is about to move in. */
  async #prepareTurn(): Promise<void> {
    if (this.#game.isGameOver || this.#game.turn !== this.#playerColor) return;

    try {
      this.#currentAnalysis = await this.#analysisEngine.analyse(this.#game.fen, {
        multiPv: 3,
        movetime: COACH_MOVETIME,
      });
      this.#evalBar.set(this.#currentAnalysis.lines[0]?.score ?? null);
    } catch (error) {
      if (!(error instanceof SearchCancelled)) throw error;
    }
  }

  async #onPlayerMove(from: Square, to: Square, promotion?: PromotionPiece): Promise<boolean> {
    if (this.#busy || this.#game.turn !== this.#playerColor) return false;

    const proposed = promotion ? { from, to, promotion } : { from, to };
    const peeked = this.#game.peek(proposed);
    if (!peeked) return false;

    this.#setBusy(true);
    this.#silenceCoach();
    this.#clearSuggestion();

    try {
      const mover = this.#game.turn;
      const legalMoveCount = this.#game.legalDests().size;
      const evaluation = await this.#evaluateCandidate(peeked.uci, peeked.fen);

      const cpLoss = evaluation
        ? centipawnLoss(evaluation.bestScore, evaluation.scoreAfter, mover)
        : 0;

      const verdict = classify(cpLoss, {
        isBook: isBookPosition(peeked.fen, this.#game.ply + 1),
        isForced: legalMoveCount === 1,
      });

      // Step 3: ask before committing. Nothing has been written yet.
      if (this.#settings.warningsEnabled && warrantsWarning(verdict)) {
        const proceed = await confirmRiskyMove(document.body, {
          san: peeked.san,
          verdict,
          reason: warningReason(cpLoss, evaluation?.bestSan ?? null),
        });
        if (!proceed) {
          this.#setBusy(false);
          return false;
        }
      }

      // Step 4: commit.
      const record = this.#game.play(proposed);
      if (!record) {
        this.#setBusy(false);
        return false;
      }

      record.cpLoss = cpLoss;
      record.verdict = verdict;
      record.evalAfter = evaluation?.scoreAfter ?? null;
      record.bestMoveSan = evaluation?.bestSan ?? null;

      this.#board.sync({ lastMove: [from, to] });
      this.#refresh();
      if (evaluation) {
        this.#moveAccuracies.push(
          moveAccuracy(evaluation.bestScore, evaluation.scoreAfter, mover),
        );
      }

      const spoken = this.#showVerdict(record, evaluation);
      this.#recall.noteTriggered(record.triggeredRules);
      this.#persistMove(record);
      this.#polishLater(record, evaluation);

      if (evaluation && verdict !== 'best' && evaluation.bestUci) {
        this.#showSuggestion(evaluation.bestUci);
      }

      // The coach starts talking, and the arrow stays up for exactly as long
      // as it keeps talking.
      this.#speakCoach(spoken, { clearShapesWhenDone: true });

      this.#setBusy(false);
      void this.#playOpponentMove();
      return true;
    } catch (error) {
      this.#setBusy(false);
      if (error instanceof SearchCancelled) return false;
      throw error;
    }
  }

  /**
   * Evaluates a candidate move.
   *
   * The cheap path matters: when the move is one of the three the engine
   * already looked at, its evaluation is in hand and no second search happens.
   * That is the common case for reasonable moves, and it's the difference
   * between a responsive board and one that stalls on every drag.
   */
  async #evaluateCandidate(
    uci: string,
    fenAfter: string,
  ): Promise<Evaluation | null> {
    const analysis = this.#currentAnalysis;
    if (!analysis || analysis.fen !== this.#game.fen || analysis.lines.length === 0) {
      return this.#evaluateByFreshSearch(uci, fenAfter);
    }

    const best = analysis.lines[0]!;
    const matching = analysis.lines.find((line) => line.uci[0] === uci);

    if (matching) {
      return {
        bestScore: best.score,
        scoreAfter: matching.score,
        bestSan: best.san[0] ?? null,
        bestUci: best.uci[0] ?? null,
        // The matching line already continues past our move, so the opponent's
        // punishment is simply the rest of it — no second search required.
        refutationSan: matching.san.slice(1),
      };
    }

    const fresh = await this.#analysisEngine.analyse(fenAfter, {
      multiPv: 1,
      movetime: WARNING_MOVETIME,
    });

    return {
      bestScore: best.score,
      scoreAfter: fresh.lines[0]?.score ?? best.score,
      bestSan: best.san[0] ?? null,
      bestUci: best.uci[0] ?? null,
      refutationSan: fresh.lines[0]?.san ?? [],
    };
  }

  /** Fallback when no pre-analysis was available (first move, or after undo). */
  async #evaluateByFreshSearch(
    uci: string,
    fenAfter: string,
  ): Promise<Evaluation | null> {
    const before = await this.#analysisEngine.analyse(this.#game.fen, {
      multiPv: 3,
      movetime: WARNING_MOVETIME,
    });
    const best = before.lines[0];
    if (!best) return null;

    const matching = before.lines.find((line) => line.uci[0] === uci);
    if (matching) {
      return {
        bestScore: best.score,
        scoreAfter: matching.score,
        bestSan: best.san[0] ?? null,
        bestUci: best.uci[0] ?? null,
        refutationSan: matching.san.slice(1),
      };
    }

    const after = await this.#analysisEngine.analyse(fenAfter, {
      multiPv: 1,
      movetime: WARNING_MOVETIME,
    });

    return {
      bestScore: best.score,
      scoreAfter: after.lines[0]?.score ?? best.score,
      bestSan: best.san[0] ?? null,
      bestUci: best.uci[0] ?? null,
      refutationSan: after.lines[0]?.san ?? [],
    };
  }

  async #playOpponentMove(): Promise<void> {
    if (this.#checkGameOver()) return;

    const epoch = this.#epoch;
    this.#setBusy(true);
    this.#board.setInteractive(false);
    this.#coach.setStatus('Thinking');

    try {
      const uci = await chooseOpponentMove(
        this.#opponentEngine,
        this.#game.fen,
        this.#settings.level,
        this.#opponentRng ?? Math.random,
      );

      // Starting a new game (or taking back) while the engine was thinking
      // must not drop its move into the position that replaced it.
      if (epoch !== this.#epoch) return;

      if (uci) {
        // Hold the suggestion arrow on screen long enough to actually be read
        // before the position moves on. The engine often replies in under half
        // a second, which would make the arrow flash past unseen.
        await this.#letCoachFinish();
        if (epoch !== this.#epoch) return;

        const from = uci.slice(0, 2) as Square;
        const to = uci.slice(2, 4) as Square;
        const promotion = uci.length > 4 ? (uci.slice(4, 5) as PromotionPiece) : undefined;

        // The arrow describes the position *before* your move. Once the
        // opponent replies it points at squares that mean something else, so
        // it goes before the board changes.
        this.#clearSuggestion();

        this.#game.play(promotion ? { from, to, promotion } : { from, to });
        this.#board.sync({ lastMove: [from, to] });
        this.#refresh();
        this.#narrateOpponentMove();

        // Their reply is stored too, after narration so any explanation goes
        // with it. Without this the history holds only your own moves, and
        // replay jumps two plies at a time — both sides appearing to move at
        // once on a single press.
        const reply = this.#game.records.at(-1);
        if (reply) this.#persistMove(reply);
      }
    } catch (error) {
      if (!(error instanceof SearchCancelled)) {
        this.#coach.render({
          headline: 'The opponent could not move',
          body: [String(error)],
        });
      }
    } finally {
      if (epoch === this.#epoch) {
        this.#coach.setStatus('');
        this.#setBusy(false);
        this.#board.setInteractive(true);
      }
    }

    if (epoch !== this.#epoch) return;
    if (this.#checkGameOver()) return;
    void this.#prepareTurn();
  }

  #checkGameOver(): boolean {
    if (!this.#game.isGameOver) return false;

    this.#board.setInteractive(false);
    void this.#finishGame();
    return true;
  }

  /** End-of-game summary, and the moment the profile is rebuilt. */
  async #finishGame(): Promise<void> {
    const alreadyRecorded = this.#gameRecorded;
    const praise = hasProfile(this.#profile)
      ? this.#recall.reinforcement(this.#profile)
      : null;

    await this.#recordGameEnd();

    if (alreadyRecorded) return;

    const accuracy = gameAccuracy(this.#moveAccuracies);
    const stored = history.isAvailable()
      ? await history.movesForGame(this.#gameId).catch(() => [])
      : [];
    const review = buildReview(stored, this.#playerColor, accuracy, this.#profile);

    const body = [
      `You played at ${accuracy}% accuracy across ${review.moveCount} moves — ` +
        `${review.bestMoveCount} of them the engine's first choice` +
        `${review.blunderCount > 0 ? `, and ${review.blunderCount} blunder${review.blunderCount > 1 ? 's' : ''}` : ''}.`,
    ];

    // The moments that actually decided the game.
    for (const point of review.turningPoints.slice(0, 3)) {
      const glyph = point.verdict ? VERDICT_STYLE[point.verdict].glyph : '';
      body.push(`Move ${Math.ceil(point.ply / 2)}, ${point.san} ${glyph} — the costliest moment.`);
      break;
    }

    if (praise) body.push(praise.text);
    for (const advice of review.workOn.slice(0, 2)) body.push(`Work on: ${advice}`);

    this.#coach.render({
      headline: describeResult(this.#game.result, this.#playerColor),
      body,
      takeaway: 'Open Progress to step back through this game with the coaching you were given.',
    });
  }

  // --- Rendering ---------------------------------------------------------

  /**
   * The only place `#busy` changes.
   *
   * Control enablement depends on it, so setting the flag without updating the
   * buttons leaves them stale — which is exactly how Take back ended up
   * permanently disabled: `#refresh()` ran mid-move while busy was true, and
   * nothing refreshed after the opponent's reply cleared it.
   */
  #setBusy(busy: boolean): void {
    this.#busy = busy;
    this.#controls.setUndoEnabled(this.#canUndo());
    this.#updateHintControl();
  }

  #canUndo(): boolean {
    return this.#game.ply > 0 && !this.#busy;
  }

  #refresh(): void {
    this.#moveList.render(this.#game.records);
    this.#captured.render(this.#game.fen);
    this.#controls.setUndoEnabled(this.#canUndo());
    this.#updateHintControl();

    const last = this.#game.records.at(-1);
    if (last?.evalAfter) this.#evalBar.set(last.evalAfter);
  }

  /** Runs the narrator over a committed player move and renders it. */
  #showVerdict(record: MoveRecord, evaluation: Evaluation | null): string[] {
    const narration = narrate({
      fenBefore: record.fenBefore,
      fenAfter: record.fenAfter,
      san: record.san,
      uci: record.uci,
      mover: record.color,
      playerColor: this.#playerColor,
      verdict: record.verdict ?? 'good',
      cpLoss: record.cpLoss ?? 0,
      bestUci: evaluation?.bestUci ?? null,
      bestSan: evaluation?.bestSan ?? null,
      refutationSan: evaluation?.refutationSan ?? [],
      openingName: this.#game.openingName,
    });

    record.triggeredRules = narration.triggeredRules;
    record.explanation = narration.body.join(' ');
    this.#lastNarration = narration;

    // The history-aware line, if the guardrails allow one. It replaces the
    // generic takeaway: being told "this is the fourth time" is strictly more
    // useful than the same principle restated.
    const callout = this.#recall.recurrence(this.#profile, narration.triggeredRules);
    const body = callout ? [...narration.body, callout.text] : narration.body;

    this.#coach.render({
      ...(record.verdict ? { verdict: record.verdict } : {}),
      mover: 'you',
      headline: narration.headline,
      body,
      ...(callout ? {} : narration.takeaway ? { takeaway: narration.takeaway } : {}),
    });

    return callout ? [...narration.speech, callout.text] : narration.speech;
  }

  /**
   * Asks the optional LLM layer to reword the explanation already on screen.
   *
   * Fire-and-forget: the rule text is rendered and spoken first, so this can
   * only ever improve the wording. Any failure — provider down, bad key, a
   * model that invented a square — leaves the rule text exactly where it is.
   */
  #polishLater(record: MoveRecord, evaluation: Evaluation | null): void {
    if (!this.#llm.enabled || this.#llm.mode !== 'always' || !this.#llm.model) return;

    const narration = this.#lastNarration;
    if (!narration) return;

    this.#polishing?.abort();
    const controller = new AbortController();
    this.#polishing = controller;

    const facts = buildFacts({
      narration,
      verdict: record.verdict ?? 'good',
      mover: 'you',
      san: record.san,
      uci: record.uci,
      fenBefore: record.fenBefore,
      fenAfter: record.fenAfter,
      bestSan: evaluation?.bestSan ?? null,
      bestUci: evaluation?.bestUci ?? null,
      refutationSan: evaluation?.refutationSan ?? [],
      openingName: this.#game.openingName,
      cpLoss: record.cpLoss ?? 0,
      habitSummary: this.#habitSummary(),
    });

    const epoch = this.#epoch;
    void polish(facts, this.#llm, () => undefined, controller.signal).then((result) => {
      // A newer move (or a new game) supersedes this rewrite.
      if (controller.signal.aborted || epoch !== this.#epoch) return;
      if (result.used !== 'llm') return;

      this.#coach.replaceBody(result.text);
      record.explanation = result.text;
    });
  }

  /** One line about recurring habits, for the LLM payload. */
  #habitSummary(): string | null {
    if (!hasProfile(this.#profile)) return null;
    const top = this.#profile.weaknesses[0];
    return top ? `They repeatedly struggle with ${labelFor(top)}.` : null;
  }

  /** Narrates what the opponent just did, and what it threatens. */
  #narrateOpponentMove(): void {
    const record = this.#game.records.at(-1);
    if (!record) return;

    const narration = narrateOpponentMove(
      record.fenBefore,
      record.fenAfter,
      record.uci,
      this.#playerColor,
    );

    // Ordinary replies get no commentary at all: the coaching on your own move
    // stays on screen instead of being buried under a running transcript.
    if (!narration) return;

    record.explanation = narration.body.join(' ');

    // Appended, not rendered: the coaching on your own move has to survive the
    // opponent's reply, which arrives within a few hundred milliseconds.
    this.#coach.appendFollowUp({
      mover: 'opponent',
      headline: narration.headline,
      body: narration.body,
    });

    if (narration.highlight.length > 0) {
      this.#board.setShapes(narration.highlight.map((square) => highlightSquare(square)));
    }

    this.#speakCoach(narration.speech, { clearShapesWhenDone: true });
  }

  // --- Hints ---------------------------------------------------------------

  /**
   * Points the player at something, when they are stuck.
   *
   * The first press on a position spends a hint and gives the nudge; a second
   * press on the *same* position escalates to the move itself for free. Moving
   * on retires the hint, so the next press starts a new one.
   */
  async #giveHint(): Promise<void> {
    // A second press while the first is still searching would supersede it, and
    // the cancelled search would report itself as a failure a moment before the
    // real hint arrived.
    if (this.#hintPending) return;

    const remaining = hintsRemaining(this.#settings.hintAllowance, this.#hintsUsed);
    const escalating = this.#hintFen === this.#game.fen && this.#hintStage === 'nudge';

    const blocked = hintUnavailableReason({
      gameOver: this.#game.isGameOver,
      playersTurn: this.#game.turn === this.#playerColor && !this.#busy,
      // An escalation is already paid for; a spent budget must not swallow it.
      remaining: escalating ? 1 : remaining,
    });

    if (blocked) {
      this.#coach.render({ headline: 'No hint just now', body: [blocked] });
      return;
    }

    const stage: HintStage = escalating ? 'reveal' : 'nudge';

    let analysis: Analysis | null;
    this.#hintPending = true;
    try {
      analysis = await this.#analysisForHint();
    } catch (error) {
      // Superseded by a new game or a move. Say nothing — the player has moved
      // on, and an error card about a hint they no longer want is just noise.
      if (error instanceof SearchCancelled) return;
      throw error;
    } finally {
      this.#hintPending = false;
    }

    const bestUci = analysis?.lines[0]?.uci[0];
    if (!bestUci) {
      this.#coach.render({
        headline: 'No hint just now',
        body: ['The engine did not come back with a move for this position.'],
      });
      return;
    }

    const hint = buildHint({
      fen: this.#game.fen,
      bestUci,
      playerColor: this.#playerColor,
      stage,
    });
    if (!hint) return;

    // Charge only for the nudge. The reveal is the same hint, escalated.
    if (stage === 'nudge') this.#hintsUsed++;
    this.#hintFen = this.#game.fen;
    this.#hintStage = stage;
    this.#updateHintControl();

    this.#silenceCoach();
    this.#coach.render({ headline: hint.headline, body: hint.body });

    this.#board.setShapes([
      ...hint.highlight.map((square) => highlightSquare(square, 'blue')),
      ...(hint.arrow ? [suggestionArrow(hint.arrow.from, hint.arrow.to)] : []),
    ]);

    // Unlike the post-move arrow, this one stays up after the coach stops
    // talking: it is there to be looked at while you decide what to play.
    this.#speakCoach(hint.speech);
  }

  /** The analysis a hint is built from — reused if it is already in hand. */
  async #analysisForHint(): Promise<Analysis | null> {
    const existing = this.#currentAnalysis;
    if (existing && existing.fen === this.#game.fen && existing.lines.length > 0) return existing;

    this.#coach.setStatus('Looking');
    try {
      const analysis = await this.#analysisEngine.analyse(this.#game.fen, {
        multiPv: 3,
        movetime: COACH_MOVETIME,
      });
      this.#currentAnalysis = analysis;
      return analysis;
    } finally {
      this.#coach.setStatus('');
    }
  }

  /** Keeps the hint button honest about what pressing it would do. */
  #updateHintControl(): void {
    const escalating = this.#hintFen === this.#game.fen && this.#hintStage === 'nudge';
    const usable =
      !this.#busy && !this.#game.isGameOver && this.#game.turn === this.#playerColor;

    this.#controls.setHints(
      this.#settings.hintAllowance,
      this.#hintsUsed,
      // An escalation stays clickable even on the last hint, since it is free.
      usable && (escalating || hintsRemaining(this.#settings.hintAllowance, this.#hintsUsed) > 0),
    );
  }

  /** Forgets the hint on screen, so the next press buys a fresh one. */
  #retireHint(): void {
    this.#hintFen = null;
    this.#hintStage = null;
  }

  // --- Suggestion arrows ---------------------------------------------------

  /**
   * Draws the "you should have played this" arrow and starts its dismissal.
   *
   * The arrow describes the position *before* the move, so it must not outlive
   * the coach's comment about that move — left up, it ends up pointing at
   * squares that now mean something entirely different.
   */
  #showSuggestion(bestUci: string): void {
    this.#board.setShapes([suggestionArrow(bestUci.slice(0, 2), bestUci.slice(2, 4))]);
  }

  #clearSuggestion(): void {
    this.#board.clearShapes();
  }

  /**
   * Says the explanation out loud and marks the panel as speaking.
   *
   * The handle is what the rest of the flow waits on: the arrow stays on the
   * board, and the opponent holds their reply, until the coach has finished.
   */
  #speakCoach(sentences: string[], options: { clearShapesWhenDone?: boolean } = {}): void {
    const handle = this.#speaker.speak(sentences);
    this.#speaking = handle;
    this.#coach.setSpeaking(true);

    void handle.finished.then(() => {
      // Only act if this utterance is still the current one — a newer move may
      // have superseded it while it was talking.
      if (this.#speaking !== handle) return;
      this.#coach.setSpeaking(false);
      if (options.clearShapesWhenDone) this.#clearSuggestion();
    });
  }

  /** Waits for the coach to stop talking, so the arrow is never cut short. */
  async #letCoachFinish(): Promise<void> {
    if (!this.#speaking) return;
    // Capped: a synthesiser that stalls must not freeze the game.
    await Promise.race([this.#speaking.finished, delay(MAX_SPEECH_WAIT)]);
  }

  /** Stops the coach mid-sentence — a new move supersedes the old explanation. */
  #silenceCoach(): void {
    this.#speaker.cancel();
    this.#speaking = null;
    this.#coach.setSpeaking(false);
  }

  // --- Commands ----------------------------------------------------------

  async #newGame(): Promise<void> {
    this.#analysisEngine.cancel();
    this.#opponentEngine.cancel();

    this.#epoch++;
    this.#game.reset();
    this.#gameId = history.newGameId();
    this.#gameStartedAt = Date.now();
    this.#moveAccuracies = [];
    this.#gameRecorded = false;
    this.#recall.reset();
    this.#currentAnalysis = null;
    // A fresh game is a fresh allowance. Take-backs deliberately do not refund
    // one: a hint you have already seen cannot be unseen, and refunding would
    // make take-back an unlimited hint button.
    this.#hintsUsed = 0;
    this.#retireHint();
    this.#setBusy(false);

    this.#silenceCoach();
    this.#board.sync();
    this.#clearSuggestion();
    this.#board.setInteractive(true);
    this.#evalBar.set(null);
    this.#coach.welcome();
    this.#refresh();

    await Promise.all([this.#analysisEngine.newGame(), this.#opponentEngine.newGame()]);
    void this.#startTurn();
  }

  /**
   * Chooses which side you play, which is what Flip now does.
   *
   * It starts a fresh game rather than rotating the current one: swapping
   * colours mid-game would hand you a position you did not play into.
   */
  async #setPlayerColor(color: Color): Promise<void> {
    this.#settings.playerColor = color;
    this.#playerColor = color;
    saveSettings(this.#settings);
    this.#applyPlayerColor();
    await this.#newGame();
  }

  #applyPlayerColor(): void {
    this.#board.setOrientation(this.#playerColor);
    this.#captured.setOrientation(this.#playerColor);
    this.#controls.setPlayerColor(this.#playerColor);
  }

  /**
   * Begins whoever's turn it is. Playing Black means the engine opens, so this
   * is the one place that has to handle "the game starts without you".
   */
  #startTurn(): void {
    if (this.#game.isGameOver) return;
    if (this.#game.turn === this.#playerColor) void this.#prepareTurn();
    else void this.#playOpponentMove();
  }

  async #undo(): Promise<void> {
    if (this.#busy || this.#game.ply === 0) return;

    this.#analysisEngine.cancel();
    this.#opponentEngine.cancel();

    this.#epoch++;
    this.#game.undoToPlayerTurn(this.#playerColor);
    this.#currentAnalysis = null;

    this.#silenceCoach();
    this.#board.sync();
    this.#clearSuggestion();
    this.#board.setInteractive(true);
    this.#coach.welcome();
    this.#refresh();

    this.#startTurn();
  }

  async #setLevel(level: number): Promise<void> {
    this.#settings.level = level;
    saveSettings(this.#settings);
    await configureOpponent(this.#opponentEngine, level);
    this.#coach.render({
      headline: `Level ${level} — ${levelConfig(level).label}`,
      body: [levelConfig(level).blurb],
    });
  }

  // --- Views ---------------------------------------------------------------

  async #showProgress(): Promise<void> {
    this.#silenceCoach();
    let games: history.StoredGame[] = [];
    let moves: history.StoredMove[] = [];
    if (history.isAvailable()) {
      try {
        [games, moves] = await Promise.all([history.allGames(), history.allMoves()]);
      } catch {
        // An unreadable history shows an empty progress screen, not an error.
      }
    }

    const finished = games.filter((g) => g.endedAt !== null);
    renderProgress(query('#overlay'), this.#profile, finished, moves, {
      onClose: () => this.#showPlay(),
      onReplay: (gameId) => void this.#showReplay(gameId),
    });
    this.#setView('progress');
  }

  async #showReplay(gameId: string): Promise<void> {
    let games: history.StoredGame[] = [];
    let moves: history.StoredMove[] = [];
    try {
      [games, moves] = await Promise.all([history.allGames(), history.movesForGame(gameId)]);
    } catch {
      return this.#showProgress();
    }

    const game = games.find((g) => g.id === gameId);
    if (!game) return this.#showProgress();

    this.#replay.render(game, moves, { onClose: () => void this.#showProgress() });
    this.#setView('replay');
  }

  #showSettings(): void {
    this.#silenceCoach();
    renderSettings(query('#overlay'), {
      onClose: () => this.#showPlay(),
      onChange: (settings) => {
        this.#llm = settings;
      },
    });
    this.#setView('settings');
  }

  #showPlay(): void {
    this.#replay.destroy();
    this.#setView('play');
  }

  #setView(view: 'play' | 'progress' | 'replay' | 'settings'): void {
    if (view !== 'replay' && this.#view === 'replay') this.#replay.destroy();
    this.#view = view;

    const overlay = query('#overlay');
    overlay.hidden = view === 'play';
    query('.app-main').classList.toggle('is-hidden', view !== 'play');
  }

  #toggleTheme(): void {
    const order: Settings['theme'][] = ['system', 'light', 'dark'];
    const next = order[(order.indexOf(this.#settings.theme) + 1) % order.length]!;
    this.#settings.theme = next;
    saveSettings(this.#settings);
    this.#applyTheme();
  }

  #applyTheme(): void {
    if (this.#settings.theme === 'system') {
      document.documentElement.removeAttribute('data-theme');
    } else {
      document.documentElement.setAttribute('data-theme', this.#settings.theme);
    }
  }
}

function warningReason(cpLoss: number, bestSan: string | null): string {
  const cost = describeMaterial(cpLoss);
  return bestSan
    ? `This looks like it costs you ${cost}. ${bestSan} keeps things together.`
    : `This looks like it costs you ${cost}.`;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function query<T extends HTMLElement>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`Missing element: ${selector}`);
  return element;
}

const root = document.querySelector<HTMLElement>('#app');
if (root) new App(root);
