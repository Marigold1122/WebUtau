import { resolve, join } from 'node:path'
import { tmpdir } from 'node:os'
import { readFileSync } from 'node:fs'
import { readFile as readFilePromise, rm as rmPromise } from 'node:fs/promises'
import { defineConfig } from 'vite'

// 读取 package.json 的 version，注入给前端用于「关于」页显示
const PACKAGE_VERSION = (() => {
  try {
    const raw = readFileSync(resolve(__dirname, 'package.json'), 'utf8')
    return JSON.parse(raw).version || '0.0.0'
  } catch {
    return '0.0.0'
  }
})()

const TUNNEL_STATUS_FILE = process.env.MELODY_TUNNEL_STATUS_FILE
  || join(tmpdir(), 'webutau-tunnel-status.json')

const DISABLED_TUNNEL_STATUS = {
  available: false,
  manualStart: false,
  state: 'disabled',
  url: null,
  downloadedBytes: 0,
  totalBytes: 0,
  message: '隧道服务未启动；通过 dev-mac.sh / dev.bat 启动可自动开启，或设置 MELODY_TUNNEL=1',
  error: null,
  source: 'web',
  updatedAt: 0,
}

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

/** 打包结束后清掉 public/ 里被复制进来的 macOS .DS_Store */
function stripDsStorePlugin() {
  return {
    name: 'strip-ds-store',
    apply: 'build',
    async closeBundle() {
      const outDir = resolve(__dirname, 'dist')
      await rmPromise(join(outDir, '.DS_Store'), { force: true }).catch(() => {})
    },
  }
}

/** 暴露 cloudflare tunnel 的状态文件给前端轮询 */
function tunnelStatusPlugin() {
  const handler = async (req, res, next) => {
    if (!req.url) return next()
    const path = req.url.split('?')[0]
    if (path !== '/__tunnel/status') return next()
    if (req.method !== 'GET') {
      res.statusCode = 405
      res.end()
      return
    }
    let payload
    try {
      const text = await readFilePromise(TUNNEL_STATUS_FILE, 'utf8')
      JSON.parse(text)
      payload = text
    } catch {
      payload = JSON.stringify(DISABLED_TUNNEL_STATUS)
    }
    res.setHeader('Content-Type', 'application/json; charset=utf-8')
    res.setHeader('Cache-Control', 'no-store')
    res.end(payload)
  }

  return {
    name: 'tunnel-status-endpoint',
    configureServer(server) {
      // 同步注册 → 在 vite 内部 middlewares（含 SPA fallback）之前匹配
      server.middlewares.use(handler)
    },
    configurePreviewServer(server) {
      server.middlewares.use(handler)
    },
  }
}

export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify(PACKAGE_VERSION),
  },
  plugins: [audioInlinePlugin(), tunnelStatusPlugin(), stripDsStorePlugin()],
  server: {
    port: resolveFrontendPort(),
    strictPort: true,
    open: process.env.MELODY_TAURI_DEV !== '1',
    headers: CROSS_ORIGIN_ISOLATION_HEADERS,
    allowedHosts: ['.trycloudflare.com', 'singer.haruyuki.cn'],
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:38510',
        changeOrigin: true,
      },
      '/seedvc/api': {
        target: 'http://127.0.0.1:38511',
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
