import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { syncEngine, SyncSnapshot } from '../lib/syncEngine';

interface Props {
  slug: string;
  projectTitle: string;
  activePath: string | null;
  activeTitle: string | null;
  liveWordCount: number;
  saveState: 'clean' | 'dirty' | 'saving' | 'saved' | 'error';
  onOpenPalette: () => void;
}

export function StatusBar({
  slug,
  projectTitle,
  activePath,
  activeTitle,
  liveWordCount,
  saveState,
  onOpenPalette,
}: Props) {
  const [snap, setSnap] = useState<SyncSnapshot>(syncEngine.getSnapshot());
  useEffect(() => syncEngine.subscribe(setSnap), []);
  const navigate = useNavigate();
  const syncBadge = (() => {
    if (snap.status === 'conflict')
      return { className: 'sb-status conflict', label: `${snap.conflictCount} conflict${snap.conflictCount === 1 ? '' : 's'}` };
    if (snap.status === 'offline') {
      const parts: string[] = ['offline'];
      if (snap.pendingCount > 0) parts.push(`${snap.pendingCount} edits`);
      if (snap.structureOpsCount > 0) parts.push(`${snap.structureOpsCount} creates`);
      return { className: 'sb-status offline', label: parts.join(' · ') };
    }
    if (snap.status === 'syncing')
      return { className: 'sb-status saving', label: snap.pendingCount > 0 ? `syncing ${snap.pendingCount}` : 'syncing' };
    if (snap.lastFlushAt) {
      const ago = relativeTime(snap.lastFlushAt);
      return { className: 'sb-status ok', label: `synced ${ago}` };
    }
    return { className: 'sb-status ok', label: 'synced' };
  })();

  const saveBadge = (() => {
    if (saveState === 'error') return { className: 'sb-status offline', label: 'save failed' };
    if (saveState === 'saving') return { className: 'sb-status saving', label: 'saving…' };
    if (saveState === 'dirty') return { className: 'sb-status dirty', label: '● unsaved' };
    if (saveState === 'saved') return { className: 'sb-status ok', label: 'saved' };
    return null;
  })();

  return (
    <footer className="statusbar">
      <span className="sb-section">
        <button onClick={() => navigate(`/p/${encodeURIComponent(slug)}/write`)} title="Project">
          {projectTitle}
        </button>
      </span>
      {activeTitle && (
        <>
          <span className="sb-divider">·</span>
          <span className="sb-section">
            <span className="sb-tag">{activeTitle}</span>
          </span>
        </>
      )}
      {activePath && (
        <>
          <span className="sb-divider">·</span>
          <span className="sb-section">
            {liveWordCount.toLocaleString()} words
          </span>
        </>
      )}
      <span className="sb-spacer" />
      {saveBadge && (
        <span className={saveBadge.className}>{saveBadge.label}</span>
      )}
      <span className={syncBadge.className}>{syncBadge.label}</span>
      <span className="sb-divider">·</span>
      <button className="kbd-row" onClick={onOpenPalette} title="Open command palette (Ctrl/Cmd+K)">
        <kbd>⌘K</kbd>
      </button>
    </footer>
  );
}

function relativeTime(ts: number): string {
  const diff = Math.floor((Date.now() - ts) / 1000);
  if (diff < 60) return 'just now';
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}
