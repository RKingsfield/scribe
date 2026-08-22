import { useEffect, useRef, useState } from 'react';
import { ChevronDown, ChevronRight, Pencil, X } from 'lucide-react';
import {
  DraggableAttributes,
  DraggableSyntheticListeners,
  useDndContext,
  useDroppable,
} from '@dnd-kit/core';
import {
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { ChapterEntry, SceneEntry } from '../../lib/api';
import { syncEngine } from '../../lib/syncEngine';
import { isOfflinePath } from '../../lib/offlineTree';
import { ActGroup, SIDEBAR_ACT_ZONE_PREFIX, actZoneId, statusClass } from '../../lib/chapterDrag';
import { toast } from '../../app/Toast';
import { onActivate } from '../../lib/a11y';

const actWordCount = (g: ActGroup) =>
  g.chapters.reduce((acc, c) => acc + c.word_count, 0);

const aggregateStatus = (chapter: ChapterEntry): string => {
  const scenes = chapter.scenes;
  if (scenes.length === 0) return 'draft';
  const set = new Set(scenes.map((s) => statusClass(s.status)));
  if (set.size === 1) return [...set][0];
  return 'mixed';
};

const aggregatePov = (chapter: ChapterEntry): string => {
  const seen: string[] = [];
  for (const s of chapter.scenes) {
    const p = s.pov;
    if (p && !seen.includes(p)) seen.push(p);
  }
  if (seen.length === 0) return '';
  if (seen.length === 1) return seen[0];
  if (seen.length === 2) return `${seen[0]} + ${seen[1]}`;
  return `${seen[0]} + ${seen.length - 1} more`;
};

interface SortableProps {
  setNodeRef: (el: HTMLElement | null) => void;
  style: React.CSSProperties;
  attributes: DraggableAttributes;
  listeners: DraggableSyntheticListeners;
}

export function ActBlock({
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
  const id = actZoneId(SIDEBAR_ACT_ZONE_PREFIX, actName);
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
  const pov = aggregatePov(chapter);
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
      toast(`Failed: ${err}`, 'error');
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
      toast(`Failed to delete: ${err}`, 'error');
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
        role="button"
        tabIndex={0}
        onKeyDown={onActivate(() => onSelect(cardClickTarget))}
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
            {pov && <span>· {pov}</span>}
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
        role="button"
        tabIndex={0}
        onKeyDown={onActivate(() => props.onSelect(props.scene.path))}
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
          <span className={`status-dot ${statusClass(props.scene.status)}`} />
          <span>{props.scene.word_count.toLocaleString()}w</span>
          {props.scene.pov && <span>· {props.scene.pov}</span>}
        </div>
      </div>
      <div className="row-actions">
        <button
          className="ghost-btn danger"
          onClick={async (e) => {
            e.stopPropagation();
            if (!window.confirm(`Delete scene ${props.scene.scene}?`)) return;
            try {
              await syncEngine.deleteScene(props.slug, props.scene.path);
              props.onTreeChanged();
            } catch (err) {
              toast(`Failed to delete: ${err}`, 'error');
            }
          }}
        >
          <X size={14} />
        </button>
      </div>
    </li>
  );
}
