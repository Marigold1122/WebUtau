import { resolve } from 'node:path'
import { defineConfig } from 'vite'

const CROSS_ORIGIN_ISOLATION_HEADERS = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
}

export default defineConfig({
  server: {
    port: 3000,
    strictPort: true,
    open: true,
    headers: CROSS_ORIGIN_ISOLATION_HEADERS,
    allowedHosts: ['.trycloudflare.com', 'singer.haruyuki.cn'],
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:5000',
        changeOrigin: true,
      },
      '/seedvc/api': {
        target: 'http://127.0.0.1:5001',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/seedvc/, ''),
      },
    },
    watch: {
      // Keep Vite responsive by ignoring large non-frontend trees.
      ignored: [
        '**/$dest/**',
        '**/.playwright-mcp/**',
        '**/backups/**',
        '**/dist/**',
        '**/external/**',
        '**/handoff/**',
        '**/research/**',
        '**/server/**',
      ],
    },
  },
  preview: {
    headers: CROSS_ORIGIN_ISOLATION_HEADERS,
  },
  build: {
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        runtime: resolve(__dirname, 'voice-runtime.html'),
      },
    },
  },
})
