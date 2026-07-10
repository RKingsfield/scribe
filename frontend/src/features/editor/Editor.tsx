import { useEffect, useImperativeHandle, useRef, forwardRef } from 'react';
import { EditorSelection, EditorState } from '@codemirror/state';
import { Command, EditorView, keymap } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { openSearchPanel, search, SearchQuery, setSearchQuery } from '@codemirror/search';
import {
  CodexClickHandler,
  CodexEntry,
  codexHighlightExtension,
} from './codexLink';
import { liveMarkdownExtension } from './liveMarkdown';
import {
  setTypewriter,
  typewriterCompartment,
  typewriterDisabled,
  typewriterEnabled,
} from './typewriter';

export interface SelectionInfo {
  text: string;
  from: number;
  to: number;
  before: string;
  after: string;
}

export interface EditorHandle {
  getSelection: () => SelectionInfo | null;
  replaceRange: (from: number, to: number, replacement: string) => void;
  getDoc: () => string;
  scrollToRange: (from: number, to: number) => void;
  posCoords: (pos: number) => { top: number; bottom: number } | null;
}

interface Props {
  value: string;
  onChange: (next: string) => void;
  codex?: readonly CodexEntry[];
  onCodexClick?: CodexClickHandler;
  typewriter?: boolean;
  onRequestRewrite?: () => void;
  searchTerm?: string;
  hideSearchPanel?: boolean;
}

const CONTEXT_CHARS = 600;

/** Toggle a markdown wrapper (e.g. `**` for bold, `*` for italic) around
 *  the primary selection. Empty selection inserts the markers and parks
 *  the cursor between them. Already-wrapped text unwraps. */
function toggleWrap(marker: string): Command {
  return ({ state, dispatch }) => {
    const range = state.selection.main;
    const len = marker.length;
    const doc = state.doc;

    if (range.empty) {
      dispatch(
        state.update({
          changes: { from: range.from, insert: marker + marker },
          selection: EditorSelection.cursor(range.from + len),
          scrollIntoView: true,
        }),
      );
      return true;
    }

    const selected = state.sliceDoc(range.from, range.to);

    // Selection includes the markers (e.g. user selected `**bold**`)
    if (
      selected.length >= 2 * len &&
      selected.startsWith(marker) &&
      selected.endsWith(marker)
    ) {
      const inner = selected.slice(len, selected.length - len);
      dispatch(
        state.update({
          changes: { from: range.from, to: range.to, insert: inner },
          selection: EditorSelection.range(
            range.from,
            range.to - 2 * len,
          ),
          scrollIntoView: true,
        }),
      );
      return true;
    }

    // Markers immediately outside the selection (selection is the inner text)
    const before = state.sliceDoc(Math.max(0, range.from - len), range.from);
    const after = state.sliceDoc(
      range.to,
      Math.min(doc.length, range.to + len),
    );
    if (before === marker && after === marker) {
      dispatch(
        state.update({
          changes: [
            { from: range.from - len, to: range.from, insert: '' },
            { from: range.to, to: range.to + len, insert: '' },
          ],
          selection: EditorSelection.range(
            range.from - len,
            range.to - len,
          ),
          scrollIntoView: true,
        }),
      );
      return true;
    }

    // Plain wrap
    dispatch(
      state.update({
        changes: { from: range.from, to: range.to, insert: marker + selected + marker },
        selection: EditorSelection.range(range.from + len, range.to + len),
        scrollIntoView: true,
      }),
    );
    return true;
  };
}

export const Editor = forwardRef<EditorHandle, Props>(function Editor({
  value,
  onChange,
  codex = [],
  onCodexClick,
  typewriter = false,
  onRequestRewrite,
  searchTerm,
  hideSearchPanel = false,
}, ref) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const codexRef = useRef<readonly CodexEntry[]>(codex);
  codexRef.current = codex;
  const onCodexClickRef = useRef(onCodexClick);
  onCodexClickRef.current = onCodexClick;
  const onRewriteRef = useRef(onRequestRewrite);
  onRewriteRef.current = onRequestRewrite;

  useEffect(() => {
    if (!hostRef.current) return;
    const state = EditorState.create({
      doc: value,
      extensions: [
        history(),
        keymap.of([
          {
            key: 'Mod-Shift-r',
            run: () => {
              if (onRewriteRef.current) {
                onRewriteRef.current();
                return true;
              }
              return false;
            },
            preventDefault: true,
          },
          { key: 'Mod-b', run: toggleWrap('**'), preventDefault: true },
          { key: 'Mod-i', run: toggleWrap('*'), preventDefault: true },
          {
            key: 'Mod-Shift-x',
            run: toggleWrap('~~'),
            preventDefault: true,
          },
          { key: 'Mod-e', run: toggleWrap('`'), preventDefault: true },
          ...defaultKeymap,
          ...historyKeymap,
        ]),
        markdown({ base: markdownLanguage }),
        EditorView.lineWrapping,
        liveMarkdownExtension(),
        codexHighlightExtension(
          () => codexRef.current,
          (entry, name) => onCodexClickRef.current?.(entry, name),
        ),
        typewriterCompartment.of(
          typewriter ? typewriterEnabled() : typewriterDisabled(),
        ),
        search({ top: true }),
        EditorView.theme({
          '&': { height: '100%' },
          '.cm-scroller': { padding: '0' },
          // @codemirror/search highlights only render when its panel extension is active; hide the built-in panel so ChapterFlow can provide its own search bar.
          ...(hideSearchPanel ? { '.cm-panels': { display: 'none' } } : {}),
        }),
        EditorView.updateListener.of((u) => {
          if (u.docChanged) onChangeRef.current(u.state.doc.toString());
        }),
      ],
    });
    const view = new EditorView({ state, parent: hostRef.current });
    viewRef.current = view;
    return () => {
      view.destroy();
      viewRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    if (view.state.doc.toString() === value) return;
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: value },
    });
  }, [value]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({});
  }, [codex]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    setTypewriter(view, typewriter);
  }, [typewriter]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    if (searchTerm) {
      openSearchPanel(view);
      view.dispatch({ effects: setSearchQuery.of(new SearchQuery({ search: searchTerm, caseSensitive: false })) });
    } else {
      view.dispatch({ effects: setSearchQuery.of(new SearchQuery({ search: '' })) });
    }
  }, [searchTerm]);

  useImperativeHandle(
    ref,
    () => ({
      getSelection: () => {
        const view = viewRef.current;
        if (!view) return null;
        const sel = view.state.selection.main;
        if (sel.empty) return null;
        const doc = view.state.doc;
        const text = doc.sliceString(sel.from, sel.to);
        const before = doc.sliceString(Math.max(0, sel.from - CONTEXT_CHARS), sel.from);
        const after = doc.sliceString(sel.to, Math.min(doc.length, sel.to + CONTEXT_CHARS));
        return { text, from: sel.from, to: sel.to, before, after };
      },
      replaceRange: (from, to, replacement) => {
        const view = viewRef.current;
        if (!view) return;
        view.dispatch({
          changes: { from, to, insert: replacement },
          selection: { anchor: from + replacement.length },
        });
        view.focus();
      },
      getDoc: () => viewRef.current?.state.doc.toString() ?? '',
      scrollToRange: (from, to) => {
        const view = viewRef.current;
        if (!view) return;
        view.dispatch({ selection: EditorSelection.range(from, to) });
      },
      posCoords: (pos) => {
        const view = viewRef.current;
        if (!view) return null;
        return view.coordsAtPos(pos);
      },
    }),
    [],
  );

  return <div ref={hostRef} className="editor-host" />;
});
