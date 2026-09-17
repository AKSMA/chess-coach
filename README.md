# Chess Coach

A chess game that teaches while you play. Every move gets explained in plain
English: what it did to the position, what went wrong, and what would have been
better.

```bash
npm install     # also fetches the engine
npm run dev
```

## How it works

Three layers, deliberately separated:

- **Stockfish** supplies ground truth — evaluations, best moves, refutation lines.
- **A rule library** (`src/coach/`) reads the position with `chess.js` and turns
  those numbers into layman sentences.
- **An optional LLM layer** rephrases those sentences more warmly. It is handed
  only facts the first two layers established, and its output is validated
  against them before display — so no model can put a wrong chess claim on
  screen. The app is fully functional without it.

## Hints

When you are stuck, **Hint** works in two stages. The first press points at the
piece and says what its move achieves, without naming the move — you still have
to find it. Press again on the same position and the coach names the move and
draws the arrow.

Both stages are one hint. Charging for the reveal would just push people to
spend two hints to be sure, which defeats the budget.

**Hints per game** sets the allowance (none, 1, 3, 5, 10, or unlimited;
3 by default). A take-back does not refund a hint — a hint you have seen cannot
be unseen, and refunding would turn Take back into an unlimited hint button.

## Scripts

| Command | Does |
|---|---|
| `npm run dev` | Dev server |
| `npm test` | Unit tests (vitest) |
| `npm run typecheck` | Types only |
| `npm run engine:fetch` | Re-download the Stockfish WASM |
| `npm run engine:smoke` | Prove the engine boots and returns a legal move |
| `npm run e2e` | Drive the real app in headless Chrome (dev server must be running) |

## Browser checks

`scripts/e2e.mjs` drives the app in your installed Chrome over the DevTools
Protocol and screenshots each step into `.e2e/`. It has no dependencies —
`scripts/browser.mjs` is a small CDP client built on Node's global `WebSocket`
and `fetch`, so there is no Playwright or Puppeteer install to keep current.

Start the dev server first, then `npm run e2e`.

## The engine

`scripts/fetch-engine.mjs` downloads Stockfish 18.0.8 (lite, single-threaded —
~7 MB, needs no COOP/COEP headers) into `public/engine/`, pinned by SHA-256.
It runs on `postinstall`, and `public/engine/` is gitignored.

We deliberately don't depend on the `stockfish` npm package: its `files` field
is `["bin/"]`, so installing it pulls all five engine flavours (~251 MB) to use
7 MB of it.

Stockfish is GPL-3.0, © Chess.com, LLC.
