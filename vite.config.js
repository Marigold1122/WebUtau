import { resolve } from 'node:path'
import { defineConfig } from 'vite'

export default defineConfig({
  server: {
    port: 3000,
    open: true,
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
  build: {
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        runtime: resolve(__dirname, 'voice-runtime.html'),
      },
    },
  },
})
