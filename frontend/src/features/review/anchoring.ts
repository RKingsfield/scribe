import type { TextAnchor } from '../../lib/api';

export function anchorFromSelection(root: HTMLElement, selection: Selection): TextAnchor | null {
  const range = selection.getRangeAt(0);
  if (!root.contains(range.commonAncestorContainer)) return null;
  const exact = selection.toString().trim();
  if (!exact) return null;
  const before = range.startContainer.textContent?.slice(0, range.startOffset) ?? '';
  const after = range.endContainer.textContent?.slice(range.endOffset) ?? '';
  return { prefix: before.slice(-30), exact, suffix: after.slice(0, 30) };
}

interface AnchorMatch {
  start: number;
  end: number;
}

function findAnchor(text: string, anchor: TextAnchor): AnchorMatch | null {
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

    const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
    let charIdx = 0;
    const marks: HTMLElement[] = [];

    while (walker.nextNode()) {
      const node = walker.currentNode as Text;
      const nodeEnd = charIdx + node.length;
      if (nodeEnd > match.start && charIdx < match.end) {
        const overlapStart = Math.max(match.start - charIdx, 0);
        const overlapEnd = Math.min(match.end - charIdx, node.length);
        const range = document.createRange();
        range.setStart(node, overlapStart);
        range.setEnd(node, overlapEnd);
        const mark = document.createElement('mark');
        mark.className = 'review-highlight';
        mark.dataset.commentId = id;
        range.surroundContents(mark);
        marks.push(mark);
      }
      charIdx = nodeEnd;
    }
    if (marks.length) result.set(id, marks);
  }
  return result;
}
