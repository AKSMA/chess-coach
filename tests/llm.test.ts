import { describe, expect, it, vi, afterEach } from 'vitest';
import { anthropic } from '../src/llm/anthropic.js';
import { gemini } from '../src/llm/gemini.js';
import { openaiCompatible } from '../src/llm/openaiCompatible.js';
import { stripInlineReasoning, visibleTextFrom } from '../src/llm/stream.js';
import { capabilitiesFor } from '../src/coach/prompt.js';
import { defaultSettings, presetFor, PRESETS } from '../src/llm/registry.js';
import type { ExplainFacts, ProviderConfig } from '../src/llm/types.js';

/** A recorded stream, replayed as a Response. No network, no spend. */
function sseResponse(lines: string[]): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      for (const line of lines) controller.enqueue(encoder.encode(`data: ${line}\n\n`));
      controller.enqueue(encoder.encode('data: [DONE]\n\n'));
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

const facts: ExplainFacts = {
  verdict: 'blunder',
  mover: 'you',
  san: 'Nxe5',
  bestSan: 'O-O',
  refutationSan: ['Nxe5'],
  allowedSquares: ['e5', 'c6'],
  allowedSan: ['Nxe5', 'O-O'],
  allowedPieces: ['knight', 'pawn'],
  sentences: ['You took their pawn on e5 with your knight.'],
  triggeredRules: ['hangs-piece'],
  openingName: null,
  cpLoss: 300,
  habitSummary: null,
};

const config: ProviderConfig = {
  providerId: 'custom',
  baseUrl: 'http://localhost:11434/v1',
  model: 'test-model',
  direct: true,
};

afterEach(() => vi.restoreAllMocks());

describe('visibleTextFrom — reasoning is never displayed', () => {
  it('returns ordinary content', () => {
    expect(visibleTextFrom({ content: 'hello' })).toBe('hello');
  });

  it('drops a chunk that carries reasoning instead of an answer', () => {
    expect(visibleTextFrom({ reasoning_content: 'let me think' })).toBe('');
    expect(visibleTextFrom({ reasoning: 'hmm' })).toBe('');
    expect(visibleTextFrom({ thinking: 'considering' })).toBe('');
  });

  it('handles an empty delta', () => {
    expect(visibleTextFrom({})).toBe('');
    expect(visibleTextFrom(null)).toBe('');
  });
});

describe('stripInlineReasoning', () => {
  it('removes a complete think block', () => {
    expect(stripInlineReasoning('<think>ponder</think>Your knight is loose.')).toBe(
      'Your knight is loose.',
    );
  });

  it('removes stray tags a model leaves behind', () => {
    expect(stripInlineReasoning('Your knight is loose.</think>')).toBe('Your knight is loose.');
  });

  it('leaves clean text alone', () => {
    expect(stripInlineReasoning('Your knight is loose.')).toBe('Your knight is loose.');
  });
});

describe('openaiCompatible adapter', () => {
  it('assembles the visible text from an SSE stream', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        sseResponse([
          JSON.stringify({ choices: [{ delta: { content: 'Your knight ' } }] }),
          JSON.stringify({ choices: [{ delta: { content: 'is loose.' } }] }),
        ]),
      ),
    );

    const deltas: string[] = [];
    const text = await openaiCompatible.explain(
      { facts, model: 'test-model' },
      config,
      (d) => deltas.push(d),
      new AbortController().signal,
    );

    expect(text).toBe('Your knight is loose.');
    expect(deltas).toEqual(['Your knight ', 'is loose.']);
  });

  it('drops reasoning deltas from a thinking model', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        sseResponse([
          JSON.stringify({ choices: [{ delta: { reasoning_content: 'First I check e5...' } }] }),
          JSON.stringify({ choices: [{ delta: { content: 'Your knight is loose.' } }] }),
        ]),
      ),
    );

    const deltas: string[] = [];
    const text = await openaiCompatible.explain(
      { facts, model: 'test-model' },
      config,
      (d) => deltas.push(d),
      new AbortController().signal,
    );

    expect(text).toBe('Your knight is loose.');
    expect(deltas).not.toContain('First I check e5...');
  });

  it('surfaces a clear message on a bad key', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 401 })));

    await expect(
      openaiCompatible.explain(
        { facts, model: 'test-model' },
        config,
        () => undefined,
        new AbortController().signal,
      ),
    ).rejects.toThrow(/Authentication failed/);
  });

  it('labels an Ollama :cloud model as remote, not local', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({ data: [{ id: 'glm-5.2:cloud' }, { id: 'qwen3:4b' }] }),
            { status: 200 },
          ),
      ),
    );

    const models = await openaiCompatible.listModels!(config);
    expect(models.find((m) => m.id === 'glm-5.2:cloud')?.locality).toBe('remote');
    expect(models.find((m) => m.id === 'qwen3:4b')?.locality).toBe('local-daemon');
  });

  it('reports a model that is not available', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ data: [{ id: 'other' }] }), { status: 200 })),
    );

    const status = await openaiCompatible.probe({ ...config, model: 'missing-model' });
    expect(status.ok).toBe(false);
    expect(status.detail).toMatch(/not among/);
  });
});

