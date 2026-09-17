/**
 * End-to-end check of the Milestone 1 gate, in a real browser.
 *
 * Run the dev server first, then: node scripts/e2e.mjs
 * Screenshots land in .e2e/ (gitignored).
 */
import { mkdir, rm } from 'node:fs/promises';
import { Chess } from 'chess.js';
import { Browser, delay } from './browser.mjs';

const BASE = 'http://localhost:5173';
const SHOTS = '.e2e';

const results = [];
let browser;

function check(name, passed, detail = '') {
  results.push({ name, passed, detail });
  console.log(`${passed ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

/** Viewport coordinates of the centre of a square, honouring orientation. */
async function squareCenter(square) {
  return browser.evaluate(`
    const board = document.querySelector('cg-board');
    if (!board) return null;
    const rect = board.getBoundingClientRect();
    const orientation = document.querySelector('.cg-wrap').classList.contains('orientation-black')
      ? 'black' : 'white';
    const file = '${square}'.charCodeAt(0) - 97;
    const rank = Number('${square}'[1]) - 1;
    const col = orientation === 'white' ? file : 7 - file;
    const row = orientation === 'white' ? 7 - rank : rank;
    const size = rect.width / 8;
    return { x: rect.left + (col + 0.5) * size, y: rect.top + (row + 0.5) * size };
  `);
}

async function clickSquare(square) {
  const point = await squareCenter(square);
  if (!point) throw new Error(`Could not locate square ${square}`);
  await browser.click(point.x, point.y);
  await delay(120);
}

/** Click-move: select origin, then destination. */
async function playMove(from, to) {
  await clickSquare(from);
  await clickSquare(to);
}

const boardFen = () =>
  browser.evaluate(`
    const rows = [...document.querySelectorAll('cg-board piece')];
    return rows.length;
  `);

const coachText = () =>
  browser.evaluate(`return document.querySelector('.coach-card')?.innerText ?? '';`);

const moveListText = () =>
  browser.evaluate(`return document.querySelector('.movelist-body')?.innerText ?? '';`);

async function main() {
  await rm(SHOTS, { recursive: true, force: true });
  await mkdir(SHOTS, { recursive: true });

  browser = await Browser.launch();
  await browser.setViewport(1440, 960);

  // --- 1. The page renders at all -----------------------------------------
  await browser.goto(BASE);
  // Pieces are rendered a tick after cg-board appears, so wait for them.
  await browser.waitFor(`document.querySelectorAll('cg-board piece').length > 0`, {
    label: 'board to render pieces',
  });

  const pieceCount = await boardFen();
  check('Board renders with 32 pieces', pieceCount === 32, `found ${pieceCount}`);

  const title = await browser.evaluate(`return document.querySelector('.app-title')?.textContent;`);
  check('App shell renders', title === 'Chess Coach', `title="${title}"`);

  // --- 2. The engine actually boots ---------------------------------------
  // The coach shows an explicit failure card if the worker or wasm didn't load.
  await delay(2500);
  const afterBoot = await coachText();
  check(
    'Engine started (no failure card)',
    !afterBoot.includes('could not start'),
    afterBoot.split('\n')[0] ?? '',
  );

  await browser.screenshot(`${SHOTS}/01-initial.png`);

  // --- 3. A legal move commits and gets a verdict --------------------------
  await playMove('e2', 'e4');
  await browser.waitFor(`document.querySelector('.movelist-san') !== null`, {
    label: 'move to appear in the list',
  });

  const listAfterE4 = await moveListText();
  check('Player move appears in move list', listAfterE4.includes('e4'), listAfterE4.trim());

  const verdictShown = await browser.waitFor(
    `document.querySelector('.coach-verdict-label')?.textContent ?? ''`,
    { label: 'a verdict on the coach card' },
  );
  check('Move receives a verdict', Boolean(verdictShown), `verdict="${verdictShown}"`);

  // --- 4. The opponent replies --------------------------------------------
  const opponentReplied = await browser
    .waitFor(`document.querySelectorAll('.movelist-move').length >= 2`, {
      timeout: 25_000,
      label: 'opponent reply',
    })
    .then(() => true)
    .catch(() => false);
  check('Opponent replies', opponentReplied, await moveListText());

  await browser.screenshot(`${SHOTS}/02-after-first-moves.png`);

  // --- 4b. Take back works after the opponent has replied ------------------
  const undoEnabled = await browser.waitFor(
    `!document.querySelector('#undo-button').disabled`,
    { timeout: 20_000, label: 'Take back to become enabled' },
  )
    .then(() => true)
    .catch(() => false);
  check('Take back is enabled after the opponent replies', undoEnabled);

  if (undoEnabled) {
    const before = await browser.evaluate(
      `return document.querySelectorAll('.movelist-move').length;`,
    );
    await browser.evaluate(
      `document.querySelector('#undo-button').click(); return true;`,
    );
    await delay(1500);
    const after = await browser.evaluate(
      `return document.querySelectorAll('.movelist-move').length;`,
    );
    check('Take back actually retracts moves', after < before, `${before} -> ${after}`);

    // Replay a move so later steps have a game in progress.
    await playMove('d2', 'd4');
    await delay(2500);
  }

  // --- 4c. New game and Take back leave no stale highlights ---------------
  /*
   * Chessground recycles square elements: unused ones keep their class and are
   * hidden with `display: none` (util.setVisible), not by being removed and not
   * via `visibility`. Counting nodes — or filtering on the wrong property —
   * reports highlights that are not on screen.
   */
  const litSquares = () =>
    browser.evaluate(`
      return [...document.querySelectorAll('cg-board square.last-move')]
        .filter((el) => el.getClientRects().length > 0).length;
    `);

  check('A played move is highlighted', (await litSquares()) === 2, `${await litSquares()} lit`);

  await browser.evaluate(
    `document.querySelector('#new-game-button').click(); return true;`,
  );
  await delay(1200);
  const afterNewGame = await litSquares();
  check(
    'New game clears the previous game’s move highlight',
    afterNewGame === 0,
    `${afterNewGame} squares still lit`,
  );

  // Play a move, take it back, and confirm the highlight goes with it.
  await playMove('e2', 'e4');
  await browser.waitFor(`document.querySelectorAll('.movelist-move').length >= 1`, {
    timeout: 30_000,
    label: 'a move to replay after the new game',
  });
  await browser.waitFor(`!document.querySelector('#undo-button').disabled`, {
    timeout: 30_000,
    label: 'Take back to become available',
  });
  await browser.evaluate(
    `document.querySelector('#undo-button').click(); return true;`,
  );
  await delay(1200);
  const afterUndo = await litSquares();
  check('Take back clears the highlight too', afterUndo === 0, `${afterUndo} squares still lit`);

  // Restore a game in progress for the checks that follow.
  await playMove('d2', 'd4');
  await delay(2500);

  // --- 5. Illegal moves are refused ---------------------------------------
  await browser.waitFor(`!document.querySelector('#undo-button').disabled`, {
    timeout: 30_000,
    label: 'the position to settle before testing an illegal move',
  });
  const pliesBefore = await browser.evaluate(
    `return document.querySelectorAll('.movelist-move').length;`,
  );
  await playMove('a1', 'a5'); // rook through its own pawn
  await delay(900);
  const pliesAfter = await browser.evaluate(
    `return document.querySelectorAll('.movelist-move').length;`,
  );
  check('Illegal move is refused', pliesAfter === pliesBefore, `${pliesBefore} -> ${pliesAfter}`);

  // --- 6. Eval bar responds ------------------------------------------------
  const evalHeight = await browser.evaluate(
    `return document.querySelector('.evalbar-fill')?.style.height ?? '';`,
  );
  check('Eval bar reflects the position', evalHeight !== '' && evalHeight !== '50%', `height=${evalHeight}`);

  // --- 7. Captured tray ----------------------------------------------------
  const trayExists = await browser.evaluate(
    `return document.querySelectorAll('.captured').length === 2;`,
  );
  check('Captured trays are present', trayExists);

  // --- 8. The blunder warning ---------------------------------------------
  // Load the Giuoco Piano position where 4.Nxe5 drops a piece.
  const blunderFen = 'r1bqk1nr/pppp1ppp/2n5/2b1p3/2B1P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 4 4';
  await browser.goto(`${BASE}/?fen=${encodeURIComponent(blunderFen)}`);
  await browser.waitFor(`document.querySelectorAll('cg-board piece').length > 0`);
  await delay(3000);

  await playMove('f3', 'e5'); // Nxe5??
  const warningAppeared = await browser
    .waitFor(`document.querySelector('.warning-dialog') !== null`, {
      timeout: 15_000,
      label: 'blunder warning',
    })
    .then(() => true)
    .catch(() => false);
  check('Blunder warning appears before the move lands', warningAppeared);

  if (warningAppeared) {
    await browser.screenshot(`${SHOTS}/03-warning.png`);

    const warningText = await browser.evaluate(
      `return document.querySelector('.warning-dialog')?.innerText ?? '';`,
    );
    check('Warning explains the cost', /costs you/i.test(warningText), warningText.replace(/\n/g, ' | '));

    // Accept the blunder so the coach has to explain it.
    await browser.evaluate(
      `document.querySelectorAll('.warning-actions .btn')[1].click(); return true;`,
    );
    await browser.waitFor(`document.querySelectorAll('.movelist-move').length > 0`, {
      label: 'the blunder to commit',
    });

    const explanation = await coachText();
    check(
      'Coach describes the move in words, not notation',
      /took their pawn on e5 with your knight/i.test(explanation),
      explanation.replace(/\n/g, ' | ').slice(0, 160),
    );
    check(
      'Coach explains what is wrong, naming the piece and attacker',
      /e5/.test(explanation) && /knight/i.test(explanation) && /c6/.test(explanation),
    );
    check(
      'Coach says what would have been better, and why',
      /stronger was to have/i.test(explanation),
    );
    check('Coach gives a takeaway', await browser.evaluate(
      `return document.querySelector('.coach-takeaway') !== null;`,
    ));
    check(
      'Explanation is more than one sentence',
      explanation.split('.').filter((s) => s.trim().length > 8).length >= 3,
      `${explanation.split('.').filter((s) => s.trim().length > 8).length} sentences`,
    );
    await browser.screenshot(`${SHOTS}/08-coach-explanation.png`);

    // The suggestion arrow must not outlive the coach's comment.
    // chessground v10 renders auto-shapes into `svg.cg-shapes > g`.
    const arrowShown = await browser.evaluate(
      `return (document.querySelector('svg.cg-shapes g')?.children.length ?? 0) > 0;`,
    );
    check('Suggestion arrow is drawn', arrowShown);

    const arrowCleared = await browser
      .waitFor(
        `(document.querySelector('svg.cg-shapes g')?.children.length ?? 0) === 0`,
        { timeout: 40_000, label: 'the suggestion arrow to clear itself' },
      )
      .then(() => true)
      .catch(() => false);
    check('Suggestion arrow disappears on its own', arrowCleared);

    // Reload for the take-back-from-warning check below.
    await browser.goto(`${BASE}/?fen=${encodeURIComponent(blunderFen)}`);
    await browser.waitFor(`document.querySelectorAll('cg-board piece').length > 0`);
    await delay(3000);
    await playMove('f3', 'e5');
    await browser.waitFor(`document.querySelector('.warning-dialog') !== null`, {
      timeout: 15_000,
      label: 'blunder warning (second pass)',
    });

    // "Take it back" must leave position and history untouched.
    await browser.evaluate(
      `document.querySelectorAll('.warning-actions .btn')[0].click(); return true;`,
    );
    await delay(1200);

    const movesAfterTakeBack = await browser.evaluate(
      `return document.querySelectorAll('.movelist-move').length;`,
    );
    const piecesAfterTakeBack = await boardFen();
    check(
      'Take it back leaves history untouched',
      movesAfterTakeBack === 0,
      `${movesAfterTakeBack} moves recorded`,
    );
    // Nothing has been captured in the Giuoco Piano, so all 32 are still on.
    check(
      'Take it back leaves the position untouched',
      piecesAfterTakeBack === 32,
      `${piecesAfterTakeBack} pieces on board`,
    );
    await browser.screenshot(`${SHOTS}/04-after-take-back.png`);
  }

  // --- 8b. Hints ------------------------------------------------------------
  /*
   * The two stages have to stay distinct on the board, not just in the text:
   * a nudge that draws the arrow has already answered the position.
   */
  await browser.goto(`${BASE}/?fen=${encodeURIComponent(blunderFen)}`);
  await browser.waitFor(`document.querySelectorAll('cg-board piece').length > 0`);
  await delay(3000);

  const hintLabel = () => browser.evaluate(`return document.querySelector('#hint-button').textContent;`);
  const hintShapes = () =>
    browser.evaluate(`return document.querySelector('svg.cg-shapes g')?.innerHTML ?? '';`);
  const pressHint = async () => {
    await browser.evaluate(`document.querySelector('#hint-button').click(); return true;`);
    await delay(1500);
  };

  check('Hint button shows the allowance', /Hint \(3\)/.test(await hintLabel()), await hintLabel());

  await pressHint();
  const nudgeText = await coachText();
  const nudgeShapes = await hintShapes();

  check(
    'A hint points at a piece in plain language',
    /Have a look at your/i.test(nudgeText),
    nudgeText.replace(/\n/g, ' | ').slice(0, 140),
  );
  check('The nudge rings the piece', /<circle/.test(nudgeShapes));
  check('The nudge does not draw the move', !/<line/.test(nudgeShapes));
  check('Asking for a hint spends one', /Hint \(2\)/.test(await hintLabel()), await hintLabel());

  await pressHint();
  const revealText = await coachText();
  check('Asking again names the move', /^The move/im.test(revealText) || /castle|move your|take their/i.test(revealText),
    revealText.replace(/\n/g, ' | ').slice(0, 140));
  check('The reveal draws the arrow', /<line/.test(await hintShapes()));
  check(
    'The reveal is free — the same hint, escalated',
    /Hint \(2\)/.test(await hintLabel()),
    await hintLabel(),
  );
  await browser.screenshot(`${SHOTS}/08b-hint.png`);

  // Lower the allowance mid-game: two are already spent, so none are left.
  await browser.evaluate(`
    const select = document.querySelector('#hint-select');
    select.value = '1';
    select.dispatchEvent(new Event('change'));
    return true;
  `);
  await delay(300);
  const lowered = await hintLabel();
  check('Lowering the allowance below what is spent leaves none', /No hints left/.test(lowered), lowered);
  check(
    'A spent hint button is disabled',
    await browser.evaluate(`return document.querySelector('#hint-button').disabled;`),
  );

  // Switching hints off entirely says so rather than showing "0".
  await browser.evaluate(`
    const select = document.querySelector('#hint-select');
    select.value = '0';
    select.dispatchEvent(new Event('change'));
    return true;
  `);
  await delay(300);
  check('Hints can be switched off', /Hints off/.test(await hintLabel()), await hintLabel());

  // A new game is a fresh allowance.
  await browser.evaluate(`
    const select = document.querySelector('#hint-select');
    select.value = '3';
    select.dispatchEvent(new Event('change'));
    return true;
  `);
  await browser.evaluate(`document.querySelector('#new-game-button').click(); return true;`);
  await delay(1500);
  check('A new game restores the allowance', /Hint \(3\)/.test(await hintLabel()), await hintLabel());

  // --- 9. Promotion picker -------------------------------------------------
  await browser.goto(`${BASE}/?fen=${encodeURIComponent('8/P7/8/4k3/8/8/8/K7 w - - 0 1')}`);
  await browser.waitFor(`document.querySelectorAll('cg-board piece').length > 0`);
  await delay(2500);

  await playMove('a7', 'a8');
  const pickerAppeared = await browser
    .waitFor(`document.querySelector('.promotion-panel') !== null`, {
      timeout: 10_000,
      label: 'promotion picker',
    })
    .then(() => true)
    .catch(() => false);
  check('Promotion picker appears', pickerAppeared);

  if (pickerAppeared) {
    const choices = await browser.evaluate(
      `return [...document.querySelectorAll('.promotion-choice')].map(b => b.dataset.piece).join(',');`,
    );
    check('Promotion offers all four pieces', choices === 'q,r,b,n', choices);
    await browser.screenshot(`${SHOTS}/05-promotion.png`);

    // Escape must cancel without promoting.
    await browser.pressKey('Escape');
    await delay(800);
    const cancelled = await browser.evaluate(
      `return document.querySelector('.promotion-panel') === null
        && document.querySelectorAll('.movelist-move').length === 0;`,
    );
    check('Escape cancels promotion without moving', cancelled);

    // Under-promote to a knight. Note this is itself a blunder here — it throws
    // away a winning queen — so the warning fires on the promotion, which is
    // the correct behaviour and has to be accepted before the move lands.
    await playMove('a7', 'a8');
    await browser.waitFor(`document.querySelector('.promotion-panel') !== null`);
    await browser.evaluate(
      `document.querySelector('.promotion-choice[data-piece="n"]').click(); return true;`,
    );

    const promotionWarned = await browser
      .waitFor(`document.querySelector('.warning-dialog') !== null`, {
        timeout: 15_000,
        label: 'warning on a losing under-promotion',
      })
      .then(() => true)
      .catch(() => false);
    check('Under-promotion that loses material is warned about', promotionWarned);

    if (promotionWarned) {
      await browser.evaluate(
        `document.querySelectorAll('.warning-actions .btn')[1].click(); return true;`,
      );
    }

    await browser.waitFor(`document.querySelectorAll('.movelist-move').length > 0`, {
      timeout: 15_000,
      label: 'the promotion to commit',
    });
    const knightPromotion = await moveListText();
    check('Under-promotion to a knight works', knightPromotion.includes('a8=N'), knightPromotion.trim());
    await browser.screenshot(`${SHOTS}/06-underpromotion.png`);
  }

  // --- 9b. Flip chooses your side -------------------------------------------
  await browser.goto(BASE);
  await browser.waitFor(`document.querySelectorAll('cg-board piece').length > 0`);
  await delay(2500);

  const flipLabel = await browser.evaluate(
    `return document.querySelector('#flip-button').textContent;`,
  );
  check('Flip button names the side it switches to', /Play as Black/.test(flipLabel), flipLabel);

  await browser.evaluate(
    `document.querySelector('#flip-button').click(); return true;`,
  );

  // White is the engine now, so a move must appear without the player acting.
  const engineOpened = await browser
    .waitFor(`document.querySelectorAll('.movelist-move').length >= 1`, {
      timeout: 30_000,
      label: 'the engine to open as White',
    })
    .then(() => true)
    .catch(() => false);
  check('Flipping to Black makes the engine move first', engineOpened, await moveListText());

  const asBlack = await browser.evaluate(`return JSON.stringify({
    orientedBlack: document.querySelector('.cg-wrap').classList.contains('orientation-black'),
    label: document.querySelector('#flip-button').textContent,
  });`);
  const black = JSON.parse(asBlack);
  check('Board orients to Black when playing Black', black.orientedBlack);
  check('Flip button now offers White', /Play as White/.test(black.label), black.label);
  await browser.screenshot(`${SHOTS}/09-as-black.png`);

  // --- 9c. Muted coach moves on after a fixed beat --------------------------
  await browser.goto(`${BASE}/?fen=${encodeURIComponent(blunderFen)}`);
  await browser.waitFor(`document.querySelectorAll('cg-board piece').length > 0`);
  await delay(3000);

  // Turn the voice off — the board should stop waiting on speech.
  await browser.evaluate(
    `const boxes = document.querySelectorAll('.controls-toggle input');
     if (boxes[1].checked) boxes[1].click();
     return true;`,
  );

  await playMove('f3', 'e5');
  await browser.waitFor(`document.querySelector('.warning-dialog') !== null`, {
    timeout: 15_000,
    label: 'warning before the muted-coach check',
  });
  await browser.evaluate(
    `document.querySelectorAll('.warning-actions .btn')[1].click(); return true;`,
  );
  await browser.waitFor(`document.querySelectorAll('.movelist-move').length > 0`, {
    label: 'the blunder to commit',
  });

  const mutedStart = Date.now();
  const opponentMoved = await browser
    .waitFor(`document.querySelectorAll('.movelist-move').length >= 2`, {
      timeout: 12_000,
      label: 'the opponent to reply while the coach is muted',
    })
    .then(() => true)
    .catch(() => false);
  const elapsed = Date.now() - mutedStart;

  check('Muted coach still lets the opponent reply', opponentMoved, `${elapsed}ms`);
  check(
    'Muted reply lands on a short fixed beat, not a speech-length wait',
    opponentMoved && elapsed < 9000,
    `${elapsed}ms`,
  );

  const mutedArrowCleared = await browser
    .waitFor(`(document.querySelector('svg.cg-shapes g')?.children.length ?? 0) === 0`, {
      timeout: 15_000,
      label: 'the arrow to clear while muted',
    })
    .then(() => true)
    .catch(() => false);
  check('Arrow is removed once the muted beat elapses', mutedArrowCleared);

  // --- 9d. Level 1 plays weak but sane chess --------------------------------
  // The whole point of the weighted-sampler ladder is that a beginner opponent
  // makes plausible mistakes rather than donating pieces. Twenty moves of real
  // play is the only way to see that.
  // Seeded so the sampler is reproducible: without it a failure here cannot be
  // told apart from a dice roll.
  await browser.goto(`${BASE}/?seed=7`);
  await browser.waitFor(`document.querySelectorAll('cg-board piece').length > 0`);
  await delay(2500);

  await browser.evaluate(`
    const level = document.querySelector('#level-select');
    level.value = '1';
    level.dispatchEvent(new Event('change'));
    // Warnings and speech only slow the loop down.
    for (const box of document.querySelectorAll('.controls-toggle input')) {
      if (box.checked) box.click();
    }
    return true;
  `);
  await delay(1200);

  /*
   * chessground's getFen() returns piece placement only, so the side to move
   * has to come from elsewhere. It is derived from the ply count rather than
   * assumed: settings persist in localStorage, so an earlier check may have
   * left this session playing Black with the engine opening.
   */
  const boardFenOf = async () => {
    const placement = await browser.evaluate(`return window.__cg.getFen();`);
    const plies = await browser.evaluate(
      `return document.querySelectorAll('.movelist-move').length;`,
    );
    return `${placement} ${plies % 2 === 0 ? 'w' : 'b'} - - 0 1`;
  };

  /** True when the side's queen is attacked and undefended. */
  const queenIsHanging = (fen, color) => {
    const board = new Chess(fen);
    for (const row of board.board()) {
      for (const entry of row) {
        if (!entry || entry.type !== 'q' || entry.color !== color) continue;
        const enemy = color === 'w' ? 'b' : 'w';
        const attacked = board.attackers(entry.square, enemy).length > 0;
        const defended = board.attackers(entry.square, color).length > 0;
        if (attacked && !defended) return entry.square;
      }
    }
    return null;
  };

  // A deterministic pseudo-random pick, so a failure is reproducible.
  let seed = 12345;
  const nextRandom = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };

  // Whoever we are not.
  const engineColor =
    (await browser.evaluate(
      `return document.querySelector('#flip-button').dataset.playing;`,
    )) === 'w'
      ? 'b'
      : 'w';

  let hungQueen = null;
  let playedPairs = 0;

  for (let i = 0; i < 20; i++) {
    const fen = await boardFenOf();
    const board = new Chess(fen);
    const moves = board.moves({ verbose: true }).filter((m) => !m.promotion);
    if (moves.length === 0) break;

    const chosen = moves[Math.floor(nextRandom() * moves.length)];
    const before = await browser.evaluate(
      `return document.querySelectorAll('.movelist-move').length;`,
    );

    await playMove(chosen.from, chosen.to);
    const advanced = await browser
      .waitFor(`document.querySelectorAll('.movelist-move').length >= ${before + 2}`, {
        timeout: 20_000,
        label: 'level-1 move pair',
      })
      .then(() => true)
      .catch(() => false);
    if (!advanced) break;

    playedPairs++;
    hungQueen = queenIsHanging(await boardFenOf(), engineColor);
    if (hungQueen) break;
  }

  check(
    'Level 1 plays a real game without hanging its queen',
    playedPairs >= 8 && !hungQueen,
    hungQueen
      ? `queen left hanging on ${hungQueen} after ${playedPairs} move pairs`
      : `${playedPairs} move pairs played`,
  );
  await browser.screenshot(`${SHOTS}/10-level-one.png`);

  // --- 9e. History survives a reload ----------------------------------------
  const stored = await browser.evaluate(`
    return new Promise((resolve) => {
      const req = indexedDB.open('chess-coach');
      req.onsuccess = () => {
        const db = req.result;
        const tx = db.transaction('moves', 'readonly');
        const all = tx.objectStore('moves').getAll();
        all.onsuccess = () => resolve(all.result.length);
        all.onerror = () => resolve(-1);
      };
      req.onerror = () => resolve(-1);
    });
  `);
  check('Moves are persisted to IndexedDB as they are played', stored > 0, `${stored} stored`);

  const withRules = await browser.evaluate(`
    return new Promise((resolve) => {
      const req = indexedDB.open('chess-coach');
      req.onsuccess = () => {
        const tx = req.result.transaction('moves', 'readonly');
        const all = tx.objectStore('moves').getAll();
        all.onsuccess = () => resolve(JSON.stringify({
          withPhase: all.result.filter((m) => m.phase).length,
          withRules: all.result.filter((m) => m.triggeredRules && m.triggeredRules.length).length,
          withExplanation: all.result.filter((m) => m.explanation).length,
        }));
        all.onerror = () => resolve('{}');
      };
      req.onerror = () => resolve('{}');
    });
  `);
  const detail = JSON.parse(withRules);
  check(
    'Stored moves carry the phase, rules and explanation the profile needs',
    detail.withPhase > 0 && detail.withRules > 0 && detail.withExplanation > 0,
    withRules,
  );

  // Reload and confirm the history is still there.
  await browser.goto(BASE);
  await browser.waitFor(`document.querySelectorAll('cg-board piece').length > 0`);
  await delay(2500);
  const afterReload = await browser.evaluate(`
    return new Promise((resolve) => {
      const req = indexedDB.open('chess-coach');
      req.onsuccess = () => {
        const tx = req.result.transaction('moves', 'readonly');
        const all = tx.objectStore('moves').getAll();
        all.onsuccess = () => resolve(all.result.length);
        all.onerror = () => resolve(-1);
      };
      req.onerror = () => resolve(-1);
    });
  `);
  check('History survives a reload', afterReload >= stored, `${afterReload} after reload`);

  // Clearing site data must cold-start cleanly with a generic coach.
  await browser.evaluate(`
    return new Promise((resolve) => {
      const req = indexedDB.deleteDatabase('chess-coach');
      req.onsuccess = req.onerror = req.onblocked = () => resolve(true);
    });
  `);
  await browser.goto(BASE);
  await browser.waitFor(`document.querySelectorAll('cg-board piece').length > 0`);
  await delay(2000);
  const coldStart = await coachText();
  check(
    'Cold start after clearing data is generic, not fabricated',
    coldStart.includes('Ready when you are') && !/time you have made/i.test(coldStart),
    coldStart.split('\n')[0] ?? '',
  );

  // --- 9f. Progress screen and replay ---------------------------------------
  // Seed a couple of finished games so the screen has something to show.
  await browser.evaluate(`
    return new Promise((resolve) => {
      const req = indexedDB.open('chess-coach');
      req.onsuccess = () => {
        const db = req.result;
        const tx = db.transaction(['games', 'moves'], 'readwrite');
        const games = tx.objectStore('games');
        const moves = tx.objectStore('moves');
        for (let g = 1; g <= 3; g++) {
          const id = 'seed' + g;
          games.put({
            id, startedAt: Date.now() - g * 100000, endedAt: Date.now() - g * 90000,
            playerColor: 'w', level: 3, result: 'draw', pgn: '', moveCount: 4,
            accuracy: 60 + g * 5, avgCpLoss: 90, openingName: 'Italian Game',
          });
          // Both colours, so replay has a real alternating sequence to step.
          const seq = [
            { ply: 1, color: 'w', san: 'e4',
              before: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
              after: 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1' },
            { ply: 2, color: 'b', san: 'e5',
              before: 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1',
              after: 'rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq e6 0 2' },
            { ply: 3, color: 'w', san: 'Nf3',
              before: 'rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq e6 0 2',
              after: 'rnbqkbnr/pppp1ppp/8/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R b KQkq - 1 2' },
          ];
          for (const m of seq) {
            moves.put({
              id: id + ':' + m.ply, gameId: id, ply: m.ply,
              fenBefore: m.before, fenAfter: m.after,
              san: m.san, color: m.color, phase: 'opening',
              verdict: m.color === 'w' ? 'blunder' : null,
              cpLoss: m.color === 'w' ? 320 : null,
              triggeredRules: m.color === 'w' ? ['hangs-piece'] : [],
              bestMoveSan: 'd4',
              explanation: m.color === 'w'
                ? 'You moved your pawn from e2 to e4. The problem: your knight hangs.'
                : 'Black moved their pawn from e7 to e5.',
            });
          }
        }
        tx.oncomplete = () => resolve(true);
      };
      req.onerror = () => resolve(false);
    });
  `);

  await browser.goto(BASE);
  await browser.waitFor(`document.querySelectorAll('cg-board piece').length > 0`);
  await delay(2500);

  await browser.evaluate(`document.querySelector('#progress-button').click(); return true;`);
  await browser.waitFor(`document.querySelector('.progress-title') !== null`, {
    label: 'the progress screen',
  });

  const progress = await browser.evaluate(`return JSON.stringify({
    tiles: document.querySelectorAll('.stat-tile').length,
    charts: document.querySelectorAll('.chart').length,
    advice: document.querySelectorAll('.advice-list li').length,
    gameRows: document.querySelectorAll('.game-row').length,
    boardHidden: document.querySelector('.app-main').classList.contains('is-hidden'),
  });`);
  const p = JSON.parse(progress);
  check('Progress screen shows headline tiles', p.tiles >= 4, progress);
  check('Progress screen renders its charts', p.charts >= 2);
  check('Progress screen leads with what to work on', p.advice >= 1);
  check('Progress screen lists past games', p.gameRows >= 3);
  check('Progress screen replaces the board view', p.boardHidden);

  const tableView = await browser.evaluate(
    `return document.querySelectorAll('.chart-table table').length > 0;`,
  );
  check('Charts ship a table view of the numbers', tableView);
  await browser.screenshot(`${SHOTS}/11-progress.png`);

  // Replay a stored game — no engine should be needed.
  await browser.evaluate(`document.querySelectorAll('.game-row')[0].click(); return true;`);
  await browser.waitFor(`document.querySelector('.replay-layout') !== null`, {
    label: 'the replay view',
  });

  const replayStart = await browser.evaluate(
    `return document.querySelector('.replay-explanation').innerText;`,
  );
  check('Replay opens at the start of the game', /Step forward/.test(replayStart));

  await browser.evaluate(
    `[...document.querySelectorAll('.replay-controls .btn')].find(b => b.textContent.includes('Forward')).click();
     return true;`,
  );
  await delay(500);
  const replayed = await browser.evaluate(
    `return document.querySelector('.replay-explanation').innerText;`,
  );
  check(
    'Replay shows the saved explanation without re-running the engine',
    /The problem: your knight hangs/.test(replayed),
    replayed.replace(/\n/g, ' | ').slice(0, 120),
  );

  const stripCells = await browser.evaluate(
    `return document.querySelectorAll('.verdict-cell').length;`,
  );
  check('Replay shows a clickable verdict strip', stripCells > 0, `${stripCells} cells`);

  // One press must advance exactly one ply — both sides moving at once means
  // the opponent's replies were never stored.
  /*
   * The replay board is viewOnly, so its pieces take no pointer events and
   * elementFromPoint returns the board beneath them. Match on the piece's own
   * translate offset instead, which is how chessground positions them.
   */
  const pieceAt = (sq) => browser.evaluate(`
    const board = document.querySelector('.replay-board cg-board');
    const z = board.getBoundingClientRect().width / 8;
    const f = '${sq}'.charCodeAt(0) - 97, r = Number('${sq}'[1]) - 1;
    const wantX = Math.round(f * z), wantY = Math.round((7 - r) * z);
    for (const piece of board.querySelectorAll('piece')) {
      const m = /translate\\((-?[\\d.]+)px,\\s*(-?[\\d.]+)px\\)/.exec(piece.style.transform || '');
      if (!m) continue;
      if (Math.abs(Math.round(+m[1]) - wantX) <= 2 && Math.abs(Math.round(+m[2]) - wantY) <= 2) {
        return piece.className;
      }
    }
    return 'empty';
  `);

  // After ply 1 (e4) White's pawn is on e4 and Black has not replied yet.
  const afterPly1 = JSON.parse(
    JSON.stringify({ e4: await pieceAt('e4'), e5: await pieceAt('e5') }),
  );
  check(
    'One press advances a single ply, not a whole move pair',
    afterPly1.e4.includes('white') && afterPly1.e5 === 'empty',
    `e4=${afterPly1.e4}, e5=${afterPly1.e5}`,
  );

  await browser.evaluate(
    `[...document.querySelectorAll('.replay-controls .btn')].find(b => b.textContent.includes('Forward')).click();
     return true;`,
  );
  await delay(500);
  const afterPly2 = { e5: await pieceAt('e5') };
  check(
    'The next press plays the opponent’s reply',
    afterPly2.e5.includes('black'),
    `e5=${afterPly2.e5}`,
  );

  const replyText = await browser.evaluate(
    `return document.querySelector('.replay-explanation').innerText;`,
  );
  check(
    'Their move carries its own commentary in replay',
    /Black moved their pawn/.test(replyText),
    replyText.replace(/\n/g, ' | ').slice(0, 100),
  );
  await browser.screenshot(`${SHOTS}/12-replay.png`);

  // Back out to the board.
  await browser.evaluate(
    `[...document.querySelectorAll('.btn')].find(b => b.textContent.includes('Back to progress')).click();
     return true;`,
  );
  await browser.waitFor(`document.querySelector('.progress-title') !== null`);
  await browser.evaluate(
    `[...document.querySelectorAll('.btn')].find(b => b.textContent.includes('Back to the board')).click();
     return true;`,
  );
  await delay(600);
  const backToBoard = await browser.evaluate(
    `return !document.querySelector('.app-main').classList.contains('is-hidden');`,
  );
  check('Closing progress returns to the board', backToBoard);

  // --- 9g. The LLM layer is optional and off by default ---------------------
  await browser.goto(BASE);
  await browser.waitFor(`document.querySelectorAll('cg-board piece').length > 0`);
  await delay(2000);

  const llmOff = await browser.evaluate(`
    const raw = localStorage.getItem('chess-coach/llm');
    return raw === null || JSON.parse(raw).enabled === false;
  `);
  check('LLM wording layer is off until switched on', llmOff);

  await browser.evaluate(`document.querySelector('#settings-button').click(); return true;`);
  await browser.waitFor(`document.querySelector('.settings-form') !== null`, {
    label: 'the settings panel',
  });

  const settingsShape = await browser.evaluate(`return JSON.stringify({
    providers: document.querySelectorAll('#llm-provider option').length,
    modelIsFreeText: document.querySelector('#llm-model').tagName === 'INPUT',
    hasTest: document.querySelector('#llm-test') !== null,
    privacy: document.querySelector('.settings-privacy')?.textContent ?? '',
  });`);
  const shape = JSON.parse(settingsShape);
  check('Settings offers several providers', shape.providers >= 6, `${shape.providers} providers`);
  check(
    'Model is free text, so a model released later still works',
    shape.modelIsFreeText,
  );
  check('Settings says what leaves the machine', /never leaves this machine/.test(shape.privacy));

  // Probe against a provider that isn't running: must explain, not hang.
  await browser.evaluate(`
    document.querySelector('#llm-provider').value = 'lmstudio';
    document.querySelector('#llm-provider').dispatchEvent(new Event('change'));
    document.querySelector('#llm-model').value = 'nothing-here';
    document.querySelector('#llm-model').dispatchEvent(new Event('change'));
    document.querySelector('#llm-test').click();
    return true;
  `);
  const probed = await browser
    .waitFor(`!/^(|Testing…)$/.test(document.querySelector('#llm-status').textContent)`, {
      timeout: 20_000,
      label: 'a probe result',
    })
    .then(() => true)
    .catch(() => false);

  const probeText = await browser.evaluate(
    `return document.querySelector('#llm-status').textContent;`,
  );
  check('A dead provider reports a clear reason', probed, probeText);
  await browser.screenshot(`${SHOTS}/13-settings.png`);

  await browser.evaluate(
    `[...document.querySelectorAll('.btn')].find(b => b.textContent.includes('Back to the board')).click();
     return true;`,
  );
  await delay(500);

  // --- 10. Themes and narrow viewport --------------------------------------
  await browser.goto(BASE);
  await browser.waitFor(`document.querySelectorAll('cg-board piece').length > 0`);
  await delay(1500);

  await browser.setColorScheme('dark');
  await delay(400);
  const darkBg = await browser.evaluate(
    `return getComputedStyle(document.body).backgroundColor;`,
  );
  await browser.screenshot(`${SHOTS}/06-dark.png`);

  await browser.setColorScheme('light');
  await delay(400);
  const lightBg = await browser.evaluate(
    `return getComputedStyle(document.body).backgroundColor;`,
  );
  check('Dark and light themes differ', darkBg !== lightBg, `${darkBg} vs ${lightBg}`);

  await browser.setViewport(420, 860);
  await delay(600);
  const overflows = await browser.evaluate(
    `return document.documentElement.scrollWidth > document.documentElement.clientWidth + 1;`,
  );
  check('No horizontal scroll on a narrow viewport', !overflows);
  await browser.screenshot(`${SHOTS}/07-narrow.png`);

  // --- 11. Console hygiene --------------------------------------------------
  /*
   * The dead-provider probe above deliberately contacts a server that isn't
   * running, and the browser logs that failed request. That one is expected —
   * everything else is not.
   */
  const errors = [
    ...browser.pageErrors,
    ...browser.console.filter((m) => m.type === 'error').map((m) => m.text),
  ].filter((text) => !/502 \(Bad Gateway\)/.test(text));
  check('No console errors', errors.length === 0, errors.slice(0, 4).join(' | '));

  // --- Summary --------------------------------------------------------------
  const failed = results.filter((r) => !r.passed);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) {
    console.log('\nFailures:');
    for (const f of failed) console.log(`  - ${f.name}${f.detail ? `: ${f.detail}` : ''}`);
  }
  await browser.close();
  process.exit(failed.length ? 1 : 0);
}

main().catch(async (error) => {
  console.error(`\nHarness error: ${error.message}`);
  try {
    await browser?.screenshot(`${SHOTS}/error.png`);
  } catch {
    // Nothing to capture.
  }
  await browser?.close();
  process.exit(2);
});
