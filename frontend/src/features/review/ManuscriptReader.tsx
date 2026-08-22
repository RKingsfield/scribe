import { useCallback, useEffect, useRef, useState } from 'react';
import DOMPurify from 'dompurify';
import type { Manuscript, ReviewComment, TextAnchor } from '../../lib/api';
import {
  addComment,
  addSessionComment,
  getComments,
  getManuscript,
  getSessionComments,
  getSessionManuscript,
  resolveComment,
  resolveSessionComment,
} from '../../lib/api';
import { toast } from '../../app/Toast';
import { CommentRail } from './CommentRail';
import { anchorFromSelection, highlightAnchors } from './anchoring';

interface Props {
  token: string;
  isAuthor: boolean;
  reviewerName: string;
  /** Owner-scoped data source: reads/resolves work regardless of session active state. */
  ownerSession?: { slug: string; sessionId: string };
}

export function ManuscriptReader({ token, isAuthor, reviewerName, ownerSession }: Props) {
  const [manuscript, setManuscript] = useState<Manuscript | null>(null);
  const [comments, setComments] = useState<ReviewComment[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [activeCommentId, setActiveCommentId] = useState<string | null>(null);
  const [showComposer, setShowComposer] = useState(false);
  const [composerAnchor, setComposerAnchor] = useState<{ scene: string; anchor: TextAnchor } | null>(null);
  const [composerText, setComposerText] = useState('');
  const [composerPos, setComposerPos] = useState<{ top: number; left: number } | null>(null);
  const manuscriptRef = useRef<HTMLDivElement>(null);
  const ownerSlug = ownerSession?.slug;
  const ownerSessionId = ownerSession?.sessionId;

  useEffect(() => {
    const manuscriptFetch = ownerSlug && ownerSessionId
      ? getSessionManuscript(ownerSlug, ownerSessionId)
      : getManuscript(token);
    const commentsFetch = ownerSlug && ownerSessionId
      ? getSessionComments(ownerSlug, ownerSessionId)
      : getComments(token);
    manuscriptFetch.then(setManuscript).catch((e) => setError(String(e)));
    commentsFetch.then(setComments).catch((e) => setError(String(e)));
  }, [token, ownerSlug, ownerSessionId]);

  useEffect(() => {
    if (!manuscriptRef.current || !manuscript) return;
    const el = manuscriptRef.current;
    // Clear existing highlights
    el.querySelectorAll('mark.review-highlight').forEach((m) => {
      const parent = m.parentNode;
      if (parent) {
        parent.replaceChild(document.createTextNode(m.textContent ?? ''), m);
        parent.normalize();
      }
    });
    const unresolved = comments.filter((c) => !c.resolved);
    // Match per scene, not across the whole manuscript, so an identical phrase
    // in another scene can't steal a highlight (R5).
    el.querySelectorAll<HTMLElement>('[data-scene]').forEach((sceneEl) => {
      const scenePath = sceneEl.getAttribute('data-scene');
      const anchors = unresolved
        .filter((c) => c.scene === scenePath)
        .map((c) => ({ id: c.id, anchor: c.anchor }));
      if (anchors.length) highlightAnchors(sceneEl, anchors);
    });
  }, [comments, manuscript]);

  const handleTextSelect = useCallback(() => {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !manuscriptRef.current) {
      setShowComposer(false);
      return;
    }
    const sceneEl = (sel.anchorNode as HTMLElement)?.closest?.('[data-scene]')
      ?? sel.anchorNode?.parentElement?.closest?.('[data-scene]');
    const scenePath = sceneEl?.getAttribute('data-scene');
    if (!sceneEl || !scenePath) return;
    const anchor = anchorFromSelection(sceneEl as HTMLElement, sel);
    if (!anchor) return;
    const range = sel.getRangeAt(0);
    const rect = range.getBoundingClientRect();
    setComposerPos({ top: rect.bottom + window.scrollY + 8, left: rect.left + window.scrollX });
    setComposerAnchor({ scene: scenePath, anchor });
    setShowComposer(true);
    setComposerText('');
  }, []);

  const submitComment = async () => {
    if (!composerAnchor || !composerText.trim()) return;
    try {
      const payload = { scene: composerAnchor.scene, anchor: composerAnchor.anchor, text: composerText.trim() };
      const comment = ownerSession
        ? await addSessionComment(ownerSession.slug, ownerSession.sessionId, payload, reviewerName)
        : await addComment(token, payload, reviewerName);
      setComments((prev) => [...prev, comment]);
      setShowComposer(false);
      setComposerText('');
      window.getSelection()?.removeAllRanges();
    } catch {
      toast('Failed to post comment', 'error');
    }
  };

  const handleResolve = async (id: string, resolved: boolean) => {
    try {
      const updated = ownerSession
        ? await resolveSessionComment(ownerSession.slug, ownerSession.sessionId, id, resolved)
        : await resolveComment(token, id, resolved);
      setComments((prev) => prev.map((c) => (c.id === id ? updated : c)));
    } catch {
      toast('Failed to update comment', 'error');
    }
  };

  const scrollToComment = (id: string) => {
    setActiveCommentId(id);
    const mark = manuscriptRef.current?.querySelector(`mark[data-comment-id="${id}"]`);
    mark?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  };

  const scrollToHighlight = useCallback((id: string) => {
    setActiveCommentId(id);
    document.getElementById(`comment-${id}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, []);

  const handleHighlightClick = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    const mark = (e.target as HTMLElement).closest('mark[data-comment-id]');
    if (mark) scrollToHighlight(mark.getAttribute('data-comment-id')!);
  }, [scrollToHighlight]);

  if (error) return <p className="error">{error}</p>;
  if (!manuscript) return <p className="editor-empty">Loading manuscript…</p>;

  return (
    <div className="review-layout">
      <div className="review-manuscript" ref={manuscriptRef} onMouseUp={handleTextSelect} onClick={handleHighlightClick}>
        <header className="review-title-page">
          <h1>{manuscript.title}</h1>
          {manuscript.author && <p className="review-author">{manuscript.author}</p>}
        </header>
        {manuscript.chapters.map((ch) => (
          <article key={ch.slug} className="review-chapter">
            <h2>{ch.title}</h2>
            {ch.scenes.map((scene, i) => (
              <div key={scene.path} data-scene={scene.path}>
                {i > 0 && <hr className="scene-break" />}
                <div dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(scene.html) }} />
              </div>
            ))}
          </article>
        ))}
      </div>

      <CommentRail
        comments={comments}
        activeCommentId={activeCommentId}
        onCommentClick={scrollToComment}
        onResolve={isAuthor ? handleResolve : undefined}
        isAuthor={isAuthor}
      />

      {showComposer && composerPos && (
        <div className="comment-composer" style={{ top: composerPos.top, left: composerPos.left }}>
          <textarea
            autoFocus
            value={composerText}
            onChange={(e) => setComposerText(e.target.value)}
            placeholder="Add a comment…"
            rows={3}
          />
          <div className="comment-composer-actions">
            <button className="ghost-btn" onClick={() => setShowComposer(false)}>Cancel</button>
            <button onClick={submitComment} disabled={!composerText.trim()}>Comment</button>
          </div>
        </div>
      )}
    </div>
  );
}
