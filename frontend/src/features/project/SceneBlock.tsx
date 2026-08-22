import { useEffect, useMemo, useRef, useState } from 'react';
import { Sparkles } from 'lucide-react';
import { Editor, EditorHandle } from '../editor/Editor';
import { CodexEntry, detectCharacters } from '../editor/codexLink';
import {
  ChapterEntry,
  ModelEntry,
  SceneEntry,
  summarizeFile,
} from '../../lib/api';
import { EditorBuffer, useFileEditor } from '../../lib/useFileEditor';
import { syncEngine } from '../../lib/syncEngine';
import { toast } from '../../app/Toast';
import type { SceneFrontmatter } from '../../lib/types';
import type { SceneSaveState } from './ChapterFlow';

interface SceneBlockProps {
  slug: string;
  chapter: ChapterEntry;
  scene: SceneEntry;
  isActive: boolean;
  onActivate: () => void;
  onSelect: (path: string) => void;
  onTreeChanged: () => void;
  codex: readonly CodexEntry[];
  onSaveStateChange: (state: SceneSaveState) => void;
  registerBuffer: (
    path: string,
    entry: { getBuffer: () => EditorBuffer | null; saveState: SceneSaveState } | null,
  ) => void;
  onLiveWordCount?: (n: number) => void;
  onRequestRewrite: () => void;
  registerRef: (h: EditorHandle | null) => void;
  models: ModelEntry[];
  helperModel: string | undefined;
  setHelperModel: (m: string | undefined) => void;
  searchTerm?: string;
}

export function SceneBlock({
  slug,
  chapter,
  scene,
  isActive,
  onActivate,
  onSelect,
  onTreeChanged,
  codex,
  onSaveStateChange,
  registerBuffer,
  onLiveWordCount,
  onRequestRewrite,
  registerRef,
  models,
  helperModel,
  setHelperModel,
  searchTerm,
}: SceneBlockProps) {
  const {
    file,
    body,
    frontmatter,
    setFrontmatter,
    saveState,
    error,
    wordCount,
    onBodyChange,
    scheduleSave,
    save,
    getBuffer,
  } = useFileEditor({
    slug,
    path: scene.path,
    onSaved: onTreeChanged,
  });

  const editorRef = useRef<EditorHandle>(null);
  useEffect(() => {
    if (file && editorRef.current) registerRef(editorRef.current);
    return () => registerRef(null);
  }, [file, registerRef]);

  const blockRef = useRef<HTMLDivElement | null>(null);
  const selfActivatedRef = useRef(false);
  const loadedRef = useRef(false);
  useEffect(() => {
    if (file && !loadedRef.current) loadedRef.current = true;
  }, [file]);
  useEffect(() => {
    if (isActive && loadedRef.current && blockRef.current) {
      if (selfActivatedRef.current) {
        selfActivatedRef.current = false;
        return;
      }
      blockRef.current.scrollIntoView({ block: 'start', behavior: 'smooth' });
    }
  }, [isActive]);

  useEffect(() => {
    if (isActive) onSaveStateChange(saveState);
  }, [isActive, saveState, onSaveStateChange]);

  useEffect(() => {
    registerBuffer(scene.path, { getBuffer, saveState });
    return () => registerBuffer(scene.path, null);
  }, [scene.path, getBuffer, saveState, registerBuffer]);

  useEffect(() => {
    if (isActive && onLiveWordCount) onLiveWordCount(wordCount);
  }, [isActive, wordCount, onLiveWordCount]);

  const updateFm = (patch: Partial<SceneFrontmatter>) => {
    setFrontmatter({ ...frontmatter, ...patch });
    scheduleSave();
  };
  const removeFmKey = (key: string) => {
    const next = { ...frontmatter };
    delete next[key];
    setFrontmatter(next);
    scheduleSave();
  };

  const detectedChars = useMemo(() => {
    if (!body || codex.length === 0) return [] as CodexEntry[];
    return detectCharacters(body, codex);
  }, [body, codex]);

  const chapterIdLabel =
    chapter.kind === 'interlude'
      ? `i${chapter.interlude ?? ''}`
      : chapter.chapter ?? '';
  const sceneLabel =
    chapterIdLabel !== '' && scene.scene !== null
      ? `${chapterIdLabel}.${scene.scene}`
      : `Scene ${scene.scene ?? ''}`;

  return (
    <div
      ref={blockRef}
      className={`scene-block${isActive ? ' active' : ''}`}
      onFocusCapture={() => {
        if (!isActive) {
          selfActivatedRef.current = true;
          onActivate();
        }
      }}
    >
      <div className="scene-block-editor">
        {error && <p className="error">{error}</p>}
        {!file ? (
          <p className="editor-empty">Loading…</p>
        ) : (
          <Editor
            ref={editorRef}
            value={body}
            onChange={onBodyChange}
            codex={codex}
            onCodexClick={(entry) => onSelect(entry.path)}
            onRequestRewrite={onRequestRewrite}
            searchTerm={searchTerm}
            hideSearchPanel
          />
        )}
      </div>

      <SceneSidecard
        slug={slug}
        scenePath={scene.path}
        scene={scene}
        chapter={chapter}
        frontmatter={frontmatter}
        wordCount={wordCount}
        sceneLabel={sceneLabel}
        detectedChars={detectedChars}
        update={updateFm}
        removeKey={removeFmKey}
        onSelect={onSelect}
        flushPendingSave={save}
        models={models}
        helperModel={helperModel}
        setHelperModel={setHelperModel}
      />
    </div>
  );
}

