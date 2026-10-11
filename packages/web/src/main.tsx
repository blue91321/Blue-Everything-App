import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { reloadOnStaleBuild } from './stale-build';
import './styles.css';

// Before the first render, so a screen opened straight away is covered too.
reloadOnStaleBuild();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
);

// Registered after load so it never competes with the first render. Without a
// service worker iOS won't treat this as installable at all.
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch((error) => {
      console.warn('service worker registration failed', error);
    });
  });
}
