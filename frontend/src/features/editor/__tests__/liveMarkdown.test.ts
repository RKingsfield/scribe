import { describe, it, expect, afterEach } from 'vitest';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { liveMarkdownExtension } from '../liveMarkdown';

function mount(doc: string, anchor: number): EditorView {
  const state = EditorState.create({
    doc,
    selection: { anchor },
    extensions: [markdown({ base: markdownLanguage }), liveMarkdownExtension()],
  });
  return new EditorView({ state, parent: document.body });
}

describe('liveMarkdown decorations', () => {
  let view: EditorView | undefined;

  afterEach(() => {
    view?.destroy();
    view = undefined;
  });

  it('hides the heading marker and applies the size class when the cursor is elsewhere', () => {
    const doc = '# Hello\n\nBody text here.';
    view = mount(doc, doc.length);
    const line = view.dom.querySelector('.cm-md-h1')!;
    expect(line).toBeTruthy();
    expect(line.textContent).toBe('Hello');
  });

  it('shows the raw heading marker when the cursor is on that line', () => {
    const doc = '# Hello\n\nBody text here.';
    view = mount(doc, 2); // inside "# Hello"
    const line = view.dom.querySelector('.cm-md-h1')!;
    expect(line.textContent).toBe('# Hello');
  });

  it('always styles bold/italic/strikethrough, hiding the markup chars when the cursor is away', () => {
    const doc = 'Some **bold** and *italic* and ~~strike~~ text.';
    view = mount(doc, 0);
    const strong = view.dom.querySelector('.cm-md-strong')!;
    const em = view.dom.querySelector('.cm-md-em')!;
    const strike = view.dom.querySelector('.cm-md-strike')!;
    expect(strong.textContent).toBe('bold');
    expect(em.textContent).toBe('italic');
    expect(strike.textContent).toBe('strike');
    // markup characters are hidden, not just visually — they're absent from the line's text
    expect(view.dom.querySelector('.cm-line')!.textContent).not.toContain('*');
    expect(view.dom.querySelector('.cm-line')!.textContent).not.toContain('~~');
  });

  it('reveals the markup chars when the cursor is inside the emphasis construct', () => {
    const doc = 'Some **bold** text.';
    const idx = doc.indexOf('bold') + 1;
    view = mount(doc, idx);
    const strong = view.dom.querySelector('.cm-md-strong')!;
    expect(strong.textContent).toBe('**bold**');
  });

  it('replaces a table with a widget rendering the correct headers and cells when the cursor is away', () => {
    const doc = '| Name | Age |\n| --- | --- |\n| Asha | 20 |\n\nAfter table.';
    view = mount(doc, doc.length);
    const table = view.dom.querySelector('table.cm-md-table-widget')!;
    expect(table).toBeTruthy();
    const headers = [...table.querySelectorAll('th')].map((th) => th.textContent);
    expect(headers).toEqual(['Name', 'Age']);
    const cells = [...table.querySelectorAll('td')].map((td) => td.textContent);
    expect(cells).toEqual(['Asha', '20']);
    // the widget replaces the source lines entirely — raw pipes aren't in the DOM
    expect(view.dom.textContent).not.toContain('|');
  });

  it('formats inline marks inside table cells and escapes special characters', () => {
    const doc =
      '| A | B |\n| --- | --- |\n| **Bold** and `code` and ~~gone~~ | Tom & <b> |\n\nafter';
    view = mount(doc, doc.length);
    const table = view.dom.querySelector('table.cm-md-table-widget')!;
    const [cellA, cellB] = [...table.querySelectorAll('td')];
    expect(cellA.querySelector('strong')!.textContent).toBe('Bold');
    expect(cellA.querySelector('code')!.textContent).toBe('code');
    expect(cellA.querySelector('s')!.textContent).toBe('gone');
    // "&" and "<b>" are escaped, not interpreted as HTML
    expect(cellB.textContent).toBe('Tom & <b>');
    expect(cellB.querySelector('b')).toBeNull();
  });

  it('renders raw striped rows with pipe styling instead of the widget when the cursor is inside the table', () => {
    const doc = '| Name | Age |\n| --- | --- |\n| Asha | 20 |';
    view = mount(doc, 2); // inside the header row
    expect(view.dom.querySelector('table.cm-md-table-widget')).toBeNull();
    expect(view.dom.querySelector('.cm-md-table-header')).toBeTruthy();
    expect(view.dom.querySelector('.cm-md-table-delimiter')).toBeTruthy();
    const pipes = view.dom.querySelectorAll('.cm-md-table-pipe');
    expect(pipes.length).toBeGreaterThan(0);
  });

  it('zebra-stripes table rows by even/odd index', () => {
    const doc = '| A |\n| --- |\n| r1 |\n| r2 |\n| r3 |\n\nafter';
    view = mount(doc, doc.length);
    const rows = [...view.dom.querySelectorAll('table.cm-md-table-widget tbody tr')];
    expect(rows.map((r) => r.className)).toEqual(['even', '', 'even']);
  });
});
