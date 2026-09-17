/**
 * Shared streaming helpers.
 *
 * Reasoning-delta stripping lives here rather than in each adapter, because
 * "which field carries the visible text" varies by provider but "which fields
 * carry chain-of-thought" is the same everywhere. Unfiltered, the coach panel
 * fills with the model's internal monologue the moment someone picks a
 * thinking model — and plenty of them are, including the only model installed
 * on this machine.
 */

/** Fields that carry reasoning rather than the answer. Never displayed. */
const REASONING_FIELDS = ['reasoning_content', 'reasoning', 'thinking', 'thought'];

/** Inline reasoning some models emit in the visible channel anyway. */
const INLINE_REASONING = /<\/?(?:think|thinking|reasoning|scratchpad)>/gi;

/** Pulls the visible text out of a delta object, ignoring reasoning fields. */
export function visibleTextFrom(delta: unknown): string {
  if (typeof delta === 'string') return delta;
  if (!delta || typeof delta !== 'object') return '';

  const record = delta as Record<string, unknown>;
  for (const field of REASONING_FIELDS) {
    if (field in record) {
      // Present and non-empty means this chunk is reasoning — drop it whole.
      if (typeof record[field] === 'string' && record[field]) return '';
    }
  }

  return typeof record['content'] === 'string' ? record['content'] : '';
}

/**
 * Strips inline reasoning blocks from accumulated text.
 *
 * Some models open a `<think>` block in the visible channel regardless of
 * instructions. Everything up to the closing tag is discarded.
 */
export function stripInlineReasoning(text: string): string {
  const closed = text.replace(/<(?:think|thinking|reasoning|scratchpad)>[\s\S]*?<\/(?:think|thinking|reasoning|scratchpad)>/gi, '');
  return closed.replace(INLINE_REASONING, '').trim();
}

/**
 * Reads a Server-Sent Events body, yielding each `data:` payload.
 *
 * Terminates on the `[DONE]` sentinel. Handles chunk boundaries falling in the
 * middle of a line, which they routinely do.
 */
export async function* readSse(response: Response, signal: AbortSignal): AsyncGenerator<string> {
  const reader = response.body?.getReader();
  if (!reader) return;

  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (!signal.aborted) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) continue;

        const payload = trimmed.slice(5).trim();
        if (payload === '[DONE]') return;
        if (payload.length > 0) yield payload;
      }
    }
  } finally {
    void reader.cancel().catch(() => undefined);
  }
}

/** Reads a newline-delimited JSON body, yielding each line. */
export async function* readNdjson(response: Response, signal: AbortSignal): AsyncGenerator<string> {
  const reader = response.body?.getReader();
  if (!reader) return;

  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (!signal.aborted) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        if (line.trim().length > 0) yield line;
      }
    }
    if (buffer.trim().length > 0) yield buffer;
  } finally {
    void reader.cancel().catch(() => undefined);
  }
}

export function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
