import type { TextAnchor } from '../../lib/api';

export function anchorFromSelection(sceneEl: HTMLElement, selection: Selection): TextAnchor | null {
  const range = selection.getRangeAt(0);
  if (!sceneEl.contains(range.commonAncestorContainer)) return null;
  // Keep exact untrimmed (reject only whitespace-only) so prefix+exact+suffix stays
  // a literal substring of the scene text and disambiguates repeated phrases correctly.
  const exact = selection.toString();
  if (!exact.trim()) return null;
  const before = range.startContainer.textContent?.slice(0, range.startOffset) ?? '';
  const after = range.endContainer.textContent?.slice(range.endOffset) ?? '';
  // Selection.toString() inserts newlines at block boundaries that textContent lacks;
  // a selection that can't be found back in the scene text can never re-highlight.
  if (!(sceneEl.textContent ?? '').includes(exact)) return null;
  return { prefix: before.slice(-30), exact, suffix: after.slice(0, 30) };
}

interface AnchorMatch {
  start: number;
  end: number;
}

export function findAnchor(text: string, anchor: TextAnchor): AnchorMatch | null {
  const searchStr = anchor.prefix + anchor.exact + anchor.suffix;
  const idx = text.indexOf(searchStr);
  if (idx !== -1) {
    const start = idx + anchor.prefix.length;
    return { start, end: start + anchor.exact.length };
  }
  const exactIdx = text.indexOf(anchor.exact);
  if (exactIdx !== -1) {
    return { start: exactIdx, end: exactIdx + anchor.exact.length };
  }
  return null;
}

export function highlightAnchors(
  container: HTMLElement,
  anchors: { id: string; anchor: TextAnchor }[],
): Map<string, HTMLElement[]> {
  const result = new Map<string, HTMLElement[]>();
  const text = container.textContent ?? '';

  for (const { id, anchor } of anchors) {
    const match = findAnchor(text, anchor);
    if (!match) continue;

    // Snapshot nodes + offsets before wrapping: surroundContents splits text
    // nodes, which corrupts a live walk's offset accounting mid-anchor.
    const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
    let charIdx = 0;
    const segments: { node: Text; from: number; to: number }[] = [];
    while (walker.nextNode()) {
      const node = walker.currentNode as Text;
      const nodeEnd = charIdx + node.length;
      if (nodeEnd > match.start && charIdx < match.end) {
        segments.push({
          node,
          from: Math.max(match.start - charIdx, 0),
          to: Math.min(match.end - charIdx, node.length),
        });
      }
      charIdx = nodeEnd;
    }

    const marks: HTMLElement[] = [];
    for (const seg of segments) {
      const range = document.createRange();
      range.setStart(seg.node, seg.from);
      range.setEnd(seg.node, seg.to);
      const mark = document.createElement('mark');
      mark.className = 'review-highlight';
      mark.dataset.commentId = id;
      range.surroundContents(mark);
      marks.push(mark);
    }
    if (marks.length) result.set(id, marks);
  }
  return result;
}
