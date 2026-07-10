import React, { useState } from 'react';
import { ChevronDown, ChevronRight, X, Sparkles } from 'lucide-react';
import {
  DndContext,
  DraggableAttributes,
  DraggableSyntheticListeners,
  DragEndEvent,
  PointerSensor,
  closestCenter,
  useDroppable,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import {
  SortableContext,
  arrayMove,
  rectSortingStrategy,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { useNavigate, useOutletContext } from 'react-router-dom';
import {
  Act,
  ChapterEntry,
  ProjectTree,
  SceneEntry,
  deleteFile,
  putFile,
  getFile,
  summarizeFile,
  updateProject,
} from '../../lib/api';
import { syncEngine } from '../../lib/syncEngine';
import { resolveSceneMove } from '../../lib/sceneDrag';
import { ActsEditor } from './ActsEditor';
import { ProjectContext } from './ProjectView';

type Status = 'draft' | 'revision' | 'final';
const STATUSES: { id: Status; label: string; color: string }[] = [
  { id: 'draft', label: 'Draft', color: 'var(--fg-mid)' },
  { id: 'revision', label: 'Revision', color: 'var(--warn)' },
  { id: 'final', label: 'Final', color: 'var(--success)' },
];

interface SceneCardData {
  scene: SceneEntry;
  chapter: ChapterEntry;
}

function sceneStatusOf(s: SceneEntry): Status {
  if (s.status === 'revision') return 'revision';
  if (s.status === 'final') return 'final';
  return 'draft';
}

function flattenScenes(tree: ProjectTree): SceneCardData[] {
  const out: SceneCardData[] = [];
  for (const c of tree.chapters) {
    for (const s of c.scenes) out.push({ scene: s, chapter: c });
  }
  return out;
}

function sceneInAct(
  card: SceneCardData,
  _tree: ProjectTree,
  filter: string,
): boolean {
  if (filter === 'all') return true;
  const c = card.chapter;
  if (filter === '__unassigned') return !c.act;
  return c.act === filter;
}

type PlanMode = 'outline' | 'status';
const PLAN_MODE_KEY = 'scribe.plan.mode';

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
      const f = await getFile(slug, card.scene.path);
      const fm = { ...f.frontmatter, status: next };
      await putFile(
        slug,
        card.scene.path,
        { body: f.body, frontmatter: fm },
        f.etag,
      );
      refreshTree();
    } catch (e) {
      alert(`Failed to update status: ${e}`);
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
      alert(`Failed to create ${kind}: ${e}`);
    }
  };

  const handleNewSceneInLatestChapter = async (status: Status) => {
    const ch = pickLatestChapter(tree);
    if (!ch) {
      alert('Create a chapter first (use Outline view).');
      return;
    }
    try {
      const r = await syncEngine.createScene(slug, ch.slug, {});
      if (status !== 'draft') {
        const f = await getFile(slug, r.path);
        await putFile(
          slug,
          r.path,
          { body: f.body, frontmatter: { ...f.frontmatter, status } },
          f.etag,
        );
      }
      refreshTree();
    } catch (e) {
      alert(`Failed: ${e}`);
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
          <div className="corkboard">
            {STATUSES.map((s) => (
              <SceneSwimlane
                key={s.id}
                status={s.id}
                label={s.label}
                color={s.color}
                cards={sceneGrouped[s.id]}
                onOpenFile={goToFile}
                onNewScene={() => handleNewSceneInLatestChapter(s.id)}
              />
            ))}
          </div>
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

function OutlineGrid({
  tree,
  slug,
  onTreeChanged,
  onOpenFile,
  onNewChapter,
}: {
  tree: ProjectTree;
  slug: string;
  onTreeChanged: () => void;
  onOpenFile: (path: string) => void;
  onNewChapter: (act: string | null, kind: 'chapter' | 'interlude') => void;
}) {
  const groups = groupChaptersByAct(tree);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
  );
  const [collapsedActs, setCollapsedActs] = useState<Set<string>>(() => {
    try {
      const v = localStorage.getItem('scribe.plan.collapsedActs');
      return v ? new Set(JSON.parse(v)) : new Set();
    } catch { return new Set(); }
  });
  const toggleAct = (label: string) => {
    setCollapsedActs((prev) => {
      const next = new Set(prev);
      if (next.has(label)) next.delete(label); else next.add(label);
      localStorage.setItem('scribe.plan.collapsedActs', JSON.stringify([...next]));
      return next;
    });
  };

  const allChapters = tree.chapters;

  const onDragEnd = async (e: DragEndEvent) => {
    if (!e.over) return;
    const activeId = String(e.active.id);
    const overId = String(e.over.id);

    const isSceneDrag = activeId.endsWith('.md');

    if (isSceneDrag) {
      const move = resolveSceneMove(tree, activeId, overId);
      if (!move) return;
      try {
        if (move.kind === 'same-chapter') {
          await syncEngine.reorderItems(slug, move.reorderedScenes);
        } else {
          await syncEngine.moveScene(slug, {
            srcPath: move.srcPath,
            dstChapterSlug: move.dstChapterSlug,
            srcOrder: move.srcOrder,
            dstOrder: move.dstOrder,
          });
        }
        onTreeChanged();
      } catch (err) {
        console.error('Scene move failed', err);
      }
      return;
    }

    const sourceChapter = allChapters.find((c) => c.path === activeId);
    if (!sourceChapter) return;

    const findActFor = (ch: ChapterEntry): string | null =>
      groups.find((g) => g.chapters.some((c) => c.path === ch.path))?.act?.name ?? null;
    const sourceAct = findActFor(sourceChapter);

    let next: ChapterEntry[];
    let targetAct: string | null;

    if (overId.startsWith('outline-act-zone:')) {
      targetAct = overId.slice('outline-act-zone:'.length);
      if (targetAct === '__unassigned') targetAct = null;
      const remaining = allChapters.filter((c) => c.path !== sourceChapter.path);
      const targetGroup = groups.find((g) => (g.act?.name ?? null) === targetAct);
      let insertAt = remaining.length;
      if (targetGroup && targetGroup.chapters.length > 0) {
        const last = targetGroup.chapters[targetGroup.chapters.length - 1];
        insertAt = remaining.findIndex((c) => c.path === last.path) + 1;
      }
      next = [...remaining];
      next.splice(insertAt, 0, sourceChapter);
    } else {
      const targetChapter = allChapters.find((c) => c.path === overId);
      if (!targetChapter || sourceChapter.path === targetChapter.path) return;
      targetAct = findActFor(targetChapter);
      const oldIdx = allChapters.findIndex((c) => c.path === sourceChapter.path);
      const newIdx = allChapters.findIndex((c) => c.path === targetChapter.path);
      next = arrayMove([...allChapters], oldIdx, newIdx);
    }

    const actChanged = sourceAct !== targetAct;
    const payload = next.map((c, i) => {
      const item: { path: string; order: number; act?: string | null } = {
        path: c.meta_path,
        order: i + 1,
      };
      if (actChanged && c.path === sourceChapter.path) {
        item.act = targetAct ?? '';
      }
      return item;
    });

    try {
      await syncEngine.reorderItems(slug, payload);
      onTreeChanged();
    } catch (err) {
      console.error('Chapter reorder failed', err);
    }
  };

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      onDragEnd={onDragEnd}
    >
      <div className="outline-grid-shell">
        {groups.map((g, i) => {
          const totalWords = g.chapters.reduce((acc, c) => acc + c.word_count, 0);
          const label = g.act?.name ?? 'Unassigned';
          const collapsed = collapsedActs.has(label);
          return (
            <section
              key={g.act?.name ?? `__unassigned-${i}`}
              className="outline-act"
            >
              <header
                className="outline-act-header"
                onClick={() => toggleAct(label)}
                style={{ cursor: 'pointer' }}
              >
                <span className="outline-act-caret">
                  {collapsed ? <ChevronRight size={16} /> : <ChevronDown size={16} />}
                </span>
                <h3>{label}</h3>
                <span className="dim">
                  {g.chapters.length} chapter
                  {g.chapters.length === 1 ? '' : 's'} ·{' '}
                  {totalWords.toLocaleString()}w
                </span>
                {!collapsed && (
                  <>
                    <button
                      className="outline-add"
                      onClick={(e) => { e.stopPropagation(); onNewChapter(g.act?.name ?? null, 'chapter'); }}
                      title={`New chapter in ${label}`}
                    >
                      + New Chapter
                    </button>
                    <button
                      className="outline-add outline-add-interlude"
                      onClick={(e) => { e.stopPropagation(); onNewChapter(g.act?.name ?? null, 'interlude'); }}
                      title={`New interlude in ${label}`}
                    >
                      + Interlude
                    </button>
                  </>
                )}
              </header>
              {!collapsed && (
                <SortableContext
                  items={g.chapters.map((c) => c.path)}
                  strategy={rectSortingStrategy}
                >
                  <div className="outline-grid">
                    {g.chapters.map((c) => (
                      <SortableOutlineCard
                        key={c.path}
                        chapter={c}
                        slug={slug}
                        onTreeChanged={onTreeChanged}
                        onOpenFile={onOpenFile}
                      />
                    ))}
                    {g.chapters.length === 0 && (
                      <p className="outline-empty">— no chapters yet —</p>
                    )}
                  </div>
                  <OutlineActDropzone actName={g.act?.name ?? null} isEmpty={g.chapters.length === 0} />
                </SortableContext>
              )}
            </section>
          );
        })}
      </div>
    </DndContext>
  );
}

