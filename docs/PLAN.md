# Chess Coach — a chess game that teaches while you play

## Context

You want to learn chess by playing it, with a coach that explains every move in
plain English: what the move did to the position, and what would have been
better. Nothing like this exists in your home directory yet — this is a
greenfield build.

The core insight driving the design: **a chess engine already knows the truth
about every move** (was that a blunder? what was best? what does the opponent do
to punish it?). What engines don't do is explain *why* in human terms. So the
architecture separates two jobs:

- **Stockfish** supplies ground truth — evaluations, best moves, refutation lines.
- **A rule library** reads the position with `chess.js` and turns those numbers
  into layman sentences ("you left your knight on f3 undefended, and Black's
  bishop takes it for free").

An optional LLM layer polishes the prose into warmer, more varied coaching, with
your choice of provider — Anthropic, OpenAI, Google, local models via Ollama,
Apple's on-device model, or anything OpenAI-compatible. The app is fully
functional and free without any of them. Ground truth never comes from the LLM —
it only rephrases facts the engine and rules already established, and its output
is **validated against those facts before display**, so no model (however small)
can put a wrong chess claim on screen.

Every game is **persisted with its per-move analysis**, which does two things a
one-off coach can't: it lets the coach teach from *your* recurring habits during
play ("this is the fourth time you've left a knight undefended"), and it gives
you a progress view showing whether you're actually getting better.

Confirmed decisions: browser web app, hybrid engine+rules coach with optional
pluggable LLM, play-and-coach scope (no separate tutorial module), blunder
warnings behind a "training wheels" toggle, high visual polish, and persistent
match history feeding both live coaching and progress tracking.

---

## Stack (all versions verified available)

| Piece | Choice | Why |
|---|---|---|
| Build | Vite 8 + TypeScript 7 | Dev server doubles as the LLM proxy host |
| Chess rules | `chess.js` 1.4.0 | Legal moves, SAN, and — key for the coach — `attackers(square, color)` and `isAttacked()` |
| Board UI | `chessground` 9.2.1 | Lichess's board. Zero deps, hardware-accelerated, and `setAutoShapes()` draws labelled arrows/highlights — essential for *showing* the better move, not just naming it |
| Engine | `stockfish` 18.0.8, `bin/stockfish-18-lite-single.{js,wasm}` | ~7 MB, single-threaded, **needs no COOP/COEP headers**. The full build is >100 MB and needs cross-origin isolation — not worth it |
| Pieces/CSS | `chessground/assets/*.css` | Pieces are embedded base64 SVGs — no asset pipeline, no broken images |
| Storage | IndexedDB via a ~60-line hand-rolled wrapper | Games with full per-move analysis outgrow `localStorage`'s 5 MB; only three object stores, so a dependency isn't worth it |
| LLM (optional) | `@anthropic-ai/sdk` for Claude; plain `fetch` for everything else | The other providers need only a request shape and a stream parser — pulling in four vendor SDKs would cost more than it saves |

The npm `stockfish` package ships a 251 MB `bin/` directory. A `postinstall`
script copies **only** the two lite-single files into `public/engine/`; never
bundle or commit `bin/`.

---

## Layout

```
chess-coach/
  vite.config.ts            # + /api/explain middleware (optional LLM)
  scripts/copy-engine.mjs   # postinstall: node_modules/stockfish/bin -> public/engine
  .env.local.example        # ANTHROPIC_API_KEY=
  src/
    engine/
      EngineClient.ts       # Worker + UCI protocol + serialized promise queue
      analysis.ts           # analyse(fen, {multiPv, depth}) -> Analysis
      opponent.ts           # difficulty ladder -> chosen move
      score.ts              # Score type + sign normalisation + mate handling
    game/
      GameState.ts          # chess.js wrapper, history, undo, per-move verdicts
      classify.ts           # centipawn loss -> verdict
      openings.ts           # ~40 common openings: FEN -> name
    coach/
      features.ts           # position detectors (the eyes)
      narrate.ts            # detectors + engine facts -> English (the voice)
      lessons.ts            # rule -> reusable takeaway principle
      recall.ts             # profile-aware callouts (the memory)
      verify.ts             # validate LLM prose against engine facts before display
      prompt.ts             # one shared prompt + per-provider capability hints
    llm/
      types.ts              # LlmProvider interface, ExplainRequest, ProviderStatus
      registry.ts           # provider list, selection, persistence, probe()
      anthropic.ts          # native Messages API (@anthropic-ai/sdk)
      openaiCompatible.ts   # OpenAI, Ollama, LM Studio, vLLM, OpenRouter, Groq, …
      gemini.ts             # Google's distinct request shape
      appleFoundation.ts    # stdio bridge to the Swift helper
  bridge-apple/             # OPTIONAL Swift package -> chesscoach-apple-llm binary
    Package.swift
    Sources/main.swift      # LanguageModelSession + streamResponse over stdio
    history/
      db.ts                 # IndexedDB wrapper: games, moves, profile
      profile.ts            # aggregate moves -> SkillProfile
      review.ts             # end-of-game report model
    ui/
      theme.css             # design tokens: colour, type, spacing, elevation
      board.ts              # chessground + custom theme + arrows + effects
      panel.ts              # coach card
      evalbar.ts controls.ts movelist.ts captured.ts
      progress.ts           # progress screen + charts
      replay.ts             # walk a stored game with its saved explanations
    main.ts
  index.html
```

---

## The parts that need care

### 1. Score sign normalisation (`engine/score.ts`)

This is the single biggest bug source in any engine integration, so it gets its
own module with tests. Stockfish reports `cp`/`mate` **from the side-to-move's
perspective**. Everything internally is stored **white-positive**:

```ts
type Score = { kind: 'cp'; cp: number } | { kind: 'mate'; moves: number };
// normalise: negate the engine's raw value when black is to move
// toCp(): mate-in-N becomes ±(10000 - N) so losses are comparable,
//         while the mate info is retained for narration
```

Centipawn loss for a move by `mover` is then
`(bestEvalWhitePov - actualEvalWhitePov) * (mover === 'w' ? 1 : -1)`, clamped at 0.

### 2. Engine client (`engine/EngineClient.ts`)

Wrap the worker in a class with a **strictly serialized request queue** — UCI is
stateful and interleaved `go` commands corrupt results. Run **two instances**:
`analysisEngine` and `opponentEngine`, so coaching analysis never fights the
opponent's search. Two 7 MB WASM instances is fine.

Handshake: `uci` → wait `uciok` → `setoption`s → `isready` → wait `readyok`.
Parse `info depth N multipv K score cp X pv e2e4 e7e5 …` and `bestmove`.
Convert PV UCI moves to SAN by replaying them on a scratch `Chess` instance —
the narrator needs SAN, and users read SAN.

### 3. Difficulty ladder (`engine/opponent.ts`)

Stockfish's `UCI_Elo` bottoms out at **1320** (verified in its source), which is
still far above a beginner. So the ladder has two regimes:

- **Levels 1–3 (beginner):** `MultiPV 5` at shallow depth, then pick a
  weighted-random move from the top 5, biased away from the best and with a cap
  on how much material it may throw away. This plays *weak but sane* chess.
  Crippling Stockfish with depth 1 instead produces bizarre blunders that teach
  nothing.
- **Levels 4–8:** `UCI_LimitStrength true` + `UCI_Elo` 1320→2200.
- **Levels 9–10:** full strength, depth/time limited.

### 4. Feature detectors (`coach/features.ts`) — the coach's eyes

Pure functions over `chess.js`. These are what let the coach say something
concrete instead of "the engine disagrees". Each returns a stable **rule id**,
because those ids are also the keys the history layer aggregates on.

- `hangingPiece` — for each piece, `attackers(sq, enemy)` non-empty and either
  undefended or the cheapest attacker is worth less than the target (a
  lightweight static-exchange approximation)
- `newlyHanging(before, after, color)` — the workhorse for "you just left that undefended"
- `allowsFork` / `missedFork` — one piece attacking ≥2 enemy pieces worth ≥3, or a king + anything
- `pin`, `discoveredAttack`
- `losesCentre`, `slowDevelopment` (minors off home squares, castled), `kingSafety`
  (enemy attackers on the 8 squares around the king, pawn shield intact)
- `material`, `mobility`, `passed/doubled/isolatedPawns`
- `createsThreat` — does the moved piece now attack something undefended and
  valuable, or give check
- `trappedPiece` — a piece whose every legal destination is attacked
- `missedMate`, `allowsMate`

### 5. The narrator (`coach/narrate.ts`) — the coach's voice

Composes 2–4 short sentences from ordered slots. Not every slot fires every move.

| Slot | Content |
|---|---|
| **verdict** | "That was the best move." / "Good move." / "Careful — that's a mistake." / "That's a blunder." Plus `Book` ("This is the Italian Game, a classic opening") and `Only move` |
| **what it did** | Always present, from the top *positive* feature delta — so even a bad move is described before it's criticised. "It develops your knight and eyes the centre." |
| **what went wrong** | Only above the inaccuracy threshold. Highest-priority triggered negative rule, by this order: allows mate → loses a piece outright → allows a fork/pin/discovered attack → walks into a losing capture → wrecks king safety → surrenders the centre / traps a piece / collapses mobility → generic fallback |
| **refutation** | Walk the engine PV 2–4 plies as prose: "Black replies Bxf7+, and after your king steps to e7, Black's queen picks up the rook." Skipped when the line isn't clear-cut |
| **better move** | Engine's best move **with a reason**, obtained by running the same positive detectors on *that* move: "d4 was stronger — it claims the centre and opens a path for your bishop." Drawn as a green labelled arrow on the board |
| **recall** | The history-aware line — see §7 below. Fires at most twice per game |
| **takeaway** | A reusable principle from `lessons.ts`, keyed to the triggered rule: "Before you move a piece, check whether its destination is defended by an enemy pawn." |

Plain-language rules, enforced in this module:

- **Piece names, not letters,** in the explanation body — "your knight on f3", not "Nf3".
  SAN stays only in move labels and the move list.
- **No unglossed jargon.** First mention of a term carries a parenthetical:
  "a fork (one piece attacking two at once)".
- **No raw numbers by default.** Translate centipawns into words — "this hands
  Black about the value of a knight" — behind a "show engine eval" toggle for later.
- **Narrate the opponent's move too.** Half the learning is understanding what was
  just done *to* you: "Black played Ng5, which attacks your undefended pawn on f7."

### 6. Move flow, and the warnings toggle

Per player move, using a **scratch** `new Chess(fen)` clone so a taken-back move
never touched real state:

1. On the player's turn, analyse position *P* at `MultiPV 3`. This one result
   powers the hint button, the warning check, and the "better move" line.
2. Player drags a move *M*. Analyse *P+M*. Compute centipawn loss.
3. If warnings are **on** and the loss crosses the mistake threshold: show
   "Are you sure? This loses your knight on f3" with **Play anyway / Take it back**.
   Both paths are cheap because nothing was committed.
4. Commit, narrate, draw arrows, append to the move list with a verdict badge,
   and write the move record to IndexedDB.
5. Opponent moves; narrate that too.

Warnings default **on** and are a single switch in the controls — training wheels
you turn off when you're ready for a real game.

Classification thresholds (Lichess-style, in centipawns lost):
`0–20` best/excellent · `20–50` good · `50–100` inaccuracy · `100–200` mistake ·
`200+` blunder. Overridden by `Book` and `Only move`.

---

## 7. Match history and the coach's memory

This is what makes the coach a *teacher* rather than a commentator.

### Storage (`history/db.ts`)

Three IndexedDB stores:

- **`games`** — `{ id, startedAt, endedAt, playerColor, level, result, pgn,
  moveCount, accuracy, avgCpLoss, openingName }`
- **`moves`** — indexed by `gameId` — `{ gameId, ply, fen, san, verdict, cpLoss,
  triggeredRules[], phase, bestMove, explanation }`. Persisting the rendered
  explanation means replay costs nothing and needs no re-analysis.
- **`profile`** — one derived record, recomputed after each game and updated
  incrementally during play.

Everything stays on your machine. The only thing that ever leaves is the optional
`/api/explain` call, which includes a short profile summary — flagged in the
settings copy so it isn't a surprise.

### The skill profile (`history/profile.ts`)

```ts
type SkillProfile = {
  gamesPlayed: number;
  ruleStats: Record<RuleId, { count; lastSeenGameId; last10Rate; trend }>;
  byPhase: Record<'opening'|'middlegame'|'endgame', { avgCpLoss; blunderRate }>;
  openings: Record<string, { games; avgCpLoss; typicalDriftPly }>;
  weaknesses: RuleId[];   // ranked, recency-weighted
  strengths: RuleId[];    // rules that used to fire and have stopped
  accuracyTrend: number[]; // per-game, for the chart
};
```

Ranking is **recency-weighted** — a habit you kicked ten games ago shouldn't be
the headline. `strengths` is derived from rules that *were* frequent and have
gone quiet; it's what powers positive reinforcement.

### How the coach uses it live (`coach/recall.ts`)

1. **Recurrence callout.** When a triggered rule is a top weakness: *"This is the
   fourth time you've left a knight undefended right after moving it — it's the
   pattern costing you the most games. Check the destination square first."*
2. **Pre-emptive nudge.** When the position matches a known weakness *before* you
   move — king still uncastled at move 12 and `kingSafety` is a top weakness — a
   quiet panel note, not a modal.
3. **Positive reinforcement.** When you avoid a mistake you've repeatedly made:
   *"You spotted that. The last three games you took that pawn and lost the rook —
   that's real progress."*
4. **Opening continuity.** *"You've played the Italian four times; last time you
   drifted around move 8. The main idea here is…"*
5. **Calibrated depth.** Rules you've mastered get one line; new weaknesses get
   the full refutation plus takeaway. Stops the coach re-explaining what you know.
6. **Feeds the LLM payload**, so the polished prose can weave history in naturally
   instead of appending it as a separate paragraph.

**Guardrails — without these it becomes nagging:** require ≥3 occurrences before
calling something a pattern; at most 2 recurrence callouts per game; never repeat
the same callout twice in one game; always pair a criticism with the concrete
check that prevents it. And with fewer than 3 games stored there is no profile —
the coach must behave generically rather than inventing history.

### End-of-game review (`history/review.ts`)

On game end: accuracy score, a verdict timeline strip you can click through, the
**three turning points** (largest eval swings), and "what to work on" pulled from
the profile. This is the moment the lesson lands, so it gets real design
attention rather than a stats dump.

### Progress screen (`ui/progress.ts`)

- Headline tiles: games played, accuracy trend, current level, best streak.
- Accuracy over time (line), mistake mix by rule (ranked bars with trend arrows),
  per-phase performance.
- **"Your top 3 things to work on"** in plain language — the single most useful
  thing on the page.
- Game list → click to open `replay.ts` and walk any past game with its saved
  explanations.

> **Load the `dataviz` skill before writing any chart code** — these charts need
> to read as one system with the app's theme, and it covers palette, axis, and
> accessibility rules.

---

## 8. Visual design

Treated as a first-class requirement, not styling applied at the end.

**Design tokens first (`ui/theme.css`).** A real token set — colour ramps,
type scale, spacing, radii, elevation, motion durations — defined before any
component CSS, with light and dark themes via `prefers-color-scheme` plus a
manual override. No ad-hoc hex values in component files.

**Board.** Chessground with a custom theme rather than the default brown: a
restrained two-tone surface with subtle grain, soft inner shadow at the edges,
coordinates set outside the playing area. `cburnett` pieces (embedded SVG, so
they always load); the piece set is a single swappable CSS file if you want a
different look later.

**Motion.** Chessground animates moves natively; on top of that:

- Piece **capture** fade-and-scale rather than a hard swap
- **Check** — a soft pulse ring on the king, not a jarring red square
- **Last move** trail plus origin/destination tint
- Coach arrows **draw in** over ~200 ms so the eye follows the suggestion
- Eval bar moves on a spring, so a swing is felt as well as read
- All of it honours `prefers-reduced-motion`

**Layout.** Board centre-stage at a fluid size (never a scrollbar, never a
squashed board); coach panel as an elevated card beside it; slim vertical eval
bar; move list with verdict chips; captured-piece tray with material
differential. Collapses to a single column on narrow screens with the board
first and the coach panel beneath.

**Verdict language must not rely on colour alone** — each verdict pairs a hue
with a glyph (★ best, ✓ good, ?! inaccuracy, ? mistake, ?? blunder), so it reads
correctly for colourblind users and in the move list at a glance. Contrast
targets meet WCAG AA.

---

## 9. Optional LLM polish — bring your own provider

### What makes this tractable

The coach's LLM task is deliberately tiny: **turn a JSON bag of established
facts into 2–3 sentences of plain prose.** No tool calling, no structured
output, no long context. Two consequences worth stating up front:

1. Every adapter is small — a request shape and a stream parser, nothing more.
2. **A 3–8B local model is genuinely good enough** for this. "Support open source
   models" is a real feature here, not a checkbox.

### Adapters (`src/llm/`)

One interface, four implementations:

```ts
interface LlmProvider {
  id: string; label: string; kind: 'cloud' | 'local';
  listModels?(): Promise<ModelInfo[]>;   // populate the model dropdown
  probe(): Promise<ProviderStatus>;      // reachable? key present? model pulled?
  explain(req: ExplainRequest, onDelta: (t: string) => void,
          signal: AbortSignal): Promise<string>;
}
```

| Adapter | Covers | Notes |
|---|---|---|
| `anthropic.ts` | Claude | Native Messages API via `@anthropic-ai/sdk`. `claude-opus-5`, `effort: "low"`, streamed, system prompt marked `cache_control` (well over the 512-token minimum, so every move after the first reads from cache) |
| `openaiCompatible.ts` | **OpenAI, Ollama, LM Studio, llama.cpp, vLLM, OpenRouter, Groq, Together, Mistral, DeepSeek, Azure** | The workhorse. Base URL + model + optional key. SSE stream, `data: [DONE]` terminator |
| `gemini.ts` | Google Gemini | `:streamGenerateContent`; distinct `contents`/`parts` shape, so it earns its own adapter |
| `appleFoundation.ts` | Apple on-device | stdio bridge — see below |

Everything OpenAI-compatible collapses into **one** adapter configured by base
URL, which is why the provider list can be long without the code being.
Verified endpoints: Ollama at `http://localhost:11434/v1/chat/completions` with
the key ignored (placeholder `"ollama"`); it also offers an Anthropic-compatible
endpoint if that ever proves a better fit.

Per-adapter **capability hints** in `coach/prompt.ts` — `supportsCaching`,
`supportsEffort`, `maxTokensField`, `acceptsTemperature` — keep one shared prompt
while honouring provider quirks (notably that OpenAI renamed `max_tokens` to
`max_completion_tokens` on newer models and reasoning models reject
`temperature`; the adapter carries a small per-model quirk table rather than
forking the prompt).

### Where the call happens — security boundary

- **Cloud providers:** the key must never reach the browser. Requests go through
  a `/api/llm` Vite middleware that reads keys from `.env.local`
  (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`, …) and streams the
  response back. This is the recommended path.
- **Local providers:** Ollama allows browser CORS from localhost by default
  (verified), so no key and no proxy are needed. Calls still route through the
  same proxy by default for one uniform code path, with a direct-from-browser
  toggle for people who'd rather skip the hop.
- Keys may alternatively be typed into the settings UI and kept in
  `localStorage` — convenient, but the UI says plainly that a key stored there
  lives in the browser. `.env.local` stays the default.

### Apple Foundation Models — the honest constraint

I checked this machine rather than assuming. The situation:

- ✅ **macOS 27.0**, comfortably above the `macOS 26.0+` requirement, and the
  on-device model assets are present (`…MobileAsset_UAF_FM_GenerativeModels`).
- ⚠️ The framework is **Swift-only. There is no HTTP endpoint and no CLI** — it
  cannot be called from a browser or from Node. Reaching it requires a small
  helper binary using `SystemLanguageModel.default.availability`,
  `LanguageModelSession`, and `streamResponse`, which `/api/llm` spawns and talks
  to over stdio (one JSON request per line, streamed text back).
- ⛔ **Your toolchain can't build that helper today.** You have Command Line
  Tools only — SDK 11.3, Swift 5.4, no Xcode — and `FoundationModels.framework`
  isn't in that SDK. It needs full Xcode, a multi-GB install.

So `bridge-apple/` is planned and wired behind the same `LlmProvider` interface,
but shipped as an **optional component built by `npm run build:apple`**. When the
binary is absent, `probe()` reports it and the settings UI greys the option out
with the actual reason ("needs Xcode to build the on-device bridge") rather than
failing mysteriously. Nothing else in the app depends on it, so this is cleanly
deferrable — installing Xcode is your call, not a prerequisite.

### The guardrail that makes small models safe (`coach/verify.ts`)

This is the piece that matters most once weak local models are in scope. A 3B
model *will* occasionally invent a square or contradict the verdict. So LLM prose
is validated before it reaches the screen:

- Every square reference (`[a-h][1-8]`) must be in an allowlist derived from the
  facts — the move's from/to, the PV squares, the pieces involved.
- Every SAN-looking token must be the played move, the best move, or a move in
  the supplied PV.
- The sentiment must not contradict the classification (no "nicely played" on a
  blunder), checked against a small lexicon.
- Length and sentence-count caps.

On any failure: silently fall back to the rule-based text, with the reason
surfaced in a dev-only panel. **The rule-based coach is always the floor**, so
the worst case for a bad model is plainer prose — never wrong chess.

### Cost, latency, and the on-demand switch

A game is ~40 moves and the coach narrates both sides, so a cloud provider means
~80 calls per game. Two controls:

- **Explain mode:** `always` (every move) or `on demand` (rule-based inline, LLM
  only when you click "explain more"). On demand defaults for cloud providers,
  always for local ones.
- Cache keyed by `fen|san|provider|model` in IndexedDB — replaying a game or
  revisiting a move costs nothing.

Local models trade first-token latency for being free and private; the settings
panel states that tradeoff per provider instead of making you discover it.

### Settings UI

Provider dropdown → base URL (prefilled per provider) → model (auto-populated
from `listModels()` for Ollama and OpenAI) → optional key → **Test connection**
button running `probe()`, reporting reachability, auth, and whether the model is
actually pulled. Suggested defaults per provider, and a note that the profile
summary is included in the payload when the LLM layer is on.

Render the rule-based text **immediately**, then stream the polished version over
it — the panel is never blank, and any provider failure degrades to the rules.

---

## Build order

1. Scaffold + design tokens + app shell. Board renders and enforces legal moves
   against `chess.js`. **Get the visual foundation right here** — retrofitting a
   token system later is the expensive path.
2. `EngineClient` + `score.ts` + tests. Engine plays a legal game at full strength.
3. Difficulty ladder + controls (new game, undo, flip, level).
4. `classify.ts`, eval bar, move list with verdict chips, captured tray. First
   real feedback.
5. `features.ts` + tests — the largest single chunk.
6. `narrate.ts` + `lessons.ts` + coach panel + board arrows and effects.
   **This is the product.**
7. Warnings toggle and the pre-move check.
8. `history/db.ts` + `profile.ts` — persist games and derive the profile.
9. `recall.ts` — the history-aware coaching lines, with the anti-nagging guardrails.
10. End-of-game review, then the progress screen and replay (load `dataviz` first).
11. LLM layer last, so it's provably additive: `llm/types.ts` + `registry.ts` +
    `coach/verify.ts` first, then `openaiCompatible.ts` (widest coverage, and
    testable against your already-installed Ollama with zero cost), then
    `anthropic.ts` and `gemini.ts`, then settings UI. `bridge-apple/` last and
    only if you decide to install Xcode.

---

## Verification

**Unit (`vitest`)** — the coach's correctness lives here, because a coach that
explains a position wrongly is worse than no coach:

- `score.ts`: black-to-move negation, mate-score conversion, loss is never negative.
- `classify.ts`: threshold boundaries.
- `features.ts`: each detector against hand-built FENs — a knight fork, a real
  pin vs a fake one, a piece defended by a pawn, a trapped bishop.
- `narrate.ts`: ~10 golden positions with snapshotted text, including the classic
  scholar's-mate blunder and one hanging-piece case. Assert the output names the
  right square and contains no unglossed jargon.
- `profile.ts`: seed synthetic game records, assert weakness ranking is
  recency-weighted and that a fixed habit migrates from `weaknesses` to `strengths`.
- `recall.ts`: the guardrails — no callout under 3 occurrences, max 2 per game,
  no duplicate callout, and **nothing at all on a cold profile**.
- `verify.ts`: the highest-value tests in the LLM layer. Feed it adversarial
  strings — an invented square, a SAN move not in the PV, "great move!" on a
  blunder, a rambling 10-sentence reply — and assert each is rejected and falls
  back. Then assert a good paraphrase passes untouched.
- Each adapter against a **recorded stream fixture** (SSE for OpenAI-compatible,
  NDJSON for Ollama's native route, Gemini's chunk shape), so parsing is tested
  without network or spend.

**Engine smoke test** — a node script that boots the WASM in a worker and asserts
`uciok`, then a legal `bestmove` from the start position. Catches a broken
`postinstall` copy before it wastes debugging time in the browser.

**End to end** — `npm run dev`, then:

1. Play `1. e4 e5 2. Nf3 Nc6 3. Bc4 Bc5 4. Nxe5??` — the coach must say the knight
   on e5 is now undefended, show `Nxe5` being answered by `Nxe5`, and name a
   better move with a reason.
2. Turn warnings on and repeat: the confirmation must appear *before* the move
   lands, and **Take it back** must leave the position and history untouched.
3. Set level 1, play 20 moves: the opponent should never hang a queen for nothing
   (validates the weighted-top-5 sampler over crippled-Stockfish).
4. Set level 10: it should punish `4. Nxe5??` immediately.
5. **History:** play three short games hanging a piece the same way each time. On
   game three the coach must name the recurring pattern; the progress screen must
   list it as a top weakness; then avoid it in game four and confirm the positive
   reinforcement fires.
6. **Replay:** open a finished game from the progress screen and step through it —
   the saved explanations must appear without re-running the engine.
7. Reload the browser mid-game and confirm history survived; clear site data and
   confirm the app cold-starts cleanly with a generic (not fabricated) coach.
8. **Visual:** check light and dark themes, a narrow viewport, and
   `prefers-reduced-motion`; confirm verdict chips are distinguishable in
   greyscale.
9. **Providers.** Start with Ollama, since it's already installed and free:
   `ollama serve`, then point the app at `glm-5.2` (already pulled) and confirm
   streamed explanations. Then swap provider to Anthropic or OpenAI with a key in
   `.env.local` and confirm the *same* move produces prose with the same chess
   facts — only the wording changes. Then break each one deliberately: stop
   Ollama, use a bad key, name a model that isn't pulled — each must surface a
   clear message from `probe()` and fall back to the rule-based coach rather than
   blanking the panel.
10. **Small-model safety.** Point at the smallest local model available and play
    20 moves watching for any claim `verify.ts` should have caught. Anything that
    slips through is a missing validation rule, and the fixture goes into the
    test suite.
11. With no provider configured at all, confirm the app is fully playable and the
    coach still explains every move.
12. Load `?fen=<known blunder position>` for repeatable manual checks.
