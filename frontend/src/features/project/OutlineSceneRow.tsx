import React, { useState } from 'react';
import { Sparkles, X } from 'lucide-react';
import {
  DraggableAttributes,
  DraggableSyntheticListeners,
  useDroppable,
} from '@dnd-kit/core';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { SceneEntry, summarizeFile } from '../../lib/api';
import { syncEngine } from '../../lib/syncEngine';
import { toast } from '../../app/Toast';

function warnIfBlocked(result: 'queued' | 'blocked'): boolean {
  if (result === 'blocked') {
    toast('Blocked by conflict — resolve it first', 'error');
    return true;
  }
  return false;
}

export function OutlineSceneDropzone({ chapterSlug }: { chapterSlug: string }) {
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

export function SortableSceneRow(props: {
  scene: SceneEntry;
  chapterIndex: number | string | null;
  slug: string;
  onTreeChanged: () => void;
  onOpenFile: (path: string) => void;
  helperModel: string | undefined;
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
  helperModel,
  sortable,
}: {
  scene: SceneEntry;
  chapterIndex: number | string | null;
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
      const result = await syncEngine.saveFile(slug, scene.path, f.body, fm, f.etag);
      if (warnIfBlocked(result)) return;
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
  const generate = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (scene.word_count === 0) {
      toast('No scene content yet — write something first.', 'info');
      return;
    }
    setGenerating(true);
    try {
      // Make sure on-disk body is the one the LLM sees.
      await syncEngine.flush();
      const { summary: next } = await summarizeFile(
        slug,
        scene.path,
        helperModel,
      );
      const f = await syncEngine.getFile(slug, scene.path);
      const result = await syncEngine.saveFile(slug, scene.path, f.body, { ...f.frontmatter, summary: next }, f.etag);
      if (warnIfBlocked(result)) return;
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
      const result = await syncEngine.saveFile(slug, scene.path, f.body, { ...f.frontmatter, summary: next }, f.etag);
      if (warnIfBlocked(result)) return;
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
            className="oc-scene-pov pov-tag"
            onClick={startEditPov}
            title="Scene POV (click to edit)"
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
