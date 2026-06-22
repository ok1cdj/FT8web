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
  };
});
