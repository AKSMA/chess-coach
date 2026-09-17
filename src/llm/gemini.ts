/**
 * Google Gemini.
 *
 * Earns its own adapter for one reason: a distinct request shape
 * (`contents` / `parts`, `systemInstruction`) and a stream that is a JSON
 * array of chunks rather than OpenAI-style SSE.
 */
import { buildUserMessage, SYSTEM_PROMPT } from '../coach/prompt.js';
import { readSse, safeJsonParse, stripInlineReasoning } from './stream.js';
import { describeFailure, get, send } from './transport.js';
import type { ExplainRequest, LlmProvider, ModelInfo, ProviderConfig, ProviderStatus } from './types.js';

const DEFAULT_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';

function streamUrl(baseUrl: string, model: string): string {
  const base = (baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '');
  return `${base}/models/${model}:streamGenerateContent?alt=sse`;
}

function buildBody(request: ExplainRequest): Record<string, unknown> {
  return {
    systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
    contents: [{ role: 'user', parts: [{ text: buildUserMessage(request.facts) }] }],
    generationConfig: { maxOutputTokens: 300, temperature: 0.7 },
  };
}

/** Pulls visible text out of a Gemini chunk, skipping any thought parts. */
function textFromChunk(chunk: unknown): string {
  const candidate = (chunk as { candidates?: { content?: { parts?: unknown[] } }[] } | null)
    ?.candidates?.[0];

  const parts = candidate?.content?.parts ?? [];
  let text = '';

  for (const part of parts) {
    const record = part as { text?: string; thought?: boolean };
    // Gemini marks reasoning parts with `thought: true`.
    if (record.thought) continue;
    if (typeof record.text === 'string') text += record.text;
  }

  return text;
}

export const gemini: LlmProvider = {
  id: 'gemini',
  label: 'Google Gemini',
  kind: 'cloud',
  defaultBaseUrl: DEFAULT_BASE_URL,
  needsKey: true,

  async listModels(config: ProviderConfig): Promise<ModelInfo[]> {
    const base = (config.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '');
    const response = await get(`${base}/models`, config);
    if (!response.ok) return [];

    const payload = safeJsonParse(await response.text()) as { models?: { name?: string }[] } | null;
    return (payload?.models ?? [])
      .map((entry) => entry.name?.replace(/^models\//, ''))
      .filter((id): id is string => typeof id === 'string')
      .map((id) => ({ id, label: id, locality: 'remote' as const }));
  },

  async probe(config: ProviderConfig): Promise<ProviderStatus> {
    try {
      const models = (await this.listModels?.(config)) ?? [];
      if (models.length === 0) {
        return { ok: false, detail: 'Could not list models — check the key and base URL.' };
      }
      const named = models.some((m) => m.id === config.model);
      return named
        ? { ok: true, detail: `Reachable. "${config.model}" is available.`, models }
        : { ok: false, detail: `"${config.model}" is not in the model list.`, models };
    } catch (error) {
      return { ok: false, detail: `Could not reach it: ${String(error)}` };
    }
  },

  async explain(request, config, onDelta, signal): Promise<string> {
    const response = await send(
      { url: streamUrl(config.baseUrl, request.model), headers: {}, body: buildBody(request) },
      config,
      signal,
    );

    if (!response.ok) throw new Error(await describeFailure(response));

    // `alt=sse` gives us ordinary `data:` lines, so the shared reader applies.
    let text = '';

    for await (const payload of readSse(response, signal)) {
      const visible = textFromChunk(safeJsonParse(payload));
      if (visible) {
        text += visible;
        onDelta(visible);
      }
    }

    return stripInlineReasoning(text);
  },
};
