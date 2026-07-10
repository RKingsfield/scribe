import { Compartment, Extension } from '@codemirror/state';
import { EditorView, ViewPlugin, ViewUpdate } from '@codemirror/view';

const TYPEWRITER_THEME = EditorView.theme({
  '&.cm-typewriter .cm-content': {
    paddingTop: '45vh',
    paddingBottom: '45vh',
  },
});

const TYPEWRITER_PLUGIN = ViewPlugin.fromClass(
  class {
    constructor(public view: EditorView) {
      view.dom.classList.add('cm-typewriter');
      queueMicrotask(() => this.recenter());
    }
    update(u: ViewUpdate) {
      if (u.selectionSet || u.docChanged) this.recenter();
    }
    destroy() {
      this.view.dom.classList.remove('cm-typewriter');
    }
    private recenter() {
      const head = this.view.state.selection.main.head;
      this.view.dispatch({
        effects: EditorView.scrollIntoView(head, { y: 'center' }),
      });
    }
  },
);

export const typewriterCompartment = new Compartment();

export function typewriterEnabled(): Extension {
  return [TYPEWRITER_THEME, TYPEWRITER_PLUGIN];
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
