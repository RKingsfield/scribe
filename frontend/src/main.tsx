import React from 'react';
import ReactDOM from 'react-dom/client';
import { App } from './app/App';
import { syncEngine } from './lib/syncEngine';
import { ensureOpen } from './lib/db';

import '@fontsource/source-serif-4/400.css';
import '@fontsource/source-serif-4/400-italic.css';
import '@fontsource/source-serif-4/600.css';
import '@fontsource/source-serif-4/700.css';
import '@fontsource/inter/400.css';
import '@fontsource/inter/500.css';
import '@fontsource/inter/600.css';
import '@fontsource/jetbrains-mono/400.css';

import './styles/index.css';

const savedTheme = localStorage.getItem('scribe.theme');
if (savedTheme === 'light' || savedTheme === 'dark') {
  document.documentElement.setAttribute('data-theme', savedTheme);
}

if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => {
    navigator.serviceWorker
      .register('/sw.js')
      .then((reg) => {
        reg.addEventListener('updatefound', () => {
          const newWorker = reg.installing;
          if (!newWorker) return;
          newWorker.addEventListener('statechange', () => {
            if (
              newWorker.state === 'installed' &&
              navigator.serviceWorker.controller
            ) {
              window.dispatchEvent(
                new CustomEvent('scribe:sw-update'),
              );
            }
          });
        });
      })
      .catch((e) => console.warn('SW register failed', e));
  });
}

ensureOpen()
  .then(() => syncEngine.init())
  .then(() => {
    ReactDOM.createRoot(document.getElementById('root')!).render(
      <React.StrictMode>
        <App />
      </React.StrictMode>,
    );
  })
  .catch((e) => {
    console.error('startup failed', e);
    document.getElementById('root')!.textContent = 'Failed to start — try refreshing.';
  });
