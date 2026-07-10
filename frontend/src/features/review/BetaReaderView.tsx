import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { Download } from 'lucide-react';
import { ManuscriptReader } from './ManuscriptReader';
import { exportReviewUrl } from '../../lib/api';

export function BetaReaderView() {
  const { token } = useParams<{ token: string }>();
  const [name, setName] = useState<string | null>(
    () => localStorage.getItem('scribe.reviewer.name'),
  );
  const [nameInput, setNameInput] = useState('');

  if (!token) return <p className="error">Missing review token.</p>;

  if (!name) {
    return (
      <div className="beta-reader-name-prompt">
        <div className="beta-reader-name-card">
          <h2>Welcome to this review</h2>
          <p className="dim">Enter your name to leave comments on the manuscript.</p>
          <input
            autoFocus
            placeholder="Your name"
            value={nameInput}
            onChange={(e) => setNameInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && nameInput.trim()) {
                localStorage.setItem('scribe.reviewer.name', nameInput.trim());
                setName(nameInput.trim());
              }
            }}
          />
          <button
            onClick={() => {
              if (nameInput.trim()) {
                localStorage.setItem('scribe.reviewer.name', nameInput.trim());
                setName(nameInput.trim());
              }
            }}
            disabled={!nameInput.trim()}
          >
            Continue
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="beta-reader-shell">
      <header className="beta-reader-header">
        <span className="beta-reader-brand">scribe review</span>
        <div className="beta-reader-actions">
          <a href={exportReviewUrl(token)} download className="ghost-btn">
            <Download size={14} /> epub
          </a>
          <span className="dim">{name}</span>
        </div>
      </header>
      <ManuscriptReader token={token} isAuthor={false} reviewerName={name} />
    </div>
  );
}