function groupChaptersByAct(
  tree: ProjectTree,
): { act: { name: string } | null; chapters: ChapterEntry[] }[] {
  const groups: { act: { name: string } | null; chapters: ChapterEntry[] }[] =
    tree.acts.map((a) => ({ act: { name: a.name }, chapters: [] }));
  const unassigned: ChapterEntry[] = [];
  for (const c of tree.chapters) {
    if (c.act) {
      const idx = tree.acts.findIndex((a) => a.name === c.act);
      if (idx !== -1) {
        groups[idx].chapters.push(c);
        continue;
      }
    }
    unassigned.push(c);
  }
  if (tree.acts.length === 0) return [{ act: null, chapters: tree.chapters }];
  if (unassigned.length > 0) groups.push({ act: null, chapters: unassigned });
  return groups;
}

function OutlineActDropzone({ actName, isEmpty }: { actName: string | null; isEmpty: boolean }) {
  const id = `outline-act-zone:${actName ?? '__unassigned'}`;
  const { setNodeRef, isOver } = useDroppable({ id });
  const cls = `act-dropzone${isOver ? ' over' : ''}${isEmpty ? ' empty' : ''}`;
  return (
    <div ref={setNodeRef} className={cls}>
      {isEmpty
        ? `Drop here to add to ${actName ?? 'Unassigned'}`
        : isOver
          ? `Drop to end of ${actName ?? 'Unassigned'}`
          : ''}
    </div>
  );
}

