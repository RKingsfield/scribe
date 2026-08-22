export { FLUSH_INTERVAL_MS, SAVE_DEBOUNCE_MS } from './core';
export type { SyncSnapshot } from './core';
export { useOnline } from './hooks';

import { SyncEngine } from './core';
export const syncEngine = new SyncEngine();
