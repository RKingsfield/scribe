import { useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { X, ArrowLeft, ChevronLeft, ChevronRight, Check } from 'lucide-react';
import {
  ServerConflictEntry,
  discardServerConflict,
  getFile,
  listServerConflicts,
  putFile,
} from '../../lib/api';
import { db, fileKey } from '../../lib/db';
import { FLUSH_INTERVAL_MS, syncEngine } from '../../lib/syncEngine';
import { GetEditorBuffer } from '../../lib/useFileEditor';
import {
  ThreeWaySource,
  ThreeWayZone,
  assembleThreeWayBody,
  buildMergeZones,
  buildThreeWayZones,
  diffWords,
  mergeThreeWayFrontmatter,
  threeWayFmDiffKeys,
} from '../../lib/diff';

interface Props {
  slug: string;
  getEditorBuffer?: GetEditorBuffer | null;
}

export function ConflictsBanner({ slug, getEditorBuffer = null }: Props) {
  const [conflicts, setConflicts] = useState<ServerConflictEntry[]>([]);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState<ServerConflictEntry | null>(null);
  const prevStatus = useRef<string | null>(null);

  const refresh = async () => {
    try {
      const list = await listServerConflicts(slug);
      setConflicts(list);
    } catch {
      // Offline; keep last value.
    }
  };

  useEffect(() => {
    refresh();
    const id = window.setInterval(refresh, FLUSH_INTERVAL_MS);
    return () => window.clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug]);

  useEffect(
    () =>
      syncEngine.subscribe((snapshot) => {
        const prev = prevStatus.current;
        prevStatus.current = snapshot.status;
        if (prev === 'syncing' && (snapshot.status === 'idle' || snapshot.status === 'conflict')) {
          refresh();
        }
      }),
    [slug], // eslint-disable-line react-hooks/exhaustive-deps
  );

  if (conflicts.length === 0 && !open) return null;

  return (
    <>
      {conflicts.length > 0 && (
        <div className="conflicts-banner">
          <span>
            ⚠ {conflicts.length} conflict{conflicts.length === 1 ? '' : 's'} —
            edits made offline diverged from the server
          </span>
          <button onClick={() => setOpen(true)}>Resolve</button>
        </div>
      )}
      {open && (
        <ConflictsModal
          slug={slug}
          getEditorBuffer={getEditorBuffer}
          conflicts={conflicts}
          active={active}
          setActive={setActive}
          onClose={() => {
            setOpen(false);
            setActive(null);
            refresh();
          }}
          onResolved={refresh}
        />
      )}
    </>
  );
}

function ConflictsModal(props: {
  slug: string;
  getEditorBuffer: GetEditorBuffer | null;
  conflicts: ServerConflictEntry[];
  active: ServerConflictEntry | null;
  setActive: (c: ServerConflictEntry | null) => void;
  onClose: () => void;
  onResolved: () => void;
}) {
  const { slug, getEditorBuffer, conflicts, active, setActive, onClose, onResolved } = props;
  const [canonicalBody, setCanonicalBody] = useState('');
  const [canonicalEtag, setCanonicalEtag] = useState('');
  const [canonicalFm, setCanonicalFm] = useState<Record<string, unknown>>({});
  const [conflictBody, setConflictBody] = useState('');
  const [conflictFm, setConflictFm] = useState<Record<string, unknown>>({});
  // The editor buffer is snapshotted once, when a conflict is activated below;
  // keystrokes typed while the modal is open are not re-snapshotted.
  const [editorSnap, setEditorSnap] = useState<{
    body: string;
    frontmatter: Record<string, unknown>;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const [picks, setPicks] = useState<Record<number, ThreeWaySource>>({});
  const [fmPicks, setFmPicks] = useState<Record<string, ThreeWaySource>>({});
  const [navIdx, setNavIdx] = useState(-1);
  const leftRef = useRef<HTMLDivElement>(null);
  const rightRef = useRef<HTMLDivElement>(null);
  const editorColRef = useRef<HTMLDivElement>(null);

  // Read the latest lookup inside the activation effect without re-snapshotting
  // on every parent re-render.
  const getEditorBufferRef = useRef(getEditorBuffer);
  getEditorBufferRef.current = getEditorBuffer;

  const editorActive = editorSnap !== null;

  const zones = useMemo<ThreeWayZone[]>(() => {
    if (editorSnap) {
      return buildThreeWayZones(canonicalBody, conflictBody, editorSnap.body);
    }
    if (!canonicalBody && !conflictBody) return [];
    return buildMergeZones(diffWords(canonicalBody, conflictBody)).map((z) => ({
      ...z,
      editorText: '',
    }));
  }, [canonicalBody, conflictBody, editorSnap]);

  const { changeIndices, changeIdxByZone } = useMemo(() => {
    const indices: number[] = [];
    const byZone = new Map<number, number>();
    zones.forEach((z, i) => {
      if (z.type === 'change') {
        byZone.set(i, indices.length);
        indices.push(i);
      }
    });
    return { changeIndices: indices, changeIdxByZone: byZone };
  }, [zones]);

  const fmDiffKeys = useMemo(() => {
    if (editorSnap) {
      return threeWayFmDiffKeys(canonicalFm, conflictFm, editorSnap.frontmatter);
    }
    const allKeys = new Set([
      ...Object.keys(canonicalFm),
      ...Object.keys(conflictFm),
    ]);
    return [...allKeys]
      .filter(
        (k) =>
          JSON.stringify(canonicalFm[k]) !== JSON.stringify(conflictFm[k]),
      )
      .sort();
  }, [canonicalFm, conflictFm, editorSnap]);

  useEffect(() => {
    if (!active) return;
    setErr(null);
    setPicks({});
    setFmPicks({});
    setNavIdx(-1);
    setCanonicalBody('');
    setCanonicalEtag('');
    setCanonicalFm({});
    setConflictBody('');
    setConflictFm({});
    const lookup = getEditorBufferRef.current;
    setEditorSnap(lookup ? lookup(active.canonical_path) : null);
    let cancelled = false;
    Promise.all([
      getFile(slug, active.canonical_path),
      getFile(slug, active.path),
    ])
      .then(([can, conf]) => {
        if (cancelled) return;
        setCanonicalBody(can.body);
        setCanonicalEtag(can.etag);
        setCanonicalFm(can.frontmatter);
        setConflictBody(conf.body);
        setConflictFm(conf.frontmatter);
      })
      .catch((e) => {
        if (!cancelled) setErr(String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [slug, active]);

  // If a queued move-scene replays while the modal is open, rekeyLocalPath
  // moves the conflict marker to a new path. The activated paths would then be
  // stale — resolving would PUT to the old path and orphan the rekeyed marker.
  // Drop back to the list and refresh; losing in-progress picks in this exotic
  // race is acceptable.
  useEffect(() => {
    if (!active) return;
    return syncEngine.onPathRemap((oldPath) => {
      if (oldPath === active.canonical_path || oldPath === active.path) {
        setActive(null);
        onResolved();
      }
    });
  }, [active, setActive, onResolved]);

  useEffect(() => {
    if (navIdx < 0) return;
    for (const ref of [leftRef, rightRef, editorColRef]) {
      const el = ref.current?.querySelector(`[data-change="${navIdx}"]`);
      el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }, [navIdx]);

  // Keep server / Use conflict discard the editor buffer, so confirm before
  // they run while the Editor column is shown. Apply merge and Keep my edits
  // are the explicit choice — they never confirm.
  const confirmDiscardBuffer = () =>
    !editorActive ||
    window.confirm(
      'Your unsaved editor edits will be discarded. Resolve anyway?',
    );

  const dropLocalMarker = async () => {
    if (!active) return;
    await syncEngine.dismissConflict(fileKey(slug, active.path));
    await db.cache.delete(fileKey(slug, active.path));
  };

  const keepCanonical = async () => {
    if (!active) return;
    if (!confirmDiscardBuffer()) return;
    setBusy(true);
    try {
      await discardServerConflict(slug, active.path);
      await dropLocalMarker();
      setActive(null);
      onResolved();
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  };

  const writeAndResolve = async (
    body: string,
    fm: Record<string, unknown>,
  ) => {
    if (!active) return;
    setBusy(true);
    try {
      const result = await putFile(
        slug,
        active.canonical_path,
        { body, frontmatter: fm },
        canonicalEtag,
      );
      await db.cache.put({
        key: fileKey(slug, active.canonical_path),
        slug,
        path: active.canonical_path,
        body: result.body,
        frontmatter: result.frontmatter,
        serverEtag: result.etag,
        cachedAt: Date.now(),
      });
      await discardServerConflict(slug, active.path);
      await dropLocalMarker();
      setActive(null);
      onResolved();
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  };

  const keepConflict = () => {
    if (!confirmDiscardBuffer()) return;
    return writeAndResolve(conflictBody, conflictFm);
  };

  const keepMyEdits = () => {
    if (!editorSnap) return;
    return writeAndResolve(editorSnap.body, editorSnap.frontmatter);
  };

  const applyMerge = () => {
    const mergedBody = assembleThreeWayBody(zones, picks);
    const mergedFm = mergeThreeWayFrontmatter(
      canonicalFm,
      conflictFm,
      editorSnap?.frontmatter ?? {},
      fmDiffKeys,
      fmPicks,
    );
    return writeAndResolve(mergedBody, mergedFm);
  };

  const pickZone = (zoneIdx: number, choice: ThreeWaySource) =>
    setPicks((prev) => ({ ...prev, [zoneIdx]: choice }));

  const pickFm = (field: string, choice: ThreeWaySource) =>
    setFmPicks((prev) => ({ ...prev, [field]: choice }));

  const navPrev = () => {
    if (changeIndices.length === 0) return;
    setNavIdx((prev) =>
      prev <= 0 ? changeIndices.length - 1 : prev - 1,
    );
  };
  const navNext = () => {
    if (changeIndices.length === 0) return;
    setNavIdx((prev) =>
      prev >= changeIndices.length - 1 ? 0 : prev + 1,
    );
  };

  const hasDiffs = changeIndices.length > 0 || fmDiffKeys.length > 0;
  // Without the canonical etag a resolve would PUT unconditionally, so the
  // write actions stay disabled until the activation fetch has landed.
  const loaded = canonicalEtag !== '';

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal conflicts-modal"
        onClick={(e) => e.stopPropagation()}
      >
        <header>
          <h2>Resolve conflicts</h2>
          <button onClick={onClose}>
            <X size={16} />
          </button>
        </header>

        {!active && (
          <ul className="conflict-list">
            {conflicts.map((c) => (
              <li key={c.path}>
                <button onClick={() => setActive(c)}>
                  <strong>{c.canonical_path}</strong>
                  <span className="meta">
                    from {c.device_id} · {formatTs(c.timestamp)}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}

        {active && (
          <div className="diff-pane">
            <div className="diff-header">
              <button onClick={() => setActive(null)}>
                <ArrowLeft size={14} /> back
              </button>
              <span>{active.canonical_path}</span>
            </div>
            {err && <p className="error">{err}</p>}
            {editorActive && (
              <p className="error">
                ⚠ Your unsaved edits are shown as the Editor column — resolving
                replaces the editor content with the result.
              </p>
            )}

            {changeIndices.length > 0 && (
              <div className="diff-nav">
                <span className="diff-nav-count">
                  {changeIndices.length} difference
                  {changeIndices.length === 1 ? '' : 's'}
                </span>
                <div className="diff-nav-arrows">
                  <button onClick={navPrev} title="Previous difference">
                    <ChevronLeft size={14} />
                  </button>
                  <span className="diff-nav-pos">
                    {navIdx >= 0
                      ? `${navIdx + 1} / ${changeIndices.length}`
                      : '—'}
                  </span>
                  <button onClick={navNext} title="Next difference">
                    <ChevronRight size={14} />
                  </button>
                </div>
              </div>
            )}

            <div className={`diff-cols${editorActive ? ' diff-cols-3' : ''}`}>
              <DiffColumn
                heading="Server (current)"
                source="server"
                hlClass="diff-hl-del"
                text={(z) => z.serverText}
                zones={zones}
                changeIdxByZone={changeIdxByZone}
                picks={picks}
                navIdx={navIdx}
                onPick={pickZone}
                bodyRef={leftRef}
              />
              <DiffColumn
                heading={`Conflicting (from ${active.device_id})`}
                source="conflict"
                hlClass="diff-hl-add"
                text={(z) => z.conflictText}
                zones={zones}
                changeIdxByZone={changeIdxByZone}
                picks={picks}
                navIdx={navIdx}
                onPick={pickZone}
                bodyRef={rightRef}
              />
              {editorActive && (
                <DiffColumn
                  heading="Editor (unsaved)"
                  source="editor"
                  hlClass="diff-hl-editor"
                  text={(z) => z.editorText}
                  zones={zones}
                  changeIdxByZone={changeIdxByZone}
                  picks={picks}
                  navIdx={navIdx}
                  onPick={pickZone}
                  bodyRef={editorColRef}
                />
              )}
            </div>

            <ConflictFmMerge
              canonical={canonicalFm}
              conflict={conflictFm}
              editor={editorSnap?.frontmatter ?? {}}
              editorActive={editorActive}
              diffKeys={fmDiffKeys}
              picks={fmPicks}
              onPick={pickFm}
            />

            <footer>
              <button onClick={keepCanonical} disabled={busy || !loaded}>
                Keep server
              </button>
              {hasDiffs && (
                <button onClick={applyMerge} disabled={busy || !loaded}>
                  Apply merge
                </button>
              )}
              {editorActive && (
                <button onClick={keepMyEdits} disabled={busy || !loaded}>
                  Keep my edits
                </button>
              )}
              <button onClick={keepConflict} disabled={busy || !loaded}>
                Use conflict
              </button>
            </footer>
          </div>
        )}
      </div>
    </div>
  );
}

function DiffColumn({
  heading,
  source,
  hlClass,
  text,
  zones,
  changeIdxByZone,
  picks,
  navIdx,
  onPick,
  bodyRef,
}: {
  heading: string;
  source: ThreeWaySource;
  hlClass: string;
  text: (zone: ThreeWayZone) => string;
  zones: ThreeWayZone[];
  changeIdxByZone: Map<number, number>;
  picks: Record<number, ThreeWaySource>;
  navIdx: number;
  onPick: (zoneIdx: number, choice: ThreeWaySource) => void;
  bodyRef: RefObject<HTMLDivElement>;
}) {
  return (
    <div className="diff-col">
      <h3>{heading}</h3>
      <div className="diff-body" ref={bodyRef}>
        {zones.map((zone, i) => {
          if (zone.type === 'equal') return <span key={i}>{zone.text}</span>;
          const changeIdx = changeIdxByZone.get(i) ?? -1;
          const pick = picks[i] ?? 'server';
          return (
            <span
              key={i}
              className={`diff-hl ${hlClass}${pick === source ? ' zone-picked' : ''}${navIdx === changeIdx ? ' zone-current' : ''}`}
              data-change={changeIdx}
              onClick={() => onPick(i, source)}
            >
              {text(zone)}
            </span>
          );
        })}
      </div>
    </div>
  );
}

function ConflictFmMerge({
  canonical,
  conflict,
  editor,
  editorActive,
  diffKeys,
  picks,
  onPick,
}: {
  canonical: Record<string, unknown>;
  conflict: Record<string, unknown>;
  editor: Record<string, unknown>;
  editorActive: boolean;
  diffKeys: string[];
  picks: Record<string, ThreeWaySource>;
  onPick: (field: string, choice: ThreeWaySource) => void;
}) {
  if (diffKeys.length === 0) return null;
  const cell = (
    k: string,
    source: ThreeWaySource,
    value: unknown,
    pick: ThreeWaySource,
  ) => (
    <td
      className={`fm-pick${pick === source ? ' fm-picked' : ''}`}
      onClick={() => onPick(k, source)}
    >
      {pick === source && <Check size={10} className="fm-check" />}
      {format(value)}
    </td>
  );
  return (
    <div className="fm-diff">
      <h4>Frontmatter differences</h4>
      <table>
        <thead>
          <tr>
            <th>field</th>
            <th>server</th>
            <th>conflict</th>
            {editorActive && <th>editor</th>}
          </tr>
        </thead>
        <tbody>
          {diffKeys.map((k) => {
            const pick = picks[k] ?? 'server';
            return (
              <tr key={k}>
                <td>{k}</td>
                {cell(k, 'server', canonical[k], pick)}
                {cell(k, 'conflict', conflict[k], pick)}
                {editorActive && cell(k, 'editor', editor[k], pick)}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function format(v: unknown): string {
  if (v === undefined || v === null) return '—';
  if (typeof v === 'string') return v;
  return JSON.stringify(v);
}

function formatTs(ts: string): string {
  if (!/^\d{8}T\d{6}Z$/.test(ts)) return ts;
  const y = ts.slice(0, 4);
  const mo = ts.slice(4, 6);
  const d = ts.slice(6, 8);
  const h = ts.slice(9, 11);
  const mi = ts.slice(11, 13);
  return `${y}-${mo}-${d} ${h}:${mi} UTC`;
}