function SortableOutlineCard(props: {
  chapter: ChapterEntry;
  slug: string;
  onTreeChanged: () => void;
  onOpenFile: (path: string) => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id: props.chapter.path });
  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition: transition ?? undefined,
    opacity: isDragging ? 0.85 : 1,
    zIndex: isDragging ? 10 : undefined,
    position: 'relative' as const,
  };
  return (
    <OutlineCard
      {...props}
      sortable={{ setNodeRef, style, attributes, listeners }}
    />
  );
}

function OutlineCard({
  chapter,
  slug,
  onTreeChanged,
  onOpenFile,
  sortable,
}: {
  chapter: ChapterEntry;
  slug: string;
  onTreeChanged: () => void;
  onOpenFile: (path: string) => void;
  sortable?: {
    setNodeRef: (el: HTMLElement | null) => void;
    style: React.CSSProperties;
    attributes: DraggableAttributes;
    listeners: DraggableSyntheticListeners;
  };
}) {
  const [cardOpen, setCardOpen] = useState(true);

  const handleAddScene = async () => {
    try {
      await syncEngine.createScene(slug, chapter.slug, {});
      onTreeChanged();
    } catch (err) {
      alert(`Failed: ${err}`);
    }
  };

  const handleDelete = async () => {
    if (!window.confirm(`Delete ${chapter.title || chapter.slug}?`)) return;
    try {
      await syncEngine.removeChapter(slug, chapter.slug);
      onTreeChanged();
    } catch (err) {
      alert(`Failed: ${err}`);
    }
  };

  return (
    <article
      className={`outline-card${cardOpen ? '' : ' collapsed'}`}
      ref={sortable?.setNodeRef as React.Ref<HTMLElement>}
      style={sortable?.style}
    >
      {cardOpen && (
        <div className="oc-actions">
          <button onClick={handleAddScene} title="Add scene">+</button>
          <button
            className="danger"
            onClick={handleDelete}
            title="Delete chapter"
          >
            <X size={14} />
          </button>
        </div>
      )}
      <header
        className="oc-chapter-head"
        onClick={(e) => {
          if (cardOpen) {
            onOpenFile(
              chapter.scenes.length > 0
                ? chapter.scenes[0].path
                : chapter.meta_path,
            );
          } else {
            e.stopPropagation();
            setCardOpen(true);
          }
        }}
        title={cardOpen ? 'Open chapter' : 'Expand card'}
      >
        {sortable && (
          <span
            className="oc-chapter-grip"
            {...sortable.attributes}
            {...sortable.listeners}
          >
            ⋮⋮
          </span>
        )}
        <button
          className="oc-collapse-toggle"
          onClick={(e) => { e.stopPropagation(); setCardOpen(!cardOpen); }}
          title={cardOpen ? 'Collapse' : 'Expand'}
        >
          {cardOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        </button>
        <span className="oc-num">
          {chapter.kind === 'interlude'
            ? `Interlude ${chapter.interlude ?? '·'}`
            : `Chapter ${chapter.chapter ?? '·'}`}
        </span>
        <span className="oc-words">
          {chapter.word_count.toLocaleString()}w
        </span>
        <h4 className="oc-title">{chapter.title || chapter.slug}</h4>
      </header>

      {cardOpen && <SortableContext
        items={chapter.scenes.map((s) => s.path)}
        strategy={verticalListSortingStrategy}
      >
        {chapter.scenes.length === 0 ? (
          <button className="oc-add-scene-empty" onClick={handleAddScene}>
            + New Scene
          </button>
        ) : (
          <ul className="oc-scenes-list">
            {chapter.scenes.map((s) => (
              <SortableSceneRow
                key={s.path}
                scene={s}
                chapterIndex={
                  chapter.kind === 'interlude'
                    ? `i${chapter.interlude ?? ''}`
                    : chapter.chapter
                }
                chapterPov={chapter.pov}
                slug={slug}
                onTreeChanged={onTreeChanged}
                onOpenFile={onOpenFile}
              />
            ))}
            <li>
              <button className="oc-add-scene-empty" onClick={handleAddScene}>
                + New Scene
              </button>
            </li>
          </ul>
        )}
      </SortableContext>}
      {cardOpen && <OutlineSceneDropzone chapterSlug={chapter.slug} />}
    </article>
  );
}

function OutlineSceneDropzone({ chapterSlug }: { chapterSlug: string }) {
  const id = `scene-zone:${chapterSlug}`;
  const { setNodeRef, isOver } = useDroppable({ id });
  return (
    <div
      ref={setNodeRef}
      className={`outline-scene-dropzone${isOver ? ' over' : ''}`}
    >
      {isOver ? 'Drop scene here' : ''}
    </div>
  );
}

function SortableSceneRow(props: {
  scene: SceneEntry;
  chapterIndex: number | string | null;
  chapterPov: string | null;
  slug: string;
  onTreeChanged: () => void;
  onOpenFile: (path: string) => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id: props.scene.path });
  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition: transition ?? undefined,
    opacity: isDragging ? 0.5 : undefined,
    position: 'relative' as const,
  };
  return (
    <SceneRow
      {...props}
      sortable={{ setNodeRef, style, attributes, listeners }}
    />
  );
}

