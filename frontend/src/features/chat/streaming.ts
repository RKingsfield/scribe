/**
 * SSE parser for the orchestrator-relayed `/api/projects/:slug/chat/stream`
 * endpoint. Consumes a fetch Response body and emits typed events.
 */

export type ChatStreamEvent =
  | { type: 'meta'; scope_label: string; estimated_tokens: number; extra: Record<string, unknown> }
  | { type: 'delta'; content: string }
  | { type: 'done' }
  | { type: 'error'; status: number; body: string };

export async function* readStream(
  response: Response,
): AsyncGenerator<ChatStreamEvent> {
  const reader = response.body?.getReader();
  if (!reader) return;
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let sep: number;
    while ((sep = buffer.indexOf('\n\n')) !== -1) {
      const block = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      const evt = parseBlock(block);
      if (evt) yield evt;
      if (evt && evt.type === 'done') return;
    }
  }
  // flush trailing partial block (rare — most servers terminate with \n\n)
  if (buffer.trim()) {
    const evt = parseBlock(buffer);
    if (evt) yield evt;
  }
}

function parseBlock(block: string): ChatStreamEvent | null {
  let event = 'message';
  const dataLines: string[] = [];
  for (const raw of block.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith(':')) continue; // comment
    if (line.startsWith('event:')) {
      event = line.slice(6).trim();
    } else if (line.startsWith('data:')) {
      dataLines.push(line.slice(5).trimStart());
    }
  }
  const data = dataLines.join('\n');
  if (!data) return null;

  if (event === 'meta') {
    try {
      const parsed = JSON.parse(data);
      return {
        type: 'meta',
        scope_label: String(parsed.scope_label ?? ''),
        estimated_tokens: Number(parsed.estimated_tokens ?? 0),
        extra: parsed,
      };
    } catch {
      return null;
    }
  }
  if (event === 'error') {
    try {
      const parsed = JSON.parse(data);
      return {
        type: 'error',
        status: Number(parsed.status ?? 0),
        body: String(parsed.body ?? ''),
      };
    } catch {
      return { type: 'error', status: 0, body: data };
    }
  }
  // default OpenAI-style streaming chunks
  if (data === '[DONE]') return { type: 'done' };
  try {
    const parsed = JSON.parse(data);
    const delta = parsed?.choices?.[0]?.delta?.content;
    if (typeof delta === 'string' && delta.length > 0) {
      return { type: 'delta', content: delta };
    }
    return null;
  } catch {
    return null;
  }
}
