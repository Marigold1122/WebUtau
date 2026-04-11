import { resolve } from 'node:path'
import { defineConfig } from 'vite'

const CROSS_ORIGIN_ISOLATION_HEADERS = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
}

const DEFAULT_FRONTEND_PORT = 3000

function resolveFrontendPort() {
  const rawPort = Number.parseInt(process.env.MELODY_FRONTEND_PORT || '', 10)
  return Number.isFinite(rawPort) && rawPort > 0 ? rawPort : DEFAULT_FRONTEND_PORT
}

/** 为音频静态资源设置 Content-Disposition: inline，防止 IDM 等下载管理器拦截 */
function audioInlinePlugin() {
  return {
    name: 'audio-inline-headers',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (/\.(mp3|wav|ogg|flac)(\?|$)/i.test(req.url)) {
          res.setHeader('Content-Disposition', 'inline')
        }
        next()
      })
    },
  }
}

export default defineConfig({
  plugins: [audioInlinePlugin()],
  server: {
    port: resolveFrontendPort(),
    strictPort: true,
    open: process.env.MELODY_TAURI_DEV !== '1',
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
