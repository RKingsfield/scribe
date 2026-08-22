import React from 'react';
import {
  useDraggable,
  useDroppable,
} from '@dnd-kit/core';
import type { ChapterEntry, ProjectTree, SceneEntry } from '../../lib/api';
import { onActivate } from '../../lib/a11y';

export type Status = 'draft' | 'revision' | 'final';
const STATUSES: { id: Status; label: string; color: string }[] = [
  { id: 'draft', label: 'Draft', color: 'var(--fg-mid)' },
  { id: 'revision', label: 'Revision', color: 'var(--warn)' },
  { id: 'final', label: 'Final', color: 'var(--success)' },
];

export interface SceneCardData {
  scene: SceneEntry;
  chapter: ChapterEntry;
}

export function flattenScenes(tree: ProjectTree): SceneCardData[] {
  const out: SceneCardData[] = [];
  for (const c of tree.chapters) {
    for (const s of c.scenes) out.push({ scene: s, chapter: c });
  }
  return out;
}

export function sceneInAct(
  card: SceneCardData,
  _tree: ProjectTree,
  filter: string,
): boolean {
  if (filter === 'all') return true;
  const c = card.chapter;
  if (filter === '__unassigned') return !c.act;
  return c.act === filter;
}

function chapterGroupLabel(c: ChapterEntry): string {
  return c.kind === 'interlude'
    ? `Interlude ${c.interlude ?? '·'} — ${c.title || c.slug}`
    : `Ch. ${c.chapter ?? '·'} — ${c.title || c.slug}`;
}

export function StatusBoard({
  sceneGrouped,
  onOpenFile,
  onNewScene,
}: {
  sceneGrouped: Record<Status, SceneCardData[]>;
  onOpenFile: (path: string) => void;
  onNewScene: (status: Status) => void;
}) {
  return (
    <div className="corkboard">
      {STATUSES.map((s) => (
        <SceneSwimlane
          key={s.id}
          status={s.id}
          label={s.label}
          color={s.color}
          cards={sceneGrouped[s.id]}
          onOpenFile={onOpenFile}
          onNewScene={() => onNewScene(s.id)}
        />
      ))}
    </div>
  );
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
  const pov = scene.pov ?? null;
  const pin = chapterGroupLabel(chapter);

  return (
    <article
      ref={setNodeRef}
      className="index-card"
      style={style}
      {...attributes}
      {...listeners}
      onClick={() => onOpenFile(scene.path)}
      onKeyDown={onActivate(() => onOpenFile(scene.path))}
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