function SceneSidecard({
  slug,
  scenePath,
  scene,
  chapter,
  frontmatter,
  wordCount,
  sceneLabel,
  detectedChars,
  update,
  removeKey,
  onSelect,
  flushPendingSave,
  models,
  helperModel,
  setHelperModel,
}: {
  slug: string;
  scenePath: string;
  scene: SceneEntry;
  chapter: ChapterEntry;
  frontmatter: SceneFrontmatter;
  wordCount: number;
  sceneLabel: string;
  detectedChars: CodexEntry[];
  update: (patch: Partial<SceneFrontmatter>) => void;
  removeKey: (key: string) => void;
  onSelect: (path: string) => void;
  flushPendingSave: () => Promise<void>;
  models: ModelEntry[];
  helperModel: string | undefined;
  setHelperModel: (m: string | undefined) => void;
}) {
  const [generating, setGenerating] = useState(false);
  const generate = async () => {
    if (wordCount === 0) {
      toast('No scene content yet — write something first.', 'info');
      return;
    }
    setGenerating(true);
    try {
      // Make sure on-disk body is the one the LLM sees — queue write, then a real network flush.
      await flushPendingSave();
      await syncEngine.flush();
      const { summary } = await summarizeFile(slug, scenePath, helperModel);
      update({ summary });
    } catch (err) {
      toast(`Failed to generate summary: ${err}`, 'error');
    } finally {
      setGenerating(false);
    }
  };
  return (
    <aside className="scene-sidecard">
      <header className="ssc-head">
        <span className="ssc-eyebrow">
          {chapter.kind === 'interlude'
            ? `Interlude ${chapter.interlude ?? '·'}`
            : `Chapter ${chapter.chapter ?? '·'}`}{' · '}
          Scene {scene.scene ?? '·'}
        </span>
        <span className="ssc-words">{wordCount.toLocaleString()}w</span>
      </header>

      <div className="ssc-field">
        <span className="ssc-label">Title</span>
        <input
          value={frontmatter.title ?? ''}
          onChange={(e) => update({ title: e.target.value })}
          placeholder={`Scene ${scene.scene ?? ''}`}
        />
      </div>

      <div className="ssc-field">
        <div className="ssc-label-row">
          <span className="ssc-label">Summary</span>
          <div className="ssc-generate-group">
            {models.length > 0 && (
              <select
                className="ssc-model-pick"
                value={helperModel ?? ''}
                onChange={(e) =>
                  setHelperModel(e.target.value || undefined)
                }
                title="Model used for AI helpers"
              >
                <option value="">default</option>
                {models.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.id}
                  </option>
                ))}
              </select>
            )}
            <button
              className="ssc-generate"
              onClick={generate}
              disabled={generating || wordCount === 0}
              title={
                wordCount === 0
                  ? 'Write some scene content first'
                  : `Generate summary using ${helperModel || 'project default'}`
              }
            >
              {generating ? 'Generating…' : <><Sparkles size={14} /> Generate</>}
            </button>
          </div>
        </div>
        <textarea
          rows={4}
          value={frontmatter.summary ?? ''}
          onChange={(e) => update({ summary: e.target.value })}
          placeholder="What happens in this scene"
          disabled={generating}
        />
      </div>

      <div className="ssc-row">
        <div className="ssc-field">
          <span className="ssc-label">POV</span>
          <input
            value={frontmatter.pov ?? ''}
            onChange={(e) =>
              e.target.value
                ? update({ pov: e.target.value })
                : removeKey('pov')
            }
            placeholder="(inherits)"
          />
        </div>
        <div className="ssc-field">
          <span className="ssc-label">Status</span>
          <select
            value={frontmatter.status ?? 'draft'}
            onChange={(e) => update({ status: e.target.value })}
          >
            <option>draft</option>
            <option>revision</option>
            <option>final</option>
          </select>
        </div>
      </div>

      {detectedChars.length > 0 && (
        <div className="ssc-section">
          <span className="ssc-label">Characters</span>
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
        </div>
      )}

      <div className="ssc-foot">
        <span className="ssc-label dim">{sceneLabel}</span>
      </div>
    </aside>
  );
}