function SceneRow({
  scene,
  chapterIndex,
  chapterPov,
  slug,
  onTreeChanged,
  onOpenFile,
  sortable,
}: {
  scene: SceneEntry;
  chapterIndex: number | string | null;
  chapterPov: string | null;
  slug: string;
  onTreeChanged: () => void;
  onOpenFile: (path: string) => void;
  sortable?: {
    setNodeRef: (el: HTMLElement | null) => void;
    style: React.CSSProperties;
    attributes: DraggableAttributes;
    listeners: DraggableSyntheticListeners;
  };
}) {
  const pov = scene.pov ?? chapterPov;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const [editingPov, setEditingPov] = useState(false);
  const [povDraft, setPovDraft] = useState('');
  const [summaryExpanded, setSummaryExpanded] = useState(false);

  const startEditPov = (e: React.MouseEvent) => {
    e.stopPropagation();
    setPovDraft(scene.pov ?? '');
    setEditingPov(true);
  };
  const cancelEditPov = () => {
    setEditingPov(false);
    setPovDraft('');
  };
  const savePov = async () => {
    const next = povDraft.trim();
    if (next === (scene.pov ?? '').trim()) {
      cancelEditPov();
      return;
    }
    try {
      const f = await getFile(slug, scene.path);
      const fm = { ...f.frontmatter };
      if (next) fm.pov = next;
      else delete fm.pov;
      await putFile(slug, scene.path, { body: f.body, frontmatter: fm }, f.etag);
      onTreeChanged();
      setEditingPov(false);
    } catch (err) {
      alert(`Failed to save POV: ${err}`);
    }
  };

  const handleDelete = async (e: React.MouseEvent) => {
    e.stopPropagation();
    const isEmpty = scene.word_count === 0 && !scene.summary && !scene.title;
    if (!isEmpty) {
      const label = scene.title || `scene ${scene.scene ?? ''}`;
      if (!window.confirm(`Delete ${label}?`)) return;
    }
    try {
      await deleteFile(slug, scene.path);
      onTreeChanged();
    } catch (err) {
      alert(`Failed to delete scene: ${err}`);
    }
  };

  const [generating, setGenerating] = useState(false);
  const helperModel =
    localStorage.getItem('scribe.rewrite.model') || undefined;
  const generate = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (scene.word_count === 0) {
      alert('No scene content yet — write something first.');
      return;
    }
    setGenerating(true);
    try {
      const { summary: next } = await summarizeFile(
        slug,
        scene.path,
        helperModel,
      );
      const f = await getFile(slug, scene.path);
      await putFile(
        slug,
        scene.path,
        { body: f.body, frontmatter: { ...f.frontmatter, summary: next } },
        f.etag,
      );
      onTreeChanged();
    } catch (err) {
      alert(`Failed to generate summary: ${err}`);
    } finally {
      setGenerating(false);
    }
  };

  const label =
    chapterIndex !== null && scene.scene !== null
      ? `${chapterIndex}.${scene.scene}`
      : `s${scene.scene ?? '?'}`;

  const startEdit = (e: React.MouseEvent) => {
    e.stopPropagation();
    setDraft(scene.summary ?? '');
    setEditing(true);
  };

  const cancel = () => {
    setEditing(false);
    setSummaryExpanded(false);
    setDraft('');
  };

  const save = async () => {
    const next = draft.trim();
    if (next === (scene.summary ?? '').trim()) {
      cancel();
      return;
    }
    setSaving(true);
    try {
      const f = await getFile(slug, scene.path);
      await putFile(
        slug,
        scene.path,
        { body: f.body, frontmatter: { ...f.frontmatter, summary: next } },
        f.etag,
      );
      onTreeChanged();
      setEditing(false);
    } catch (err) {
      alert(`Failed to save summary: ${err}`);
    } finally {
      setSaving(false);
    }
  };

  return (
    <li
      className="oc-scene-row"
      ref={sortable?.setNodeRef as React.Ref<HTMLLIElement>}
      style={sortable?.style}
    >
      <div className="oc-scene-head">
        <span
          className="oc-scene-grip"
          {...(sortable?.attributes ?? {})}
          {...(sortable?.listeners ?? {})}
        >
          ⋮
        </span>
        <button
          className="oc-scene-link"
          onClick={() => onOpenFile(scene.path)}
          title="Open scene"
        >
          <span className="oc-scene-num">{label}</span>
          <span className="oc-scene-title">
            {scene.title || `Scene ${scene.scene ?? ''}`}
          </span>
        </button>
        {editingPov ? (
          <input
            className="oc-pov-edit"
            value={povDraft}
            autoFocus
            onChange={(e) => setPovDraft(e.target.value)}
            onBlur={savePov}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.stopPropagation();
                cancelEditPov();
              } else if (e.key === 'Enter') {
                e.preventDefault();
                savePov();
              }
            }}
            placeholder="POV"
          />
        ) : pov ? (
          <button
            className={`oc-scene-pov pov-tag${scene.pov ? '' : ' inherited'}`}
            onClick={startEditPov}
            title={scene.pov ? 'Scene POV (click to edit)' : 'Inherited from chapter (click to set scene POV)'}
          >
            {pov}
          </button>
        ) : (
          <button
            className="oc-scene-pov pov-tag empty"
            onClick={startEditPov}
            title="Set POV"
          >
            + POV
          </button>
        )}
        <span className="oc-scene-words">
          {scene.word_count.toLocaleString()}w
        </span>
        <button
          className="oc-scene-delete ghost-btn danger"
          onClick={handleDelete}
          title="Delete scene"
        >
          <X size={14} />
        </button>
      </div>
      <div className="oc-summary-row">
        {editing ? (
          <textarea
            className="oc-summary-edit"
            value={draft}
            autoFocus
            disabled={saving}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={save}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.stopPropagation();
                cancel();
              } else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                save();
              }
            }}
            placeholder="Scene summary…"
          />
        ) : (
          <p
            className={`oc-summary editable${scene.summary ? '' : ' empty'}${generating ? ' generating' : ''}${!summaryExpanded && scene.summary ? ' collapsed' : ''}`}
            onClick={(e) => {
              if (!scene.summary || summaryExpanded) { startEdit(e); return; }
              setSummaryExpanded(true);
            }}
            onDoubleClick={startEdit}
            title={summaryExpanded || !scene.summary ? 'Click to edit summary' : 'Click to expand, double-click to edit'}
          >
            {generating
              ? 'Generating summary…'
              : scene.summary || 'Click to add summary…'}
          </p>
        )}
        {!editing && (
          <button
            className="oc-summary-generate"
            onClick={generate}
            disabled={generating || scene.word_count === 0}
            title={
              scene.word_count === 0
                ? 'Write some scene content first'
                : `Generate summary using ${helperModel || 'project default'} (set the model in the editor view)`
            }
          >
            {generating ? '…' : <Sparkles size={14} />}
          </button>
        )}
      </div>
    </li>
  );
}

