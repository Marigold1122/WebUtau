#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { mkdir, chmod, access, rm, writeFile, unlink } from 'node:fs/promises'
import { createWriteStream } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { pipeline } from 'node:stream/promises'
import { Readable } from 'node:stream'

const __filename = fileURLToPath(import.meta.url)
const ROOT = join(dirname(__filename), '..')
const CACHE_DIR = join(ROOT, 'external', 'cloudflared')
const URL_REGEX = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i
const RELEASE_BASE = 'https://github.com/cloudflare/cloudflared/releases/latest/download/'

function parseArgs() {
  const args = process.argv.slice(2)
  let port = 3000
  let urlFile = null
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]
    if (arg === '--port' || arg === '-p') {
      port = Number.parseInt(args[++i], 10)
    } else if (arg.startsWith('--port=')) {
      port = Number.parseInt(arg.slice('--port='.length), 10)
    } else if (arg === '--url-file') {
      urlFile = args[++i]
    } else if (arg.startsWith('--url-file=')) {
      urlFile = arg.slice('--url-file='.length)
    }
  }
  if (!Number.isFinite(port) || port <= 0) {
    console.error('[tunnel] 无效的端口参数')
    process.exit(2)
  }
  return { port, urlFile }
}

function detectAsset() {
  const { platform, arch } = process
  if (platform === 'darwin') {
    const file = arch === 'arm64' ? 'cloudflared-darwin-arm64.tgz' : 'cloudflared-darwin-amd64.tgz'
    return { url: RELEASE_BASE + file, archive: 'tgz', binary: 'cloudflared' }
  }
  if (platform === 'linux') {
    const map = {
      x64: 'cloudflared-linux-amd64',
      arm64: 'cloudflared-linux-arm64',
      arm: 'cloudflared-linux-arm',
      ia32: 'cloudflared-linux-386',
    }
    const file = map[arch]
    if (!file) throw new Error(`不支持的 Linux 架构: ${arch}`)
    return { url: RELEASE_BASE + file, archive: 'raw', binary: 'cloudflared' }
  }
  if (platform === 'win32') {
    const file = arch === 'arm64' ? 'cloudflared-windows-arm64.exe' : 'cloudflared-windows-amd64.exe'
    return { url: RELEASE_BASE + file, archive: 'raw', binary: 'cloudflared.exe' }
  }
  throw new Error(`不支持的平台: ${platform}`)
}

async function fileExists(path) {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

async function fetchFollowRedirect(url, maxRedirects = 8) {
  let current = url
  for (let i = 0; i < maxRedirects; i += 1) {
    const res = await fetch(current, { redirect: 'manual' })
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get('location')
      if (!location) throw new Error(`重定向缺少 location: ${current}`)
      current = new URL(location, current).toString()
      continue
    }
    if (!res.ok) throw new Error(`下载失败 ${res.status}: ${current}`)
    return res
  }
  throw new Error('重定向次数过多')
}

function formatMB(bytes) {
  return (bytes / 1024 / 1024).toFixed(1)
}

async function downloadTo(url, dest) {
  const res = await fetchFollowRedirect(url)
  if (!res.body) throw new Error('响应没有 body')
  const totalHeader = Number.parseInt(res.headers.get('content-length') || '0', 10)
  const total = Number.isFinite(totalHeader) && totalHeader > 0 ? totalHeader : 0
  let received = 0
  let lastReport = 0
  const reportInterval = 1000

  const source = Readable.fromWeb(res.body)
  source.on('data', (chunk) => {
    received += chunk.length
    const now = Date.now()
    if (now - lastReport >= reportInterval) {
      lastReport = now
      if (total > 0) {
        const pct = Math.floor((received / total) * 100)
        console.error(`[tunnel] 下载进度: ${formatMB(received)} / ${formatMB(total)} MB (${pct}%)`)
      } else {
        console.error(`[tunnel] 下载进度: ${formatMB(received)} MB`)
      }
    }
  })
  await pipeline(source, createWriteStream(dest))
  if (total > 0) {
    console.error(`[tunnel] 下载完成: ${formatMB(received)} / ${formatMB(total)} MB ✓`)
  } else {
    console.error(`[tunnel] 下载完成: ${formatMB(received)} MB ✓`)
  }
}

async function extractTgz(archivePath, destDir) {
  return new Promise((resolve, reject) => {
    const proc = spawn('tar', ['-xzf', archivePath, '-C', destDir], { stdio: 'inherit' })
    proc.on('error', reject)
    proc.on('exit', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`tar 解压失败，退出码 ${code}`))
    })
  })
}

