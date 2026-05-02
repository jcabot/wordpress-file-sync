import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const SERVER_PORT = Number(process.env['WPSYNC_PORT'] ?? 4319);
const CLIENT_PORT = Number(process.env['WPSYNC_CLIENT_PORT'] ?? 5173);

export default defineConfig({
  root: __dirname,
  plugins: [react()],
  build: {
    outDir: '../dist-client',
    emptyOutDir: true,
  },
  server: {
    host: '127.0.0.1',
    port: CLIENT_PORT,
    strictPort: false,
    proxy: {
      '/api': {
        target: `http://127.0.0.1:${SERVER_PORT}`,
        changeOrigin: false,
        ws: false,
      },
    },
  },
});