function pickLatestChapter(tree: ProjectTree): ChapterEntry | null {
  if (tree.chapters.length === 0) return null;
  let best: ChapterEntry = tree.chapters[0];
  for (const c of tree.chapters) {
    if ((c.chapter ?? -1) > (best.chapter ?? -1)) best = c;
  }
  return best;
}

function chapterGroupLabel(c: ChapterEntry): string {
  return c.kind === 'interlude'
    ? `Interlude ${c.interlude ?? '·'} — ${c.title || c.slug}`
    : `Ch. ${c.chapter ?? '·'} — ${c.title || c.slug}`;
}

function SceneSwimlane({
  status,
  label,
  color,
  cards,
  onOpenFile,
  onNewScene,
}: {
  status: Status;
  label: string;
  color: string;
  cards: SceneCardData[];
  onOpenFile: (path: string) => void;
  onNewScene: () => void;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: `lane:${status}` });
  const totalWords = cards.reduce((acc, c) => acc + c.scene.word_count, 0);

  return (
    <div className="swimlane">
      <header className="swimlane-header">
        <span className="lane-dot" style={{ color }} />
        <span>{label}</span>
        <span className="count">
          {cards.length} · {totalWords.toLocaleString()}w
        </span>
      </header>
      <div
        ref={setNodeRef}
        className={`swimlane-body${isOver ? ' over' : ''}`}
      >
        {cards.length === 0 && (
          <p className="swimlane-empty">— nothing here yet —</p>
        )}
        {cards.map((c, i) => {
          const prevChapter = i > 0 ? cards[i - 1].chapter.slug : null;
          const showGroup = c.chapter.slug !== prevChapter;
          return (
            <React.Fragment key={c.scene.path}>
              {showGroup && (
                <div className="lane-chapter-group">
                  {chapterGroupLabel(c.chapter)}
                </div>
              )}
              <DraggableSceneCard card={c} onOpenFile={onOpenFile} />
            </React.Fragment>
          );
        })}
        <button className="swimlane-add" onClick={onNewScene}>
          + scene
        </button>
      </div>
    </div>
  );
}

