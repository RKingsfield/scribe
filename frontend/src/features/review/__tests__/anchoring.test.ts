import { describe, it, expect, beforeEach } from 'vitest';
import { findAnchor, anchorFromSelection, highlightAnchors } from '../anchoring';
import type { TextAnchor } from '../../../lib/api';

function anchor(prefix: string, exact: string, suffix: string): TextAnchor {
  return { prefix, exact, suffix };
}

describe('findAnchor', () => {
  it('finds a match using the full prefix+exact+suffix context', () => {
    const text = 'The quick brown fox jumps over the lazy dog.';
    const idx = text.indexOf('brown fox');
    const match = findAnchor(text, anchor('quick ', 'brown fox', ' jumps'));
    expect(match).toEqual({ start: idx, end: idx + 'brown fox'.length });
  });

  it('falls back to matching just the exact text when surrounding context changed', () => {
    const text = 'Something else entirely, brown fox lives here now.';
    const idx = text.indexOf('brown fox');
    const match = findAnchor(text, anchor('quick ', 'brown fox', ' jumps'));
    expect(match).toEqual({ start: idx, end: idx + 'brown fox'.length });
  });

  it('returns null when the exact text cannot be found at all', () => {
    const text = 'No matching content in here.';
    expect(findAnchor(text, anchor('quick ', 'brown fox', ' jumps'))).toBeNull();
  });

  it('uses prefix/suffix context to disambiguate a duplicated exact phrase', () => {
    const text = 'Start: brown fox one. Later: brown fox two.';
    const secondIdx = text.lastIndexOf('brown fox');
    const match = findAnchor(text, anchor('Later: ', 'brown fox', ' two'));
    expect(match).toEqual({ start: secondIdx, end: secondIdx + 'brown fox'.length });
  });

  it('falls back to the first occurrence when context matches nothing', () => {
    const text = 'brown fox here, brown fox there.';
    const match = findAnchor(text, anchor('nomatch ', 'brown fox', ' nomatch'));
    expect(match).toEqual({ start: 0, end: 'brown fox'.length });
  });
});

function selectRange(startNode: Text, startOffset: number, endNode: Text, endOffset: number): Selection {
  const range = document.createRange();
  range.setStart(startNode, startOffset);
  range.setEnd(endNode, endOffset);
  const sel = window.getSelection()!;
  sel.removeAllRanges();
  sel.addRange(range);
  return sel;
}

describe('anchorFromSelection', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('anchors a whitespace-padded selection to the occurrence actually selected, not the first', () => {
    document.body.innerHTML = '<div data-scene="scene-a"><p id="p1">brown fox leads. Later, some context brown fox appears again.</p></div>';
    const sceneEl = document.querySelector('[data-scene="scene-a"]') as HTMLElement;
    const textNode = document.getElementById('p1')!.firstChild as Text;
    const fullText = textNode.data;
    // selection padded with the leading space before the second "brown fox"
    const start = fullText.indexOf(' brown fox appears');
    const end = start + ' brown fox'.length;
    const sel = selectRange(textNode, start, textNode, end);

    const result = anchorFromSelection(sceneEl, sel);
    expect(result).not.toBeNull();

    const match = findAnchor(sceneEl.textContent ?? '', result!);
    expect(match).toEqual({ start, end });
    expect(match!.start).not.toBe(0);
  });

  it('returns null for a cross-paragraph selection where Selection.toString() diverges from textContent', () => {
    document.body.innerHTML = '<div data-scene="scene-a"><p id="p1">First paragraph text.</p><p id="p2">Second paragraph text.</p></div>';
    const sceneEl = document.querySelector('[data-scene="scene-a"]') as HTMLElement;
    const p1 = document.getElementById('p1')!.firstChild as Text;
    const p2 = document.getElementById('p2')!.firstChild as Text;
    const range = document.createRange();
    range.setStart(p1, 6);
    range.setEnd(p2, 6);
    // Real browsers insert a newline between block-level elements in Selection.toString();
    // jsdom's Range doesn't lay out content, so fake that divergence directly.
    const sel = {
      getRangeAt: () => range,
      toString: () => 'paragraph text.\n\nSecond',
    } as unknown as Selection;

    expect(anchorFromSelection(sceneEl, sel)).toBeNull();
  });

  it('returns null for a whitespace-only selection', () => {
    document.body.innerHTML = '<div data-scene="scene-a"><p id="p1">Some text here.</p></div>';
    const sceneEl = document.querySelector('[data-scene="scene-a"]') as HTMLElement;
    const textNode = document.getElementById('p1')!.firstChild as Text;
    const sel = selectRange(textNode, 4, textNode, 5);

    expect(anchorFromSelection(sceneEl, sel)).toBeNull();
  });
});

describe('highlightAnchors scene scoping', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('only highlights within the given scene container, ignoring identical text in other scenes', () => {
    document.body.innerHTML = `
      <div data-scene="scene-a"><p>The door creaked open slowly.</p></div>
      <div data-scene="scene-b"><p>The door creaked open slowly.</p></div>
    `;
    const sceneA = document.querySelector('[data-scene="scene-a"]') as HTMLElement;
    const sceneB = document.querySelector('[data-scene="scene-b"]') as HTMLElement;
    const textAnchor: TextAnchor = { prefix: 'The ', exact: 'door creaked', suffix: ' open' };

    highlightAnchors(sceneB, [{ id: 'c1', anchor: textAnchor }]);

    expect(sceneA.querySelectorAll('mark.review-highlight').length).toBe(0);
    expect(sceneB.querySelectorAll('mark.review-highlight').length).toBe(1);
  });

  it('marks an anchor spanning an inline-element boundary once per text node, without nesting', () => {
    document.body.innerHTML =
      '<div data-scene="s"><p>He walked <em>very</em> quickly away from the example-novel.</p></div>';
    const scene = document.querySelector('[data-scene="s"]') as HTMLElement;

    highlightAnchors(scene, [
      { id: 'c1', anchor: { prefix: 'He ', exact: 'walked very quickly', suffix: ' away' } },
    ]);

    const marks = scene.querySelectorAll('mark.review-highlight');
    expect(scene.querySelectorAll('mark mark').length).toBe(0);
    expect(Array.from(marks, (m) => m.textContent).join('|')).toBe('walked |very| quickly');
    expect(scene.textContent).toBe('He walked very quickly away from the example-novel.');
  });

  it('places a later anchor correctly after an earlier one spanned an element boundary', () => {
    document.body.innerHTML =
      '<div data-scene="s"><p>He walked <em>very</em> quickly away from the example-novel mound.</p></div>';
    const scene = document.querySelector('[data-scene="s"]') as HTMLElement;

    highlightAnchors(scene, [
      { id: 'c1', anchor: { prefix: 'He ', exact: 'walked very quickly', suffix: ' away' } },
      { id: 'c2', anchor: { prefix: 'the ', exact: 'example-novel mound', suffix: '.' } },
    ]);

    const c2 = scene.querySelectorAll('mark[data-comment-id="c2"]');
    expect(Array.from(c2, (m) => m.textContent).join('')).toBe('example-novel mound');
    expect(scene.querySelectorAll('mark mark').length).toBe(0);
    expect(scene.textContent).toBe('He walked very quickly away from the example-novel mound.');
  });
});