async function ensureBinary() {
  const asset = detectAsset()
  const binPath = join(CACHE_DIR, asset.binary)
  if (await fileExists(binPath)) return binPath

  await mkdir(CACHE_DIR, { recursive: true })
  console.error('[tunnel] ─────────────────────────────────────────────')
  console.error('[tunnel] 准备 Cloudflare quick tunnel')
  console.error('[tunnel] 用途：把本地服务暴露为临时公网链接，便于分享给他人访问')
  console.error('[tunnel] 首次启动需要从 GitHub 下载 cloudflared（约 20–35 MB）')
  console.error(`[tunnel] 下载来源: ${asset.url}`)
  console.error('[tunnel] 此过程在后台进行，不会阻塞前后端服务，可继续在本地使用')
  console.error('[tunnel] ─────────────────────────────────────────────')

  if (asset.archive === 'tgz') {
    const tmpFile = join(CACHE_DIR, '_download.tgz')
    try {
      await downloadTo(asset.url, tmpFile)
      console.error('[tunnel] 解压中 ...')
      await extractTgz(tmpFile, CACHE_DIR)
    } finally {
      await rm(tmpFile, { force: true })
    }
  } else {
    await downloadTo(asset.url, binPath)
  }

  if (process.platform !== 'win32') {
    await chmod(binPath, 0o755)
  }

  if (!(await fileExists(binPath))) {
    throw new Error(`下载完成但未找到二进制: ${binPath}`)
  }

  console.error('[tunnel] cloudflared 已就绪')
  return binPath
}

function makeLineSplitter(onLine) {
  let buffer = ''
  return (chunk) => {
    buffer += chunk.toString('utf8')
    let idx
    while ((idx = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, idx).replace(/\r$/, '')
      buffer = buffer.slice(idx + 1)
      if (line.length > 0) onLine(line)
    }
  }
}

async function main() {
  const { port, urlFile } = parseArgs()

  if (urlFile) await unlink(urlFile).catch(() => {})

  let binPath
  try {
    binPath = await ensureBinary()
  } catch (err) {
    console.error('[tunnel] ─────────────────────────────────────────────')
    console.error(`[tunnel] cloudflared 准备失败: ${err?.message || err}`)
    console.error('[tunnel] 可能原因：')
    console.error('[tunnel]   1) 网络无法访问 GitHub（部分地区不稳定，或被代理/防火墙拦截）')
    console.error('[tunnel]   2) 磁盘写入权限不足')
    console.error('[tunnel]   3) tar 解压工具缺失（macOS/Linux 需系统自带的 tar）')
    console.error('[tunnel] 影响范围：仅外网公开链接不可用，前后端服务不受影响，仍可在本地使用 http://127.0.0.1:<port>')
    console.error('[tunnel] 处理方式：稍后重试启动；或设置环境变量 MELODY_TUNNEL=0 跳过此步')
    console.error('[tunnel] ─────────────────────────────────────────────')
    process.exit(1)
  }

  console.error(`[tunnel] 启动 cloudflared quick tunnel → http://127.0.0.1:${port}`)

  const child = spawn(binPath, [
    'tunnel',
    '--no-autoupdate',
    '--url', `http://127.0.0.1:${port}`,
  ], { stdio: ['ignore', 'pipe', 'pipe'] })

  let publicUrl = null

  const handleLine = (line) => {
    process.stdout.write(line + '\n')
    if (publicUrl) return
    const match = line.match(URL_REGEX)
    if (!match) return
    publicUrl = match[0]
    console.error('')
    console.error('[tunnel] ═════════════════════════════════════════════════════')
    console.error('[tunnel]   公开访问地址 (临时, 每次启动都会变):')
    console.error(`[tunnel]   ${publicUrl}`)
    console.error('[tunnel]   分享给他人即可访问；关闭本进程会停止外网访问。')
    console.error('[tunnel] ═════════════════════════════════════════════════════')
    console.error('')
    if (urlFile) {
      writeFile(urlFile, publicUrl + '\n', 'utf8').catch((err) => {
        console.error(`[tunnel] 写入 url-file 失败: ${err?.message || err}`)
      })
    }
  }

  const stdoutSplitter = makeLineSplitter(handleLine)
  const stderrSplitter = makeLineSplitter(handleLine)
  child.stdout.on('data', stdoutSplitter)
  child.stderr.on('data', stderrSplitter)

  let cleanedUp = false
  const cleanup = () => {
    if (cleanedUp) return
    cleanedUp = true
    if (!child.killed) {
      try { child.kill('SIGTERM') } catch {}
    }
  }
  process.on('SIGINT', cleanup)
  process.on('SIGTERM', cleanup)
  process.on('exit', cleanup)

  child.on('exit', (code, signal) => {
    if (signal) console.error(`[tunnel] cloudflared 已退出 (信号 ${signal})`)
    else console.error(`[tunnel] cloudflared 已退出 (退出码 ${code})`)
    process.exit(code ?? 0)
  })

  child.on('error', (err) => {
    console.error(`[tunnel] cloudflared 启动失败: ${err?.message || err}`)
    process.exit(1)
  })
}

main().catch((err) => {
  console.error('[tunnel] 致命错误:', err)
  process.exit(1)
})
