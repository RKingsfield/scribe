import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from 'react';
import { Sparkles } from 'lucide-react';
import { Editor, EditorHandle, SelectionInfo } from '../editor/Editor';
import { CodexEntry, detectCharacters } from '../editor/codexLink';
import {
  ChapterEntry,
  FileGet,
  ModelEntry,
  ProjectTree,
  SceneEntry,
  summarizeFile,
} from '../../lib/api';
import { SAVE_DEBOUNCE_MS, syncEngine } from '../../lib/syncEngine';
import { countWords } from '../../lib/words';

const SEARCH_SCROLL_OFFSET = 64;

export type SceneSaveState =
  | 'clean'
  | 'dirty'
  | 'saving'
  | 'saved'
  | 'error';

interface SearchMatch { scenePath: string; from: number; to: number }

export interface ChapterFlowHandle {
  getSelection: () => SelectionInfo | null;
  replaceRange: (from: number, to: number, replacement: string) => void;
  focusScene: (path: string) => void;
}

interface Props {
  slug: string;
  chapter: ChapterEntry;
  tree: ProjectTree;
  activePath: string | null;
  onActivePath: (path: string) => void;
  onSelect: (path: string) => void;
  onTreeChanged: () => void;
  codex: readonly CodexEntry[];
  onSaveStateChange: (state: SceneSaveState) => void;
  onLiveWordCount: (n: number) => void;
  onRequestRewrite: () => void;
  models: ModelEntry[];
  helperModel: string | undefined;
  setHelperModel: (m: string | undefined) => void;
}