describe('anthropic adapter', () => {
  it('reads text_delta events and ignores thinking_delta', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        sseResponse([
          JSON.stringify({ type: 'content_block_delta', delta: { type: 'thinking_delta', text: 'hmm' } }),
          JSON.stringify({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'Your knight ' } }),
          JSON.stringify({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'is loose.' } }),
        ]),
      ),
    );

    const text = await anthropic.explain(
      { facts, model: 'claude-opus-5' },
      { ...config, providerId: 'anthropic', direct: true },
      () => undefined,
      new AbortController().signal,
    );

    expect(text).toBe('Your knight is loose.');
    expect(text).not.toMatch(/hmm/);
  });

  it('treats a refusal as a failure rather than empty prose', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        sseResponse([JSON.stringify({ type: 'message_delta', stop_reason: 'refusal' })]),
      ),
    );

    await expect(
      anthropic.explain(
        { facts, model: 'claude-opus-5' },
        { ...config, providerId: 'anthropic', direct: true },
        () => undefined,
        new AbortController().signal,
      ),
    ).rejects.toThrow(/declined/);
  });

  it('never sends temperature or budget_tokens, which are 400s on this model', async () => {
    const spy = vi.fn(async (_url: unknown, _init?: unknown) => sseResponse([]));
    vi.stubGlobal('fetch', spy);

    await anthropic.explain(
      { facts, model: 'claude-opus-5' },
      { ...config, providerId: 'anthropic', direct: true },
      () => undefined,
      new AbortController().signal,
    );

    const init = spy.mock.calls[0]?.[1] as RequestInit | undefined;
    const body = JSON.parse(String(init?.body ?? '{}'));
    expect(body).not.toHaveProperty('temperature');
    expect(body.thinking).toBeUndefined();
    // Effort lives inside output_config, not at the top level.
    expect(body.output_config.effort).toBe('low');
    expect(body.effort).toBeUndefined();
  });
});

describe('gemini adapter', () => {
  it('reads its own chunk shape and skips thought parts', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        sseResponse([
          JSON.stringify({ candidates: [{ content: { parts: [{ text: 'reasoning', thought: true }] } }] }),
          JSON.stringify({ candidates: [{ content: { parts: [{ text: 'Your knight is loose.' }] } }] }),
        ]),
      ),
    );

    const text = await gemini.explain(
      { facts, model: 'gemini-2.0-flash' },
      { ...config, providerId: 'gemini', direct: true },
      () => undefined,
      new AbortController().signal,
    );

    expect(text).toBe('Your knight is loose.');
    expect(text).not.toMatch(/reasoning/);
  });
});

describe('capability quirks — unknown models must still work', () => {
  it('falls back to conservative settings for a model released after this was written', () => {
    const caps = capabilitiesFor('some-model-that-does-not-exist-yet');
    expect(caps.maxTokensField).toBe('max_tokens');
    expect(caps.acceptsTemperature).toBe(false);
  });

  it('uses the renamed token field on OpenAI reasoning models', () => {
    expect(capabilitiesFor('o3-mini').maxTokensField).toBe('max_completion_tokens');
    expect(capabilitiesFor('gpt-5').maxTokensField).toBe('max_completion_tokens');
  });

  it('allows temperature where the model accepts it', () => {
    expect(capabilitiesFor('gpt-4o-mini').acceptsTemperature).toBe(true);
    expect(capabilitiesFor('llama3.2:3b').acceptsTemperature).toBe(true);
  });
});

describe('registry', () => {
  it('is off by default — the app is fully playable without any provider', () => {
    expect(defaultSettings().enabled).toBe(false);
  });

  it('defaults paid providers to on-demand rather than every move', () => {
    expect(defaultSettings().mode).toBe('on-demand');
  });

  it('offers a preset for every adapter, including a free-form one', () => {
    expect(presetFor('custom')).toBeDefined();
    expect(presetFor('ollama')?.needsKey).toBe(false);
    expect(PRESETS.every((p) => p.adapter)).toBe(true);
  });

  it('warns honestly that Ollama :cloud models are not local', () => {
    expect(presetFor('ollama')?.note).toMatch(/:cloud.*ollama\.com/s);
  });
});
