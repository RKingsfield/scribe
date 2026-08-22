import { describe, it, expect, vi, afterEach } from 'vitest';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { typewriterCompartment, typewriterDisabled, setTypewriter } from '../typewriter';

describe('typewriter plugin', () => {
  let view: EditorView | undefined;

  afterEach(() => {
    view?.destroy();
    view = undefined;
  });

  it('survives a doc change without crashing (plugin stays active)', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    // mirrors real usage: typewriter starts off, toggled on later via setTypewriter
    const state = EditorState.create({
      doc: 'hello world',
      extensions: [typewriterCompartment.of(typewriterDisabled())],
    });
    view = new EditorView({ state, parent: document.body });

    setTypewriter(view, true);
    // flush the constructor's queued microtask before triggering the update we care about
    await Promise.resolve();
    expect(view.dom.classList.contains('cm-typewriter')).toBe(true);

    view.dispatch({
      changes: { from: 0, insert: '!' },
    });

    // recenter() is deferred to a microtask from within update(); flush it
    await Promise.resolve();

    expect(errorSpy).not.toHaveBeenCalled();
    expect(view.dom.classList.contains('cm-typewriter')).toBe(true);

    errorSpy.mockRestore();
  });
});
