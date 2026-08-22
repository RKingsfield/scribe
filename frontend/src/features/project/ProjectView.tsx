import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Link,
  NavLink,
  Outlet,
  useLocation,
  useParams,
  useSearchParams,
} from 'react-router-dom';
import { CloudDownload, Download, BookOpen, Search, SunMoon, PanelLeft, PanelRight } from 'lucide-react';
import { QuillMark } from '../../app/QuillMark';
import { ProjectTree } from '../../lib/api';
import { GetEditorBuffer } from '../../lib/useFileEditor';
import { syncEngine } from '../../lib/syncEngine';
import { CommandPalette } from '../../app/CommandPalette';
import { StatusBar } from '../../app/StatusBar';
import { ConflictsBanner } from '../sync/ConflictsBanner';
import { StuckOpsBanner } from '../sync/StuckOpsBanner';
import { RagPanel } from '../rag/RagPanel';
import { ExportPanel } from '../export/ExportPanel';
import { ToastContainer, toast } from '../../app/Toast';

export interface ProjectContext {
  slug: string;
  tree: ProjectTree | null;
  refreshTree: () => void;
  setHeader: (h: HeaderState) => void;
}

export interface HeaderState {
  activePath: string | null;
  activeTitle: string | null;
  liveWordCount: number;
  saveState: 'clean' | 'dirty' | 'saving' | 'saved' | 'error' | 'blocked';
  getEditorBuffer?: GetEditorBuffer;
  typewriter?: boolean;
  setTypewriter?: (next: boolean) => void;
  sidebarCollapsed?: boolean;
  setSidebarCollapsed?: (next: boolean) => void;
  inspectorCollapsed?: boolean;
  setInspectorCollapsed?: (next: boolean) => void;
}

const EMPTY_HEADER: HeaderState = {
  activePath: null,
  activeTitle: null,
  liveWordCount: 0,
  saveState: 'clean',
};

