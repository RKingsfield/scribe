import { useEffect, useState } from 'react';

const TOAST_MAX = 4;
const TOAST_DURATION_MS = 4000;

interface ToastItem {
  id: string;
  message: string;
  type: 'info' | 'success' | 'error';
}

let addToast: (message: string, type?: 'info' | 'success' | 'error') => void = () => {};

export function toast(message: string, type: 'info' | 'success' | 'error' = 'info') {
  addToast(message, type);
}

export function ToastContainer() {
  const [items, setItems] = useState<ToastItem[]>([]);

  useEffect(() => {
    addToast = (message, type = 'info') => {
      const id = crypto.randomUUID();
      setItems((prev) => [...prev.slice(-TOAST_MAX), { id, message, type }]);
      setTimeout(() => {
        setItems((prev) => prev.filter((t) => t.id !== id));
      }, TOAST_DURATION_MS);
    };
    return () => { addToast = () => {}; };
  }, []);

  useEffect(() => {
    const handler = () => toast('Update available — reload to apply', 'info');
    window.addEventListener('scribe:sw-update', handler);
    return () => window.removeEventListener('scribe:sw-update', handler);
  }, []);

  if (items.length === 0) return null;

  return (
    <div className="toast-container">
      {items.map((t) => (
        <div
          key={t.id}
          className={`toast toast-${t.type}`}
          onClick={() => setItems((prev) => prev.filter((i) => i.id !== t.id))}
        >
          {t.message}
        </div>
      ))}
    </div>
  );
}
