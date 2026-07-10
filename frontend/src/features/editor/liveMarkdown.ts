import { Range, RangeSetBuilder, StateField } from '@codemirror/state';
import { syntaxTree } from '@codemirror/language';
import type { SyntaxNode } from '@lezer/common';
import {
  Decoration,
  DecorationSet,
  EditorView,
  MatchDecorator,
  ViewPlugin,
  ViewUpdate,
  WidgetType,
} from '@codemirror/view';

const HEADER_LEVELS: Record<string, string> = {
  ATXHeading1: 'cm-md-h1',
  ATXHeading2: 'cm-md-h2',
  ATXHeading3: 'cm-md-h3',
  ATXHeading4: 'cm-md-h4',
  ATXHeading5: 'cm-md-h5',
  ATXHeading6: 'cm-md-h6',
};

const HIDE = Decoration.replace({});

const STYLE_NODES: Record<string, string> = {
  Emphasis: 'cm-md-em',
  StrongEmphasis: 'cm-md-strong',
  InlineCode: 'cm-md-code',
  Strikethrough: 'cm-md-strike',
};

function collectPipes(rowNode: SyntaxNode, marks: Range<Decoration>[]) {
  const c = rowNode.cursor();
  if (c.firstChild()) {
    do {
      if (c.name === 'TableDelimiter') {
        marks.push(
          Decoration.mark({ class: 'cm-md-table-pipe' }).range(c.from, c.to),
        );
      }
    } while (c.nextSibling());
  }
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function stripMarkers(s: string, marker: string): string {
  if (s.startsWith(marker) && s.endsWith(marker)) {
    return s.slice(marker.length, -marker.length);
  }
  return s;
}

function cellToHtml(cell: SyntaxNode, doc: { sliceString(from: number, to: number): string }): string {
  let html = '';
  let pos = cell.from;
  const cursor = cell.cursor();
  if (!cursor.firstChild()) return escapeHtml(doc.sliceString(cell.from, cell.to));
  do {
    if (cursor.from > pos) {
      html += escapeHtml(doc.sliceString(pos, cursor.from));
    }
    if (cursor.name === 'StrongEmphasis') {
      html += '<strong>' + escapeHtml(stripMarkers(doc.sliceString(cursor.from, cursor.to), '**')) + '</strong>';
    } else if (cursor.name === 'Emphasis') {
      html += '<em>' + escapeHtml(stripMarkers(doc.sliceString(cursor.from, cursor.to), '*')) + '</em>';
    } else if (cursor.name === 'InlineCode') {
      html += '<code>' + escapeHtml(stripMarkers(doc.sliceString(cursor.from, cursor.to), '`')) + '</code>';
    } else if (cursor.name === 'Strikethrough') {
      html += '<s>' + escapeHtml(stripMarkers(doc.sliceString(cursor.from, cursor.to), '~~')) + '</s>';
    } else if (cursor.name === 'TableDelimiter') {
      // skip pipe chars
    } else {
      html += escapeHtml(doc.sliceString(cursor.from, cursor.to));
    }
    pos = cursor.to;
  } while (cursor.nextSibling());
  if (pos < cell.to) {
    html += escapeHtml(doc.sliceString(pos, cell.to));
  }
  return html.trim();
}

class HrWidget extends WidgetType {
  eq(): boolean {
    return true;
  }

  toDOM(): HTMLElement {
    const wrap = document.createElement('div');
    wrap.className = 'cm-md-hr';
    const line = document.createElement('div');
    line.className = 'cm-md-hr-line';
    wrap.appendChild(line);
    return wrap;
  }

  ignoreEvent(): boolean {
    return false;
  }
}

class TableWidget extends WidgetType {
  constructor(
    private readonly tableNode: SyntaxNode,
    private readonly doc: { sliceString(from: number, to: number): string },
    private readonly tableFrom: number,
  ) {
    super();
  }

  eq(): boolean {
    return false;
  }

  toDOM(view: EditorView): HTMLElement {
    const table = document.createElement('table');
    table.className = 'cm-md-table-widget';

    const cursor = this.tableNode.cursor();
    if (!cursor.firstChild()) return table;

    let rowIdx = 0;
    let thead: HTMLTableSectionElement;
    let tbody: HTMLTableSectionElement | null = null;

    do {
      if (cursor.name === 'TableHeader') {
        thead = document.createElement('thead');
        const tr = document.createElement('tr');
        const cellCursor = cursor.node.cursor();
        if (cellCursor.firstChild()) {
          do {
            if (cellCursor.name === 'TableCell') {
              const th = document.createElement('th');
              th.innerHTML = cellToHtml(cellCursor.node, this.doc);
              tr.appendChild(th);
            }
          } while (cellCursor.nextSibling());
        }
        thead.appendChild(tr);
        table.appendChild(thead);
      } else if (cursor.name === 'TableDelimiter') {
        // skip the |---|---| row
      } else if (cursor.name === 'TableRow') {
        if (!tbody) {
          tbody = document.createElement('tbody');
          table.appendChild(tbody);
        }
        const tr = document.createElement('tr');
        if (rowIdx % 2 === 0) tr.className = 'even';
        const cellCursor = cursor.node.cursor();
        if (cellCursor.firstChild()) {
          do {
            if (cellCursor.name === 'TableCell') {
              const td = document.createElement('td');
              td.innerHTML = cellToHtml(cellCursor.node, this.doc);
              tr.appendChild(td);
            }
          } while (cellCursor.nextSibling());
        }
        tbody.appendChild(tr);
        rowIdx++;
      }
    } while (cursor.nextSibling());

    const wrap = document.createElement('div');
    wrap.className = 'cm-md-table-wrap';
    wrap.appendChild(table);

    wrap.addEventListener('mousedown', (e) => {
      e.preventDefault();
      view.dispatch({
        selection: { anchor: this.tableFrom },
        scrollIntoView: true,
      });
      view.focus();
    });

    return wrap;
  }

  ignoreEvent(): boolean {
    return false;
  }
}

function buildDecorations(view: EditorView): DecorationSet {
  const lineDecos: Range<Decoration>[] = [];
  const styleMarks: Range<Decoration>[] = [];
  const hideBuilder = new RangeSetBuilder<Decoration>();
  const cursors = view.state.selection.ranges.map((r) => r.from);

  const cursorIn = (from: number, to: number) =>
    cursors.some((c) => c >= from && c <= to);

  const tree = syntaxTree(view.state);
  for (const { from, to } of view.visibleRanges) {
    tree.iterate({
      from,
      to,
      enter: (n) => {
        // Headings — line decoration for sizing, hide leading "#" when cursor away.
        const cls = HEADER_LEVELS[n.name];
        if (cls) {
          const line = view.state.doc.lineAt(n.from);
          lineDecos.push(Decoration.line({ class: cls }).range(line.from));
          if (!cursorIn(line.from, line.to)) {
            const m = line.text.match(/^(#+\s+)/);
            if (m) hideBuilder.add(line.from, line.from + m[1].length, HIDE);
          }
        }

        // Inline emphasis: ALWAYS apply the style class to the whole construct
        // so italics/bold/code render as italics/bold/code; only hide the
        // markup chars themselves when the cursor isn't inside the construct.
        const styleCls = STYLE_NODES[n.name];
        if (styleCls) {
          styleMarks.push(
            Decoration.mark({ class: styleCls }).range(n.from, n.to),
          );
        }

        if (n.name === 'HeaderMark' && n.node.parent && HEADER_LEVELS[n.node.parent.name]) {
          return;
        }
        if (
          n.name === 'EmphasisMark' ||
          n.name === 'StrongEmphasisMark' ||
          n.name === 'CodeMark' ||
          n.name === 'StrikethroughMark'
        ) {
          const parent = n.node.parent;
          if (!parent) return;
          if (cursorIn(parent.from, parent.to)) return;
          hideBuilder.add(n.from, n.to, HIDE);
        }

        if (n.name === 'Table') {
          if (cursorIn(n.from, n.to)) {
            let rowIdx = 0;
            const cursor = n.node.cursor();
            if (cursor.firstChild()) {
              do {
                const line = view.state.doc.lineAt(cursor.from);
                if (cursor.name === 'TableHeader') {
                  lineDecos.push(
                    Decoration.line({ class: 'cm-md-table-header' }).range(line.from),
                  );
                  if (!cursorIn(cursor.from, cursor.to)) {
                    collectPipes(cursor.node, styleMarks);
                  }
                } else if (cursor.name === 'TableDelimiter') {
                  lineDecos.push(
                    Decoration.line({ class: 'cm-md-table-delimiter' }).range(line.from),
                  );
                } else if (cursor.name === 'TableRow') {
                  const cls = rowIdx % 2 === 0
                    ? 'cm-md-table-row cm-md-table-row-even'
                    : 'cm-md-table-row';
                  lineDecos.push(
                    Decoration.line({ class: cls }).range(line.from),
                  );
                  if (!cursorIn(cursor.from, cursor.to)) {
                    collectPipes(cursor.node, styleMarks);
                  }
                  rowIdx++;
                }
              } while (cursor.nextSibling());
            }
          } else {
            return false;
          }
        }
      },
    });
  }

  const all: Range<Decoration>[] = [...lineDecos, ...styleMarks];
  const hideSet = hideBuilder.finish();
  hideSet.between(0, view.state.doc.length, (from, to, value) => {
    all.push(value.range(from, to));
  });
  all.sort((a, b) => a.from - b.from);
  return Decoration.set(all, true);
}

const liveMarkdownPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = buildDecorations(view);
    }
    update(u: ViewUpdate) {
      if (u.docChanged || u.selectionSet || u.viewportChanged) {
        this.decorations = buildDecorations(u.view);
      }
    }
  },
  { decorations: (v) => v.decorations },
);

