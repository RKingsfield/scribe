import { render, screen, waitFor, fireEvent, cleanup } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MemoryRouter, Outlet, Route, Routes } from 'react-router-dom';
import { ChatView } from '../ChatView';
import { db } from '../../../lib/db';
import type { ProjectContext } from '../../project/ProjectView';
import type { ProjectTree, ScopePreview } from '../../../lib/api';

vi.mock('../../../lib/api', async () => {
  const actual = await vi.importActual<typeof import('../../../lib/api')>('../../../lib/api');
  return {
    ...actual,
    listModels: vi.fn(),
    previewScope: vi.fn(),
    streamChat: vi.fn(),
  };
});

import * as api from '../../../lib/api';

// jsdom doesn't implement scrollIntoView; ChatView calls it to follow new turns.
Element.prototype.scrollIntoView = vi.fn();

const tree: ProjectTree = {
  slug: 'demo',
  title: 'Demo Novel',
  author: 'Author',
  rag_recipe: null,
  default_model: 'gpt',
  acts: [],
  chapters: [],
  categories: [],
};

const context: ProjectContext = {
  slug: 'demo',
  tree,
  refreshTree: () => {},
  setHeader: () => {},
};

const preview: ScopePreview = {
  label: 'Everything',
  section_count: 0,
  char_count: 0,
  estimated_tokens: 0,
  codex_included: false,
};

function renderChatView(initialEntries: string[] = ['/']) {
  return render(
    <MemoryRouter initialEntries={initialEntries}>
      <Routes>
        <Route element={<Outlet context={context} />}>
          <Route path="/" element={<ChatView />} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
}

function sseResponse(...events: string[]): Response {
  let idx = 0;
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (idx < events.length) {
        controller.enqueue(encoder.encode(events[idx++]));
      } else {
        controller.close();
      }
    },
  });
  return { ok: true, body: stream } as unknown as Response;
}

async function clearAllTables() {
  await db.chats.clear();
}

describe('ChatView', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    await clearAllTables();
    vi.mocked(api.listModels).mockResolvedValue([]);
    vi.mocked(api.previewScope).mockResolvedValue(preview);
  });

  afterEach(async () => {
    cleanup();
    await clearAllTables();
  });

  it('creating a new thread adds it to Dexie and the sidebar', async () => {
    renderChatView();

    fireEvent.click(await screen.findByText('+ New chat'));

    await waitFor(async () => {
      expect(await db.chats.where('slug').equals('demo').count()).toBe(1);
    });
    await screen.findByText('Untitled chat');
  });

  it('renders an existing thread\'s messages', async () => {
    await db.chats.put({
      id: 't1',
      slug: 'demo',
      title: 'My chat',
      scope: { kind: 'everything' },
      includeCodex: false,
      turns: [
        { role: 'user', content: 'What is the story about?', ts: 1 },
        { role: 'assistant', content: 'A journey through the mountains.', ts: 2 },
      ],
      createdAt: 1,
      updatedAt: 2,
    });

    renderChatView(['/?t=t1']);

    await screen.findByText('What is the story about?');
    await screen.findByText('A journey through the mountains.');
  });

  it('shows a streaming cursor and appends chunks while a response streams in', async () => {
    vi.mocked(api.streamChat).mockResolvedValue(
      sseResponse(
        'data: {"choices":[{"delta":{"content":"Once "}}]}\n\n' +
          'data: {"choices":[{"delta":{"content":"upon a time."}}]}\n\n' +
          'data: [DONE]\n\n',
      ),
    );

    renderChatView();
    fireEvent.click(await screen.findByText('+ New chat'));
    await screen.findByText('Untitled chat');

    const textarea = screen.getByPlaceholderText(/Ask scribe/);
    fireEvent.change(textarea, { target: { value: 'Tell me a story' } });
    fireEvent.click(screen.getByText('Send'));

    // the streaming turn renders a cursor element while in flight
    await waitFor(() => {
      expect(document.querySelector('.chat-cursor')).toBeTruthy();
    });

    // once the stream finishes, the final content is persisted and re-rendered
    await screen.findByText('Once upon a time.');
    await waitFor(() => {
      expect(document.querySelector('.chat-cursor')).toBeNull();
    });

    const saved = await db.chats.get(
      (await db.chats.where('slug').equals('demo').toArray())[0].id,
    );
    expect(saved?.turns[saved.turns.length - 1]).toMatchObject({
      role: 'assistant',
      content: 'Once upon a time.',
    });
  });

  it('persists the selected scope on the thread and restores it when switching threads', async () => {
    await db.chats.put({
      id: 'everything-thread',
      slug: 'demo',
      title: 'Everything chat',
      scope: { kind: 'everything' },
      includeCodex: false,
      turns: [],
      createdAt: 1,
      updatedAt: 1,
    });
    await db.chats.put({
      id: 'codex-thread',
      slug: 'demo',
      title: 'Codex chat',
      scope: { kind: 'codex' },
      includeCodex: false,
      turns: [],
      createdAt: 2,
      updatedAt: 2,
    });

    renderChatView(['/?t=everything-thread']);
    await screen.findByText('Everything chat');
    const everythingRadio = (await screen.findByLabelText(
      /^Everything/,
    )) as HTMLInputElement;
    await waitFor(() => expect(everythingRadio.checked).toBe(true));

    fireEvent.click(screen.getByText('Codex chat'));
    const codexRadio = (await screen.findByLabelText(/^Codex only/)) as HTMLInputElement;
    await waitFor(() => expect(codexRadio.checked).toBe(true));

    fireEvent.click(screen.getByText('Everything chat'));
    await waitFor(() => expect(everythingRadio.checked).toBe(true));
  });
});
