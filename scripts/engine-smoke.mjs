#!/usr/bin/env node
/**
 * Engine smoke test: proves the fetched WASM actually boots and plays a legal
 * move, before any of it is debugged through a browser.
 *
 * Note the shape: the emscripten build is driven by spawning it as a Node
 * child process and writing UCI lines to stdin. Piping a heredoc into it
 * produces no output at all, and `worker_threads` is the wrong interface —
 * only the browser build is a Worker.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const enginePath = join(root, 'public', 'engine', 'stockfish-18-lite-single.js');

if (!existsSync(enginePath)) {
  console.error(`Engine not found at ${enginePath}\nRun: npm run engine:fetch`);
  process.exit(1);
}

const TIMEOUT_MS = 30_000;
const engine = spawn(process.execPath, [enginePath], { stdio: ['pipe', 'pipe', 'pipe'] });

let buffer = '';
const waiters = [];
const seen = { uciok: false, bestmove: null };

function send(cmd) {
  engine.stdin.write(cmd + '\n');
}

/** Resolves when a line satisfying `pred` arrives. */
function until(pred) {
  return new Promise((resolve) => waiters.push({ pred, resolve }));
}

engine.stdout.on('data', (chunk) => {
  buffer += chunk;
  const lines = buffer.split('\n');
  buffer = lines.pop() ?? '';
  for (const line of lines) {
    for (let i = waiters.length - 1; i >= 0; i--) {
      if (waiters[i].pred(line)) waiters.splice(i, 1)[0].resolve(line);
    }
  }
});

const timer = setTimeout(() => {
  console.error(`FAIL: engine did not respond within ${TIMEOUT_MS / 1000}s`);
  engine.kill();
  process.exit(1);
}, TIMEOUT_MS);

try {
  send('uci');
  await until((l) => l.trim() === 'uciok');
  seen.uciok = true;
  console.log('ok  uciok');

  send('isready');
  await until((l) => l.trim() === 'readyok');
  console.log('ok  readyok');

  send('position startpos');
  send('go depth 8');
  const line = await until((l) => l.startsWith('bestmove'));
  seen.bestmove = line.split(/\s+/)[1];

  // Every legal first move for White is a4-h4 / a3-h3 or a knight to a3/c3/f3/h3.
  if (!/^[a-h][12][a-h][1-4]$/.test(seen.bestmove)) {
    throw new Error(`bestmove "${seen.bestmove}" is not a plausible opening move`);
  }
  console.log(`ok  bestmove ${seen.bestmove}`);

  clearTimeout(timer);
  engine.kill();
  console.log('\nEngine smoke test passed.');
  process.exit(0);
} catch (err) {
  clearTimeout(timer);
  engine.kill();
  console.error(`\nFAIL: ${err.message}`);
  process.exit(1);
}
