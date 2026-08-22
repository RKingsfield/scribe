import React, { useState } from 'react';
import { ChevronDown, ChevronRight, X } from 'lucide-react';
import { DraggableAttributes, DraggableSyntheticListeners } from '@dnd-kit/core';
import {
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { ChapterEntry } from '../../lib/api';
import { syncEngine } from '../../lib/syncEngine';
import { toast } from '../../app/Toast';
import { OutlineSceneDropzone, SortableSceneRow } from './OutlineSceneRow';
import { onActivate } from '../../lib/a11y';

export function SortableOutlineCard(props: {
  chapter: ChapterEntry;
  slug: string;
  onTreeChanged: () => void;
  onOpenFile: (path: string) => void;
  helperModel: string | undefined;
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
  helperModel,
  sortable,
}: {
  chapter: ChapterEntry;
  slug: string;
  onTreeChanged: () => void;
  onOpenFile: (path: string) => void;
  helperModel: string | undefined;
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

  const handleHeaderActivate = () => {
    if (cardOpen) {
      onOpenFile(
        chapter.scenes.length > 0 ? chapter.scenes[0].path : chapter.meta_path,
      );
    } else {
      setCardOpen(true);
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
          if (!cardOpen) e.stopPropagation();
          handleHeaderActivate();
        }}
        role="button"
        tabIndex={0}
        onKeyDown={onActivate(handleHeaderActivate)}
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
                helperModel={helperModel}
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
