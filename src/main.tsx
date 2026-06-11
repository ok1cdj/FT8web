import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import App from './App.tsx';
import './index.css';
import { serial as bundledPolyfill } from 'web-serial-polyfill';

// Add type declaration for Navigator.serial override
declare global {
  interface Navigator {
    serial?: any;
  }
}

// --- Web Serial Polyfill fallback for Android compatibility using WebUSB mapping ---
(() => {
  if (!navigator.serial && (navigator as any).usb) {
    try {
      Object.defineProperty(navigator, 'serial', {
        value: bundledPolyfill,
        configurable: true,
        writable: true
      });
      console.log('[WebSerial Polyfill] No native Web Serial detected but WebUSB is supported. Overrode navigator.serial with WebUSB Polyfill for Android compatibility.');
    } catch (err) {
      console.error('[WebSerial Polyfill] Failed to patch navigator.serial:', err);
    }
  } else if (navigator.serial) {
    console.log('[WebSerial] Native Web Serial is supported by this browser. Polyfill fallback is dormant.');
  } else {
    console.warn('[WebSerial] Neither native Web Serial nor WebUSB is supported on this platform.');
  }
})();

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
