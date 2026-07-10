import { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, ChevronRight, Pencil, X } from 'lucide-react';
import {
  DndContext,
  DragEndEvent,
  DraggableAttributes,
  DraggableSyntheticListeners,
  PointerSensor,
  closestCenter,
  useDndContext,
  useDroppable,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import {
  SortableContext,
  arrayMove,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import {
  Act,
  CategoryData,
  ChapterEntry,
  ProjectTree,
  ReferenceEntry,
  SceneEntry,
  deleteFile,
} from '../../lib/api';
import { syncEngine } from '../../lib/syncEngine';
import { isOfflinePath } from '../../lib/offlineTree';
import { resolveSceneMove } from '../../lib/sceneDrag';

interface Props {
  tree: ProjectTree;
  slug: string;
  activePath: string | null;
  onSelect: (path: string) => void;
  onTreeChanged: () => void;
  onEditActs?: () => void;
  onEditCategories?: () => void;
}

interface ActGroup {
  act: Act | null;
  chapters: ChapterEntry[];
}

function groupChaptersByAct(
  tree: ProjectTree,
  chapters: ChapterEntry[],
): ActGroup[] {
  const groups: ActGroup[] = tree.acts.map((a) => ({ act: a, chapters: [] }));
  const unassigned: ChapterEntry[] = [];

  for (const c of chapters) {
    if (c.act) {
      const idx = tree.acts.findIndex((a) => a.name === c.act);
      if (idx !== -1) {
        groups[idx].chapters.push(c);
        continue;
      }
    }
    unassigned.push(c);
  }

  if (tree.acts.length === 0) return [{ act: null, chapters }];
  groups.push({ act: null, chapters: unassigned });
  return groups;
}

const ACT_ZONE_PREFIX = 'act-zone:';
const actZoneId = (actName: string | null) =>
  `${ACT_ZONE_PREFIX}${actName ?? '__unassigned'}`;
const isActZone = (id: string) => id.startsWith(ACT_ZONE_PREFIX);
const actNameFromZone = (id: string): string | null => {
  const name = id.slice(ACT_ZONE_PREFIX.length);
  return name === '__unassigned' ? null : name;
};

const actWordCount = (g: ActGroup) =>
  g.chapters.reduce((acc, c) => acc + c.word_count, 0);


const statusClass = (s: string | null | undefined): string => {
  if (s === 'revision') return 'revision';
  if (s === 'final') return 'final';
  return 'draft';
};

/** Roll up scene statuses into a tri-state for the chapter row. */
const aggregateStatus = (chapter: ChapterEntry): string => {
  const scenes = chapter.scenes;
  if (scenes.length === 0) return 'draft';
  const set = new Set(scenes.map((s) => statusClass(s.status)));
  if (set.size === 1) return [...set][0];
  return 'mixed';
};

/** "Asha", "Asha + Tarn", or "Asha + 2 more". Empty string if none. */
const aggregatePov = (chapter: ChapterEntry): string => {
  const seen: string[] = [];
  for (const s of chapter.scenes) {
    const p = s.pov ?? chapter.pov;
    if (p && !seen.includes(p)) seen.push(p);
  }
  if (seen.length === 0) return '';
  if (seen.length === 1) return seen[0];
  if (seen.length === 2) return `${seen[0]} + ${seen[1]}`;
  return `${seen[0]} + ${seen.length - 1} more`;
};

export function Sidebar({
  tree,
  slug,
  activePath,
  onSelect,
  onTreeChanged,
  onEditActs,
  onEditCategories,
}: Props) {
  const [orderedPaths, setOrderedPaths] = useState<string[] | null>(null);
  const [sceneOverrides, setSceneOverrides] = useState<Record<string, string[]>>({});
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
  );

  useEffect(() => {
    setSceneOverrides((prev) =>
      Object.keys(prev).length > 0 ? {} : prev,
    );
  }, [tree]);

  const orderedChapters: ChapterEntry[] = orderedPaths
    ? (orderedPaths
        .map((p) => tree.chapters.find((c) => c.path === p))
        .filter(Boolean) as ChapterEntry[])
    : tree.chapters;

  const allScenes = tree.chapters.flatMap((c) => c.scenes);
  const effectiveChapters =
    Object.keys(sceneOverrides).length > 0
      ? orderedChapters.map((c) => {
          const override = sceneOverrides[c.slug];
          if (!override) return c;
          return {
            ...c,
            scenes: override
              .map((p) => allScenes.find((s) => s.path === p))
              .filter((s): s is SceneEntry => s != null),
          };
        })
      : orderedChapters;

  const groups = groupChaptersByAct(tree, effectiveChapters);

  const onDragEnd = async (e: DragEndEvent) => {
    if (!e.over) return;
    const activeId = String(e.active.id);
    const overId = String(e.over.id);

    // Check if this is a scene drag
    const isSceneDrag = tree.chapters.some((c) =>
      c.scenes.some((s) => s.path === activeId),
    );
    if (isSceneDrag) {
      let effectiveOverId = overId;
      const overChapter = tree.chapters.find((c) => c.path === overId);
      if (overChapter) effectiveOverId = `scene-zone:${overChapter.slug}`;

      const move = resolveSceneMove(tree, activeId, effectiveOverId);
      if (!move) return;

      if (move.kind === 'same-chapter') {
        setSceneOverrides({
          [move.chapterSlug]: move.reorderedScenes.map((s) => s.path),
        });
      } else {
        const srcCh = tree.chapters.find((c) =>
          c.scenes.some((s) => s.path === move.srcPath),
        );
        setSceneOverrides({
          ...(srcCh
            ? { [srcCh.slug]: move.srcOrder.map((s) => s.path) }
            : {}),
          [move.dstChapterSlug]: move.dstOrder.map((s) => s.path),
        });
      }

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
        setSceneOverrides({});
        console.error('Scene move failed', err);
      }
      return;
    }

    const sourceChapter = orderedChapters.find((c) => c.path === e.active.id);
    if (!sourceChapter) return;

    const findActFor = (ch: ChapterEntry): string | null =>
      groups.find((g) => g.chapters.some((c) => c.path === ch.path))?.act?.name ??
      null;
    const sourceAct = findActFor(sourceChapter);

    let next: ChapterEntry[];
    let targetAct: string | null;

    if (isActZone(overId)) {
      targetAct = actNameFromZone(overId);
      const remaining = orderedChapters.filter(
        (c) => c.path !== sourceChapter.path,
      );
      const targetGroupIdx = groups.findIndex(
        (g) => (g.act?.name ?? null) === targetAct,
      );
      let insertAt = remaining.length;
      if (targetGroupIdx !== -1) {
        const targetGroup = groups[targetGroupIdx];
        if (targetGroup.chapters.length > 0) {
          const lastInGroup =
            targetGroup.chapters[targetGroup.chapters.length - 1];
          insertAt = remaining.findIndex((c) => c.path === lastInGroup.path) + 1;
        } else {
          let cursor = 0;
          for (let i = 0; i < targetGroupIdx; i++) {
            cursor += groups[i].chapters.length;
          }
          const oldIndex = orderedChapters.findIndex(
            (c) => c.path === sourceChapter.path,
          );
          if (oldIndex >= 0 && oldIndex < cursor) cursor -= 1;
          insertAt = cursor;
        }
      }
      next = [...remaining];
      next.splice(insertAt, 0, sourceChapter);
    } else {
      const targetChapter = orderedChapters.find((c) => c.path === overId);
      if (!targetChapter || sourceChapter.path === targetChapter.path) return;
      targetAct = findActFor(targetChapter);
      const oldIndex = orderedChapters.findIndex(
        (c) => c.path === sourceChapter.path,
      );
      const newIndex = orderedChapters.findIndex(
        (c) => c.path === targetChapter.path,
      );
      next = arrayMove(orderedChapters, oldIndex, newIndex);
    }

    const actChanged = sourceAct !== targetAct;
    setOrderedPaths(next.map((c) => c.path));

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
      setOrderedPaths(null);
    } catch (err) {
      alert(`Reorder failed: ${err}`);
      setOrderedPaths(null);
    }
  };

  const handleNewChapter = async (
    act?: string | null,
    kind: 'chapter' | 'interlude' = 'chapter',
  ) => {
    try {
      const r = await syncEngine.createChapter(slug, {
        kind,
        act: act ?? undefined,
      });
      onTreeChanged();
      onSelect(r.first_scene_path);
    } catch (e) {
      alert(`Failed to create ${kind}: ${e}`);
    }
  };

  const handleNewCategoryEntry = async (cat: CategoryData) => {
    const title = window.prompt(`New ${cat.name.replace(/s$/, '').toLowerCase()} title:`);
    if (!title) return;
    try {
      const r = await syncEngine.createCategoryEntry(slug, cat.folder, { title });
      onTreeChanged();
      onSelect(r.path);
    } catch (e) {
      alert(`Failed: ${e}`);
    }
  };

  return (
    <aside className="sidebar">
      <header className="sidebar-header">
        <div>
          <h2>{tree.title}</h2>
          {tree.author && <small>{tree.author}</small>}
        </div>
      </header>

      <div className="sidebar-scroll">
        <section className="sidebar-section">
          <header className="section-header">
            <span>Chapters</span>
            <span className="count">{tree.chapters.length}</span>
            {onEditActs && (
              <button
                className="ghost-btn"
                onClick={onEditActs}
                title="Edit acts"
              >
                acts
              </button>
            )}
            <button
              className="ghost-btn"
              onClick={() => handleNewChapter(null)}
              title="New chapter"
            >
              +
            </button>
          </header>
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            onDragEnd={onDragEnd}
          >
            <SortableContext
              items={orderedChapters.map((c) => c.path)}
              strategy={verticalListSortingStrategy}
            >
              {groups.map((g, i) => (
                <ActBlock
                  key={g.act ? g.act.name : `unassigned-${i}`}
                  group={g}
                  slug={slug}
                  activePath={activePath}
                  onSelect={onSelect}
                  onTreeChanged={onTreeChanged}
                  onAddChapter={() => handleNewChapter(g.act?.name ?? null)}
                />
              ))}
            </SortableContext>
          </DndContext>
        </section>

        {tree.categories.map((cat) => (
          <section key={cat.folder} className="sidebar-section">
            <header className="section-header">
              <span>{cat.name}</span>
              <span className="count">{cat.entries.length}</span>
              <button
                className="ghost-btn"
                onClick={() => handleNewCategoryEntry(cat)}
                title={`New ${cat.name.replace(/s$/, '').toLowerCase()}`}
              >
                +
              </button>
            </header>
            <RefList
              items={cat.entries}
              activePath={activePath}
              onSelect={onSelect}
              slug={slug}
              onTreeChanged={onTreeChanged}
              storageKey={`scribe.sidebar.${cat.folder}.tag`}
            />
          </section>
        ))}

        {onEditCategories && (
          <button
            className="ghost-btn sidebar-categories-btn"
            onClick={onEditCategories}
            title="Manage categories"
          >
            Manage categories…
          </button>
        )}
      </div>
    </aside>
  );
}