const sceneBeatsDecorator = new MatchDecorator({
  regexp: /\[\[([^\]\n]+)\]\]/g,
  decoration: () => Decoration.mark({ class: 'cm-scene-beat' }),
});

const sceneBeatsPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = sceneBeatsDecorator.createDeco(view);
    }
    update(u: ViewUpdate) {
      if (u.docChanged || u.viewportChanged) {
        this.decorations = sceneBeatsDecorator.createDeco(u.view);
      }
    }
  },
  { decorations: (v) => v.decorations },
);

const liveMarkdownTheme = EditorView.theme({
  '.cm-md-h1': { fontSize: '1.6em', fontWeight: '700', letterSpacing: '-0.005em' },
  '.cm-md-h2': { fontSize: '1.38em', fontWeight: '700' },
  '.cm-md-h3': { fontSize: '1.2em', fontWeight: '700' },
  '.cm-md-h4': { fontSize: '1.08em', fontWeight: '700' },
  '.cm-md-h5': { fontWeight: '700' },
  '.cm-md-h6': { fontWeight: '700' },
  '.cm-md-em': { fontStyle: 'italic' },
  '.cm-md-strong': { fontWeight: '700' },
  '.cm-md-code': {
    fontFamily: 'var(--font-mono)',
    fontSize: '0.94em',
    background: 'var(--surface-3)',
    padding: '0 0.25em',
    borderRadius: '3px',
  },
  '.cm-md-strike': { textDecoration: 'line-through', color: 'var(--fg-mid)' },
  '.cm-md-table-row': {
    borderLeft: '2px solid var(--border)',
    paddingLeft: '0.5em',
    background: 'var(--surface)',
    whiteSpace: 'pre',
  },
  '.cm-md-table-header': {
    fontWeight: '700',
    borderLeft: '2px solid var(--accent)',
    paddingLeft: '0.5em',
    background: 'var(--surface-2)',
    whiteSpace: 'pre',
  },
  '.cm-md-table-delimiter': {
    borderLeft: '2px solid var(--border)',
    paddingLeft: '0.5em',
    color: 'var(--fg-dim)',
    whiteSpace: 'pre',
  },
  '.cm-md-table-row-even': {
    background: 'var(--surface-2)',
  },
  '.cm-md-table-pipe': {
    color: 'var(--fg-mid)',
  },
  '.cm-md-table-wrap': {
    padding: '0.5em 0',
  },
  '.cm-md-table-widget': {
    width: '100%',
    borderCollapse: 'collapse',
    fontFamily: 'var(--font-body)',
    fontSize: 'var(--editor-size)',
    lineHeight: 'var(--editor-leading)',
    color: 'var(--fg)',
    cursor: 'pointer',
  },
  '.cm-md-table-widget th': {
    fontWeight: '700',
    borderLeft: '2px solid var(--accent)',
    borderBottom: '1px solid var(--border-strong)',
    background: 'var(--surface-2)',
    padding: '0.3em 0.75em',
    textAlign: 'left',
  },
  '.cm-md-table-widget td': {
    borderLeft: '2px solid var(--border)',
    borderBottom: '1px solid var(--border)',
    padding: '0.3em 0.75em',
    textAlign: 'left',
  },
  '.cm-md-table-widget tr.even td': {
    background: 'var(--surface)',
  },
  '.cm-md-table-widget code': {
    fontFamily: 'var(--font-mono)',
    fontSize: '0.94em',
    background: 'var(--surface-3)',
    padding: '0 0.25em',
    borderRadius: '3px',
  },
  '.cm-md-table-widget s': {
    textDecoration: 'line-through',
    color: 'var(--fg-mid)',
  },
  '.cm-md-hr': {
    padding: '0.75em 0',
  },
  '.cm-md-hr-line': {
    borderTop: '1px solid var(--border-strong)',
  },
});

