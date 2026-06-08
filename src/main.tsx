import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import App from './App.tsx';
import './index.css';

// --- PWA Registration and Connection Monitoring ---
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js')
      .then((registration) => {
        console.log('[PWA] Service Worker registered in scope:', registration.scope);
      })
      .catch((error) => {
        console.error('[PWA] Service Worker registration failed:', error);
      });
  });
}

// Global network state monitoring (can be exported or hooked into React context later)
window.addEventListener('online', () => {
  console.log('[PWA] Global Network State: ONLINE');
  // You can trigger custom events here to update React UI state if needed
  window.dispatchEvent(new CustomEvent('app-network-state', { detail: { isOnline: true } }));
});

window.addEventListener('offline', () => {
  console.log('[PWA] Global Network State: OFFLINE');
  window.dispatchEvent(new CustomEvent('app-network-state', { detail: { isOnline: false } }));
});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