function ActBlock({
  group,
  slug,
  activePath,
  onSelect,
  onTreeChanged,
  onAddChapter,
}: {
  group: ActGroup;
  slug: string;
  activePath: string | null;
  onSelect: (path: string) => void;
  onTreeChanged: () => void;
  onAddChapter: () => void;
}) {
  const [open, setOpen] = useState(true);
  const a = group.act;

  return (
    <div className="act-block">
      {a ? (
        <div className="act-block-header" onClick={() => setOpen((v) => !v)}>
          <span className="caret">{open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}</span>
          <span className="act-name">{a.name}</span>
          <span className="act-meta">
            {group.chapters.length} ch · {actWordCount(group).toLocaleString()}w
          </span>
          <button
            className="ghost-btn act-add"
            onClick={(e) => {
              e.stopPropagation();
              onAddChapter();
            }}
            title={`New chapter in ${a.name}`}
          >
            +
          </button>
        </div>
      ) : group.chapters.length > 0 ? (
        <div className="act-block-header unassigned">
          <span className="act-name">Unassigned</span>
          <span className="act-meta">
            {group.chapters.length} ch · {actWordCount(group).toLocaleString()}w
          </span>
          <button
            className="ghost-btn act-add"
            onClick={(e) => {
              e.stopPropagation();
              onAddChapter();
            }}
            title="New chapter (unassigned)"
          >
            +
          </button>
        </div>
      ) : null}

      {open && (
        <>
          <ul className="chapter-list">
            {group.chapters.map((c) => (
              <SortableChapterCard
                key={c.path}
                chapter={c}
                slug={slug}
                activePath={activePath}
                onSelect={onSelect}
                onTreeChanged={onTreeChanged}
              />
            ))}
          </ul>
          <ActDropzone
            actName={a?.name ?? null}
            isEmpty={group.chapters.length === 0}
          />
        </>
      )}
    </div>
  );
}

