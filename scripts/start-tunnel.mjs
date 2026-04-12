#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { mkdir, chmod, access, rm, writeFile, readFile as readFileAsync, stat as statAsync } from 'node:fs/promises'
import { writeFileSync } from 'node:fs'
import { createWriteStream } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { pipeline } from 'node:stream/promises'
import { Readable } from 'node:stream'

const __filename = fileURLToPath(import.meta.url)
const ROOT = join(dirname(__filename), '..')
const CACHE_DIR = join(ROOT, 'external', 'cloudflared')
const URL_REGEX = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i
const RELEASE_BASE = 'https://github.com/cloudflare/cloudflared/releases/latest/download/'
const DEFAULT_STATUS_FILE = join(tmpdir(), 'webutau-tunnel-status.json')

function parseArgs() {
  const args = process.argv.slice(2)
  let port = 3000
  let statusFile = process.env.MELODY_TUNNEL_STATUS_FILE || DEFAULT_STATUS_FILE
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]
    if (arg === '--port' || arg === '-p') {
      port = Number.parseInt(args[++i], 10)
    } else if (arg.startsWith('--port=')) {
      port = Number.parseInt(arg.slice('--port='.length), 10)
    } else if (arg === '--status-file') {
      statusFile = args[++i]
    } else if (arg.startsWith('--status-file=')) {
      statusFile = arg.slice('--status-file='.length)
    } else if (arg === '--url-file' || arg.startsWith('--url-file=')) {
      // 兼容旧用法：忽略 url-file 参数（状态文件取代）
      if (arg === '--url-file') i += 1
    }
  }
  if (!Number.isFinite(port) || port <= 0) {
    console.error('[tunnel] 无效的端口参数')
    process.exit(2)
  }
  return { port, statusFile }
}

const status = {
  available: true,
  manualStart: false,
  state: 'preparing',
  url: null,
  downloadedBytes: 0,
  totalBytes: 0,
  message: '正在准备',
  error: null,
  source: 'web',
  updatedAt: Date.now(),
}

let statusFilePath = null
let lastStatusWriteAt = 0

function writeStatusFileNow() {
  if (!statusFilePath) return
  try {
    writeFileSync(statusFilePath, JSON.stringify(status), 'utf8')
  } catch (err) {
    console.error(`[tunnel] 写入状态文件失败: ${err?.message || err}`)
  }
}

