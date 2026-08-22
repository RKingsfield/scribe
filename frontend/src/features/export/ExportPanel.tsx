import { useEffect, useState } from 'react';
import { X } from 'lucide-react';
import { useOnline } from '../../lib/syncEngine';
import { exportProject } from '../../lib/api';

interface Props {
  slug: string;
  projectTitle: string;
  open: boolean;
  onClose: () => void;
}

const FORMATS: { id: 'md' | 'docx' | 'html' | 'epub'; label: string; hint: string }[] = [
  { id: 'docx', label: 'Word (.docx)', hint: 'Editor / submission format' },
  { id: 'epub', label: 'EPUB', hint: 'E-reader format' },
  { id: 'html', label: 'HTML', hint: 'Standalone web page' },
  { id: 'md', label: 'Markdown', hint: 'Composed manuscript, no pandoc' },
];

export function ExportPanel({ slug, projectTitle, open, onClose }: Props) {
  const online = useOnline();
  const [format, setFormat] = useState<(typeof FORMATS)[number]['id']>('docx');
  const [includeSummaries, setIncludeSummaries] = useState(false);
  const [includeSceneBeats, setIncludeSceneBeats] = useState(false);
  const [titlePage, setTitlePage] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setError(null);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      const { blob, filename } = await exportProject(slug, format, {
        includeSummaries,
        includeSceneBeats,
        titlePage,
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="panel-overlay" onClick={onClose}>
      <div
        className="panel-dialog"
        role="dialog"
        aria-modal="true"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="panel-head">
          <h3>Export “{projectTitle}”</h3>
          <button className="icon-btn" onClick={onClose} title="Close">
            <X size={16} />
          </button>
        </header>
        {!online && (
          <p className="dim" style={{ padding: '1rem' }}>Export requires an internet connection.</p>
        )}
        {error && <div className="panel-error">{error}</div>}
        <section className="panel-section">
          <label className="panel-label">Format</label>
          <div className="export-formats">
            {FORMATS.map((f) => (
              <label key={f.id} className={`export-format${format === f.id ? ' active' : ''}`}>
                <input
                  type="radio"
                  name="format"
                  checked={format === f.id}
                  onChange={() => setFormat(f.id)}
                  disabled={busy}
                />
                <div>
                  <div className="export-format-label">{f.label}</div>
                  <div className="export-format-hint">{f.hint}</div>
                </div>
              </label>
            ))}
          </div>
        </section>
        <section className="panel-section">
          <label className="panel-label">Options</label>
          <label className="panel-toggle">
            <input
              type="checkbox"
              checked={titlePage}
              onChange={(e) => setTitlePage(e.target.checked)}
              disabled={busy}
            />
            <span>Title page (project title + author)</span>
          </label>
          <label className="panel-toggle">
            <input
              type="checkbox"
              checked={includeSummaries}
              onChange={(e) => setIncludeSummaries(e.target.checked)}
              disabled={busy}
            />
            <span>Include chapter summaries</span>
          </label>
          <label className="panel-toggle">
            <input
              type="checkbox"
              checked={includeSceneBeats}
              onChange={(e) => setIncludeSceneBeats(e.target.checked)}
              disabled={busy}
            />
            <span>Keep scene beats <code>[[…]]</code></span>
          </label>
        </section>
        <section className="panel-section">
          <div className="panel-actions">
            <button className="btn primary" onClick={run} disabled={busy}>
              {busy ? 'Composing…' : `Download ${format.toUpperCase()}`}
            </button>
            <button className="btn" onClick={onClose} disabled={busy}>
              Cancel
            </button>
          </div>
        </section>
      </div>
    </div>
  );
}
