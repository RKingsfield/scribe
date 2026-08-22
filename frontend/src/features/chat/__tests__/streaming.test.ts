import { describe, it, expect } from 'vitest';
import { readStream, ChatStreamEvent } from '../streaming';

function makeResponse(...chunks: string[]): Response {
  let idx = 0;
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (idx < chunks.length) {
        controller.enqueue(encoder.encode(chunks[idx++]));
      } else {
        controller.close();
      }
    },
  });
  return { body: stream } as unknown as Response;
}

async function collect(response: Response): Promise<ChatStreamEvent[]> {
  const events: ChatStreamEvent[] = [];
  for await (const evt of readStream(response)) {
    events.push(evt);
  }
  return events;
}

describe('readStream SSE parser', () => {
  it('parses normal delta chunks', async () => {
    const response = makeResponse(
      'data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n' +
      'data: {"choices":[{"delta":{"content":" world"}}]}\n\n' +
      'data: [DONE]\n\n',
    );
    const events = await collect(response);
    expect(events).toEqual([
      { type: 'delta', content: 'Hello' },
      { type: 'delta', content: ' world' },
      { type: 'done' },
    ]);
  });

  it('stops at [DONE] sentinel', async () => {
    const response = makeResponse(
      'data: {"choices":[{"delta":{"content":"a"}}]}\n\n' +
      'data: [DONE]\n\n' +
      'data: {"choices":[{"delta":{"content":"should not appear"}}]}\n\n',
    );
    const events = await collect(response);
    expect(events).toHaveLength(2);
    expect(events[1]).toEqual({ type: 'done' });
  });

  it('parses event: meta', async () => {
    const response = makeResponse(
      'event: meta\ndata: {"scope_label":"Chapter 3","estimated_tokens":5000}\n\n' +
      'data: [DONE]\n\n',
    );
    const events = await collect(response);
    expect(events[0]).toEqual({
      type: 'meta',
      scope_label: 'Chapter 3',
      estimated_tokens: 5000,
      extra: { scope_label: 'Chapter 3', estimated_tokens: 5000 },
    });
  });

  it('parses event: error with JSON body', async () => {
    const response = makeResponse(
      'event: error\ndata: {"status":429,"body":"rate limited"}\n\n',
    );
    const events = await collect(response);
    expect(events).toEqual([
      { type: 'error', status: 429, body: 'rate limited' },
    ]);
  });

  it('parses event: error with non-JSON body', async () => {
    const response = makeResponse(
      'event: error\ndata: something went wrong\n\n',
    );
    const events = await collect(response);
    expect(events).toEqual([
      { type: 'error', status: 0, body: 'something went wrong' },
    ]);
  });

  it('handles data split across two network chunks', async () => {
    const response = makeResponse(
      'data: {"choices":[{"delta":{"con',
      'tent":"split"}}]}\n\n' +
      'data: [DONE]\n\n',
    );
    const events = await collect(response);
    expect(events[0]).toEqual({ type: 'delta', content: 'split' });
    expect(events[1]).toEqual({ type: 'done' });
  });

  it('skips empty content deltas', async () => {
    const response = makeResponse(
      'data: {"choices":[{"delta":{"content":""}}]}\n\n' +
      'data: {"choices":[{"delta":{"content":"real"}}]}\n\n' +
      'data: [DONE]\n\n',
    );
    const events = await collect(response);
    expect(events).toEqual([
      { type: 'delta', content: 'real' },
      { type: 'done' },
    ]);
  });

  it('skips deltas with no content key', async () => {
    const response = makeResponse(
      'data: {"choices":[{"delta":{"role":"assistant"}}]}\n\n' +
      'data: {"choices":[{"delta":{"content":"ok"}}]}\n\n' +
      'data: [DONE]\n\n',
    );
    const events = await collect(response);
    expect(events).toEqual([
      { type: 'delta', content: 'ok' },
      { type: 'done' },
    ]);
  });

  it('skips malformed JSON lines without crashing', async () => {
    const response = makeResponse(
      'data: {not valid json\n\n' +
      'data: {"choices":[{"delta":{"content":"ok"}}]}\n\n' +
      'data: [DONE]\n\n',
    );
    const events = await collect(response);
    expect(events).toEqual([
      { type: 'delta', content: 'ok' },
      { type: 'done' },
    ]);
  });

  it('skips SSE comment lines', async () => {
    const response = makeResponse(
      ': this is a comment\n' +
      'data: {"choices":[{"delta":{"content":"ok"}}]}\n\n' +
      'data: [DONE]\n\n',
    );
    const events = await collect(response);
    expect(events[0]).toEqual({ type: 'delta', content: 'ok' });
  });

  it('returns nothing for a response with no body', async () => {
    const response = { body: null } as unknown as Response;
    const events = await collect(response);
    expect(events).toEqual([]);
  });

  it('handles trailing block without final double-newline', async () => {
    const response = makeResponse(
      'data: {"choices":[{"delta":{"content":"trailing"}}]}',
    );
    const events = await collect(response);
    expect(events).toEqual([{ type: 'delta', content: 'trailing' }]);
  });
});
