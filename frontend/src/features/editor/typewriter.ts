import { Compartment, Extension } from '@codemirror/state';
import { EditorView, ViewPlugin, ViewUpdate } from '@codemirror/view';

const TYPEWRITER_THEME = EditorView.theme({
  '&.cm-typewriter .cm-content': {
    paddingTop: '45vh',
    paddingBottom: '45vh',
  },
});

// editorAttributes, not view.dom.classList — CM6 recomputes the class attribute from
// facets on every update (e.g. focus changes), which clobbers directly-mutated classList entries
const TYPEWRITER_CLASS = EditorView.editorAttributes.of({ class: 'cm-typewriter' });

const TYPEWRITER_PLUGIN = ViewPlugin.fromClass(
  class {
    private destroyed = false;
    constructor(public view: EditorView) {
      queueMicrotask(() => this.recenter());
    }
    update(u: ViewUpdate) {
      // dispatch is forbidden synchronously inside update(); defer to a microtask
      if (u.selectionSet || u.docChanged) queueMicrotask(() => this.recenter());
    }
    destroy() {
      this.destroyed = true;
    }
    private recenter() {
      if (this.destroyed) return;
      const head = this.view.state.selection.main.head;
      this.view.dispatch({
        effects: EditorView.scrollIntoView(head, { y: 'center' }),
      });
    }
  },
);

export const typewriterCompartment = new Compartment();

export function typewriterEnabled(): Extension {
  return [TYPEWRITER_THEME, TYPEWRITER_CLASS, TYPEWRITER_PLUGIN];
}

export function typewriterDisabled(): Extension {
  return [];
}

export function setTypewriter(view: EditorView, on: boolean) {
  view.dispatch({
    effects: typewriterCompartment.reconfigure(
      on ? typewriterEnabled() : typewriterDisabled(),
    ),
  });
}
