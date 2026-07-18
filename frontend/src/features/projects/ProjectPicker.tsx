import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Plus } from 'lucide-react';
import { initProject, ProjectListItem } from '../../lib/api';
import { syncEngine } from '../../lib/syncEngine';
import { QuillMark } from '../../app/QuillMark';

export function ProjectPicker() {
  const [items, setItems] = useState<ProjectListItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showNew, setShowNew] = useState(false);

  const refresh = () => {
    syncEngine
      .listProjects()
      .then(setItems)
      .catch((e) => setError(String(e)));
  };

  useEffect(refresh, []);

  return (
    <main className="project-picker">
      <h1><QuillMark size={28} className="brand-mark" /> scribe</h1>
      {error && <p className="error">{error}</p>}
      {items === null && !error && <p>Loading…</p>}
      {items && items.length === 0 && (
        <p className="empty">No projects yet.</p>
      )}
      {items && items.length > 0 && (
        <ul className="project-list">
          {items.map((p) => (
            <li key={p.slug}>
              <Link to={`/p/${encodeURIComponent(p.slug)}`}>{p.title}</Link>
              <small>{p.slug}</small>
            </li>
          ))}
        </ul>
      )}
      <div className="actions">
        {!showNew && (
          <button onClick={() => setShowNew(true)}><Plus size={14} /> New project</button>
        )}
        {showNew && <NewProjectForm onCreated={() => { setShowNew(false); refresh(); }} />}
      </div>
    </main>
  );
}

function NewProjectForm({ onCreated }: { onCreated: () => void }) {
  const [slug, setSlug] = useState('');
  const [title, setTitle] = useState('');
  const [author, setAuthor] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      await initProject(slug, { title, author: author || undefined });
      onCreated();
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="new-project">
      <input
        placeholder="slug (e.g. the-example-novel)"
        value={slug}
        onChange={(e) => setSlug(e.target.value)}
        required
      />
      <input
        placeholder="title"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        required
      />
      <input
        placeholder="author (optional)"
        value={author}
        onChange={(e) => setAuthor(e.target.value)}
      />
      <button disabled={busy} type="submit">
        {busy ? 'Creating…' : 'Create'}
      </button>
      {err && <p className="error">{err}</p>}
    </form>
  );
}
