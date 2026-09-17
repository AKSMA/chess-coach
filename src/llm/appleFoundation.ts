/**
 * Apple's on-device Foundation model.
 *
 * The framework is Swift-only — there is no HTTP endpoint and no CLI — so it
 * cannot be called from a browser or from Node directly. The bridge in
 * `bridge-apple/` is a small Swift binary that the `/api/llm` proxy spawns and
 * talks to over stdio: one JSON request per line in, streamed text back.
 *
 * The binary is optional and is not built by default. When it is absent,
 * `probe()` reports the real reason rather than failing mysteriously, and the
 * settings UI greys the option out. Nothing else in the app depends on it.
 */
import { buildUserMessage, SYSTEM_PROMPT } from '../coach/prompt.js';
import { readNdjson, safeJsonParse, stripInlineReasoning } from './stream.js';
import { PROXY_PATH, type LlmProvider, type ProviderConfig, type ProviderStatus } from './types.js';

/** The proxy route that spawns the bridge. */
const BRIDGE_URL = `${PROXY_PATH}/apple`;

export const appleFoundation: LlmProvider = {
  id: 'apple',
  label: 'Apple on-device',
  kind: 'local',
  needsKey: false,

  async probe(_config: ProviderConfig): Promise<ProviderStatus> {
    try {
      const response = await fetch(`${BRIDGE_URL}/status`);
      const payload = safeJsonParse(await response.text()) as
        | { available?: boolean; detail?: string }
        | null;

      return {
        ok: payload?.available === true,
        detail:
          payload?.detail ??
          'The on-device bridge is not built. Run `npm run build:apple` (needs Xcode).',
      };
    } catch {
      return {
        ok: false,
        detail: 'The on-device bridge is not built. Run `npm run build:apple` (needs Xcode).',
      };
    }
  },

  async explain(request, _config, onDelta, signal): Promise<string> {
    const response = await fetch(BRIDGE_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        system: SYSTEM_PROMPT,
        prompt: buildUserMessage(request.facts),
      }),
      signal,
    });

    if (!response.ok) {
      throw new Error('The on-device bridge is unavailable. Run `npm run build:apple`.');
    }

    let text = '';
    for await (const line of readNdjson(response, signal)) {
      const event = safeJsonParse(line) as { delta?: string; error?: string } | null;
      if (event?.error) throw new Error(event.error);
      if (event?.delta) {
        text += event.delta;
        onDelta(event.delta);
      }
    }

    return stripInlineReasoning(text);
  },
};
