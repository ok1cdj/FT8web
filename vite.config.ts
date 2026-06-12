import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import {defineConfig} from 'vite';

export default defineConfig(() => {
  const commitHash = process.env.VERCEL_GIT_COMMIT_SHA 
    ? process.env.VERCEL_GIT_COMMIT_SHA.substring(0, 7) 
    : 'local-dev';
  const buildTime = new Date().toLocaleString('cs-CZ', { timeZone: 'Europe/Prague' });

  return {
    define: {
      __COMMIT_HASH__: JSON.stringify(commitHash),
      __BUILD_TIME__: JSON.stringify(buildTime),
    },
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
      },
    },
    server: {
      // HMR is disabled in AI Studio via DISABLE_HMR env var.
      // Do not modifyâfile watching is disabled to prevent flickering during agent edits.
      hmr: process.env.DISABLE_HMR !== 'true',
      // Disable file watching when DISABLE_HMR is true to save CPU during agent edits.
      watch: process.env.DISABLE_HMR === 'true' ? null : {},
    },
  };
});
