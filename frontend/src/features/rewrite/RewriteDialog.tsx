import { useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { useOnline } from '../../lib/syncEngine';
import { countWords } from '../../lib/words';
import { ModelEntry, streamRewrite } from '../../lib/api';
import { readStream } from '../chat/streaming';
import { diffStats, diffWords, DiffSeg } from './diff';

export interface RewriteDialogProps {
  slug: string;
  selection: string;
  beforeContext: string;
  afterContext: string;
  open: boolean;
  onClose: () => void;
  onAccept: (rewrite: string) => void;
  models?: ModelEntry[];
  model?: string;
  setModel?: (m: string | undefined) => void;
}

const PRESETS = [
  { label: 'Tighten', text: 'Tighten this. Cut fat, keep meaning, preserve the voice.' },
  { label: 'Expand', text: 'Expand this with more sensory detail. Match the existing voice.' },
  { label: 'Cut adverbs', text: 'Remove unnecessary adverbs. Strengthen verbs in their place.' },
  { label: 'More vivid', text: 'Make the imagery more vivid and concrete without lengthening much.' },
  { label: 'Smoother', text: 'Smooth the rhythm. Vary sentence length. Keep meaning intact.' },
];

export function RewriteDialog({
  slug,
  selection,
  beforeContext,
  afterContext,
  open,
  onClose,
  onAccept,
  models,
  model,
  setModel,
}: RewriteDialogProps) {
  const online = useOnline();
  const [instruction, setInstruction] = useState('');
  const [includeCodex, setIncludeCodex] = useState(false);
  const [streaming, setStreaming] = useState(false);
  const [output, setOutput] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [meta, setMeta] = useState<{ selection_chars: number; context_chars: number } | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    if (!open) return;
    setInstruction('');
    setOutput('');
    setError(null);
    setStreaming(false);
    setMeta(null);
    // focus the instruction input
    setTimeout(() => inputRef.current?.focus(), 0);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (streaming) {
          abortRef.current?.abort();
        } else {
          onClose();
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, streaming, onClose]);

  if (!open) return null;

  const run = async () => {
    if (!instruction.trim() || streaming) return;
    setOutput('');
    setError(null);
    setStreaming(true);

    const ctrl = new AbortController();
    abortRef.current = ctrl;

    let acc = '';
    try {
      const r = await streamRewrite(
        slug,
        {
          selection,
          instruction: instruction.trim(),
          before_context: beforeContext,
          after_context: afterContext,
          include_codex: includeCodex,
          model,
        },
        ctrl.signal,
      );
      for await (const evt of readStream(r)) {
        if (evt.type === 'meta') {
          setMeta({
            selection_chars: Number(evt.extra.selection_chars ?? selection.length),
            context_chars: Number(evt.extra.context_chars ?? 0),
          });
        } else if (evt.type === 'delta') {
          acc += evt.content;
          setOutput(acc);
        } else if (evt.type === 'error') {
          setError(`${evt.status}: ${evt.body}`);
          break;
        } else if (evt.type === 'done') {
          break;
        }
      }
    } catch (e) {
      if ((e as { name?: string }).name !== 'AbortError') {
        setError(String(e));
      }
    } finally {
      abortRef.current = null;
      setStreaming(false);
    }
  };

  const onComposerKey = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      run();
    }
  };

  const cleanedOutput = stripFences(output).trim();
  const segs: DiffSeg[] = cleanedOutput ? diffWords(selection, cleanedOutput) : [];
  const stats = diffStats(segs);

  return (
    <div className="rewrite-overlay" onClick={onClose}>
      <div
        className="rewrite-dialog"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
      >
        <header className="rewrite-head">
          <h3>Rewrite passage</h3>
          {models && setModel && (
            <select
              className="rewrite-model"
              value={model ?? ''}
              onChange={(e) => setModel(e.target.value || undefined)}
              disabled={streaming}
              title="Model"
            >
              <option value="">(project default)</option>
              {models.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.id}
                  {m.tags.includes('big-context') ? ' — 1M (Claude)' : ''}
                </option>
              ))}
            </select>
          )}
          <button className="icon-btn" onClick={onClose} title="Close">
            <X size={16} />
          </button>
        </header>

        <section className="rewrite-section">
          <label className="rewrite-label">Instruction</label>
          <div className="rewrite-presets">
            {PRESETS.map((p) => (
              <button
                key={p.label}
                className="rewrite-preset"
                onClick={() => setInstruction(p.text)}
              >
                {p.label}
              </button>
            ))}
          </div>
          <textarea
            ref={inputRef}
            value={instruction}
            onChange={(e) => setInstruction(e.target.value)}
            onKeyDown={onComposerKey}
            rows={2}
            placeholder="Tighten this. Cut adverbs. Match the surrounding voice."
            disabled={streaming}
          />
          <label className="rewrite-toggle">
            <input
              type="checkbox"
              checked={includeCodex}
              disabled={streaming}
              onChange={(e) => setIncludeCodex(e.target.checked)}
            />
            <span>Attach codex (characters + references)</span>
          </label>
        </section>

        <section className="rewrite-section">
          <div className="rewrite-panes">
            <div className="rewrite-pane">
              <div className="rewrite-pane-head">Original ({countWords(selection)} words)</div>
              <div className="rewrite-pane-body original">{selection}</div>
            </div>
            <div className="rewrite-pane">
              <div className="rewrite-pane-head">
                Rewrite{' '}
                {cleanedOutput ? `(${countWords(cleanedOutput)} words)` : ''}
                {streaming && <span className="rewrite-pulse">●</span>}
              </div>
              <div className="rewrite-pane-body rewrite">
                {cleanedOutput ? (
                  cleanedOutput
                ) : streaming ? (
                  <span className="dim">Streaming…</span>
                ) : (
                  <span className="dim">Output will appear here.</span>
                )}
              </div>
            </div>
          </div>
        </section>

        {cleanedOutput && (
          <section className="rewrite-section">
            <div className="rewrite-pane-head">
              Diff{' '}
              <span className="dim small">
                +{stats.added} / −{stats.removed} words
              </span>
            </div>
            <div className="rewrite-diff">
              {segs.map((s, i) => (
                <span key={i} className={`diff-${s.type}`}>
                  {s.text}
                </span>
              ))}
            </div>
          </section>
        )}

        {error && <div className="rewrite-error">{error}</div>}

        {meta && !streaming && (
          <div className="rewrite-meta dim small">
            {meta.selection_chars} chars selected · {meta.context_chars} chars of context
            {includeCodex ? ' · codex attached' : ''}
          </div>
        )}

        <footer className="rewrite-foot">
          <div className="rewrite-foot-hint dim small">
            <kbd>⌘↵</kbd> rewrite · <kbd>esc</kbd> {streaming ? 'stop' : 'close'}
          </div>
          <div className="rewrite-foot-actions">
            {streaming ? (
              <button className="btn" onClick={() => abortRef.current?.abort()}>
                Stop
              </button>
            ) : (
              <>
                <button className="btn" onClick={onClose}>
                  Cancel
                </button>
                {cleanedOutput && !error && (
                  <button
                    className="btn primary"
                    onClick={() => {
                      onAccept(cleanedOutput);
                      onClose();
                    }}
                  >
                    Accept
                  </button>
                )}
                {!online && (
                  <span className="dim small">Offline</span>
                )}
                <button
                  className="btn primary"
                  onClick={run}
                  disabled={!instruction.trim() || !online}
                >
                  {cleanedOutput ? 'Try again' : 'Rewrite'}
                </button>
              </>
            )}
          </div>
        </footer>
      </div>
    </div>
  );
}


/**
 * Strip markdown code fences if the model wrapped its reply despite the
 * "no fences" instruction. Tolerant of leading/trailing whitespace.
 */
function stripFences(s: string): string {
  const trimmed = s.trim();
  const fenceRe = /^```[a-zA-Z]*\n([\s\S]*?)\n```\s*$/;
  const m = trimmed.match(fenceRe);
  return m ? m[1] : s;
}
