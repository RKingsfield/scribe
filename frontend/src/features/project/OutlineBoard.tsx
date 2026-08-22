import { useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import {
  DndContext,
  DragEndEvent,
  PointerSensor,
  closestCenter,
  useDroppable,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import { SortableContext, rectSortingStrategy } from '@dnd-kit/sortable';
import { ProjectTree } from '../../lib/api';
import { syncEngine } from '../../lib/syncEngine';
import { resolveSceneMove } from '../../lib/sceneDrag';
import {
  OUTLINE_ACT_ZONE_PREFIX,
  actZoneId,
  groupChaptersByAct,
  resolveChapterReorder,
} from '../../lib/chapterDrag';
import { toast } from '../../app/Toast';
import { SortableOutlineCard } from './OutlineCard';

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
  const helperModel = localStorage.getItem('scribe.rewrite.model') || undefined;
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
      } catch (err) {
        toast(`Scene move failed: ${err}`, 'error');
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
    } catch (err) {
      toast(`Reorder failed: ${err}`, 'error');
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
                        helperModel={helperModel}
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
