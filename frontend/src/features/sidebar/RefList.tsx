import { useMemo, useState } from 'react';
import { X } from 'lucide-react';
import {
  DndContext,
  DragEndEvent,
  DraggableAttributes,
  DraggableSyntheticListeners,
  PointerSensor,
  closestCenter,
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
import { ReferenceEntry } from '../../lib/api';
import { syncEngine } from '../../lib/syncEngine';
import { toast } from '../../app/Toast';
import { onActivate } from '../../lib/a11y';

interface SortableProps {
  setNodeRef: (el: HTMLElement | null) => void;
  style: React.CSSProperties;
  attributes: DraggableAttributes;
  listeners: DraggableSyntheticListeners;
  disabled: boolean;
}

export function RefList({
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
  // Reordering a filtered subset can't map cleanly back onto the full list's order — disable instead.
  const dragDisabled = tagFilter !== 'all';

  const handleRefDragEnd = async (e: DragEndEvent) => {
    if (dragDisabled || !e.over) return;
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
      toast(`Reorder failed: ${err}`, 'error');
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
                  dragDisabled={dragDisabled}
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
  dragDisabled: boolean;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id: props.item.path, disabled: props.dragDisabled });
  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition: transition ?? undefined,
    opacity: isDragging ? 0.5 : undefined,
    position: 'relative' as const,
  };
  return (
    <RefRow
      {...props}
      sortable={{ setNodeRef, style, attributes, listeners, disabled: props.dragDisabled }}
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
      await syncEngine.deleteCategoryEntry(slug, item.path);
      onTreeChanged();
    } catch (err) {
      toast(`Failed: ${err}`, 'error');
    }
  };

  return (
    <li
      ref={sortable?.setNodeRef as React.Ref<HTMLLIElement>}
      style={sortable?.style}
      className={`ref-row${item.path === activePath ? ' active' : ''}`}
      onClick={() => onSelect(item.path)}
      role="button"
      tabIndex={0}
      onKeyDown={onActivate(() => onSelect(item.path))}
    >
      <span
        className="row-grip"
        title={sortable?.disabled ? 'Clear filter to reorder' : 'Drag to reorder'}
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
