import { useCallback, useEffect, useState } from 'react';
import { X } from 'lucide-react';
import { useOnline } from '../../lib/syncEngine';
import {
  RagHit,
  RagState,
  deleteRagCollection,
  getRagState,
  queryRag,
  writeRagRecipe,
} from '../../lib/api';

interface Props {
  slug: string;
  open: boolean;
  onClose: () => void;
}

export function RagPanel({ slug, open, onClose }: Props) {
  const online = useOnline();
  const [state, setState] = useState<RagState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<null | string>(null);
  const [copied, setCopied] = useState(false);
  const [showRecipe, setShowRecipe] = useState(false);

  const [queryText, setQueryText] = useState('');
  const [hits, setHits] = useState<RagHit[] | null>(null);
  const [queryError, setQueryError] = useState<string | null>(null);
  const [querying, setQuerying] = useState(false);

  const refresh = useCallback(async () => {
    setError(null);
    try {
      const s = await getRagState(slug);
      setState(s);
    } catch (e) {
      setError(String(e));
    }
  }, [slug]);

  useEffect(() => {
    if (!open) return;
    refresh();
  }, [open, refresh]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  const regenerate = async () => {
    setBusy('recipe');
    setError(null);
    try {
      await writeRagRecipe(slug);
      await refresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(null);
    }
  };

  const dropCollection = async () => {
    if (!window.confirm(`Drop Qdrant collection "${state?.collection}"? You'll need to re-ingest after this.`)) return;
    setBusy('drop');
    setError(null);
    try {
      await deleteRagCollection(slug);
      await refresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(null);
    }
  };

  const copyCommand = async () => {
    if (!state?.ingest_command) return;
    try {
      await navigator.clipboard.writeText(state.ingest_command);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // ignore
    }
  };

  const runQuery = async () => {
    if (!queryText.trim() || querying) return;
    setQuerying(true);
    setQueryError(null);
    setHits(null);
    try {
      const r = await queryRag(slug, { text: queryText.trim(), limit: 8 });
      setHits(r.hits);
    } catch (e) {
      setQueryError(String(e));
    } finally {
      setQuerying(false);
    }
  };

  const onQueryKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      runQuery();
    }
  };

  return (
    <div className="panel-overlay" onClick={onClose}>
      <div
        className="panel-dialog"
        role="dialog"
        aria-modal="true"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="panel-head">
          <h3>Project RAG</h3>
          <button className="icon-btn" onClick={onClose} title="Close">
            <X size={16} />
          </button>
        </header>

        {!online && (
          <p className="dim" style={{ padding: '1rem' }}>RAG queries require an internet connection.</p>
        )}

        {error && <div className="panel-error">{error}</div>}

        {!state ? (
          <div className="panel-section dim">Loading…</div>
        ) : (
          <>
            <section className="panel-section">
              <div className="rag-row">
                <span className="panel-label">Collection</span>
                <code className="rag-mono">{state.collection}</code>
              </div>
              <div className="rag-row">
                <span className="panel-label">Qdrant</span>
                {state.qdrant.exists ? (
                  <span className="rag-status ok">
                    {(state.qdrant.points_count ?? 0).toLocaleString()} chunks · {state.qdrant.status ?? '—'}
                  </span>
                ) : (
                  <span className="rag-status missing">
                    {state.qdrant.error ? `unreachable (${state.qdrant.error})` : 'not ingested yet'}
                  </span>
                )}
              </div>
              <div className="rag-row">
                <span className="panel-label">Recipe</span>
                <code className="rag-mono">{state.recipe_path}</code>
                <span className={`rag-status ${state.recipe_exists ? 'ok' : 'missing'}`}>
                  {state.recipe_exists ? 'exists' : 'not written'}
                </span>
              </div>
            </section>

            <section className="panel-section">
              <div className="panel-actions">
                <button
                  className="btn primary"
                  onClick={regenerate}
                  disabled={busy === 'recipe'}
                >
                  {busy === 'recipe' ? 'Writing…' : state.recipe_exists ? 'Regenerate recipe' : 'Generate recipe'}
                </button>
                <button
                  className="btn"
                  onClick={() => setShowRecipe((v) => !v)}
                  disabled={!state.recipe_yaml}
                >
                  {showRecipe ? 'Hide recipe' : 'View recipe'}
                </button>
                {state.qdrant.exists && (
                  <button
                    className="btn danger"
                    onClick={dropCollection}
                    disabled={busy === 'drop'}
                  >
                    {busy === 'drop' ? 'Dropping…' : 'Drop collection'}
                  </button>
                )}
              </div>
              {showRecipe && state.recipe_yaml && (
                <pre className="rag-recipe-yaml">{state.recipe_yaml}</pre>
              )}
            </section>

            <section className="panel-section">
              <label className="panel-label">Ingest</label>
              <p className="dim small">
                Run this on a host that has the writing volume mounted and the
                RAG stack running. ntfy will push to <code>rag-ingest</code> when
                it finishes.
              </p>
              <div className="rag-cmd-row">
                <code className="rag-cmd">{state.ingest_command}</code>
                <button className="btn" onClick={copyCommand}>
                  {copied ? 'Copied' : 'Copy'}
                </button>
              </div>
            </section>

            <section className="panel-section">
              <label className="panel-label">Quick query</label>
              <div className="rag-query-row">
                <input
                  type="text"
                  value={queryText}
                  onChange={(e) => setQueryText(e.target.value)}
                  onKeyDown={onQueryKey}
                  placeholder="Search the embedded manuscript… (Enter to run)"
                  disabled={!state.qdrant.exists || querying}
                />
                <button
                  className="btn primary"
                  onClick={runQuery}
                  disabled={!state.qdrant.exists || !queryText.trim() || querying}
                >
                  {querying ? '…' : 'Search'}
                </button>
              </div>
              {!state.qdrant.exists && (
                <div className="dim small">Run the ingest first.</div>
              )}
              {queryError && <div className="panel-error">{queryError}</div>}
              {hits && (
                <div className="rag-hits">
                  {hits.length === 0 && <div className="dim small">No matches.</div>}
                  {hits.map((h, i) => (
                    <RagHitRow key={i} hit={h} />
                  ))}
                </div>
              )}
            </section>
          </>
        )}
      </div>
    </div>
  );
}

function RagHitRow({ hit }: { hit: RagHit }) {
  const text =
    (hit.payload.text as string | undefined) ??
    (hit.payload.content as string | undefined) ??
    '';
  const path = hit.payload.path as string | undefined;
  const kind = hit.payload.kind as string | undefined;
  return (
    <div className="rag-hit">
      <div className="rag-hit-head">
        <span className="rag-hit-score">{hit.score.toFixed(3)}</span>
        {kind && <span className="rag-hit-kind">{kind}</span>}
        {path && <code className="rag-hit-path">{path}</code>}
      </div>
      {text && <div className="rag-hit-text">{text.slice(0, 380)}{text.length > 380 ? '…' : ''}</div>}
    </div>
  );
}
