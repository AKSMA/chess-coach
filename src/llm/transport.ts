/**
 * How a provider request actually leaves the browser.
 *
 * Cloud keys must never reach the browser, so adapters don't fetch directly:
 * they describe the request, and the dev-server proxy attaches the key and
 * forwards it. Local providers may opt out of the hop, since there is no key
 * to protect and Ollama already allows browser CORS from localhost.
 */
import { PROXY_PATH, type ProviderConfig } from './types.js';

/** A provider request, fully shaped but with no credential attached. */
export interface ProviderRequest {
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

/**
 * Sends a provider request, through the proxy unless the config opts out.
 *
 * The proxy is the default even for local providers so there is one code path;
 * `direct: true` skips it for people who would rather not have the hop.
 */
export async function send(
  request: ProviderRequest,
  config: ProviderConfig,
  signal: AbortSignal,
): Promise<Response> {
  if (config.direct) {
    const headers = { ...request.headers };
    if (config.apiKey) headers['Authorization'] = `Bearer ${config.apiKey}`;

    return fetch(request.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(request.body),
      signal,
    });
  }

  const response = await fetch(PROXY_PATH, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      providerId: config.providerId,
      url: request.url,
      headers: request.headers,
      body: request.body,
      // A key typed into settings rides along; keys in .env.local never do.
      apiKey: config.apiKey ?? null,
    }),
    signal,
  });

  return response;
}

/** A GET, for model listing and reachability probes. */
export async function get(
  url: string,
  config: ProviderConfig,
  signal?: AbortSignal,
): Promise<Response> {
  if (config.direct) {
    const headers: Record<string, string> = {};
    if (config.apiKey) headers['Authorization'] = `Bearer ${config.apiKey}`;
    return fetch(url, { headers, ...(signal ? { signal } : {}) });
  }

  return fetch(PROXY_PATH, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      providerId: config.providerId,
      url,
      method: 'GET',
      apiKey: config.apiKey ?? null,
    }),
    ...(signal ? { signal } : {}),
  });
}

/** Turns a non-2xx response into a message worth showing the user. */
export async function describeFailure(response: Response): Promise<string> {
  const text = await response.text().catch(() => '');
  const snippet = text.slice(0, 200).replace(/\s+/g, ' ').trim();

  switch (response.status) {
    case 401:
    case 403:
      return 'Authentication failed — check the API key.';
    case 404:
      return `Not found (${response.status}). Check the base URL and model name.`;
    case 429:
      return 'Rate limited. Wait a moment and try again.';
    default:
      return snippet.length > 0
        ? `${response.status}: ${snippet}`
        : `Request failed with status ${response.status}.`;
  }
}
