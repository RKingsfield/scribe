import { useEffect, useState } from 'react';
import {
  DndContext,
  DragEndEvent,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import {
  SortableContext,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import {
  CategoryData,
  ChapterEntry,
  ProjectTree,
  SceneEntry,
} from '../../lib/api';
import { syncEngine } from '../../lib/syncEngine';
import { resolveSceneMove } from '../../lib/sceneDrag';
import {
  SIDEBAR_ACT_ZONE_PREFIX,
  groupChaptersByAct,
  resolveChapterReorder,
} from '../../lib/chapterDrag';
import { toast } from '../../app/Toast';
import { ActBlock } from './ChapterCard';
import { RefList } from './RefList';

interface Props {
  tree: ProjectTree;
  slug: string;
  activePath: string | null;
  onSelect: (path: string) => void;
  onTreeChanged: () => void;
  onEditActs?: () => void;
  onEditCategories?: () => void;
}


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

  const groups = groupChaptersByAct(tree, effectiveChapters, {
    alwaysIncludeUnassigned: true,
  });

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
        toast(`Reorder failed: ${err}`, 'error');
        setSceneOverrides({});
      }
      return;
    }

    const result = resolveChapterReorder(tree, orderedChapters, activeId, overId, {
      actZonePrefix: SIDEBAR_ACT_ZONE_PREFIX,
      groupOpts: { alwaysIncludeUnassigned: true },
    });
    if (!result) return;

    setOrderedPaths(result.chapters.map((c) => c.path));

    try {
      await syncEngine.reorderItems(slug, result.payload);
      onTreeChanged();
      setOrderedPaths(null);
    } catch (err) {
      toast(`Reorder failed: ${err}`, 'error');
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
      toast(`Failed to create ${kind}: ${e}`, 'error');
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
      toast(`Failed: ${e}`, 'error');
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
