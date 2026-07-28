import { useState } from 'react';
import {
  DndContext,
  DragEndEvent,
  PointerSensor,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import { useNavigate, useOutletContext } from 'react-router-dom';
import {
  Act,
  ChapterEntry,
  ProjectTree,
  SceneEntry,
  updateProject,
} from '../../lib/api';
import { syncEngine } from '../../lib/syncEngine';
import { statusClass } from '../../lib/chapterDrag';
import { toast } from '../../app/Toast';
import { ActsEditor } from './ActsEditor';
import { ProjectContext } from './ProjectView';
import { OutlineGrid } from './OutlineBoard';
import { StatusBoard, flattenScenes, sceneInAct } from './StatusBoard';

export type Status = 'draft' | 'revision' | 'final';
export const STATUSES: { id: Status; label: string; color: string }[] = [
  { id: 'draft', label: 'Draft', color: 'var(--fg-mid)' },
  { id: 'revision', label: 'Revision', color: 'var(--warn)' },
  { id: 'final', label: 'Final', color: 'var(--success)' },
];

export interface SceneCardData {
  scene: SceneEntry;
  chapter: ChapterEntry;
}

function sceneStatusOf(s: SceneEntry): Status {
  return statusClass(s.status);
}

type PlanMode = 'outline' | 'status';
const PLAN_MODE_KEY = 'scribe.plan.mode';

function pickLatestChapter(tree: ProjectTree): ChapterEntry | null {
  if (tree.chapters.length === 0) return null;
  let best: ChapterEntry = tree.chapters[0];
  for (const c of tree.chapters) {
    if ((c.order ?? -1) > (best.order ?? -1)) best = c;
  }
  return best;
}

export function PlanBoard() {
  const { slug, tree, refreshTree } = useOutletContext<ProjectContext>();
  const navigate = useNavigate();
  const [actFilter, setActFilter] = useState<string>('all');
  const [showActs, setShowActs] = useState(false);
  const [mode, setMode] = useState<PlanMode>(() => {
    const v = localStorage.getItem(PLAN_MODE_KEY);
    return v === 'status' ? 'status' : 'outline';
  });
  const updateMode = (next: PlanMode) => {
    setMode(next);
    localStorage.setItem(PLAN_MODE_KEY, next);
  };
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
  );

  if (!tree) return <p>Loading…</p>;

  const allScenes = flattenScenes(tree);
  const filteredScenes = allScenes.filter((c) => sceneInAct(c, tree, actFilter));

  const sceneGrouped: Record<Status, SceneCardData[]> = {
    draft: [],
    revision: [],
    final: [],
  };
  for (const c of filteredScenes) sceneGrouped[sceneStatusOf(c.scene)].push(c);

  const goToFile = (path: string) =>
    navigate(`/p/${encodeURIComponent(slug)}/write?path=${encodeURIComponent(path)}`);

  const setSceneStatus = async (
    card: SceneCardData,
    next: Status,
  ) => {
    if (sceneStatusOf(card.scene) === next) return;
    try {
      const f = await syncEngine.getFile(slug, card.scene.path);
      const fm = { ...f.frontmatter, status: next };
      await syncEngine.saveFile(slug, card.scene.path, f.body, fm, f.etag);
      refreshTree();
    } catch (e) {
      toast(`Failed to update status: ${e}`, 'error');
    }
  };

  const onDragEnd = (e: DragEndEvent) => {
    if (!e.over) return;
    const overId = String(e.over.id);
    if (!overId.startsWith('lane:')) return;
    const target = overId.slice('lane:'.length) as Status;
    const card = filteredScenes.find((c) => c.scene.path === e.active.id);
    if (card) setSceneStatus(card, target);
  };

  const handleNewChapterInAct = async (
    act: string | null,
    kind: 'chapter' | 'interlude' = 'chapter',
  ) => {
    try {
      await syncEngine.createChapter(slug, {
        kind,
        act: act ?? undefined,
      });
      refreshTree();
    } catch (e) {
      toast(`Failed to create ${kind}: ${e}`, 'error');
    }
  };

  const handleNewSceneInLatestChapter = async (status: Status) => {
    const ch = pickLatestChapter(tree);
    if (!ch) {
      toast('Create a chapter first (use Outline view).', 'info');
      return;
    }
    try {
      const r = await syncEngine.createScene(slug, ch.slug, {});
      if (status !== 'draft') {
        const f = await syncEngine.getFile(slug, r.path);
        await syncEngine.saveFile(slug, r.path, f.body, { ...f.frontmatter, status }, f.etag);
      }
      refreshTree();
    } catch (e) {
      toast(`Failed: ${e}`, 'error');
    }
  };

  return (
    <div className="corkboard-shell">
      <div className="corkboard-toolbar">
        <h2>{mode === 'outline' ? 'Outline' : 'Corkboard'}</h2>
        <span className="dim">
          {mode === 'status'
            ? `${filteredScenes.length} scene${filteredScenes.length === 1 ? '' : 's'}`
            : `${tree.chapters.length} chapter${tree.chapters.length === 1 ? '' : 's'}`}
        </span>
        <div className="plan-mode-toggle" role="tablist">
          <button
            role="tab"
            aria-selected={mode === 'outline'}
            className={mode === 'outline' ? 'active' : ''}
            onClick={() => updateMode('outline')}
          >
            Outline
          </button>
          <button
            role="tab"
            aria-selected={mode === 'status'}
            className={mode === 'status' ? 'active' : ''}
            onClick={() => updateMode('status')}
          >
            Status
          </button>
        </div>
        <span style={{ marginLeft: 'auto' }} />
        {mode === 'outline' && (
          <button
            className="outline-add"
            onClick={() => setShowActs(true)}
          >
            Manage Acts
          </button>
        )}
        {mode === 'status' && (
          <>
            <label className="dim" style={{ fontSize: 'var(--text-xs)' }}>
              Filter act:
            </label>
            <select
              value={actFilter}
              onChange={(e) => setActFilter(e.target.value)}
            >
              <option value="all">All acts</option>
              {tree.acts.map((a) => (
                <option key={a.name} value={a.name}>
                  {a.name}
                </option>
              ))}
              <option value="__unassigned">Unassigned</option>
            </select>
          </>
        )}
      </div>
      {mode === 'status' ? (
        <DndContext sensors={sensors} onDragEnd={onDragEnd}>
          <StatusBoard
            sceneGrouped={sceneGrouped}
            onOpenFile={goToFile}
            onNewScene={handleNewSceneInLatestChapter}
          />
        </DndContext>
      ) : (
        <OutlineGrid
          tree={tree}
          slug={slug}
          onTreeChanged={refreshTree}
          onOpenFile={goToFile}
          onNewChapter={(act, kind) => handleNewChapterInAct(act, kind)}
        />
      )}
      {showActs && (
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
    </div>
  );
}