const tableWidgetField = StateField.define<DecorationSet>({
  create(state) {
    const decos: Range<Decoration>[] = [];
    const cursors = state.selection.ranges.map((r) => r.from);
    const cursorIn = (from: number, to: number) =>
      cursors.some((c) => c >= from && c <= to);
    syntaxTree(state).iterate({
      enter: (n) => {
        if (n.name === 'Table' && !cursorIn(n.from, n.to)) {
          decos.push(
            Decoration.replace({
              widget: new TableWidget(n.node, state.doc, n.from),
              block: true,
              inclusive: false,
            }).range(n.from, n.to),
          );
          return false;
        }
        if (n.name === 'HorizontalRule' && !cursorIn(n.from, n.to)) {
          decos.push(
            Decoration.replace({
              widget: new HrWidget(),
              block: true,
              inclusive: false,
            }).range(n.from, n.to),
          );
          return false;
        }
      },
    });
    decos.sort((a, b) => a.from - b.from);
    return Decoration.set(decos, true);
  },
  update(decos, tr) {
    if (!tr.docChanged && !tr.selection) return decos;
    const state = tr.state;
    const out: Range<Decoration>[] = [];
    const cursors = state.selection.ranges.map((r) => r.from);
    const cursorIn = (from: number, to: number) =>
      cursors.some((c) => c >= from && c <= to);
    syntaxTree(state).iterate({
      enter: (n) => {
        if (n.name === 'Table' && !cursorIn(n.from, n.to)) {
          out.push(
            Decoration.replace({
              widget: new TableWidget(n.node, state.doc, n.from),
              block: true,
              inclusive: false,
            }).range(n.from, n.to),
          );
          return false;
        }
        if (n.name === 'HorizontalRule' && !cursorIn(n.from, n.to)) {
          out.push(
            Decoration.replace({
              widget: new HrWidget(),
              block: true,
              inclusive: false,
            }).range(n.from, n.to),
          );
          return false;
        }
      },
    });
    out.sort((a, b) => a.from - b.from);
    return Decoration.set(out, true);
  },
  provide: (f) => EditorView.decorations.from(f),
});

export function liveMarkdownExtension() {
  return [liveMarkdownTheme, liveMarkdownPlugin, sceneBeatsPlugin, tableWidgetField];
}
