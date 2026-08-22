import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from 'react';
import { EditorHandle, SelectionInfo } from '../editor/Editor';
import { CodexEntry } from '../editor/codexLink';
import { ChapterEntry, ModelEntry } from '../../lib/api';
import { EditorBuffer, GetEditorBuffer, editorHoldsUnsaved } from '../../lib/useFileEditor';
import { syncEngine } from '../../lib/syncEngine';
import { toast } from '../../app/Toast';
import { SceneBlock } from './SceneBlock';

const SEARCH_SCROLL_OFFSET = 64;

export type SceneSaveState =
  | 'clean'
  | 'dirty'
  | 'saving'
  | 'saved'
  | 'error'
  | 'blocked';

interface SearchMatch { scenePath: string; from: number; to: number }

export interface ChapterFlowHandle {
  getSelection: () => SelectionInfo | null;
  replaceRange: (from: number, to: number, replacement: string) => void;
  focusScene: (path: string) => void;
}

interface Props {
  slug: string;
  chapter: ChapterEntry;
  activePath: string | null;
  onActivePath: (path: string) => void;
  onSelect: (path: string) => void;
  onTreeChanged: () => void;
  codex: readonly CodexEntry[];
  onSaveStateChange: (state: SceneSaveState) => void;
  onLiveWordCount: (n: number) => void;
  onBufferLookup: (lookup: GetEditorBuffer) => void;
  onRequestRewrite: () => void;
  models: ModelEntry[];
  helperModel: string | undefined;
  setHelperModel: (m: string | undefined) => void;
}

export const ChapterFlow = forwardRef<ChapterFlowHandle, Props>(function ChapterFlow(
  {
    slug,
    chapter,
    activePath,
    onActivePath,
    onSelect,
    onTreeChanged,
    codex,
    onSaveStateChange,
    onLiveWordCount,
    onBufferLookup,
    onRequestRewrite,
    models,
    helperModel,
    setHelperModel,
  },
  ref,
) {
  const blockRefs = useRef(new Map<string, EditorHandle>());

  // Every mounted SceneBlock registers its buffer accessor + live save state
  // here, keyed by scene path, so a conflict on any scene (not just the active
  // one) can lift its unsaved buffer as the Editor merge column.
  const bufferRegistry = useRef(
    new Map<
      string,
      { getBuffer: () => EditorBuffer | null; saveState: SceneSaveState }
    >(),
  );
  const registerBuffer = useCallback(
    (
      path: string,
      entry: { getBuffer: () => EditorBuffer | null; saveState: SceneSaveState } | null,
    ) => {
      if (entry) bufferRegistry.current.set(path, entry);
      else bufferRegistry.current.delete(path);
    },
    [],
  );
  const getEditorBuffer = useCallback<GetEditorBuffer>((path) => {
    const entry = bufferRegistry.current.get(path);
    if (!entry || !editorHoldsUnsaved(entry.saveState)) return null;
    return entry.getBuffer();
  }, []);
  useEffect(() => onBufferLookup(getEditorBuffer), [onBufferLookup, getEditorBuffer]);

  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState('');
  const titleRef = useRef<HTMLInputElement>(null);

  const commitTitle = useCallback(async () => {
    const trimmed = titleDraft.trim();
    setEditingTitle(false);
    if (!trimmed || trimmed === (chapter.title || chapter.slug)) return;
    try {
      const f = await syncEngine.getFile(slug, chapter.meta_path);
      const result = await syncEngine.saveFile(slug, chapter.meta_path, f.body, { ...f.frontmatter, title: trimmed }, f.etag);
      if (result === 'blocked') {
        toast('Blocked by conflict — resolve it first', 'error');
        return;
      }
      onTreeChanged();
    } catch (e) {
      toast(`Failed to save chapter title: ${e}`, 'error');
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
      toast(`Failed: ${err}`, 'error');
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
        <div key={scene.path}>
          {i > 0 && (
            <div className="scene-divider" aria-hidden="true">
              <span>◆</span>
            </div>
          )}
          <SceneBlock
            slug={slug}
            chapter={chapter}
            scene={scene}
            isActive={scene.path === activePath}
            onActivate={() => onActivePath(scene.path)}
            onSelect={onSelect}
            onTreeChanged={onTreeChanged}
            codex={codex}
            onSaveStateChange={onSaveStateChange}
            registerBuffer={registerBuffer}
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

