/**
 * The workhorse adapter: anything speaking the OpenAI chat-completions shape.
 *
 * Covers OpenAI, Ollama, LM Studio, llama.cpp, vLLM, OpenRouter, Groq,
 * Together, Mistral, DeepSeek, and Azure — one adapter configured by base URL,
 * which is why the provider list can be long without the code being.
 */
import { buildUserMessage, capabilitiesFor, SYSTEM_PROMPT } from '../coach/prompt.js';
import { readSse, safeJsonParse, stripInlineReasoning, visibleTextFrom } from './stream.js';
import { describeFailure, get, send } from './transport.js';
import type { ExplainRequest, LlmProvider, ModelInfo, ProviderConfig, ProviderStatus } from './types.js';

function chatUrl(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/+$/, '');
  return trimmed.endsWith('/chat/completions') ? trimmed : `${trimmed}/chat/completions`;
}

function modelsUrl(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/+$/, '').replace(/\/chat\/completions$/, '');
  return `${trimmed}/models`;
}

function buildBody(request: ExplainRequest, stream: boolean): Record<string, unknown> {
  const capabilities = capabilitiesFor(request.model);

  const body: Record<string, unknown> = {
    model: request.model,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: buildUserMessage(request.facts) },
    ],
    stream,
  };

  // OpenAI renamed this on its newer models; the quirk table decides which.
  body[capabilities.maxTokensField] = 220;
  if (capabilities.acceptsTemperature) body['temperature'] = 0.7;

  return body;
}

export const openaiCompatible: LlmProvider = {
  id: 'openai-compatible',
  label: 'OpenAI-compatible',
  kind: 'cloud',
  needsKey: true,

  async listModels(config: ProviderConfig): Promise<ModelInfo[]> {
    const response = await get(modelsUrl(config.baseUrl), config);
    if (!response.ok) return [];

    const payload = safeJsonParse(await response.text()) as { data?: { id?: string }[] } | null;
    return (payload?.data ?? [])
      .map((entry) => entry.id)
      .filter((id): id is string => typeof id === 'string')
      .map((id) => ({
        id,
        label: id,
        // Ollama's `:cloud` entries live at localhost but are proxied to
        // ollama.com — a local endpoint is not the same as a local model.
        locality: id.endsWith(':cloud') ? ('remote' as const) : localityFor(config.baseUrl),
      }));
  },

  async probe(config: ProviderConfig): Promise<ProviderStatus> {
    try {
      const response = await get(modelsUrl(config.baseUrl), config);
      if (!response.ok) {
        return { ok: false, detail: await describeFailure(response) };
      }

      const models = (await this.listModels?.(config)) ?? [];
      if (models.length === 0) {
        return { ok: true, detail: 'Reachable, but it listed no models.', models };
      }

      const named = models.find((m) => m.id === config.model);
      if (config.model && !named) {
        return {
          ok: false,
          detail: `Reachable, but "${config.model}" is not among the ${models.length} available models.`,
          models,
        };
      }

      return { ok: true, detail: `Reachable. ${models.length} model(s) available.`, models };
    } catch (error) {
      return { ok: false, detail: `Could not reach it: ${String(error)}` };
    }
  },

  async explain(request, config, onDelta, signal): Promise<string> {
    const response = await send(
      { url: chatUrl(config.baseUrl), headers: {}, body: buildBody(request, true) },
      config,
      signal,
    );

    if (!response.ok) throw new Error(await describeFailure(response));

    let text = '';
    for await (const payload of readSse(response, signal)) {
      const chunk = safeJsonParse(payload) as
        | { choices?: { delta?: unknown }[] }
        | null;

      const delta = chunk?.choices?.[0]?.delta;
      const visible = visibleTextFrom(delta);
      if (visible) {
        text += visible;
        onDelta(visible);
      }
    }

    return stripInlineReasoning(text);
  },
};

function localityFor(baseUrl: string): ModelInfo['locality'] {
  return /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])/i.test(baseUrl) ? 'local-daemon' : 'remote';
}
