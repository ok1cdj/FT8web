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
        // Force update check on page load to see if a newer sw.js is available
        registration.update();
      })
      .catch((error) => {
        console.error('[PWA] Service Worker registration failed:', error);
      });
  });

  // Automatically refresh the page when a new service worker takes over control
  let refreshing = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!refreshing) {
      refreshing = true;
      console.log('[PWA] New Service Worker active, reloading for latest updates...');
      window.location.reload();
    }
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

// --- Eruda Mobile DevTools / Console Console Initialization ---
(() => {
  const isMobile = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);
  const debugQuery = window.location.search.includes('eruda=true') || window.location.search.includes('debug=true');
  if (isMobile || debugQuery) {
    const script = document.createElement('script');
    script.src = 'https://cdn.jsdelivr.net/npm/eruda';
    script.async = true;
    script.onload = () => {
      if ((window as any).eruda) {
        (window as any).eruda.init({
          defaults: {
            displaySize: 50,
            theme: 'Dark'
          }
        });
        console.log('[Eruda] Mobile developer console initialized successfully.');
      }
    };
    script.onerror = () => {
      console.error('[Eruda] Failed to load Eruda devtools script from CDN.');
    };
    document.head.appendChild(script);
  }
})();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