export const ChapterFlow = forwardRef<ChapterFlowHandle, Props>(function ChapterFlow(
  {
    slug,
    chapter,
    tree,
    activePath,
    onActivePath,
    onSelect,
    onTreeChanged,
    codex,
    onSaveStateChange,
    onLiveWordCount,
    onRequestRewrite,
    models,
    helperModel,
    setHelperModel,
  },
  ref,
) {
  const blockRefs = useRef(new Map<string, EditorHandle>());
  const sceneElRefs = useRef(new Map<string, HTMLDivElement>());
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState('');
  const titleRef = useRef<HTMLInputElement>(null);

  const commitTitle = useCallback(async () => {
    const trimmed = titleDraft.trim();
    setEditingTitle(false);
    if (!trimmed || trimmed === (chapter.title || chapter.slug)) return;
    try {
      const f = await syncEngine.getFile(slug, chapter.meta_path);
      await syncEngine.saveFile(slug, chapter.meta_path, f.body, { ...f.frontmatter, title: trimmed }, f.etag);
      onTreeChanged();
    } catch (e) {
      console.error('Failed to save chapter title', e);
    }
  }, [slug, chapter.meta_path, chapter.title, chapter.slug, titleDraft, onTreeChanged]);

  const setBlockRef = (path: string, handle: EditorHandle | null) => {
    if (handle) blockRefs.current.set(path, handle);
    else blockRefs.current.delete(path);
  };

  useImperativeHandle(ref, () => ({
    getSelection: () => {
      if (!activePath) return null;
      return blockRefs.current.get(activePath)?.getSelection() ?? null;
    },
    replaceRange: (from, to, replacement) => {
      if (!activePath) return;
      blockRefs.current.get(activePath)?.replaceRange(from, to, replacement);
    },
    focusScene: (path) => onActivePath(path),
  }));

  const [searchOpen, setSearchOpen] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');
  const [matchIndex, setMatchIndex] = useState(0);
  const searchInputRef = useRef<HTMLInputElement>(null);

  const matches = useMemo((): SearchMatch[] => {
    if (!searchTerm) return [];
    const q = searchTerm.toLowerCase();
    const result: SearchMatch[] = [];
    for (const scene of chapter.scenes) {
      const handle = blockRefs.current.get(scene.path);
      if (!handle) continue;
      const doc = handle.getDoc();
      const lower = doc.toLowerCase();
      let pos = 0;
      while (true) {
        const idx = lower.indexOf(q, pos);
        if (idx === -1) break;
        result.push({ scenePath: scene.path, from: idx, to: idx + searchTerm.length });
        pos = idx + 1;
      }
    }
    return result;
  }, [searchTerm, chapter.scenes]);

  const goToMatch = useCallback((idx: number) => {
    if (matches.length === 0) return;
    const wrapped = ((idx % matches.length) + matches.length) % matches.length;
    setMatchIndex(wrapped);
    const m = matches[wrapped];
    const handle = blockRefs.current.get(m.scenePath);
    if (!handle) return;
    handle.scrollToRange(m.from, m.to);
    requestAnimationFrame(() => {
      const coords = handle.posCoords(m.from);
      if (!coords) return;
      const pane = document.querySelector('.editor-pane');
      if (!pane) return;
      const paneRect = pane.getBoundingClientRect();
      const target = pane.scrollTop + coords.top - paneRect.top - SEARCH_SCROLL_OFFSET;
      pane.scrollTo({ top: target, behavior: 'smooth' });
      searchInputRef.current?.focus();
    });
  }, [matches]);

  const openSearch = useCallback(() => {
    setSearchOpen(true);
    requestAnimationFrame(() => searchInputRef.current?.focus());
  }, []);

  const closeSearch = useCallback(() => {
    setSearchOpen(false);
    setSearchTerm('');
  }, []);

  const handleAddScene = async () => {
    try {
      const r = await syncEngine.createScene(slug, chapter.slug, {});
      onTreeChanged();
      onSelect(r.path);
    } catch (err) {
      alert(`Failed: ${err}`);
    }
  };

  return (
    <div
      className="chapter-flow"
      onKeyDown={(e) => {
        if ((e.metaKey || e.ctrlKey) && e.key === 'f') {
          e.preventDefault();
          openSearch();
        }
      }}
    >
      {searchOpen && (
        <div className="cf-search-bar">
          <input
            ref={searchInputRef}
            placeholder="Search chapter…"
            value={searchTerm}
            onChange={(e) => { setSearchTerm(e.target.value); setMatchIndex(0); }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                goToMatch(e.shiftKey ? matchIndex - 1 : matchIndex + 1);
              }
              if (e.key === 'Escape') closeSearch();
            }}
          />
          {searchTerm && (
            <span className="cf-search-count">
              {matches.length > 0 ? `${matchIndex + 1} of ${matches.length}` : 'no matches'}
            </span>
          )}
          <button className="ghost-btn" onClick={() => goToMatch(matchIndex - 1)} disabled={matches.length === 0}>↑</button>
          <button className="ghost-btn" onClick={() => goToMatch(matchIndex + 1)} disabled={matches.length === 0}>↓</button>
          <button className="ghost-btn" onClick={closeSearch}>✕</button>
        </div>
      )}
      <header className="chapter-flow-head">
        <span className="cf-eyebrow">
          {chapter.kind === 'interlude'
            ? `Interlude ${chapter.interlude ?? '·'}`
            : `Chapter ${chapter.chapter ?? '·'}`}
        </span>
        {editingTitle ? (
          <input
            ref={titleRef}
            className="cf-title-input"
            value={titleDraft}
            onChange={(e) => setTitleDraft(e.target.value)}
            onBlur={commitTitle}
            onKeyDown={(e) => {
              if (e.key === 'Enter') e.currentTarget.blur();
              if (e.key === 'Escape') setEditingTitle(false);
            }}
          />
        ) : (
          <h2
            className="cf-title-editable"
            onClick={() => {
              setTitleDraft(chapter.title || chapter.slug);
              setEditingTitle(true);
              requestAnimationFrame(() => titleRef.current?.focus());
            }}
          >
            {chapter.title || chapter.slug}
          </h2>
        )}
        <span className="cf-meta">
          {chapter.scenes.length} scene{chapter.scenes.length === 1 ? '' : 's'} ·{' '}
          {chapter.word_count.toLocaleString()}w
        </span>
      </header>

      {chapter.scenes.map((scene, i) => (
        <div key={scene.path} ref={(el) => { if (el) sceneElRefs.current.set(scene.path, el); }}>
          {i > 0 && (
            <div className="scene-divider" aria-hidden="true">
              <span>◆</span>
            </div>
          )}
          <SceneBlock
            slug={slug}
            chapter={chapter}
            scene={scene}
            tree={tree}
            isActive={scene.path === activePath}
            onActivate={() => onActivePath(scene.path)}
            onSelect={onSelect}
            onTreeChanged={onTreeChanged}
            codex={codex}
            onSaveStateChange={onSaveStateChange}
            onLiveWordCount={
              scene.path === activePath ? onLiveWordCount : undefined
            }
            onRequestRewrite={onRequestRewrite}
            registerRef={(h) => setBlockRef(scene.path, h)}
            models={models}
            helperModel={helperModel}
            setHelperModel={setHelperModel}
            searchTerm={searchOpen ? searchTerm : undefined}
          />
        </div>
      ))}

      <div className="chapter-flow-foot">
        <button className="oc-add-scene-empty" onClick={handleAddScene}>
          + New Scene
        </button>
      </div>
    </div>
  );
});

