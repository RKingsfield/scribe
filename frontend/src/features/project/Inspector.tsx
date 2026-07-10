import { useMemo } from 'react';
import { ChapterEntry, ProjectTree } from '../../lib/api';
import { CodexEntry, detectCharacters } from '../editor/codexLink';
import { detectKind } from '../editor/detectKind';

interface Props {
  tree: ProjectTree;
  activePath: string | null;
  frontmatter: Record<string, unknown>;
  body: string;
  liveWordCount: number;
  codex: readonly CodexEntry[];
  onChange: (next: Record<string, unknown>) => void;
  onSelect: (path: string) => void;
}

const STATUSES = ['draft', 'revision', 'final'] as const;

export function Inspector({
  tree,
  activePath,
  frontmatter,
  body,
  liveWordCount,
  codex,
  onChange,
  onSelect,
}: Props) {
  const kind = activePath ? detectKind(activePath) : null;
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

  const enclosingChapter = useMemo<ChapterEntry | null>(() => {
    if (!activePath) return null;
    return (
      tree.chapters.find(
        (c) =>
          c.meta_path === activePath ||
          c.scenes.some((s) => s.path === activePath),
      ) ?? null
    );
  }, [tree, activePath]);

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
        <h4>{kind === 'chapter' ? 'Chapter' : kind === 'scene' ? 'Scene' : 'Reference'}</h4>
        <div className="field">
          <span className="field-label">Title</span>
          <input
            value={(frontmatter.title as string) ?? ''}
            onChange={(e) => update({ title: e.target.value })}
          />
        </div>

        {(kind === 'chapter' || kind === 'scene') && (
          <div className="field">
            <span className="field-label">Summary</span>
            <textarea
              rows={3}
              value={(frontmatter.summary as string) ?? ''}
              onChange={(e) => update({ summary: e.target.value })}
              placeholder={
                kind === 'chapter'
                  ? 'What happens in this chapter (shown in sidebar + corkboard)'
                  : 'What happens in this scene'
              }
            />
          </div>
        )}

        {kind === 'scene' && (
          <div className="row">
            <div className="field">
              <span className="field-label">Status</span>
              <select
                value={(frontmatter.status as string) ?? 'draft'}
                onChange={(e) => update({ status: e.target.value })}
              >
                {STATUSES.map((s) => (
                  <option key={s}>{s}</option>
                ))}
              </select>
            </div>
            <div className="field">
              <span className="field-label">POV</span>
              <input
                value={(frontmatter.pov as string) ?? ''}
                onChange={(e) =>
                  e.target.value
                    ? update({ pov: e.target.value })
                    : removeKey('pov')
                }
                placeholder="(inherits from chapter)"
              />
            </div>
          </div>
        )}

        {kind === 'scene' && (
          <div className="row">
            <div className="field">
              <span className="field-label">Words</span>
              <input
                value={liveWordCount.toLocaleString()}
                readOnly
              />
            </div>
            <div className="field">
              <span className="field-label">Word target</span>
              <input
                type="number"
                min={0}
                value={numOrNull(frontmatter.words_target) ?? ''}
                onChange={(e) =>
                  e.target.value === ''
                    ? removeKey('words_target')
                    : update({ words_target: Number(e.target.value) })
                }
              />
            </div>
          </div>
        )}

        {kind === 'chapter' && (
          <div className="row">
            {(frontmatter.kind as string | undefined) !== 'interlude' ? (
              <div className="field">
                <span className="field-label">Chapter #</span>
                <input
                  type="number"
                  min={1}
                  value={numOrNull(frontmatter.chapter) ?? ''}
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
                  value={numOrNull(frontmatter.interlude) ?? ''}
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
                value={numOrNull(frontmatter.order) ?? ''}
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
                value={(asList(frontmatter.aliases) || []).join(', ')}
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
                value={(asList(frontmatter.tags) || []).join(', ')}
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

      {(kind === 'chapter' || kind === 'scene') && detectedChars.length > 0 && (
        <section className="inspector-section">
          <h4>Characters in scene</h4>
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

      {kind === 'scene' && enclosingChapter && enclosingChapter.scenes.length > 1 && (
        <section className="inspector-section">
          <h4>In this chapter</h4>
          <ul className="ref-list" style={{ marginBottom: '-0.25rem' }}>
            {enclosingChapter.scenes.map((s) => (
              <li
                key={s.path}
                className={`ref-row${s.path === activePath ? ' active' : ''}`}
                onClick={() => onSelect(s.path)}
              >
                <span className="chapter-num">
                  {enclosingChapter.chapter ?? '·'}.{s.scene ?? '·'}
                </span>
                <span className="ref-title">
                  {s.title || `Scene ${s.scene ?? ''}`}
                </span>
                <span className="ref-aliases">
                  {s.word_count.toLocaleString()}w
                </span>
              </li>
            ))}
          </ul>
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

function asList(v: unknown): string[] | null {
  if (Array.isArray(v)) return v.map(String);
  return null;
}

