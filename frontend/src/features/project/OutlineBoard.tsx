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
  rectSortingStrategy,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { ChapterEntry, ProjectTree, SceneEntry, summarizeFile } from '../../lib/api';
import { syncEngine } from '../../lib/syncEngine';
import { resolveSceneMove } from '../../lib/sceneDrag';
import {
  OUTLINE_ACT_ZONE_PREFIX,
  actZoneId,
  groupChaptersByAct,
  resolveChapterReorder,
} from '../../lib/chapterDrag';
import { toast } from '../../app/Toast';

export function OutlineGrid({
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
  const groups = groupChaptersByAct(tree, tree.chapters);
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
      } catch {
        // error already shown to user
      }
      return;
    }

    const result = resolveChapterReorder(tree, allChapters, activeId, overId, {
      actZonePrefix: OUTLINE_ACT_ZONE_PREFIX,
    });
    if (!result) return;

    try {
      await syncEngine.reorderItems(slug, result.payload);
      onTreeChanged();
    } catch {
      // error already shown to user
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

function OutlineActDropzone({ actName, isEmpty }: { actName: string | null; isEmpty: boolean }) {
  const id = actZoneId(OUTLINE_ACT_ZONE_PREFIX, actName);
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
      toast(`Failed: ${err}`, 'error');
    }
  };

  const handleDelete = async () => {
    if (!window.confirm(`Delete ${chapter.title || chapter.slug}?`)) return;
    try {
      await syncEngine.removeChapter(slug, chapter.slug);
      onTreeChanged();
    } catch (err) {
      toast(`Failed: ${err}`, 'error');
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
  slug,
  onTreeChanged,
  onOpenFile,
  sortable,
}: {
  scene: SceneEntry;
  chapterIndex: number | string | null;
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
  const pov = scene.pov;
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
      const f = await syncEngine.getFile(slug, scene.path);
      const fm = { ...f.frontmatter };
      if (next) fm.pov = next;
      else delete fm.pov;
      await syncEngine.saveFile(slug, scene.path, f.body, fm, f.etag);
      onTreeChanged();
      setEditingPov(false);
    } catch (err) {
      toast(`Failed to save POV: ${err}`, 'error');
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
      await syncEngine.deleteScene(slug, scene.path);
      onTreeChanged();
    } catch (err) {
      toast(`Failed to delete scene: ${err}`, 'error');
    }
  };

  const [generating, setGenerating] = useState(false);
  const helperModel =
    localStorage.getItem('scribe.rewrite.model') || undefined;
  const generate = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (scene.word_count === 0) {
      toast('No scene content yet — write something first.', 'info');
      return;
    }
    setGenerating(true);
    try {
      const { summary: next } = await summarizeFile(
        slug,
        scene.path,
        helperModel,
      );
      const f = await syncEngine.getFile(slug, scene.path);
      await syncEngine.saveFile(slug, scene.path, f.body, { ...f.frontmatter, summary: next }, f.etag);
      onTreeChanged();
    } catch (err) {
      toast(`Failed to generate summary: ${err}`, 'error');
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
      const f = await syncEngine.getFile(slug, scene.path);
      await syncEngine.saveFile(slug, scene.path, f.body, { ...f.frontmatter, summary: next }, f.etag);
      onTreeChanged();
      setEditing(false);
    } catch (err) {
      toast(`Failed to save summary: ${err}`, 'error');
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