function ActDropzone({
  actName,
  isEmpty,
}: {
  actName: string | null;
  isEmpty: boolean;
}) {
  const id = actZoneId(actName);
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

function SceneDropzone({ chapterSlug }: { chapterSlug: string }) {
  const { active } = useDndContext();
  const isSceneDrag = active != null && String(active.id).endsWith('.md');
  const id = `scene-zone:${chapterSlug}`;
  const { setNodeRef, isOver } = useDroppable({ id, disabled: !isSceneDrag });
  if (!isSceneDrag) return null;
  return (
    <div
      ref={setNodeRef}
      className={`scene-dropzone${isOver ? ' over' : ''}`}
    >
      {isOver ? 'Drop scene here' : ''}
    </div>
  );
}

function SortableChapterCard(props: {
  chapter: ChapterEntry;
  slug: string;
  activePath: string | null;
  onSelect: (path: string) => void;
  onTreeChanged: () => void;
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: props.chapter.path });
  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.85 : 1,
    zIndex: isDragging ? 10 : undefined,
    boxShadow: isDragging ? 'var(--shadow-md)' : undefined,
    background: isDragging ? 'var(--surface-3)' : undefined,
    borderRadius: isDragging ? 4 : undefined,
    position: 'relative',
  };
  return (
    <ChapterCard
      {...props}
      sortable={{
        setNodeRef,
        style,
        attributes,
        listeners,
      }}
    />
  );
}

