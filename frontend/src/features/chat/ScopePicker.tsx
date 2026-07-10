import { useEffect, useState } from 'react';
import {
  ChatScope,
  ModelEntry,
  ProjectTree,
  ScopePreview,
  previewScope,
} from '../../lib/api';
import { scopeToKey } from './threads';

interface Props {
  slug: string;
  tree: ProjectTree | null;
  scope: ChatScope;
  setScope: (s: ChatScope) => void;
  includeCodex: boolean;
  setIncludeCodex: (v: boolean) => void;
  model: string | undefined;
  setModel: (m: string | undefined) => void;
  models: ModelEntry[];
  onPreview?: (preview: ScopePreview) => void;
}

export function ScopePicker({
  slug,
  tree,
  scope,
  setScope,
  includeCodex,
  setIncludeCodex,
  model,
  setModel,
  models,
  onPreview,
}: Props) {
  const [preview, setPreview] = useState<ScopePreview | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);

  const scopeKey = scopeToKey(scope);
  useEffect(() => {
    let cancelled = false;
    setPreviewError(null);
    previewScope(slug, {
      messages: [],
      scope,
      include_codex: includeCodex,
    })
      .then((p) => {
        if (cancelled) return;
        setPreview(p);
        onPreview?.(p);
      })
      .catch((e) => {
        if (cancelled) return;
        setPreview(null);
        setPreviewError(String(e));
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug, scopeKey, includeCodex]);

  const acts = tree?.acts ?? [];
  const chapters = tree?.chapters ?? [];
  const allScenes = chapters.flatMap((c) =>
    c.scenes.map((s) => ({
      ...s,
      chapterTitle: c.title || c.slug,
      chapterNum: c.chapter,
    })),
  );

  return (
    <aside className="chat-scope">
      <div className="chat-scope-section">
        <label className="chat-scope-label">Scope</label>
        <div className="chat-scope-radios">
          <RadioRow
            checked={scope.kind === 'everything'}
            onChange={() => setScope({ kind: 'everything' })}
            label="Everything"
            hint="Whole project"
          />
          <RadioRow
            checked={scope.kind === 'act'}
            onChange={() =>
              setScope({ kind: 'act', act: scope.kind === 'act' ? scope.act : 1 })
            }
            label="Act"
            disabled={acts.length === 0}
          >
            {scope.kind === 'act' && acts.length > 0 && (
              <select
                className="chat-scope-select"
                value={scope.act}
                onChange={(e) => setScope({ kind: 'act', act: Number(e.target.value) })}
              >
                {acts.map((a, i) => (
                  <option key={a.name} value={i + 1}>
                    {a.name}
                  </option>
                ))}
              </select>
            )}
          </RadioRow>
          <RadioRow
            checked={scope.kind === 'chapter'}
            onChange={() =>
              setScope({
                kind: 'chapter',
                chapter:
                  scope.kind === 'chapter'
                    ? scope.chapter
                    : chapters[0]?.slug ?? '',
              })
            }
            label="Chapter"
            disabled={chapters.length === 0}
          >
            {scope.kind === 'chapter' && chapters.length > 0 && (
              <select
                className="chat-scope-select"
                value={scope.chapter}
                onChange={(e) => setScope({ kind: 'chapter', chapter: e.target.value })}
              >
                {chapters.map((c) => (
                  <option key={c.slug} value={c.slug}>
                    {c.chapter !== null ? `Ch. ${c.chapter}` : c.slug} —{' '}
                    {c.title || c.slug}
                  </option>
                ))}
              </select>
            )}
          </RadioRow>
          <RadioRow
            checked={scope.kind === 'scene'}
            onChange={() =>
              setScope({
                kind: 'scene',
                path: scope.kind === 'scene' ? scope.path : allScenes[0]?.path ?? '',
              })
            }
            label="Scene"
            disabled={allScenes.length === 0}
          >
            {scope.kind === 'scene' && allScenes.length > 0 && (
              <select
                className="chat-scope-select"
                value={scope.path}
                onChange={(e) => setScope({ kind: 'scene', path: e.target.value })}
              >
                {allScenes.map((s) => (
                  <option key={s.path} value={s.path}>
                    {s.chapterNum !== null ? `${s.chapterNum}.${s.scene ?? '?'}` : s.path}{' '}
                    — {s.title || s.chapterTitle}
                  </option>
                ))}
              </select>
            )}
          </RadioRow>
          <RadioRow
            checked={scope.kind === 'codex'}
            onChange={() => setScope({ kind: 'codex' })}
            label="Codex only"
            hint="Characters + references"
          />
        </div>
      </div>

      <div className="chat-scope-section">
        <label className="chat-scope-toggle">
          <input
            type="checkbox"
            checked={includeCodex || scope.kind === 'codex'}
            disabled={scope.kind === 'codex'}
            onChange={(e) => setIncludeCodex(e.target.checked)}
          />
          <span>Attach codex (characters + references)</span>
        </label>
      </div>

      <div className="chat-scope-section">
        <label className="chat-scope-label">Model</label>
        <select
          className="chat-scope-select wide"
          value={model ?? ''}
          onChange={(e) => setModel(e.target.value || undefined)}
        >
          <option value="">(project default)</option>
          {models.map((m) => (
            <option key={m.id} value={m.id}>
              {m.id}
              {m.tags.includes('big-context') ? ' — 1M context (Claude)' : ''}
            </option>
          ))}
        </select>
        {model && isClaudeModel(model) && (
          <div className="chat-scope-hint dim small">
            Routes via Anthropic API · token-billed
          </div>
        )}
      </div>

      <div className="chat-scope-section">
        <label className="chat-scope-label">Context size</label>
        {previewError ? (
          <div className="chat-scope-error">{previewError}</div>
        ) : preview ? (
          <ContextBadge preview={preview} />
        ) : (
          <div className="dim">…</div>
        )}
      </div>
    </aside>
  );
}

function RadioRow({
  checked,
  onChange,
  label,
  hint,
  disabled,
  children,
}: {
  checked: boolean;
  onChange: () => void;
  label: string;
  hint?: string;
  disabled?: boolean;
  children?: React.ReactNode;
}) {
  return (
    <div className={`chat-scope-radio${disabled ? ' is-disabled' : ''}`}>
      <label>
        <input
          type="radio"
          checked={checked}
          disabled={disabled}
          onChange={() => !disabled && onChange()}
        />
        <span>{label}</span>
        {hint && <span className="chat-scope-hint">{hint}</span>}
      </label>
      {checked && children}
    </div>
  );
}

function isClaudeModel(id: string): boolean {
  return id.startsWith('claude');
}

function ContextBadge({ preview }: { preview: ScopePreview }) {
  const t = preview.estimated_tokens;
  const cls =
    t > 64000 ? 'huge' : t > 16000 ? 'big' : t > 4000 ? 'med' : 'small';
  return (
    <div className={`chat-scope-tokens ${cls}`}>
      <div className="chat-scope-tokens-num">~{t.toLocaleString()} tok</div>
      <div className="chat-scope-tokens-meta">
        {preview.section_count} file{preview.section_count === 1 ? '' : 's'}
        {preview.codex_included ? ' · codex' : ''}
      </div>
    </div>
  );
}
