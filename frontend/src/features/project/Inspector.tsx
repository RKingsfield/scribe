import { useMemo } from 'react';

import { CodexEntry, detectCharacters } from '../editor/codexLink';
import { detectKind } from '../editor/detectKind';
import type { ChapterFrontmatter, ReferenceFrontmatter } from '../../lib/types';

type InspectorFrontmatter = ChapterFrontmatter & ReferenceFrontmatter;

interface Props {
  activePath: string | null;
  frontmatter: Record<string, unknown>;
  body: string;
  codex: readonly CodexEntry[];
  onChange: (next: Record<string, unknown>) => void;
  onSelect: (path: string) => void;
}

export function Inspector({
  activePath,
  frontmatter,
  body,
  codex,
  onChange,
  onSelect,
}: Props) {
  const kind = activePath ? detectKind(activePath) : null;
  const fm = frontmatter as InspectorFrontmatter;
  const update = (patch: Record<string, unknown>) =>
    onChange({ ...frontmatter, ...patch });
  const removeKey = (key: string) => {
    const next = { ...frontmatter };
    delete next[key];
    onChange(next);
  };

  const detectedChars = useMemo(() => {
    if (!body || codex.length === 0) return [];
    return detectCharacters(body, codex);
  }, [body, codex]);

  if (!activePath) {
    return (
      <div className="inspector-body">
        <p className="inspector-empty">Select a chapter to inspect.</p>
      </div>
    );
  }

  return (
    <div className="inspector-body">
      <section className="inspector-section">
        <h4>{kind === 'chapter' ? 'Chapter' : 'Reference'}</h4>
        <div className="field">
          <span className="field-label">Title</span>
          <input
            value={fm.title ?? ''}
            onChange={(e) => update({ title: e.target.value })}
          />
        </div>

        {kind === 'chapter' && (
          <div className="field">
            <span className="field-label">Summary</span>
            <textarea
              rows={3}
              value={fm.summary ?? ''}
              onChange={(e) => update({ summary: e.target.value })}
              placeholder="What happens in this chapter (shown in sidebar + corkboard)"
            />
          </div>
        )}

        {kind === 'chapter' && (
          <div className="row">
            {fm.kind !== 'interlude' ? (
              <div className="field">
                <span className="field-label">Chapter #</span>
                <input
                  type="number"
                  min={1}
                  value={numOrNull(fm.chapter) ?? ''}
                  onChange={(e) =>
                    e.target.value === ''
                      ? removeKey('chapter')
                      : update({ chapter: Number(e.target.value) })
                  }
                />
              </div>
            ) : (
              <div className="field">
                <span className="field-label">Interlude #</span>
                <input
                  type="number"
                  min={1}
                  value={numOrNull(fm.interlude) ?? ''}
                  onChange={(e) =>
                    e.target.value === ''
                      ? removeKey('interlude')
                      : update({ interlude: Number(e.target.value) })
                  }
                />
              </div>
            )}
            <div className="field">
              <span className="field-label">Order</span>
              <input
                type="number"
                step="0.1"
                value={numOrNull(fm.order) ?? ''}
                onChange={(e) =>
                  e.target.value === ''
                    ? removeKey('order')
                    : update({ order: Number(e.target.value) })
                }
              />
            </div>
          </div>
        )}

        {kind === 'reference' && (
          <>
            <div className="field">
              <span className="field-label">Aliases (comma-separated)</span>
              <input
                value={(fm.aliases ?? []).join(', ')}
                onChange={(e) => {
                  const list = e.target.value
                    .split(',')
                    .map((s) => s.trim())
                    .filter(Boolean);
                  if (list.length === 0) removeKey('aliases');
                  else update({ aliases: list });
                }}
                placeholder="e.g. Old Tarn, the Foxhead"
              />
            </div>
            <div className="field">
              <span className="field-label">Tags (comma-separated)</span>
              <input
                value={(fm.tags ?? []).join(', ')}
                onChange={(e) => {
                  const list = e.target.value
                    .split(',')
                    .map((s) => s.trim())
                    .filter(Boolean);
                  if (list.length === 0) removeKey('tags');
                  else update({ tags: list });
                }}
                placeholder="e.g. worldbuilding, magic, revisions"
              />
            </div>
          </>
        )}
      </section>

      {kind === 'chapter' && detectedChars.length > 0 && (
        <section className="inspector-section">
          <h4>Characters detected</h4>
          <div className="chip-row">
            {detectedChars.map((c) => (
              <button
                key={c.path}
                className="chip"
                onClick={() => onSelect(c.path)}
                title={`Open ${c.title}`}
              >
                {c.title}
              </button>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

function numOrNull(v: unknown): number | null {
  if (typeof v === 'number') return v;
  if (typeof v === 'string' && v !== '' && !Number.isNaN(Number(v))) return Number(v);
  return null;
}
