import { useState } from 'react';
import type { ReviewComment } from '../../lib/api';

interface Props {
  comments: ReviewComment[];
  activeCommentId: string | null;
  onCommentClick: (id: string) => void;
  onResolve?: (id: string, resolved: boolean) => void;
  isAuthor: boolean;
}

export function CommentRail({ comments, activeCommentId, onCommentClick, onResolve, isAuthor }: Props) {
  const [showResolved, setShowResolved] = useState(false);
  const resolved = comments.filter((c) => c.resolved);
  const unresolved = comments.filter((c) => !c.resolved);
  const visible = showResolved ? comments : unresolved;

  return (
    <aside className="comment-rail">
      <div className="comment-rail-header">
        <span className="comment-rail-count">
          {unresolved.length} comment{unresolved.length === 1 ? '' : 's'}
          {resolved.length > 0 && (
            <button className="ghost-btn" onClick={() => setShowResolved(!showResolved)}>
              {showResolved ? 'hide' : 'show'} {resolved.length} resolved
            </button>
          )}
        </span>
      </div>
      <div className="comment-rail-list">
        {visible.map((c) => (
          <div
            key={c.id}
            id={`comment-${c.id}`}
            className={`comment-card${c.id === activeCommentId ? ' active' : ''}${c.resolved ? ' resolved' : ''}`}
            onClick={() => onCommentClick(c.id)}
          >
            <div className="comment-card-head">
              <span className="comment-author">{c.author}</span>
              <span className="comment-time">{new Date(c.created).toLocaleDateString()}</span>
            </div>
            <blockquote className="comment-quote">{c.anchor.exact}</blockquote>
            <p className="comment-text">{c.text}</p>
            {isAuthor && onResolve && (
              <button className="ghost-btn" onClick={(e) => { e.stopPropagation(); onResolve(c.id, !c.resolved); }}>
                {c.resolved ? 'Unresolve' : 'Resolve'}
              </button>
            )}
          </div>
        ))}
      </div>
    </aside>
  );
}