function DraggableSceneCard({
  card,
  onOpenFile,
}: {
  card: SceneCardData;
  onOpenFile: (path: string) => void;
}) {
  const { scene, chapter } = card;
  const { setNodeRef, attributes, listeners, transform, isDragging } =
    useDraggable({ id: scene.path });

  const style: React.CSSProperties = {
    transform: transform
      ? `translate3d(${transform.x}px, ${transform.y}px, 0)`
      : undefined,
    opacity: isDragging ? 0.85 : 1,
    zIndex: isDragging ? 10 : undefined,
    boxShadow: isDragging ? 'var(--shadow-lg)' : undefined,
  };

  const chapterLabel =
    chapter.kind === 'interlude'
      ? `i${chapter.interlude ?? ''}`
      : chapter.chapter ?? '';
  const label =
    chapterLabel !== '' && scene.scene !== null
      ? `${chapterLabel}.${scene.scene}`
      : `s${scene.scene ?? '?'}`;
  const pov = scene.pov ?? chapter.pov ?? null;
  const pin =
    chapter.kind === 'interlude'
      ? `Interlude ${chapter.interlude ?? '·'} — ${chapter.title || chapter.slug}`
      : `Ch. ${chapter.chapter ?? '·'} — ${chapter.title || chapter.slug}`;

  return (
    <article
      ref={setNodeRef}
      className="index-card"
      style={style}
      {...attributes}
      {...listeners}
      onClick={() => onOpenFile(scene.path)}
    >
      <div className="ic-head">
        <span className="ic-num">{label}</span>
        <span className="ic-title">
          {scene.title || `Scene ${scene.scene ?? ''}`}
        </span>
      </div>
      <p className={`ic-summary${scene.summary ? '' : ' empty'}`}>
        {scene.summary || 'No summary yet.'}
      </p>
      <div className="ic-foot">
        {pov && <span className="ic-pov">{pov}</span>}
        {pov && <span>·</span>}
        <span>{scene.word_count.toLocaleString()}w</span>
        <span className="ic-pin">{pin}</span>
      </div>
    </article>
  );
}

import { useDraggable } from '@dnd-kit/core';
