import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FileGet } from './api';
import { SAVE_DEBOUNCE_MS, syncEngine } from './syncEngine';
import { countWords } from './words';

export type SaveState = 'clean' | 'dirty' | 'saving' | 'saved' | 'error' | 'blocked';

export interface EditorBuffer {
  body: string;
  frontmatter: Record<string, unknown>;
}

// Look up the live editor buffer for a path, non-null only when that path's
// editor currently holds unsaved changes. Lets a conflict on any mounted scene
// lift its buffer as the merge's Editor column, not just the active one.
export type GetEditorBuffer = (path: string) => EditorBuffer | null;

// An editor "holds unsaved changes" when a write is pending, in flight, or
// blocked behind a conflict — the states in which its buffer must join a merge.
export const editorHoldsUnsaved = (state: SaveState): boolean =>
  state === 'dirty' || state === 'saving' || state === 'blocked';

interface UseFileEditorOptions {
  slug: string;
  path: string | null;
  onSaved?: () => void;
}

export function useFileEditor({ slug, path, onSaved }: UseFileEditorOptions) {
  const [file, setFile] = useState<FileGet | null>(null);
  const [body, setBody] = useState('');
  const [frontmatter, setFrontmatter] = useState<Record<string, unknown>>({});
  const [saveState, setSaveState] = useState<SaveState>('clean');
  const [error, setError] = useState<string | null>(null);

  const bodyRef = useRef(body);
  bodyRef.current = body;
  const fmRef = useRef(frontmatter);
  fmRef.current = frontmatter;
  const fileRef = useRef(file);
  fileRef.current = file;
  const saveTimer = useRef<number | null>(null);
  // Bumped on every load; async completions compare against it so a save or
  // reload started for the outgoing file cannot write state over the new one.
  const loadEpoch = useRef(0);

  const wordCount = useMemo(() => countWords(body), [body]);

  // Stable snapshot accessor for the conflict modal's Editor column; reads
  // refs so lifting it into parent header state triggers no re-renders.
  const getBuffer = useCallback((): EditorBuffer | null => {
    if (!fileRef.current) return null;
    return { body: bodyRef.current, frontmatter: fmRef.current };
  }, []);

  useEffect(() => {
    loadEpoch.current += 1;
    if (!slug || !path) return;
    setFile(null);
    setSaveState('clean');
    let cancelled = false;
    syncEngine
      .getFile(slug, path)
      .then((f) => {
        if (cancelled) return;
        setFile(f);
        setBody(f.body);
        setFrontmatter(f.frontmatter);
        setError(null);
      })
      .catch((e) => {
        if (!cancelled) setError(String(e));
      });
    return () => {
      cancelled = true;
      // Flush a pending debounced save before teardown; refs still hold the outgoing file.
      if (saveTimer.current) {
        window.clearTimeout(saveTimer.current);
        saveTimer.current = null;
        void save();
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug, path]);

  useEffect(() => {
    if (!slug || !path) return;
    return syncEngine.onConflictResolved((s, p) => {
      if (s !== slug || p !== path) return;
      // Drop any pending debounced save first: a timer scheduled just before
      // resolution would otherwise fire as a 'queued' write and clobber the
      // freshly resolved canonical.
      if (saveTimer.current) {
        window.clearTimeout(saveTimer.current);
        saveTimer.current = null;
      }
      // Resolve consumed the buffer as a merge input (the three-way modal
      // lifts it as the Editor column), so always reload the canonical.
      const epoch = loadEpoch.current;
      syncEngine.getFile(slug, path).then((f) => {
        if (loadEpoch.current !== epoch) return;
        setFile(f);
        setBody(f.body);
        setFrontmatter(f.frontmatter);
        setSaveState('clean');
        setError(null);
      });
    });
  }, [slug, path]);

  const save = useCallback(async () => {
    if (!slug || !path) return;
    const f = fileRef.current;
    if (!f) return;
    // The queue write below must still land on teardown, but its completion
    // belongs to the file that was loaded when the save started.
    const epoch = loadEpoch.current;
    const sentBody = bodyRef.current;
    const sentFm = fmRef.current;
    setSaveState('saving');
    try {
      const result = await syncEngine.saveFile(slug, path, sentBody, sentFm, f.etag);
      if (loadEpoch.current !== epoch) return;
      if (result === 'blocked') {
        // The write never happened — the file stays dirty behind the conflict.
        setSaveState('blocked');
        return;
      }
      setFile({
        path,
        body: sentBody,
        frontmatter: sentFm,
        etag: f.etag,
        word_count: countWords(sentBody),
      });
      setSaveState('saved');
      setError(null);
      onSaved?.();
    } catch (e) {
      if (loadEpoch.current !== epoch) return;
      setError(String(e));
      setSaveState('error');
    }
  }, [slug, path, onSaved]);

  const scheduleSave = useCallback(() => {
    setSaveState('dirty');
    if (saveTimer.current) window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => {
      saveTimer.current = null;
      save();
    }, SAVE_DEBOUNCE_MS);
  }, [save]);

  const onBodyChange = useCallback(
    (next: string) => {
      setBody(next);
      if (fileRef.current && next !== fileRef.current.body) scheduleSave();
    },
    [scheduleSave],
  );

  return {
    file,
    body,
    frontmatter,
    setFrontmatter,
    saveState,
    error,
    wordCount,
    onBodyChange,
    scheduleSave,
    save,
    getBuffer,
  };
}
