import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { config as loadDotEnv } from 'dotenv';
import path from 'path';
import {defineConfig} from 'vite';

loadDotEnv({ path: path.resolve(__dirname, 'trading-bot-backend/.env') });

export default defineConfig(() => {
  const backendTarget = process.env.BACKEND_URL || 'http://127.0.0.1:3001';
  return {
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
      },
    },
    server: {
      proxy: {
        '/api/control': {
          target: backendTarget,
          changeOrigin: true,
          rewrite: (requestPath) => requestPath.replace(/^\/api\/control/, '/api'),
          configure: (proxy) => {
            proxy.on('proxyReq', (proxyRequest) => {
              if (process.env.BOT_CONTROL_TOKEN) {
                proxyRequest.setHeader('Authorization', `Bearer ${process.env.BOT_CONTROL_TOKEN}`);
              }
            });
          },
        },
        '/api': {
          target: backendTarget,
          changeOrigin: true,
        },
      },
      // HMR is disabled in AI Studio via DISABLE_HMR env var.
      // Do not modify—file watching is disabled to prevent flickering during agent edits.
      hmr: process.env.DISABLE_HMR !== 'true',
      // Disable file watching when DISABLE_HMR is true to save CPU during agent edits.
      watch: process.env.DISABLE_HMR === 'true' ? null : {},
    },
  };
});
