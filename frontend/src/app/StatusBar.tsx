import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { relativeTime } from '../lib/format';
import { syncEngine, SyncSnapshot } from '../lib/syncEngine';

interface Props {
  slug: string;
  projectTitle: string;
  activePath: string | null;
  activeTitle: string | null;
  liveWordCount: number;
  saveState: 'clean' | 'dirty' | 'saving' | 'saved' | 'error' | 'blocked';
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
  const activeStructureOps = snap.structureOpsCount - snap.stuckOpsCount;
  const activePending = snap.pendingCount - snap.stuckPendingCount;
  const stuckCount = snap.stuckOpsCount + snap.stuckPendingCount;
  const syncBadge = (() => {
    if (snap.status === 'conflict')
      return { className: 'sb-status conflict', label: `${snap.conflictCount} conflict${snap.conflictCount === 1 ? '' : 's'}` };
    if (snap.status === 'offline') {
      const parts: string[] = ['offline'];
      if (activePending > 0) parts.push(`${activePending} edits`);
      if (activeStructureOps > 0) parts.push(`${activeStructureOps} creates`);
      if (stuckCount > 0) parts.push(`${stuckCount} stuck`);
      return { className: 'sb-status offline', label: parts.join(' · ') };
    }
    if (snap.status === 'syncing') {
      const parts: string[] = [activePending > 0 ? `syncing ${activePending}` : 'syncing'];
      if (stuckCount > 0) parts.push(`${stuckCount} stuck`);
      return { className: 'sb-status saving', label: parts.join(' · ') };
    }
    if (stuckCount > 0)
      return { className: 'sb-status offline', label: `${stuckCount} stuck` };
    if (snap.lastFlushAt) {
      const ago = relativeTime(snap.lastFlushAt);
      return { className: 'sb-status ok', label: `synced ${ago}` };
    }
    return { className: 'sb-status ok', label: 'synced' };
  })();

  const saveBadge = (() => {
    if (saveState === 'blocked') return { className: 'sb-status offline', label: 'conflict — resolve to save' };
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

