import { useState } from 'react';
import { X } from 'lucide-react';
import { Category } from '../../lib/api';

interface Props {
  initial: Category[];
  onSave: (categories: Category[]) => Promise<void>;
  onClose: () => void;
}

function slugify(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'untitled';
}

export function CategoriesEditor({ initial, onSave, onClose }: Props) {
  const [cats, setCats] = useState<Category[]>(() =>
    initial.map((c) => ({ ...c })),
  );
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const update = (i: number, patch: Partial<Category>) =>
    setCats((prev) => prev.map((c, j) => (i === j ? { ...c, ...patch } : c)));

  const remove = (i: number) =>
    setCats((prev) => prev.filter((_, j) => j !== i));

  const add = () =>
    setCats((prev) => [
      ...prev,
      { name: '', folder: '', codex: false },
    ]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      const cleaned: Category[] = cats
        .filter((c) => c.name.trim())
        .map((c) => ({
          name: c.name.trim(),
          folder: c.folder.trim() || slugify(c.name),
          codex: c.codex,
        }));
      const folders = cleaned.map((c) => c.folder);
      if (new Set(folders).size !== folders.length) {
        setErr('Each category must have a unique folder name');
        setBusy(false);
        return;
      }
      await onSave(cleaned);
      onClose();
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <header className="modal-header">
          <h2>Manage categories</h2>
          <button onClick={onClose}><X size={16} /></button>
        </header>
        <form onSubmit={submit} className="categories-editor">
          {cats.length === 0 && <p className="empty">No categories.</p>}
          {cats.map((c, i) => (
            <div key={i} className="category-row">
              <input
                value={c.name}
                onChange={(e) => {
                  const name = e.target.value;
                  const autoFolder = !c.folder || c.folder === slugify(cats[i].name);
                  update(i, {
                    name,
                    ...(autoFolder ? { folder: slugify(name) } : {}),
                  });
                }}
                placeholder="Category name"
                className="cat-name"
              />
              <input
                value={c.folder}
                onChange={(e) => update(i, { folder: e.target.value })}
                placeholder="folder"
                className="cat-folder"
                title="Folder name on disk"
              />
              <label className="cat-codex" title="Highlight names in editor">
                <input
                  type="checkbox"
                  checked={c.codex}
                  onChange={(e) => update(i, { codex: e.target.checked })}
                />
                codex
              </label>
              <button type="button" onClick={() => remove(i)}>
                <X size={14} />
              </button>
            </div>
          ))}
          <div className="modal-actions">
            <button type="button" onClick={add}>
              + Add category
            </button>
            <button type="submit" disabled={busy}>
              {busy ? 'Saving…' : 'Save'}
            </button>
          </div>
          {err && <p className="error">{err}</p>}
        </form>
      </div>
    </div>
  );
}
