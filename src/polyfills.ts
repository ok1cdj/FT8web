import { serial as bundledPolyfill } from 'web-serial-polyfill';

// Extension interface for strict TypeScript typing
declare global {
  interface Navigator {
    serial?: any;
  }
}

(() => {
  const isAndroid = /Android/i.test(navigator.userAgent);
  const hasUsb = !!(navigator as any).usb;

  if (isAndroid) {
    if (hasUsb) {
      console.log('[WebSerial Polyfill] Android platform detected with WebUSB capability. Force-patching navigator.serial with polyfill.');
      try {
        Object.defineProperty(navigator, 'serial', {
          value: bundledPolyfill,
          configurable: true,
          writable: true,
          enumerable: true
        });
        console.log('[WebSerial Polyfill] Successfully forced polyfill on navigator.serial.');
      } catch (err) {
        console.error('[WebSerial Polyfill] Failed to force-patch navigator.serial:', err);
      }
    } else {
      console.warn('[WebSerial Polyfill] Running on Android, but WebUSB is not available in this browser context.');
    }
  } else {
    // Non-Android platforms: Fallback to polyfill ONLY if native serial is absent
    if (!navigator.serial && hasUsb) {
      console.log('[WebSerial Polyfill] Non-Android platform with no native Web Serial detected. Registering WebUSB polyfill fallback.');
      try {
        Object.defineProperty(navigator, 'serial', {
          value: bundledPolyfill,
          configurable: true,
          writable: true,
          enumerable: true
        });
      } catch (err) {
        console.error('[WebSerial Polyfill] Failed to register fallback:', err);
      }
    } else if (navigator.serial) {
      console.log('[WebSerial] Native Web Serial is supported on this desktop/platform. Polyfill is inactive.');
    }
  }
})();