interface SortableProps {
  setNodeRef: (el: HTMLElement | null) => void;
  style: React.CSSProperties;
  attributes: DraggableAttributes;
  listeners: DraggableSyntheticListeners;
}

function ChapterCard({
  chapter,
  slug,
  activePath,
  onSelect,
  onTreeChanged,
  sortable,
}: {
  chapter: ChapterEntry;
  slug: string;
  activePath: string | null;
  onSelect: (path: string) => void;
  onTreeChanged: () => void;
  sortable?: SortableProps;
}) {
  const hasScenes = chapter.scenes.length > 0;
  const isActive =
    activePath === chapter.meta_path ||
    chapter.scenes.some((s) => s.path === activePath);
  const activeSceneInChapter = chapter.scenes.find((s) => s.path === activePath);
  const cardClickTarget =
    activeSceneInChapter?.path ??
    (chapter.scenes.length >= 1 ? chapter.scenes[0].path : chapter.meta_path);
  const [openOverride, setOpenOverride] = useState<boolean | null>(null);
  const open = openOverride !== null ? openOverride : isActive && hasScenes;

  const cardRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (isActive) {
      cardRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
  }, [isActive]);

  const handleAddScene = async (e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      const r = await syncEngine.createScene(slug, chapter.slug, {});
      onTreeChanged();
      onSelect(r.path);
    } catch (err) {
      alert(`Failed: ${err}`);
    }
  };

  const handleDeleteChapter = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (
      !window.confirm(
        `Delete ${chapter.title || chapter.slug} and all its scenes?`,
      )
    )
      return;
    try {
      await syncEngine.removeChapter(slug, chapter.slug);
      onTreeChanged();
    } catch (err) {
      alert(`Failed to delete: ${err}`);
    }
  };

  return (
    <li
      className="chapter-row"
      ref={sortable?.setNodeRef as React.Ref<HTMLLIElement>}
      style={sortable?.style}
    >
      <div
        ref={cardRef}
        className={`chapter-card${isActive ? ' active' : ''}`}
        onClick={() => onSelect(cardClickTarget)}
      >
        <span
          className="row-grip"
          title="Drag to reorder"
          {...(sortable?.attributes ?? {})}
          {...(sortable?.listeners ?? {})}
        >
          ⋮⋮
        </span>
        <div className="row-body">
          <div className="row-head">
            {hasScenes && (
              <button
                className="expand-toggle"
                onClick={(e) => {
                  e.stopPropagation();
                  setOpenOverride(!open);
                }}
                title={open ? 'Collapse scenes' : 'Expand scenes'}
              >
                {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
              </button>
            )}
            <span className="chapter-num">
              {chapter.kind === 'interlude'
                ? `i${chapter.interlude ?? '·'}`
                : (chapter.chapter ?? '·')}
            </span>
            <span className="chapter-title">
              {chapter.title || chapter.slug}
              {isOfflinePath(chapter.path) && (
                <span className="offline-badge" title="Awaiting sync">⟳</span>
              )}
            </span>
          </div>
          {chapter.summary && (
            <div className="row-summary">{chapter.summary}</div>
          )}
          <div className="row-meta">
            <span
              className={`status-dot ${aggregateStatus(chapter)}`}
              title={`Scene statuses (${aggregateStatus(chapter)})`}
            />
            <span>{chapter.word_count.toLocaleString()}w</span>
            {chapter.scenes.length > 0 && (
              <span>
                · {chapter.scenes.length} scene
                {chapter.scenes.length === 1 ? '' : 's'}
              </span>
            )}
            {aggregatePov(chapter) && <span>· {aggregatePov(chapter)}</span>}
          </div>
        </div>
        <div className="row-actions">
          <button
            className="ghost-btn"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation();
              onSelect(chapter.meta_path);
            }}
            title="Edit chapter metadata"
          >
            <Pencil size={14} />
          </button>
          <button
            className="ghost-btn"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={handleAddScene}
            title="Add scene"
          >
            +
          </button>
          <button
            className="ghost-btn danger"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={handleDeleteChapter}
            title="Delete chapter"
          >
            <X size={14} />
          </button>
        </div>
      </div>
      {hasScenes && open && (
        <SortableContext
          items={chapter.scenes.map((s) => s.path)}
          strategy={verticalListSortingStrategy}
        >
          <ul className="scene-list">
            {chapter.scenes.map((s) => (
              <SortableSceneRow
                key={s.path}
                scene={s}
                chapterIndex={chapter.chapter}
                slug={slug}
                activePath={activePath}
                onSelect={onSelect}
                onTreeChanged={onTreeChanged}
              />
            ))}
          </ul>
        </SortableContext>
      )}
      <SceneDropzone chapterSlug={chapter.slug} />
    </li>
  );
}

