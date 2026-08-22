import { useCallback, useEffect, useState } from 'react';
import { useOutletContext } from 'react-router-dom';
import { useOnline } from '../../lib/syncEngine';
import { Copy, Download, Plus, X } from 'lucide-react';
import { toast } from '../../app/Toast';
import { ProjectContext } from './ProjectView';
import { ManuscriptReader } from '../review/ManuscriptReader';
import {
  ReviewSession,
  createSession,
  deleteReviewSession,
  exportSessionUrl,
  listSessions,
  updateSession,
} from '../../lib/api';

function isExpired(s: ReviewSession): boolean {
  return s.expires !== null && new Date(s.expires).getTime() <= Date.now();
}

export function ReviewView() {
  const online = useOnline();
  const { slug, tree } = useOutletContext<ProjectContext>();
  const [sessions, setSessions] = useState<ReviewSession[]>([]);
  const [activeSession, setActiveSession] = useState<ReviewSession | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [newName, setNewName] = useState('');
  const [newExpiry, setNewExpiry] = useState('');
  const [selectedChapters, setSelectedChapters] = useState<string[]>([]);
  const [copied, setCopied] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const list = await listSessions(slug);
      setSessions(list);
    } catch {
      toast('Failed to load review sessions', 'error');
    }
  }, [slug]);

  useEffect(() => { refresh(); }, [refresh]);

  const handleCreate = async () => {
    if (!newName.trim() || selectedChapters.length === 0) return;
    try {
      const session = await createSession(slug, {
        name: newName,
        chapters: selectedChapters,
        ...(newExpiry ? { expires: newExpiry } : {}),
      });
      setSessions((prev) => [...prev, session]);
      setActiveSession(session);
      setShowCreate(false);
      setNewName('');
      setNewExpiry('');
      setSelectedChapters([]);
    } catch {
      toast('Failed to create review session', 'error');
    }
  };

  const handleExpiryChange = async (id: string, expires: string) => {
    if (!expires) return;
    try {
      const updated = await updateSession(slug, id, { expires });
      setSessions((prev) => prev.map((s) => (s.id === id ? updated : s)));
      if (activeSession?.id === id) setActiveSession(updated);
    } catch {
      toast('Failed to update expiry', 'error');
    }
  };

  const handleRevoke = async (id: string) => {
    try {
      const updated = await updateSession(slug, id, { active: false });
      setSessions((prev) => prev.map((s) => (s.id === id ? updated : s)));
      if (activeSession?.id === id) setActiveSession(updated);
    } catch {
      toast('Failed to revoke session', 'error');
    }
  };

  const handleDelete = async (id: string) => {
    if (!window.confirm('Delete this review session and all its comments?')) return;
    try {
      await deleteReviewSession(slug, id);
      setSessions((prev) => prev.filter((s) => s.id !== id));
      if (activeSession?.id === id) setActiveSession(null);
    } catch {
      toast('Failed to delete session', 'error');
    }
  };

  const copyLink = (token: string) => {
    navigator.clipboard.writeText(`${window.location.origin}/review/t/${token}`);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  if (!online) {
    return (
      <div className="placeholder-view">
        <p className="dim">Review sessions require an internet connection.</p>
      </div>
    );
  }

  if (!tree) return <p>Loading…</p>;

  return (
    <div className="review-view">
      <div className="review-toolbar">
        <select
          value={activeSession?.id ?? ''}
          onChange={(e) => {
            const s = sessions.find((s) => s.id === e.target.value);
            setActiveSession(s ?? null);
          }}
        >
          <option value="" disabled>Select session…</option>
          {sessions.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name} {!s.active ? '(revoked)' : isExpired(s) ? '(expired)' : ''}
            </option>
          ))}
        </select>
        <button className="ghost-btn" onClick={() => setShowCreate(true)}>
          <Plus size={14} /> New session
        </button>
        {activeSession && (
          <>
            <a href={exportSessionUrl(slug, activeSession.id)} download className="ghost-btn">
              <Download size={14} /> epub
            </a>
            <button className="ghost-btn" onClick={() => copyLink(activeSession.token)}>
              <Copy size={14} /> {copied ? 'Copied!' : 'Copy link'}
            </button>
            <label className="dim review-expiry">
              expires
              <input
                type="date"
                value={activeSession.expires?.slice(0, 10) ?? ''}
                onChange={(e) => handleExpiryChange(activeSession.id, e.target.value)}
              />
            </label>
            {activeSession.active && (
              <button className="ghost-btn" onClick={() => handleRevoke(activeSession.id)}>
                Revoke
              </button>
            )}
            <button className="ghost-btn danger" onClick={() => handleDelete(activeSession.id)}>
              <X size={14} />
            </button>
          </>
        )}
      </div>

      {showCreate && (
        <div className="review-create-panel">
          <input
            placeholder="Session name (e.g. Beta Round 1)"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
          />
          <label className="dim review-expiry">
            expires
            <input
              type="date"
              value={newExpiry}
              onChange={(e) => setNewExpiry(e.target.value)}
            />
            <span className="dim">blank = 6 months</span>
          </label>
          <div className="review-chapter-picker">
            <div className="review-select-all">
              <button
                className="ghost-btn"
                onClick={() => setSelectedChapters(tree.chapters.map((ch) => ch.path))}
              >
                Select all
              </button>
              <button
                className="ghost-btn"
                onClick={() => setSelectedChapters([])}
              >
                Select none
              </button>
            </div>
            {tree.chapters.map((ch) => (
              <label key={ch.path}>
                <input
                  type="checkbox"
                  checked={selectedChapters.includes(ch.path)}
                  onChange={(e) => {
                    setSelectedChapters((prev) =>
                      e.target.checked ? [...prev, ch.path] : prev.filter((p) => p !== ch.path),
                    );
                  }}
                />
                {ch.kind === 'interlude' ? `Interlude ${ch.interlude}` : `Ch. ${ch.chapter}`}: {ch.title}
              </label>
            ))}
          </div>
          <div className="review-create-actions">
            <button className="ghost-btn" onClick={() => setShowCreate(false)}>Cancel</button>
            <button onClick={handleCreate} disabled={!newName.trim() || selectedChapters.length === 0}>
              Create
            </button>
          </div>
        </div>
      )}

      {activeSession && (
        <ManuscriptReader
          token={activeSession.token}
          isAuthor={true}
          reviewerName="Author"
          ownerSession={{ slug, sessionId: activeSession.id }}
        />
      )}

      {!activeSession && !showCreate && (
        <div className="editor-empty">
          <p>Create a review session to get started.</p>
        </div>
      )}
    </div>
  );
}
