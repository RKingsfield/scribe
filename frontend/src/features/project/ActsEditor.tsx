import { useState } from 'react';
import { X } from 'lucide-react';
import { Act } from '../../lib/api';

interface Props {
  initial: Act[];
  onSave: (acts: Act[]) => Promise<void>;
  onClose: () => void;
}

export function ActsEditor({ initial, onSave, onClose }: Props) {
  const [acts, setActs] = useState<Act[]>(() =>
    initial.map((a) => ({ ...a })),
  );
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const update = (i: number, name: string) =>
    setActs((prev) => prev.map((a, j) => (i === j ? { ...a, name } : a)));

  const remove = (i: number) =>
    setActs((prev) => prev.filter((_, j) => j !== i));

  const add = () =>
    setActs((prev) => [...prev, { name: `Act ${prev.length + 1}` }]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      const cleaned: Act[] = acts.map((a) => ({
        name: a.name.trim() || 'Untitled act',
      }));
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
          <h2>Edit acts</h2>
          <button onClick={onClose}><X size={16} /></button>
        </header>
        <form onSubmit={submit} className="acts-editor">
          {acts.length === 0 && <p className="empty">No acts yet.</p>}
          {acts.map((a, i) => (
            <div key={i} className="act-row">
              <input
                value={a.name}
                onChange={(e) => update(i, e.target.value)}
                placeholder="Act name"
              />
              <button type="button" onClick={() => remove(i)}>
                <X size={14} />
              </button>
            </div>
          ))}
          <div className="modal-actions">
            <button type="button" onClick={add}>
              + Add act
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