export function ProjectView() {
  const { slug } = useParams<{ slug: string }>();
  const [tree, setTree] = useState<ProjectTree | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [header, setHeader] = useState<HeaderState>(EMPTY_HEADER);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [ragOpen, setRagOpen] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const location = useLocation();
  const [searchParams] = useSearchParams();

  const refreshTree = useCallback(() => {
    if (!slug) return;
    syncEngine
      .getTree(slug)
      .then(setTree)
      .catch((e) => setError(String(e)));
  }, [slug]);

  useEffect(refreshTree, [refreshTree]);

  // Reset status fields when route changes (so leftover Write state doesn't
  // bleed into Plan/Chat/Review), but preserve layout callbacks — child
  // effects (WriteView) fire before parent effects, so a full reset here
  // would clobber setSidebarCollapsed/setInspectorCollapsed on every nav.
  useEffect(() => {
    setHeader((prev) => ({
      ...EMPTY_HEADER,
      typewriter: prev.typewriter,
      setTypewriter: prev.setTypewriter,
      sidebarCollapsed: prev.sidebarCollapsed,
      setSidebarCollapsed: prev.setSidebarCollapsed,
      inspectorCollapsed: prev.inspectorCollapsed,
      setInspectorCollapsed: prev.setInspectorCollapsed,
    }));
  }, [location.pathname]);

  // ⌘K / Ctrl+K toggles palette globally.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPaletteOpen((v) => !v);
      } else if (e.key === 'Escape' && paletteOpen) {
        setPaletteOpen(false);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [paletteOpen]);

  const breadcrumb = useMemo(() => buildBreadcrumb(tree, header.activePath, searchParams), [
    tree,
    header.activePath,
    searchParams,
  ]);

  const toggleTheme = () => {
    const cur = document.documentElement.getAttribute('data-theme');
    const next = cur === 'light' ? 'dark' : 'light';
    document.documentElement.setAttribute('data-theme', next);
    localStorage.setItem('scribe.theme', next);
  };

  const handlePrefetch = useCallback(async () => {
    if (!slug) return;
    toast('Syncing for offline…');
    const unsub = syncEngine.subscribe((snap) => {
      if (snap.prefetchProgress) {
        toast(`Syncing… ${snap.prefetchProgress.done}/${snap.prefetchProgress.total} files`);
      }
    });
    try {
      await syncEngine.prefetchProject(slug);
      toast('Ready for offline', 'success');
    } catch (e) {
      toast(`Offline sync failed: ${e}`, 'error');
    } finally {
      unsub();
    }
  }, [slug]);

  if (!slug) return <p>Missing slug.</p>;

  const context: ProjectContext = { slug, tree, refreshTree, setHeader };

  return (
    <div className="project-view">
      <nav className="topbar">
        <div className="topbar-left">
          <Link to="/" className="brand-mark" title="Back to projects">
            <QuillMark size={22} />
          </Link>
          {header.setSidebarCollapsed && (
            <button
              className="icon-btn sidebar-toggle"
              onClick={() => header.setSidebarCollapsed!(!(header.sidebarCollapsed ?? false))}
              title="Toggle sidebar"
            >
              <PanelLeft size={18} />
            </button>
          )}
          <Breadcrumb crumbs={breadcrumb} />
        </div>
        <div className="tabs">
          <Tab to="write">Write</Tab>
          <Tab to="plan">Plan</Tab>
          <Tab to="chat">Chat</Tab>
          <Tab to="review">Review</Tab>
        </div>
        <div className="topbar-right">
          <button
            className="icon-btn"
            onClick={handlePrefetch}
            title="Download for offline"
          >
            <CloudDownload size={18} />
          </button>
          <button
            className="icon-btn topbar-desktop-only"
            onClick={() => setExportOpen(true)}
            title="Export"
          >
            <Download size={18} />
          </button>
          <button
            className="icon-btn topbar-desktop-only"
            onClick={() => setRagOpen(true)}
            title="Project RAG"
          >
            <BookOpen size={18} />
          </button>
          <button
            className="kbd-hint"
            onClick={() => setPaletteOpen(true)}
            title="Command palette (Ctrl/Cmd+K)"
          >
            ⌘K
          </button>
          <button
            className="icon-btn topbar-mobile-palette"
            onClick={() => setPaletteOpen(true)}
            title="Command palette"
          >
            <Search size={18} />
          </button>
          {header.setInspectorCollapsed && (
            <button
              className="icon-btn topbar-mobile-only"
              onClick={() => header.setInspectorCollapsed!(!(header.inspectorCollapsed ?? false))}
              title="Toggle inspector"
            >
              <PanelRight size={18} />
            </button>
          )}
          <button
            className="icon-btn"
            onClick={toggleTheme}
            title="Toggle light/dark"
          >
            <SunMoon size={18} />
          </button>
        </div>
      </nav>
      <main className="project-main">
        <ConflictsBanner slug={slug} getEditorBuffer={header.getEditorBuffer} />
        <StuckOpsBanner slug={slug} />
        {error && (
          <p className="error" style={{ padding: '0.5rem 1rem', margin: 0 }}>
            {error}
          </p>
        )}
        <Outlet context={context} />
      </main>
      <StatusBar
        slug={slug}
        projectTitle={tree?.title ?? slug}
        activePath={header.activePath}
        activeTitle={header.activeTitle}
        liveWordCount={header.liveWordCount}
        saveState={header.saveState}
        onOpenPalette={() => setPaletteOpen(true)}
      />
      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        slug={slug}
        tree={tree}
        onToggleTypewriter={
          header.setTypewriter
            ? () => header.setTypewriter!(!(header.typewriter ?? false))
            : undefined
        }
        onToggleSidebar={
          header.setSidebarCollapsed
            ? () => header.setSidebarCollapsed!(!(header.sidebarCollapsed ?? false))
            : undefined
        }
        onToggleInspector={
          header.setInspectorCollapsed
            ? () => header.setInspectorCollapsed!(!(header.inspectorCollapsed ?? false))
            : undefined
        }
        onToggleTheme={toggleTheme}
        onOpenRag={() => setRagOpen(true)}
        onOpenExport={() => setExportOpen(true)}
        onPrefetch={handlePrefetch}
      />
      <RagPanel slug={slug} open={ragOpen} onClose={() => setRagOpen(false)} />
      <ExportPanel
        slug={slug}
        projectTitle={tree?.title ?? slug}
        open={exportOpen}
        onClose={() => setExportOpen(false)}
      />
      <ToastContainer />
    </div>
  );
}

function Breadcrumb({ crumbs }: { crumbs: { label: string; active?: boolean }[] }) {
  return (
    <div className="breadcrumb">
      {crumbs.map((c, i) => (
        <span key={i} className="breadcrumb-part">
          <span className={`crumb${c.active ? ' active' : ''}`}>{c.label}</span>
          {i < crumbs.length - 1 && <span className="sep"> / </span>}
        </span>
      ))}
    </div>
  );
}

function buildBreadcrumb(
  tree: ProjectTree | null,
  activePath: string | null,
  searchParams: URLSearchParams,
): { label: string; active?: boolean }[] {
  const out: { label: string; active?: boolean }[] = [];
  if (tree) out.push({ label: tree.title });
  const path = activePath ?? searchParams.get('path');
  if (!tree || !path) return out;
  const ch = tree.chapters.find(
    (c) =>
      c.meta_path === path || c.scenes.some((s) => s.path === path),
  );
  if (ch) {
    const num = ch.chapter !== null ? `Ch. ${ch.chapter}` : ch.slug;
    out.push({ label: `${num} — ${ch.title || ch.slug}` });
    if (path !== ch.meta_path) {
      const sc = ch.scenes.find((s) => s.path === path);
      if (sc) out.push({ label: sc.title || `Scene ${sc.scene ?? ''}`, active: true });
    } else {
      out[out.length - 1].active = true;
    }
  } else {
    const ref = tree.categories.flatMap((c) => c.entries).find((r) => r.path === path);
    if (ref) out.push({ label: ref.title || (path.split('/').pop() ?? path), active: true });
  }
  return out;
}

function Tab({ to, children }: { to: string; children: React.ReactNode }) {
  return (
    <NavLink
      to={to}
      className={({ isActive }) => (isActive ? 'tab active' : 'tab')}
    >
      {children}
    </NavLink>
  );
}
