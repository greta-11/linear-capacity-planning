import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const apiPort = Number(process.env.PORT ?? 4000);

export default defineConfig({
  root: 'client',
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: 5173,
    fs: { allow: ['..'] },
    proxy: { '/api': `http://127.0.0.1:${apiPort}` },
  },
  build: { outDir: '../dist/client', emptyOutDir: true },
});
