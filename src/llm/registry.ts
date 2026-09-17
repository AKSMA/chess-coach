/**
 * Provider selection and persistence.
 *
 * The presets below are conveniences, not a closed set: every one of them is
 * the same OpenAI-compatible adapter pointed at a different base URL, and the
 * user can type any base URL and any model name. Nothing here restricts which
 * models are usable.
 */
import { anthropic } from './anthropic.js';
import { appleFoundation } from './appleFoundation.js';
import { gemini } from './gemini.js';
import { openaiCompatible } from './openaiCompatible.js';
import type { LlmProvider, ProviderConfig } from './types.js';

export interface ProviderPreset {
  id: string;
  label: string;
  /** Which adapter drives it. */
  adapter: LlmProvider;
  baseUrl: string;
  /** A sensible starting model; always editable. */
  suggestedModel: string;
  needsKey: boolean;
  /** Honest note about where the work happens and what it costs. */
  note: string;
}

export const PRESETS: ProviderPreset[] = [
  {
    id: 'ollama',
    label: 'Ollama (local)',
    adapter: openaiCompatible,
    baseUrl: 'http://localhost:11434/v1',
    suggestedModel: '',
    needsKey: false,
    note: 'Free and private for models you have pulled. Slower to first word than a cloud provider. Models tagged “:cloud” are proxied to ollama.com — those are neither local nor free.',
  },
  {
    id: 'lmstudio',
    label: 'LM Studio (local)',
    adapter: openaiCompatible,
    baseUrl: 'http://localhost:1234/v1',
    suggestedModel: '',
    needsKey: false,
    note: 'Free and private. Start the LM Studio server first.',
  },
  {
    id: 'openai',
    label: 'OpenAI',
    adapter: openaiCompatible,
    baseUrl: 'https://api.openai.com/v1',
    suggestedModel: 'gpt-4o-mini',
    needsKey: true,
    note: 'Fast, costs money per move. Set OPENAI_API_KEY in .env.local.',
  },
  {
    id: 'anthropic',
    label: 'Anthropic (Claude)',
    adapter: anthropic,
    baseUrl: 'https://api.anthropic.com/v1',
    suggestedModel: 'claude-opus-5',
    needsKey: true,
    note: 'Set ANTHROPIC_API_KEY in .env.local. The system prompt is cached, so every move after the first is cheaper.',
  },
  {
    id: 'gemini',
    label: 'Google Gemini',
    adapter: gemini,
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    suggestedModel: 'gemini-2.0-flash',
    needsKey: true,
    note: 'Set GEMINI_API_KEY in .env.local.',
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    adapter: openaiCompatible,
    baseUrl: 'https://openrouter.ai/api/v1',
    suggestedModel: '',
    needsKey: true,
    note: 'One key, many models. Set OPENROUTER_API_KEY in .env.local.',
  },
  {
    id: 'custom',
    label: 'Anything OpenAI-compatible',
    adapter: openaiCompatible,
    baseUrl: '',
    suggestedModel: '',
    needsKey: false,
    note: 'llama.cpp, vLLM, Groq, Together, Mistral, DeepSeek, Azure — anything speaking the OpenAI chat shape.',
  },
  {
    id: 'apple',
    label: 'Apple on-device',
    adapter: appleFoundation,
    baseUrl: '',
    suggestedModel: 'system',
    needsKey: false,
    note: 'Runs entirely on this Mac. Needs the Swift bridge built with `npm run build:apple` (requires Xcode).',
  },
];

export function presetFor(id: string): ProviderPreset | undefined {
  return PRESETS.find((preset) => preset.id === id);
}

export type ExplainMode = 'off' | 'on-demand' | 'always';

export interface LlmSettings {
  enabled: boolean;
  providerId: string;
  baseUrl: string;
  model: string;
  /** Only when the user chose to type one here instead of using .env.local. */
  apiKey: string;
  mode: ExplainMode;
  direct: boolean;
}

const STORAGE_KEY = 'chess-coach/llm';

export function defaultSettings(): LlmSettings {
  return {
    enabled: false,
    providerId: 'ollama',
    baseUrl: 'http://localhost:11434/v1',
    model: '',
    apiKey: '',
    // Cloud providers mean ~80 calls a game, so on-demand is the safe default.
    mode: 'on-demand',
    direct: false,
  };
}

export function loadLlmSettings(): LlmSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? { ...defaultSettings(), ...(JSON.parse(raw) as Partial<LlmSettings>) } : defaultSettings();
  } catch {
    return defaultSettings();
  }
}

export function saveLlmSettings(settings: LlmSettings): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // Private browsing — settings simply don't persist.
  }
}

export function configFrom(settings: LlmSettings): ProviderConfig {
  return {
    providerId: settings.providerId,
    baseUrl: settings.baseUrl,
    model: settings.model,
    ...(settings.apiKey ? { apiKey: settings.apiKey } : {}),
    direct: settings.direct,
  };
}

export function adapterFor(settings: LlmSettings): LlmProvider | null {
  return presetFor(settings.providerId)?.adapter ?? null;
}
