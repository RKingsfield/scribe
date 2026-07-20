import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useOutletContext, useSearchParams } from 'react-router-dom';
import { Editor, EditorHandle, SelectionInfo } from '../editor/Editor';
import { RewriteDialog } from '../rewrite/RewriteDialog';
import { CodexEntry } from '../editor/codexLink';
import { Sidebar } from '../sidebar/Sidebar';
import { ActsEditor } from './ActsEditor';
import { CategoriesEditor } from './CategoriesEditor';
import { Inspector } from './Inspector';
import { ChapterFlow, ChapterFlowHandle, SceneSaveState } from './ChapterFlow';
import { Act, Category, ChapterEntry, FileGet, ModelEntry, listModels, updateProject } from '../../lib/api';
import { SAVE_DEBOUNCE_MS, syncEngine } from '../../lib/syncEngine';
import { countWords } from '../../lib/words';
import { toast } from '../../app/Toast';
import { ProjectContext } from './ProjectView';

export function WriteView() {
  const { slug, tree, refreshTree, setHeader } =
    useOutletContext<ProjectContext>();
  const [searchParams, setSearchParams] = useSearchParams();
  const urlPath = searchParams.get('path');
  const [activePath, _setActivePath] = useState<string | null>(urlPath);

  const setActivePath = useCallback(
    (next: string | null) => {
      _setActivePath(next);
      setSearchParams(next ? { path: next } : {}, { replace: true });
    },
    [setSearchParams],
  );

  useEffect(() => {
    if (urlPath !== activePath) _setActivePath(urlPath);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [urlPath]);

  useEffect(() => {
    return syncEngine.onPathRemap((oldPath, newPath) => {
      _setActivePath((current) => {
        if (current === oldPath) {
          setSearchParams({ path: newPath }, { replace: true });
          return newPath;
        }
        return current;
      });
    });
  }, [setSearchParams]);

  useEffect(() => {
    const handler = () => {
      const snap = syncEngine.getSnapshot();
      if (snap.pendingCount > 0 || snap.structureOpsCount > 0) {
        toast('Reconnecting…');
      }
    };
    window.addEventListener('online', handler);
    return () => window.removeEventListener('online', handler);
  }, []);

  const [file, setFile] = useState<FileGet | null>(null);
  const [body, setBody] = useState('');
  const [frontmatter, setFrontmatter] = useState<Record<string, unknown>>({});
  const [saveState, setSaveState] = useState<
    'clean' | 'dirty' | 'saving' | 'saved' | 'error'
  >('clean');
  const [error, setError] = useState<string | null>(null);
  const [showActs, setShowActs] = useState(false);
  const [showCategories, setShowCategories] = useState(false);
  const [rewriteSel, setRewriteSel] = useState<SelectionInfo | null>(null);
  const [helperModel, setHelperModel] = useState<string | undefined>(
    () => localStorage.getItem('scribe.rewrite.model') || undefined,
  );
  const [models, setModels] = useState<ModelEntry[]>([]);
  useEffect(() => {
    listModels()
      .then(setModels)
      .catch(() => setModels([]));
  }, []);
  useEffect(() => {
    if (helperModel) localStorage.setItem('scribe.rewrite.model', helperModel);
    else localStorage.removeItem('scribe.rewrite.model');
  }, [helperModel]);
  const editorRef = useRef<EditorHandle>(null);
  const flowRef = useRef<ChapterFlowHandle>(null);
  const saveTimer = useRef<number | null>(null);

  const flowChapter = useMemo<ChapterEntry | null>(() => {
    if (!tree || !activePath) return null;
    // Any scene path routes through ChapterFlow, regardless of how many
    // siblings the chapter has. One-scene and multi-scene chapters share
    // the same view so we don't maintain two layouts.
    const ch = tree.chapters.find((c) =>
      c.scenes.some((s) => s.path === activePath),
    );
    return ch ?? null;
  }, [tree, activePath]);
  const inFlowMode = flowChapter !== null;
  const [flowSaveState, setFlowSaveState] = useState<SceneSaveState>('clean');
  const [flowWordCount, setFlowWordCount] = useState<number>(0);

  const bodyRef = useRef(body);
  bodyRef.current = body;
  const fmRef = useRef(frontmatter);
  fmRef.current = frontmatter;
  const fileRef = useRef(file);
  fileRef.current = file;

  const liveWordCount = useMemo(() => countWords(body), [body]);

  const codex = useMemo<CodexEntry[]>(() => {
    if (!tree) return [];
    const out: CodexEntry[] = [];
    for (const cat of tree.categories) {
      if (!cat.codex) continue;
      for (const e of cat.entries) {
        if (e.title) out.push({ path: e.path, title: e.title, aliases: e.aliases });
      }
    }
    return out;
  }, [tree]);

  const [typewriter, setTypewriter] = useState<boolean>(
    () => localStorage.getItem('scribe.typewriter') === '1',
  );
  useEffect(() => {
    localStorage.setItem('scribe.typewriter', typewriter ? '1' : '0');
  }, [typewriter]);

  const [sidebarCollapsed, setSidebarCollapsed] = useState<boolean>(
    () => localStorage.getItem('scribe.sidebar') === 'collapsed',
  );
  useEffect(() => {
    localStorage.setItem(
      'scribe.sidebar',
      sidebarCollapsed ? 'collapsed' : 'open',
    );
  }, [sidebarCollapsed]);

  const [inspectorCollapsed, setInspectorCollapsed] = useState<boolean>(
    () => localStorage.getItem('scribe.inspector') === 'collapsed',
  );
  useEffect(() => {
    localStorage.setItem(
      'scribe.inspector',
      inspectorCollapsed ? 'collapsed' : 'open',
    );
  }, [inspectorCollapsed]);

  const activeTitle = useMemo<string | null>(() => {
    if (!tree || !activePath) return null;
    const ch = tree.chapters.find(
      (c) => c.meta_path === activePath || c.scenes.some((s) => s.path === activePath),
    );
    if (ch) {
      const chLabel =
        ch.kind === 'interlude'
          ? ch.interlude !== null
            ? `Interlude ${ch.interlude}`
            : 'Interlude'
          : ch.chapter !== null
            ? `Ch. ${ch.chapter}`
            : null;
      const chId =
        ch.kind === 'interlude' ? `i${ch.interlude ?? ''}` : ch.chapter ?? '';
      if (activePath === ch.meta_path) {
        return chLabel ? `${chLabel} — ${ch.title || ch.slug}` : ch.title || ch.slug;
      }
      const sc = ch.scenes.find((s) => s.path === activePath);
      if (sc) {
        return chId !== '' && sc.scene !== null
          ? `${chId}.${sc.scene} — ${sc.title || ''}`.trim()
          : sc.title || `Scene ${sc.scene ?? ''}`;
      }
    }
    const ref = tree.categories.flatMap((c) => c.entries).find(
      (r) => r.path === activePath,
    );
    if (ref) return ref.title || (activePath.split('/').pop() ?? activePath);
    return null;
  }, [tree, activePath]);

  // Push state up to ProjectView for the status bar / topbar / palette.
  useEffect(() => {
    setHeader({
      activePath,
      activeTitle,
      liveWordCount: inFlowMode ? flowWordCount : liveWordCount,
      saveState: inFlowMode ? flowSaveState : saveState,
      typewriter,
      setTypewriter,
      sidebarCollapsed,
      setSidebarCollapsed,
      inspectorCollapsed,
      setInspectorCollapsed,
    });
  }, [
    activePath,
    activeTitle,
    liveWordCount,
    saveState,
    inFlowMode,
    flowSaveState,
    flowWordCount,
    typewriter,
    sidebarCollapsed,
    inspectorCollapsed,
    setHeader,
  ]);

  useEffect(() => {
    if (!slug || !activePath) return;
    if (inFlowMode) return; // ChapterFlow loads scenes itself
    setFile(null);
    setSaveState('clean');
    syncEngine
      .getFile(slug, activePath)
      .then((f) => {
        setFile(f);
        setBody(f.body);
        setFrontmatter(f.frontmatter);
      })
      .catch((e) => setError(String(e)));
  }, [slug, activePath, inFlowMode]);

  useEffect(() => {
    if (!activePath || !tree) return;
    const exists =
      tree.chapters.some(
        (c) =>
          c.meta_path === activePath || c.scenes.some((s) => s.path === activePath),
      ) ||
      tree.categories.some((c) => c.entries.some((r) => r.path === activePath));
    if (!exists) {
      setActivePath(null);
      setFile(null);
    }
  }, [tree, activePath, setActivePath]);

  const save = useCallback(async () => {
    if (!slug || !activePath) return;
    const f = fileRef.current;
    if (!f) return;
    setSaveState('saving');
    try {
      await syncEngine.saveFile(
        slug,
        activePath,
        bodyRef.current,
        fmRef.current,
        f.etag,
      );
      setFile({
        path: activePath,
        body: bodyRef.current,
        frontmatter: fmRef.current,
        etag: f.etag,
        word_count: countWords(bodyRef.current),
      });
      setSaveState('saved');
      refreshTree();
    } catch (e) {
      setError(String(e));
      setSaveState('error');
    }
  }, [slug, activePath, refreshTree]);

  const scheduleSave = useCallback(() => {
    setSaveState('dirty');
    if (saveTimer.current) window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(save, SAVE_DEBOUNCE_MS);
  }, [save]);

  const onBodyChange = (next: string) => {
    setBody(next);
    if (fileRef.current && next !== fileRef.current.body) scheduleSave();
  };

  const onFrontmatterChange = (next: Record<string, unknown>) => {
    setFrontmatter(next);
    scheduleSave();
  };

  const requestRewrite = useCallback(() => {
    const sel = inFlowMode
      ? flowRef.current?.getSelection()
      : editorRef.current?.getSelection();
    if (sel) setRewriteSel(sel);
  }, [inFlowMode]);

  if (!tree) return <p>Loading…</p>;

  return (
    <div
      className="write-shell"
      data-sidebar={sidebarCollapsed ? 'collapsed' : 'open'}
      data-inspector={
        inFlowMode || inspectorCollapsed || !activePath ? 'collapsed' : 'open'
      }
      data-flow={inFlowMode ? 'on' : 'off'}
    >
      <Sidebar
        tree={tree}
        slug={slug}
        activePath={activePath}
        onSelect={(path) => { setActivePath(path); if (window.innerWidth <= 640) setSidebarCollapsed(true); }}
        onTreeChanged={refreshTree}
        onEditActs={() => setShowActs(true)}
        onEditCategories={() => setShowCategories(true)}
      />
      {!sidebarCollapsed && (
        <div
          className="sidebar-backdrop"
          onClick={() => setSidebarCollapsed(true)}
        />
      )}
      {!inspectorCollapsed && !inFlowMode && activePath && (
        <div
          className="inspector-backdrop"
          onClick={() => setInspectorCollapsed(true)}
        />
      )}

      <section className="editor-frame">
        <div className="editor-pane">
          <div className="editor-column">
            {error && <p className="error">{error}</p>}
            {!activePath && (
              <p className="editor-empty">
                Select a chapter on the left, or hit <kbd>⌘K</kbd> to open the
                command palette.
              </p>
            )}
            {activePath && inFlowMode && flowChapter && (
              <ChapterFlow
                ref={flowRef}
                slug={slug}
                chapter={flowChapter}
                tree={tree}
                activePath={activePath}
                onActivePath={setActivePath}
                onSelect={setActivePath}
                onTreeChanged={refreshTree}
                codex={codex}
                onSaveStateChange={setFlowSaveState}
                onLiveWordCount={setFlowWordCount}
                onRequestRewrite={requestRewrite}
                models={models}
                helperModel={helperModel}
                setHelperModel={setHelperModel}
              />
            )}
            {activePath && !inFlowMode && !file && (
              <p className="editor-empty">Loading…</p>
            )}
            {activePath && !inFlowMode && file && (
              <Editor
                ref={editorRef}
                value={body}
                onChange={onBodyChange}
                codex={codex}
                onCodexClick={(entry) => setActivePath(entry.path)}
                typewriter={typewriter}
                onRequestRewrite={requestRewrite}
              />
            )}
          </div>
        </div>
      </section>

      {!inFlowMode && (
        <aside className="inspector">
          {tree && (
            <Inspector
              tree={tree}
              activePath={activePath}
              frontmatter={frontmatter}
              body={body}
              liveWordCount={liveWordCount}
              codex={codex}
              onChange={onFrontmatterChange}
              onSelect={setActivePath}
            />
          )}
        </aside>
      )}

      {rewriteSel && (
        <RewriteDialog
          slug={slug}
          selection={rewriteSel.text}
          beforeContext={rewriteSel.before}
          afterContext={rewriteSel.after}
          open={!!rewriteSel}
          onClose={() => setRewriteSel(null)}
          onAccept={(rewrite) => {
            (inFlowMode ? flowRef.current : editorRef.current)?.replaceRange(rewriteSel.from, rewriteSel.to, rewrite);
          }}
          models={models}
          model={helperModel}
          setModel={setHelperModel}
        />
      )}

      {showActs && tree && (
        <ActsEditor
          initial={tree.acts}
          onSave={async (acts: Act[]) => {
            await updateProject(slug, { acts });
            await syncEngine.getTree(slug, true);
            refreshTree();
          }}
          onClose={() => setShowActs(false)}
        />
      )}

      {showCategories && tree && (
        <CategoriesEditor
          initial={tree.categories.map((c) => ({ name: c.name, folder: c.folder, codex: c.codex }))}
          onSave={async (categories: Category[]) => {
            await updateProject(slug, { categories });
            refreshTree();
          }}
          onClose={() => setShowCategories(false)}
        />
      )}
    </div>
  );
}

