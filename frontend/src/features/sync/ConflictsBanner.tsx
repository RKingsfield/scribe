import { useEffect, useState } from 'react';
import { X, ArrowLeft } from 'lucide-react';
import {
  ServerConflictEntry,
  discardServerConflict,
  getFile,
  listServerConflicts,
  putFile,
} from '../../lib/api';
import { db, fileKey } from '../../lib/db';
import { FLUSH_INTERVAL_MS, syncEngine } from '../../lib/syncEngine';

interface Props {
  slug: string;
}

export function ConflictsBanner({ slug }: Props) {
  const [conflicts, setConflicts] = useState<ServerConflictEntry[]>([]);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState<ServerConflictEntry | null>(null);

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

  // Re-poll when sync engine changes flush state.
  useEffect(() => syncEngine.subscribe(() => refresh()), [slug]); // eslint-disable-line

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
  conflicts: ServerConflictEntry[];
  active: ServerConflictEntry | null;
  setActive: (c: ServerConflictEntry | null) => void;
  onClose: () => void;
  onResolved: () => void;
}) {
  const { slug, conflicts, active, setActive, onClose, onResolved } = props;
  const [canonicalBody, setCanonicalBody] = useState<string>('');
  const [canonicalEtag, setCanonicalEtag] = useState<string>('');
  const [canonicalFm, setCanonicalFm] = useState<Record<string, unknown>>({});
  const [conflictBody, setConflictBody] = useState<string>('');
  const [conflictFm, setConflictFm] = useState<Record<string, unknown>>({});
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!active) return;
    setErr(null);
    Promise.all([
      getFile(slug, active.canonical_path),
      getFile(slug, active.path),
    ])
      .then(([can, conf]) => {
        setCanonicalBody(can.body);
        setCanonicalEtag(can.etag);
        setCanonicalFm(can.frontmatter);
        setConflictBody(conf.body);
        setConflictFm(conf.frontmatter);
      })
      .catch((e) => setErr(String(e)));
  }, [slug, active]);

  const dropLocalMarker = async () => {
    if (!active) return;
    await syncEngine.dismissConflict(fileKey(slug, active.path));
    await db.cache.delete(fileKey(slug, active.path));
  };

  const keepCanonical = async () => {
    if (!active) return;
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

  const keepConflictVersion = async () => {
    if (!active) return;
    setBusy(true);
    try {
      const result = await putFile(
        slug,
        active.canonical_path,
        { body: conflictBody, frontmatter: conflictFm },
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

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal conflicts-modal" onClick={(e) => e.stopPropagation()}>
        <header>
          <h2>Resolve conflicts</h2>
          <button onClick={onClose}><X size={16} /></button>
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
              <button onClick={() => setActive(null)}><ArrowLeft size={14} /> back</button>
              <span>{active.canonical_path}</span>
            </div>
            {err && <p className="error">{err}</p>}
            <div className="diff-cols">
              <div className="diff-col">
                <h3>Server (current)</h3>
                <pre>{canonicalBody}</pre>
              </div>
              <div className="diff-col">
                <h3>Conflicting (from {active.device_id})</h3>
                <pre>{conflictBody}</pre>
              </div>
            </div>
            <footer>
              <button onClick={keepCanonical} disabled={busy}>
                Keep server, discard conflict
              </button>
              <button onClick={keepConflictVersion} disabled={busy}>
                Replace server with conflict
              </button>
            </footer>
            <p className="hint">
              Tip: for a manual merge, open the canonical file in the editor and
              hand-merge content from the conflict. The conflict file lives at
              <code> {active.path}</code> on disk.
            </p>
            <ConflictFmDiff canonical={canonicalFm} conflict={conflictFm} />
          </div>
        )}
      </div>
    </div>
  );
}

function ConflictFmDiff({
  canonical,
  conflict,
}: {
  canonical: Record<string, unknown>;
  conflict: Record<string, unknown>;
}) {
  const keys = Array.from(
    new Set([...Object.keys(canonical), ...Object.keys(conflict)]),
  ).sort();
  const diffs = keys.filter(
    (k) => JSON.stringify(canonical[k]) !== JSON.stringify(conflict[k]),
  );
  if (diffs.length === 0) return null;
  return (
    <div className="fm-diff">
      <h4>Frontmatter differences</h4>
      <table>
        <thead>
          <tr><th>field</th><th>server</th><th>conflict</th></tr>
        </thead>
        <tbody>
          {diffs.map((k) => (
            <tr key={k}>
              <td>{k}</td>
              <td>{format(canonical[k])}</td>
              <td>{format(conflict[k])}</td>
            </tr>
          ))}
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
  // YYYYMMDDTHHMMSSZ
  if (!/^\d{8}T\d{6}Z$/.test(ts)) return ts;
  const y = ts.slice(0, 4);
  const mo = ts.slice(4, 6);
  const d = ts.slice(6, 8);
  const h = ts.slice(9, 11);
  const mi = ts.slice(11, 13);
  return `${y}-${mo}-${d} ${h}:${mi} UTC`;
}
