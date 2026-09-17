import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Connect, Plugin, ViteDevServer, PreviewServer } from 'vite';
import { defineConfig } from 'vite';

/**
 * Which environment variable holds each provider's key, and which origins that
 * key may be sent to.
 *
 * The allowlist is the important half. Without it this route would attach the
 * user's API key to *any* URL the page asked for, which turns a local dev
 * convenience into a one-request key-exfiltration endpoint.
 */
const PROVIDERS: Record<string, { envVar: string; header: 'bearer' | 'x-api-key' | 'query'; origins: string[] }> = {
  openai: { envVar: 'OPENAI_API_KEY', header: 'bearer', origins: ['https://api.openai.com'] },
  anthropic: { envVar: 'ANTHROPIC_API_KEY', header: 'x-api-key', origins: ['https://api.anthropic.com'] },
  gemini: {
    envVar: 'GEMINI_API_KEY',
    header: 'query',
    origins: ['https://generativelanguage.googleapis.com'],
  },
  openrouter: { envVar: 'OPENROUTER_API_KEY', header: 'bearer', origins: ['https://openrouter.ai'] },
  // Local daemons need no key; they are listed so their origins are allowed.
  ollama: { envVar: '', header: 'bearer', origins: ['http://localhost:11434', 'http://127.0.0.1:11434'] },
  lmstudio: { envVar: '', header: 'bearer', origins: ['http://localhost:1234', 'http://127.0.0.1:1234'] },
  // "custom" is any self-hosted OpenAI-compatible server. Loopback only —
  // a user-supplied origin must never receive one of the keys above.
  custom: { envVar: '', header: 'bearer', origins: [] },
};

interface ProxyPayload {
  providerId?: string;
  url?: string;
  method?: string;
  headers?: Record<string, string>;
  body?: unknown;
  apiKey?: string | null;
}

function readBody(request: Connect.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    request.on('data', (chunk) => {
      data += chunk;
      // A coaching payload is a couple of KB; anything larger is not ours.
      if (data.length > 1_000_000) reject(new Error('payload too large'));
    });
    request.on('end', () => resolve(data));
    request.on('error', reject);
  });
}

function isLoopback(origin: string): boolean {
  return /^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(origin);
}

/** Whether this provider's key may be sent to this URL. */
function originAllowed(providerId: string, target: URL): boolean {
  const provider = PROVIDERS[providerId];
  if (!provider) return false;
  if (provider.origins.includes(target.origin)) return true;
  // Self-hosted servers are allowed, but only on loopback and only when the
  // provider carries no key of its own to leak.
  return provider.envVar === '' && isLoopback(target.origin);
}

/** The Apple bridge, kept warm across moves once spawned. */
let appleBridge: ChildProcessWithoutNullStreams | null = null;

function appleBinaryPath(): string {
  return resolve(process.cwd(), 'bridge-apple/.bin/chesscoach-apple-llm');
}

function llmProxy(): Connect.NextHandleFunction {
  return async (request, response, next) => {
    const url = request.url ?? '';
    if (!url.startsWith('/api/llm')) return next();

    // --- Apple bridge status ------------------------------------------------
    if (url.startsWith('/api/llm/apple/status')) {
      const built = existsSync(appleBinaryPath());
      response.setHeader('content-type', 'application/json');
      response.end(
        JSON.stringify({
          available: built,
          detail: built
            ? 'On-device bridge is built.'
            : 'The on-device bridge is not built. Run `npm run build:apple` (needs Xcode).',
        }),
      );
      return;
    }

    // --- Apple bridge streaming --------------------------------------------
    if (url.startsWith('/api/llm/apple')) {
      if (!existsSync(appleBinaryPath())) {
        response.statusCode = 503;
        response.end('on-device bridge not built');
        return;
      }

      try {
        const payload = JSON.parse(await readBody(request)) as { system: string; prompt: string };
        appleBridge ??= spawn(appleBinaryPath(), [], { stdio: ['pipe', 'pipe', 'pipe'] });

        response.setHeader('content-type', 'application/x-ndjson');
        const onData = (chunk: Buffer) => response.write(chunk);
        appleBridge.stdout.on('data', onData);
        appleBridge.stdin.write(`${JSON.stringify(payload)}\n`);

        request.on('close', () => appleBridge?.stdout.off('data', onData));
      } catch (error) {
        response.statusCode = 500;
        response.end(String(error));
      }
      return;
    }

    // --- Provider passthrough ----------------------------------------------
    if (request.method !== 'POST') return next();

    try {
      const payload = JSON.parse(await readBody(request)) as ProxyPayload;
      const providerId = payload.providerId ?? '';
      const target = new URL(payload.url ?? '');

      if (!originAllowed(providerId, target)) {
        response.statusCode = 403;
        response.end(
          `Refusing to proxy to ${target.origin} for provider "${providerId}". ` +
            'Add it to PROVIDERS in vite.config.ts if this is intentional.',
        );
        return;
      }

      const provider = PROVIDERS[providerId]!;
      const headers: Record<string, string> = {
        'content-type': 'application/json',
        ...(payload.headers ?? {}),
      };

      // A key from .env.local wins; a key typed into settings is the fallback.
      const key = (provider.envVar ? process.env[provider.envVar] : undefined) ?? payload.apiKey ?? '';

      if (key) {
        if (provider.header === 'bearer') headers['authorization'] = `Bearer ${key}`;
        else if (provider.header === 'x-api-key') headers['x-api-key'] = key;
        else target.searchParams.set('key', key);
      }

      const upstream = await fetch(target, {
        method: payload.method ?? 'POST',
        headers,
        ...(payload.method === 'GET' ? {} : { body: JSON.stringify(payload.body ?? {}) }),
      });

      response.statusCode = upstream.status;
      response.setHeader(
        'content-type',
        upstream.headers.get('content-type') ?? 'application/octet-stream',
      );

      if (!upstream.body) {
        response.end();
        return;
      }

      const reader = upstream.body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        response.write(Buffer.from(value));
      }
      response.end();
    } catch (error) {
      response.statusCode = 502;
      // "TypeError: fetch failed" tells a user nothing. Say what to check.
      const message =
        error instanceof TypeError
          ? 'Could not reach that address. Is the server running, and is the base URL right?'
          : String(error);
      response.end(message);
    }
  };
}

/**
 * The proxy, registered on both server hooks.
 *
 * `configureServer` alone would mean cloud providers work under `npm run dev`
 * and silently 404 under `vite preview`.
 */
function llmPlugin(): Plugin {
  return {
    name: 'chess-coach-llm-proxy',
    configureServer(server: ViteDevServer) {
      server.middlewares.use(llmProxy());
    },
    configurePreviewServer(server: PreviewServer) {
      server.middlewares.use(llmProxy());
    },
  };
}

export default defineConfig({
  plugins: [llmPlugin()],
  server: { port: 5173 },
  // public/engine/*.js is loaded as a classic Worker from a plain string path,
  // so Vite must leave it alone — anything under public/ is served verbatim.
});