function SortableSceneRow(props: {
  scene: SceneEntry;
  chapterIndex: number | null;
  slug: string;
  activePath: string | null;
  onSelect: (path: string) => void;
  onTreeChanged: () => void;
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
    <li ref={setNodeRef} style={style}>
      <div
        className={`scene-card${props.scene.path === props.activePath ? ' active' : ''}`}
        onClick={() => props.onSelect(props.scene.path)}
      >
        <div className="row-head">
          <span className="row-grip scene-grip" {...attributes} {...listeners}>⋮</span>
          <span className="chapter-num">
            {props.chapterIndex != null && props.scene.scene != null
              ? `${props.chapterIndex}.${props.scene.scene}`
              : (props.scene.scene ?? '·')}
          </span>
          <span className="chapter-title">{props.scene.title || `Scene ${props.scene.scene ?? ''}`}</span>
        </div>
        <div className="row-meta" style={{ paddingLeft: '2.5em' }}>
          <span className={`status-dot ${props.scene.status || 'draft'}`} />
          <span>{props.scene.word_count.toLocaleString()}w</span>
          {props.scene.pov && <span>· {props.scene.pov}</span>}
        </div>
      </div>
      <div className="row-actions">
        <button
          className="ghost-btn danger"
          onClick={async (e) => {
            e.stopPropagation();
            if (!confirm(`Delete scene ${props.scene.scene}?`)) return;
            await deleteFile(props.slug, props.scene.path);
            await syncEngine.getTree(props.slug, true);
            props.onTreeChanged();
          }}
        >
          <X size={14} />
        </button>
      </div>
    </li>
  );
}