interface SceneBlockProps {
  slug: string;
  chapter: ChapterEntry;
  scene: SceneEntry;
  tree: ProjectTree;
  isActive: boolean;
  onActivate: () => void;
  onSelect: (path: string) => void;
  onTreeChanged: () => void;
  codex: readonly CodexEntry[];
  onSaveStateChange: (state: SceneSaveState) => void;
  onLiveWordCount?: (n: number) => void;
  onRequestRewrite: () => void;
  registerRef: (h: EditorHandle | null) => void;
  models: ModelEntry[];
  helperModel: string | undefined;
  setHelperModel: (m: string | undefined) => void;
  searchTerm?: string;
}

function SceneBlock({
  slug,
  chapter,
  scene,
  tree,
  isActive,
  onActivate,
  onSelect,
  onTreeChanged,
  codex,
  onSaveStateChange,
  onLiveWordCount,
  onRequestRewrite,
  registerRef,
  models,
  helperModel,
  setHelperModel,
  searchTerm,
}: SceneBlockProps) {
  const [file, setFile] = useState<FileGet | null>(null);
  const [body, setBody] = useState('');
  const [frontmatter, setFrontmatter] = useState<Record<string, unknown>>({});
  const [saveState, _setSaveState] = useState<SceneSaveState>('clean');
  const [error, setError] = useState<string | null>(null);

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

  const setSaveState = useCallback(
    (s: SceneSaveState) => {
      _setSaveState(s);
      if (isActive) onSaveStateChange(s);
    },
    [isActive, onSaveStateChange],
  );
  useEffect(() => {
    if (isActive) onSaveStateChange(saveState);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isActive]);

  const bodyRef = useRef(body);
  bodyRef.current = body;
  const fmRef = useRef(frontmatter);
  fmRef.current = frontmatter;
  const fileRef = useRef(file);
  fileRef.current = file;
  const saveTimer = useRef<number | null>(null);

  const wordCount = useMemo(() => countWords(body), [body]);
  useEffect(() => {
    if (isActive && onLiveWordCount) onLiveWordCount(wordCount);
  }, [isActive, wordCount, onLiveWordCount]);

  useEffect(() => {
    let cancelled = false;
    syncEngine
      .getFile(slug, scene.path)
      .then((f) => {
        if (cancelled) return;
        setFile(f);
        setBody(f.body);
        setFrontmatter(f.frontmatter);
        setSaveState('clean');
      })
      .catch((e) => !cancelled && setError(String(e)));
    return () => {
      cancelled = true;
    };
  }, [slug, scene.path, setSaveState]);

  const save = useCallback(async () => {
    const f = fileRef.current;
    if (!f) return;
    setSaveState('saving');
    try {
      await syncEngine.saveFile(
        slug,
        scene.path,
        bodyRef.current,
        fmRef.current,
        f.etag,
      );
      setFile({
        path: scene.path,
        body: bodyRef.current,
        frontmatter: fmRef.current,
        etag: f.etag,
        word_count: countWords(bodyRef.current),
      });
      setSaveState('saved');
      onTreeChanged();
    } catch (e) {
      setError(String(e));
      setSaveState('error');
    }
  }, [slug, scene.path, onTreeChanged, setSaveState]);

  const scheduleSave = useCallback(() => {
    setSaveState('dirty');
    if (saveTimer.current) window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(save, SAVE_DEBOUNCE_MS);
  }, [save, setSaveState]);

  const onBodyChange = (next: string) => {
    setBody(next);
    if (fileRef.current && next !== fileRef.current.body) scheduleSave();
  };

  const updateFm = (patch: Record<string, unknown>) => {
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
        tree={tree}
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
  tree: _tree,
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
  tree: ProjectTree;
  frontmatter: Record<string, unknown>;
  wordCount: number;
  sceneLabel: string;
  detectedChars: CodexEntry[];
  update: (patch: Record<string, unknown>) => void;
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
      alert('No scene content yet — write something first.');
      return;
    }
    setGenerating(true);
    try {
      // Make sure on-disk body is the one the LLM sees.
      await flushPendingSave();
      const { summary } = await summarizeFile(slug, scenePath, helperModel);
      update({ summary });
    } catch (err) {
      alert(`Failed to generate summary: ${err}`);
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
          value={(frontmatter.title as string) ?? ''}
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
          value={(frontmatter.summary as string) ?? ''}
          onChange={(e) => update({ summary: e.target.value })}
          placeholder="What happens in this scene"
          disabled={generating}
        />
      </div>

      <div className="ssc-row">
        <div className="ssc-field">
          <span className="ssc-label">POV</span>
          <input
            value={(frontmatter.pov as string) ?? ''}
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
            value={(frontmatter.status as string) ?? 'draft'}
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


