import { useEffect, useState } from 'react';
import { db, type PendingWrite, type StructureOp } from '../../lib/db';
import { syncEngine } from '../../lib/syncEngine';

interface Props {
  slug: string;
}

const CREATE_OPS = new Set(['new-chapter', 'new-scene', 'new-category-entry']);

interface StuckItem {
  key: string;
  kind: string;
  target: string;
  lastError?: string;
  discardWarning: string;
  discard: () => Promise<void>;
}

function targetOf(op: StructureOp): string {
  switch (op.op) {
    case 'new-chapter':
      return op.payload.title ?? op.payload.slug ?? 'new chapter';
    case 'new-scene':
      return op.payload.chapterSlug;
    case 'new-category-entry':
      return op.payload.folder;
    case 'delete-chapter':
      return op.payload.chapterSlug;
    case 'delete-scene':
    case 'delete-category-entry':
      return op.payload.path;
    case 'reorder':
      return `${op.payload.items.length} item${op.payload.items.length === 1 ? '' : 's'}`;
    case 'move-scene':
      return op.payload.srcPath;
  }
}

function opItem(op: StructureOp): StuckItem {
  const target = targetOf(op);
  return {
    key: `op-${op.id}`,
    kind: op.op,
    target,
    lastError: op.lastError,
    discardWarning: CREATE_OPS.has(op.op)
      ? `Discard queued ${op.op} for "${target}"? The offline-typed content will be orphaned — it never reaches the server.`
      : `Discard queued ${op.op} for "${target}"? This cannot be replayed later.`,
    discard: () => db.structureOps.delete(op.id!),
  };
}

function writeItem(write: PendingWrite): StuckItem {
  return {
    key: `write-${write.id}`,
    kind: 'file write',
    target: write.path,
    lastError: write.lastError,
    discardWarning:
      `Discard the queued edit to "${write.path}"? The queued text is never sent — the file falls back to the server copy on its next refresh.`,
    discard: () => db.pending.delete(write.id!),
  };
}

export function StuckOpsBanner({ slug }: Props) {
  const [items, setItems] = useState<StuckItem[]>([]);

  const refresh = async () => {
    const ops = await db.structureOps.where('slug').equals(slug).toArray();
    const writes = await db.pending.filter(p => p.slug === slug && !!p.stuckAt).toArray();
    setItems([
      ...ops.filter(op => !!op.stuckAt).map(opItem),
      ...writes.map(writeItem),
    ]);
  };

  useEffect(() => {
    refresh();
    return syncEngine.subscribe(() => refresh());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug]);

  if (items.length === 0) return null;

  const retryAll = async () => {
    await syncEngine.retryStuck(slug);
    await refresh();
  };

  const discard = async (item: StuckItem) => {
    if (!window.confirm(item.discardWarning)) return;
    await item.discard();
    await syncEngine.refreshCounts();
    await refresh();
  };

  return (
    <div className="stuck-ops-banner">
      <span>
        ⚠ {items.length} stuck operation{items.length === 1 ? '' : 's'} —
        offline changes that failed to replay
      </span>
      <button onClick={retryAll}>Retry all</button>
      <ul className="stuck-ops-list">
        {items.map((item) => (
          <li key={item.key}>
            <span className="stuck-op-kind">{item.kind}</span>
            <span className="stuck-op-target">{item.target}</span>
            {item.lastError && <span className="stuck-op-error">{item.lastError}</span>}
            <button onClick={() => discard(item)}>Discard</button>
          </li>
        ))}
      </ul>
    </div>
  );
}