function RefList({
  items,
  slug,
  activePath,
  onSelect,
  onTreeChanged,
  storageKey,
}: {
  items: ReferenceEntry[];
  slug: string;
  activePath: string | null;
  onSelect: (path: string) => void;
  onTreeChanged: () => void;
  storageKey: string;
}) {
  const refSensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
  );

  const allTags = useMemo(() => {
    const set = new Set<string>();
    for (const r of items) for (const t of r.tags) set.add(t);
    return [...set].sort();
  }, [items]);

  const [tagFilter, setTagFilter] = useState<string>(
    () => localStorage.getItem(storageKey) || 'all',
  );
  const updateFilter = (next: string) => {
    setTagFilter(next);
    if (next === 'all') localStorage.removeItem(storageKey);
    else localStorage.setItem(storageKey, next);
  };

  const filtered =
    tagFilter === 'all'
      ? items
      : items.filter((r) => r.tags.includes(tagFilter));

  const handleRefDragEnd = async (e: DragEndEvent) => {
    if (!e.over) return;
    const activeId = String(e.active.id);
    const overId = String(e.over.id);
    if (activeId === overId) return;
    const oldIdx = filtered.findIndex((r) => r.path === activeId);
    const newIdx = filtered.findIndex((r) => r.path === overId);
    if (oldIdx === -1 || newIdx === -1) return;
    const reordered = arrayMove(filtered, oldIdx, newIdx);
    try {
      await syncEngine.reorderItems(slug, reordered.map((r, i) => ({ path: r.path, order: i + 1 })));
      onTreeChanged();
    } catch (err) {
      console.error('Ref reorder failed', err);
    }
  };

  return (
    <>
      {allTags.length > 0 && (
        <div className="ref-tag-filter">
          <select
            value={tagFilter}
            onChange={(e) => updateFilter(e.target.value)}
          >
            <option value="all">all tags</option>
            {allTags.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </div>
      )}
      {filtered.length === 0 ? (
        <p className="empty-list">— none —</p>
      ) : (
        <DndContext
          sensors={refSensors}
          collisionDetection={closestCenter}
          onDragEnd={handleRefDragEnd}
        >
          <SortableContext
            items={filtered.map((r) => r.path)}
            strategy={verticalListSortingStrategy}
          >
            <ul className="ref-list">
              {filtered.map((r) => (
                <SortableRefRow
                  key={r.path}
                  item={r}
                  slug={slug}
                  activePath={activePath}
                  onSelect={onSelect}
                  onTreeChanged={onTreeChanged}
                />
              ))}
            </ul>
          </SortableContext>
        </DndContext>
      )}
    </>
  );
}

function SortableRefRow(props: {
  item: ReferenceEntry;
  slug: string;
  activePath: string | null;
  onSelect: (path: string) => void;
  onTreeChanged: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id: props.item.path });
  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition: transition ?? undefined,
    opacity: isDragging ? 0.5 : undefined,
    position: 'relative' as const,
  };
  return (
    <RefRow
      {...props}
      sortable={{ setNodeRef, style, attributes, listeners }}
    />
  );
}

function RefRow({
  item,
  slug,
  activePath,
  onSelect,
  onTreeChanged,
  sortable,
}: {
  item: ReferenceEntry;
  slug: string;
  activePath: string | null;
  onSelect: (path: string) => void;
  onTreeChanged: () => void;
  sortable?: SortableProps;
}) {
  const handleDelete = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!window.confirm(`Delete ${item.title || item.path}?`)) return;
    try {
      await deleteFile(slug, item.path);
      onTreeChanged();
    } catch (err) {
      alert(`Failed: ${err}`);
    }
  };

  return (
    <li
      ref={sortable?.setNodeRef as React.Ref<HTMLLIElement>}
      style={sortable?.style}
      className={`ref-row${item.path === activePath ? ' active' : ''}`}
      onClick={() => onSelect(item.path)}
    >
      <span
        className="row-grip"
        title="Drag to reorder"
        {...(sortable?.attributes ?? {})}
        {...(sortable?.listeners ?? {})}
      >
        ⋮⋮
      </span>
      <span className="ref-title">
        {item.title || item.path.split('/').pop()}
      </span>
      {item.tags.length > 0 && (
        <span className="ref-tags">
          {item.tags.map((t) => (
            <span key={t} className="ref-tag">
              {t}
            </span>
          ))}
        </span>
      )}
      {item.aliases.length > 0 && (
        <span className="ref-aliases">{item.aliases.join(', ')}</span>
      )}
      <div className="row-actions">
        <button
          className="ghost-btn danger"
          onClick={handleDelete}
          title="Delete"
        >
          <X size={14} />
        </button>
      </div>
    </li>
  );
}