function emitStatus(partial, { force = false } = {}) {
  Object.assign(status, partial)
  status.updatedAt = Date.now()
  const now = Date.now()
  if (force || status.state !== 'downloading' || now - lastStatusWriteAt >= 250) {
    lastStatusWriteAt = now
    writeStatusFileNow()
  }
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

async function fetchBinary(url) {
  const res = await fetch(url, { redirect: 'follow' })
  if (!res.ok) throw new Error(`下载失败 ${res.status}: ${url}`)
  return res
}

function formatMB(bytes) {
  return (bytes / 1024 / 1024).toFixed(1)
}

async function downloadTo(url, dest) {
  const res = await fetchBinary(url)
  if (!res.body) throw new Error('响应没有 body')
  const totalHeader = Number.parseInt(res.headers.get('content-length') || '0', 10)
  const total = Number.isFinite(totalHeader) && totalHeader > 0 ? totalHeader : 0
  let received = 0
  let lastReport = 0
  const reportInterval = 1000

  emitStatus({
    state: 'downloading',
    downloadedBytes: 0,
    totalBytes: total,
    message: '正在下载 cloudflared',
  }, { force: true })

  const source = Readable.fromWeb(res.body)
  source.on('data', (chunk) => {
    received += chunk.length
    emitStatus({ downloadedBytes: received, totalBytes: total })
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
  emitStatus({ downloadedBytes: received, totalBytes: total }, { force: true })
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
  if (await fileExists(binPath)) {
    try {
      await verifyExecutable(binPath)
      return binPath
    } catch (err) {
      console.error(`[tunnel] 已缓存的二进制无效，将重新下载: ${err?.message || err}`)
    }
  }

  await mkdir(CACHE_DIR, { recursive: true })
  console.error('[tunnel] ─────────────────────────────────────────────')
  console.error('[tunnel] 准备 Cloudflare quick tunnel')
  console.error('[tunnel] 用途：把本地服务暴露为临时公网链接，便于分享给他人访问')
  console.error('[tunnel] 首次启动需要从 GitHub 下载 cloudflared（约 20–35 MB）')
  console.error(`[tunnel] 下载来源: ${asset.url}`)
  console.error('[tunnel] 此过程在后台进行，不会阻塞前后端服务，可继续在本地使用')
  console.error('[tunnel] ─────────────────────────────────────────────')

  emitStatus({
    state: 'preparing',
    message: '首次启动，正在下载 cloudflared (~20-35 MB)',
  }, { force: true })

  if (asset.archive === 'tgz') {
    const tmpFile = join(CACHE_DIR, '_download.tgz')
    try {
      await downloadTo(asset.url, tmpFile)
      console.error('[tunnel] 解压中 ...')
      emitStatus({ state: 'preparing', message: '正在解压 cloudflared' }, { force: true })
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

  await verifyExecutable(binPath)

  console.error('[tunnel] cloudflared 已就绪')
  return binPath
}

async function verifyExecutable(binPath) {
  const info = await statAsync(binPath)
  if (info.size < 10_000_000) {
    await rm(binPath, { force: true })
    throw new Error(
      `下载的文件异常小 (${(info.size / 1024 / 1024).toFixed(1)} MB)，cloudflared 正常应大于 10 MB。`
      + ' 可能是下载中断、代理/防火墙拦截返回了错误页面。'
      + ' 请检查网络环境后重试。已删除无效文件。',
    )
  }
  const header = new Uint8Array(await readFileAsync(binPath).then((buf) => buf.buffer.slice(0, 4)))
  const isMachO = header[0] === 0xCF && header[1] === 0xFA
  const isPE = header[0] === 0x4D && header[1] === 0x5A
  const isELF = header[0] === 0x7F && header[1] === 0x45 && header[2] === 0x4C && header[3] === 0x46
  if (!isMachO && !isPE && !isELF) {
    await rm(binPath, { force: true })
    throw new Error(
      '下载的文件不是有效的可执行文件（文件头校验失败）。'
      + ' 可能原因：代理/防火墙拦截了 GitHub 下载，返回了 HTML 错误页面。'
      + ' 请检查网络环境后重试。已删除无效文件。',
    )
  }
  const expectedPE = process.platform === 'win32'
  const expectedMachO = process.platform === 'darwin'
  const expectedELF = process.platform === 'linux'
  if ((expectedPE && !isPE) || (expectedMachO && !isMachO) || (expectedELF && !isELF)) {
    await rm(binPath, { force: true })
    throw new Error(
      `下载的文件是有效可执行文件，但与当前平台 (${process.platform}) 不匹配。`
      + ' 已删除，重试将重新下载正确版本。',
    )
  }
  // Smoke-test: try running the binary to catch truncated/corrupted files
  await new Promise((resolve, reject) => {
    const proc = spawn(binPath, ['version'], { stdio: ['ignore', 'pipe', 'pipe'], timeout: 10_000 })
    proc.on('error', (err) => {
      rm(binPath, { force: true }).finally(() => {
        reject(new Error(
          `cloudflared 无法启动 (${err.code || err.message})，文件可能损坏或下载不完整。`
          + ' 已删除，重试将重新下载。',
        ))
      })
    })
    proc.on('exit', (code) => {
      if (code === 0) resolve()
      else {
        rm(binPath, { force: true }).finally(() => {
          reject(new Error(
            `cloudflared version 退出码 ${code}，文件可能损坏。已删除，重试将重新下载。`,
          ))
        })
      }
    })
  })
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
  const { port, statusFile } = parseArgs()
  statusFilePath = statusFile

  emitStatus({
    state: 'preparing',
    message: '正在准备 cloudflared',
    available: true,
    manualStart: false,
    source: 'web',
  }, { force: true })

  let binPath
  try {
    binPath = await ensureBinary()
  } catch (err) {
    const errMsg = err?.message || String(err)
    console.error('[tunnel] ─────────────────────────────────────────────')
    console.error(`[tunnel] cloudflared 准备失败: ${errMsg}`)
    console.error('[tunnel] 可能原因：')
    console.error('[tunnel]   1) 网络无法访问 GitHub（部分地区不稳定，或被代理/防火墙拦截）')
    console.error('[tunnel]   2) 磁盘写入权限不足')
    console.error('[tunnel]   3) tar 解压工具缺失（macOS/Linux 需系统自带的 tar）')
    console.error('[tunnel] 影响范围：仅外网公开链接不可用，前后端服务不受影响，仍可在本地使用 http://127.0.0.1:<port>')
    console.error('[tunnel] 处理方式：稍后重试启动；或设置环境变量 MELODY_TUNNEL=0 跳过此步')
    console.error('[tunnel] ─────────────────────────────────────────────')
    emitStatus({
      state: 'error',
      message: 'cloudflared 准备失败',
      error: errMsg,
    }, { force: true })
    process.exit(1)
  }

  console.error(`[tunnel] 启动 cloudflared quick tunnel → http://127.0.0.1:${port}`)
  emitStatus({
    state: 'starting',
    message: '正在建立隧道',
    downloadedBytes: 0,
    totalBytes: 0,
  }, { force: true })

  const child = spawn(binPath, [
    'tunnel',
    '--no-autoupdate',
    '--url', `http://127.0.0.1:${port}`,
  ], { stdio: ['ignore', 'pipe', 'pipe'] })

  const handleLine = (line) => {
    process.stdout.write(line + '\n')
    if (status.url) return
    const match = line.match(URL_REGEX)
    if (!match) return
    const publicUrl = match[0]
    console.error('')
    console.error('[tunnel] ═════════════════════════════════════════════════════')
    console.error('[tunnel]   公开访问地址 (临时, 每次启动都会变):')
    console.error(`[tunnel]   ${publicUrl}`)
    console.error('[tunnel]   分享给他人即可访问；关闭本进程会停止外网访问。')
    console.error('[tunnel] ═════════════════════════════════════════════════════')
    console.error('')
    emitStatus({
      state: 'ready',
      url: publicUrl,
      message: '公开链接已就绪',
      error: null,
    }, { force: true })
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
  process.on('exit', () => {
    cleanup()
    if (status.state !== 'ready' && status.state !== 'error') {
      emitStatus({ state: 'stopped', message: '隧道已停止' }, { force: true })
    } else if (status.state === 'ready') {
      emitStatus({ state: 'stopped', url: null, message: '隧道已停止' }, { force: true })
    }
  })

  child.on('exit', (code, signal) => {
    if (signal) console.error(`[tunnel] cloudflared 已退出 (信号 ${signal})`)
    else console.error(`[tunnel] cloudflared 已退出 (退出码 ${code})`)
    process.exit(code ?? 0)
  })

  child.on('error', (err) => {
    const msg = err?.message || String(err)
    console.error(`[tunnel] cloudflared 启动失败: ${msg}`)
    emitStatus({
      state: 'error',
      message: 'cloudflared 启动失败',
      error: msg,
    }, { force: true })
    process.exit(1)
  })
}

main().catch((err) => {
  console.error('[tunnel] 致命错误:', err)
  process.exit(1)
})
