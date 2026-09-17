/**
 * Claude, via the native Messages API.
 *
 * Request shape verified against the Claude API reference rather than taken
 * from the design doc, which had two details wrong:
 *
 * - `effort` lives inside `output_config`, not at the top level.
 * - `temperature` is **rejected with a 400** on `claude-opus-5`, as is
 *   `thinking.budget_tokens`. Both are simply absent here.
 *
 * Thinking is on by default on this model. We leave it on at `effort: "low"`
 * rather than disabling it: with thinking disabled the model can leak
 * `<thinking>` tags into the visible response, which is exactly the failure
 * `coach/verify.ts` would then have to catch.
 *
 * The key never reaches the browser — the proxy attaches it.
 */
import { buildUserMessage, SYSTEM_PROMPT } from '../coach/prompt.js';
import { readSse, safeJsonParse, stripInlineReasoning } from './stream.js';
import { describeFailure, send } from './transport.js';
import type { ExplainRequest, LlmProvider, ProviderConfig, ProviderStatus } from './types.js';

const DEFAULT_BASE_URL = 'https://api.anthropic.com/v1';
const API_VERSION = '2023-06-01';

function messagesUrl(baseUrl: string): string {
  return `${(baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '')}/messages`;
}

function buildBody(request: ExplainRequest, stream: boolean): Record<string, unknown> {
  return {
    model: request.model,
    max_tokens: 300,
    // Marked for caching: the system prompt is stable across every move, and
    // the cacheable minimum on current Opus models is 512 tokens.
    system: [
      { type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } },
    ],
    // Low effort: this is a two-sentence rewrite, not a reasoning task.
    output_config: { effort: 'low' },
    messages: [{ role: 'user', content: buildUserMessage(request.facts) }],
    stream,
  };
}

export const anthropic: LlmProvider = {
  id: 'anthropic',
  label: 'Anthropic (Claude)',
  kind: 'cloud',
  defaultBaseUrl: DEFAULT_BASE_URL,
  needsKey: true,

  async probe(config: ProviderConfig): Promise<ProviderStatus> {
    try {
      // The cheapest possible real call — one token, no streaming.
      const response = await send(
        {
          url: messagesUrl(config.baseUrl),
          headers: { 'anthropic-version': API_VERSION },
          body: {
            model: config.model,
            max_tokens: 1,
            messages: [{ role: 'user', content: 'ok' }],
          },
        },
        config,
        new AbortController().signal,
      );

      if (!response.ok) return { ok: false, detail: await describeFailure(response) };
      return { ok: true, detail: `Reachable, and "${config.model}" answered.` };
    } catch (error) {
      return { ok: false, detail: `Could not reach it: ${String(error)}` };
    }
  },

  async explain(request, config, onDelta, signal): Promise<string> {
    const response = await send(
      {
        url: messagesUrl(config.baseUrl),
        headers: { 'anthropic-version': API_VERSION },
        body: buildBody(request, true),
      },
      config,
      signal,
    );

    if (!response.ok) throw new Error(await describeFailure(response));

    let text = '';
    for await (const payload of readSse(response, signal)) {
      const event = safeJsonParse(payload) as
        | { type?: string; delta?: { type?: string; text?: string }; stop_reason?: string }
        | null;

      // Only `text_delta` carries visible prose. `thinking_delta` is reasoning
      // and is dropped, which is the whole reason for the type check.
      if (event?.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
        const chunk = event.delta.text ?? '';
        if (chunk) {
          text += chunk;
          onDelta(chunk);
        }
      }

      // Safety classifiers can decline; that arrives as a normal 200.
      if (event?.type === 'message_delta' && event.stop_reason === 'refusal') {
        throw new Error('The model declined this request.');
      }
    }

    return stripInlineReasoning(text);
  },
};
