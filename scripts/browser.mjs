/**
 * A minimal Chrome DevTools Protocol driver.
 *
 * Deliberately dependency-free: Node 24 ships a global WebSocket and fetch, so
 * driving a real browser needs nothing installed. Used by scripts/e2e.mjs.
 */
import { spawn } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 9333;
const PROFILE = '/tmp/chess-coach-cdp-profile';

export class Browser {
  #process;
  #socket;
  #nextId = 1;
  #pending = new Map();
  #handlers = new Map();

  /** Console messages and page errors, collected for assertions. */
  console = [];
  pageErrors = [];

  static async launch({ width = 1440, height = 960 } = {}) {
    const browser = new Browser();
    await browser.#start(width, height);
    return browser;
  }

  async #start(width, height) {
    await rm(PROFILE, { recursive: true, force: true });

    this.#process = spawn(
      CHROME,
      [
        '--headless=new',
        `--remote-debugging-port=${PORT}`,
        `--user-data-dir=${PROFILE}`,
        `--window-size=${width},${height}`,
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-extensions',
        '--hide-scrollbars',
        'about:blank',
      ],
      { stdio: 'ignore' },
    );

    const target = await this.#waitForTarget();
    this.#socket = new WebSocket(target);
    await new Promise((resolve, reject) => {
      this.#socket.addEventListener('open', resolve, { once: true });
      this.#socket.addEventListener('error', reject, { once: true });
    });

    this.#socket.addEventListener('message', (event) => this.#onMessage(event));

    await this.send('Page.enable');
    await this.send('Runtime.enable');
    await this.send('Log.enable');

    this.on('Runtime.consoleAPICalled', ({ type, args }) => {
      this.console.push({ type, text: args.map(describeArg).join(' ') });
    });
    this.on('Runtime.exceptionThrown', ({ exceptionDetails }) => {
      this.pageErrors.push(
        exceptionDetails.exception?.description ?? exceptionDetails.text ?? 'unknown error',
      );
    });
    this.on('Log.entryAdded', ({ entry }) => {
      if (entry.level === 'error') this.pageErrors.push(`${entry.source}: ${entry.text}`);
    });
  }

  async #waitForTarget() {
    for (let attempt = 0; attempt < 60; attempt++) {
      try {
        const response = await fetch(`http://127.0.0.1:${PORT}/json/list`);
        const targets = await response.json();
        const page = targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
        if (page) return page.webSocketDebuggerUrl;
      } catch {
        // Chrome is not listening yet.
      }
      await delay(200);
    }
    throw new Error('Chrome did not expose a debuggable page target');
  }

  #onMessage(event) {
    const message = JSON.parse(event.data);

    if (message.id !== undefined) {
      const pending = this.#pending.get(message.id);
      if (!pending) return;
      this.#pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message));
      else pending.resolve(message.result);
      return;
    }

    for (const handler of this.#handlers.get(message.method) ?? []) handler(message.params);
  }

  on(method, handler) {
    const existing = this.#handlers.get(method) ?? [];
    existing.push(handler);
    this.#handlers.set(method, existing);
  }

  send(method, params = {}) {
    const id = this.#nextId++;
    this.#socket.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => this.#pending.set(id, { resolve, reject }));
  }

  async goto(url) {
    const loaded = new Promise((resolve) => this.on('Page.loadEventFired', resolve));
    await this.send('Page.navigate', { url });
    await loaded;
  }

  /** Evaluates an expression in the page and returns its value. */
  async evaluate(expression) {
    const { result, exceptionDetails } = await this.send('Runtime.evaluate', {
      expression: `(() => { ${expression} })()`,
      returnByValue: true,
      awaitPromise: true,
    });
    if (exceptionDetails) {
      throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text);
    }
    return result.value;
  }

  /**
   * Polls `expression` until it returns truthy. Returns the value.
   *
   * Takes an *expression*, not statements — it is wrapped in `return (...)`.
   * A statement body here becomes a syntax error that looks like a failed
   * wait rather than a broken check.
   */
  async waitFor(expression, { timeout = 30_000, label = expression } = {}) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const value = await this.evaluate(`return (${expression});`);
      if (value) return value;
      await delay(150);
    }
    throw new Error(`Timed out waiting for: ${label}`);
  }

  /** A real mouse click at viewport coordinates. */
  async click(x, y) {
    const base = { x: Math.round(x), y: Math.round(y), button: 'left', clickCount: 1 };
    await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...base });
    await delay(30);
    await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...base });
  }

  async pressKey(key) {
    await this.send('Input.dispatchKeyEvent', { type: 'keyDown', key });
    await this.send('Input.dispatchKeyEvent', { type: 'keyUp', key });
  }

  /** Forces the emulated colour scheme, for theme checks. */
  async setColorScheme(scheme) {
    await this.send('Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-color-scheme', value: scheme }],
    });
  }

  async setReducedMotion(reduce) {
    await this.send('Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-reduced-motion', value: reduce ? 'reduce' : 'no-preference' }],
    });
  }

  async setViewport(width, height) {
    await this.send('Emulation.setDeviceMetricsOverride', {
      width,
      height,
      deviceScaleFactor: 1,
      mobile: false,
    });
  }

  async screenshot(path) {
    const { data } = await this.send('Page.captureScreenshot', { format: 'png' });
    await mkdir(join(path, '..'), { recursive: true }).catch(() => {});
    await writeFile(path, Buffer.from(data, 'base64'));
    return path;
  }

  async close() {
    try {
      this.#socket?.close();
    } catch {
      // Already gone.
    }
    this.#process?.kill();
  }
}

function describeArg(arg) {
  if (arg.value !== undefined) return String(arg.value);
  return arg.description ?? arg.type;
}

export function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
