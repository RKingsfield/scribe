import { useCallback, useEffect, useRef, useState } from 'react';
import { relativeTime } from '../../lib/format';
import { useOnline } from '../../lib/syncEngine';
import { X } from 'lucide-react';
import { useOutletContext, useSearchParams } from 'react-router-dom';
import { ChatScope, ModelEntry, listModels, streamChat } from '../../lib/api';
import { ChatThread, ChatTurn } from '../../lib/db';
import { ProjectContext } from '../project/ProjectView';
import { ScopePicker } from './ScopePicker';
import { ChatThreadView } from './ChatThread';
import { readStream } from './streaming';
import {
  appendTurn,
  createThread,
  deleteThread,
  getThread,
  listThreads,
  scopeToKey,
  updateLastTurn,
  updateThreadMeta,
} from './threads';

export function ChatView() {
  const online = useOnline();
  const { slug, tree } = useOutletContext<ProjectContext>();
  const [searchParams, setSearchParams] = useSearchParams();

  const [threads, setThreads] = useState<ChatThread[]>([]);
  const [activeId, setActiveId] = useState<string | null>(searchParams.get('t'));
  const [active, setActive] = useState<ChatThread | null>(null);

  const [scope, setScope] = useState<ChatScope>({ kind: 'everything' });
  const [includeCodex, setIncludeCodex] = useState(false);
  const [model, setModel] = useState<string | undefined>(undefined);
  const [models, setModels] = useState<ModelEntry[]>([]);
  const [draft, setDraft] = useState('');

  const [streaming, setStreaming] = useState<
    | { content: string; meta?: { scope_label: string; estimated_tokens: number } }
    | null
  >(null);
  const [streamError, setStreamError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const turnsEndRef = useRef<HTMLDivElement | null>(null);

  const refreshThreads = useCallback(async () => {
    const list = await listThreads(slug);
    setThreads(list);
  }, [slug]);

  useEffect(() => {
    refreshThreads();
    listModels()
      .then((m) => setModels(m))
      .catch(() => setModels([]));
  }, [slug, refreshThreads]);

  // load active thread on switch
  useEffect(() => {
    if (!activeId) {
      setActive(null);
      return;
    }
    let cancelled = false;
    getThread(activeId).then((t) => {
      if (cancelled) return;
      if (t) {
        setActive(t);
        setScope(t.scope);
        setIncludeCodex(t.includeCodex);
        setModel(t.model);
      } else {
        setActive(null);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [activeId]);

  // sync route param
  useEffect(() => {
    if (activeId) setSearchParams({ t: activeId }, { replace: true });
    else setSearchParams({}, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId]);

  const scopeKey = scopeToKey(scope);
  // persist scope/model edits to active thread
  useEffect(() => {
    if (!active) return;
    updateThreadMeta(active.id, { scope, includeCodex, model }).then(refreshThreads);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scopeKey, includeCodex, model, active?.id]);

  // auto-scroll to latest turn while streaming
  useEffect(() => {
    turnsEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [streaming?.content, active?.turns.length]);

  const newThread = useCallback(async () => {
    const t = await createThread(slug, scope, includeCodex, model);
    setActiveId(t.id);
    await refreshThreads();
  }, [slug, scope, includeCodex, model, refreshThreads]);

  const removeThread = useCallback(
    async (id: string) => {
      await deleteThread(id);
      if (activeId === id) setActiveId(null);
      await refreshThreads();
    },
    [activeId, refreshThreads],
  );

  const send = useCallback(async () => {
    const text = draft.trim();
    if (!text) return;
    if (streaming) return;

    let threadId = activeId;
    if (!threadId) {
      const t = await createThread(slug, scope, includeCodex, model);
      threadId = t.id;
      setActiveId(t.id);
    }

    const userTurn: ChatTurn = { role: 'user', content: text, ts: Date.now() };
    await appendTurn(threadId, userTurn);
    // seed an assistant turn we'll stream into
    const assistantTurn: ChatTurn = { role: 'assistant', content: '', ts: Date.now() };
    const t1 = await appendTurn(threadId, assistantTurn);
    setActive(t1 ?? null);
    setDraft('');
    await refreshThreads();

    setStreamError(null);
    setStreaming({ content: '' });

    const messages = (t1?.turns ?? [])
      .filter((tu) => tu.role === 'user' || tu.role === 'assistant')
      .slice(0, -1)  // drop the placeholder assistant turn we just added
      .map((tu) => ({ role: tu.role as 'user' | 'assistant', content: tu.content }));

    const ctrl = new AbortController();
    abortRef.current = ctrl;

    let acc = '';
    let errorText: string | null = null;
    let meta: { scope_label: string; estimated_tokens: number } | undefined;
    try {
      const r = await streamChat(
        slug,
        { messages, scope, include_codex: includeCodex, model },
        ctrl.signal,
      );
      for await (const evt of readStream(r)) {
        if (evt.type === 'meta') {
          meta = { scope_label: evt.scope_label, estimated_tokens: evt.estimated_tokens };
          setStreaming({ content: acc, meta });
        } else if (evt.type === 'delta') {
          acc += evt.content;
          setStreaming({ content: acc, meta });
        } else if (evt.type === 'error') {
          errorText = `${evt.status}: ${evt.body}`;
          setStreamError(errorText);
          break;
        } else if (evt.type === 'done') {
          break;
        }
      }
      // Don't persist a blank placeholder turn — the error is already surfaced via streamError.
      await updateLastTurn(threadId, {
        content: acc || (errorText ? `[error: ${errorText}]` : ''),
        ts: Date.now(),
      });
    } catch (e) {
      if ((e as { name?: string }).name === 'AbortError') {
        await updateLastTurn(threadId, { content: acc + '\n\n[interrupted]' });
      } else {
        const msg = String(e);
        setStreamError(msg);
        await updateLastTurn(threadId, { content: acc || `[error: ${msg}]`, ts: Date.now() });
      }
    } finally {
      abortRef.current = null;
      setStreaming(null);
      const fresh = await getThread(threadId);
      setActive(fresh ?? null);
      await refreshThreads();
    }
  }, [
    draft,
    streaming,
    activeId,
    slug,
    scope,
    includeCodex,
    model,
    refreshThreads,
  ]);

  const stop = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      send();
    }
  };

  const turns = active?.turns ?? [];


  if (!online) {
    return (
      <div className="placeholder-view">
        <p className="dim">Chat requires an internet connection.</p>
      </div>
    );
  }

  if (!tree) return <p>Loading…</p>;

  return (
    <div className="chat-view">
      <aside className="chat-sidebar">
        <button className="btn primary chat-new" onClick={newThread}>
          + New chat
        </button>
        <div className="chat-history">
          {threads.length === 0 && <div className="dim small">No threads yet.</div>}
          {threads.map((t) => (
            <div
              key={t.id}
              role="button"
              tabIndex={0}
              className={`chat-history-row${t.id === activeId ? ' active' : ''}`}
              onClick={() => setActiveId(t.id)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  setActiveId(t.id);
                }
              }}
            >
              <div className="chat-history-title">{t.title}</div>
              <div className="chat-history-meta">
                {scopeLabel(t.scope, tree)} · {relativeTime(t.updatedAt)}
              </div>
              <button
                className="chat-history-del"
                onClick={(e) => {
                  e.stopPropagation();
                  if (window.confirm('Delete this thread?')) removeThread(t.id);
                }}
                onKeyDown={(e) => e.stopPropagation()}
                title="Delete"
              >
                <X size={14} />
              </button>
            </div>
          ))}
        </div>
      </aside>

      <main className="chat-main">
        <ChatThreadView turns={turns} streaming={streaming} error={streamError} />
        <div ref={turnsEndRef} />
        <div className="chat-composer">
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Ask scribe… (⌘/Ctrl+Enter to send)"
            rows={3}
            disabled={!!streaming}
          />
          <div className="chat-composer-actions">
            {streaming ? (
              <button className="btn" onClick={stop}>
                Stop
              </button>
            ) : (
              <button className="btn primary" onClick={send} disabled={!draft.trim()}>
                Send
              </button>
            )}
          </div>
        </div>
      </main>

      <ScopePicker
        slug={slug}
        tree={tree}
        scope={scope}
        setScope={setScope}
        includeCodex={includeCodex}
        setIncludeCodex={setIncludeCodex}
        model={model}
        setModel={setModel}
        models={models}
      />
    </div>
  );
}

function scopeLabel(scope: ChatScope, tree: ProjectContext['tree']): string {
  if (!tree) return '—';
  if (scope.kind === 'everything') return 'Everything';
  if (scope.kind === 'codex') return 'Codex';
  if (scope.kind === 'act') {
    const a = tree.acts[scope.act - 1];
    return a ? `Act: ${a.name}` : `Act ${scope.act}`;
  }
  if (scope.kind === 'chapter') {
    const c = tree.chapters.find((x) => x.slug === scope.chapter);
    return c ? `Ch. ${c.chapter ?? c.slug}` : `Ch. ${scope.chapter}`;
  }
  if (scope.kind === 'scene') {
    return scope.path.split('/').pop() ?? scope.path;
  }
  return '—';
}

