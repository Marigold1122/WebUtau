const DEFAULT_INTERVAL_MS = 1500
const READY_INTERVAL_MS = 5000
const DOWNLOADING_INTERVAL_MS = 600

const FALLBACK_STATUS = Object.freeze({
  available: false,
  manualStart: false,
  state: 'disabled',
  url: null,
  downloadedBytes: 0,
  totalBytes: 0,
  message: '隧道服务不可用',
  error: null,
  source: 'unknown',
  updatedAt: 0,
})

function isTauriEnv() {
  if (typeof window === 'undefined') return false
  return Boolean(window.__TAURI_INTERNALS__ || window.__TAURI__)
}

async function tauriInvoke(cmd, args) {
  const internals = typeof window !== 'undefined' ? window.__TAURI_INTERNALS__ : null
  if (internals && typeof internals.invoke === 'function') {
    return internals.invoke(cmd, args ?? {})
  }
  const legacyTauri = typeof window !== 'undefined' ? window.__TAURI__ : null
  if (legacyTauri?.core?.invoke) {
    return legacyTauri.core.invoke(cmd, args ?? {})
  }
  throw new Error('当前环境不支持 Tauri invoke')
}

function normalizeStatus(raw) {
  if (!raw || typeof raw !== 'object') return { ...FALLBACK_STATUS }
  return {
    available: raw.available === true,
    manualStart: raw.manualStart === true,
    state: typeof raw.state === 'string' ? raw.state : 'disabled',
    url: typeof raw.url === 'string' && raw.url ? raw.url : null,
    downloadedBytes: Number.isFinite(raw.downloadedBytes) ? raw.downloadedBytes : 0,
    totalBytes: Number.isFinite(raw.totalBytes) ? raw.totalBytes : 0,
    message: typeof raw.message === 'string' ? raw.message : '',
    error: typeof raw.error === 'string' && raw.error ? raw.error : null,
    source: typeof raw.source === 'string' ? raw.source : 'unknown',
    updatedAt: Number.isFinite(raw.updatedAt) ? raw.updatedAt : 0,
  }
}

export function isTauriRuntime() {
  return isTauriEnv()
}

export async function getTunnelStatus() {
  if (isTauriEnv()) {
    try {
      const raw = await tauriInvoke('tunnel_get_status')
      return normalizeStatus(raw)
    } catch (err) {
      return normalizeStatus({
        ...FALLBACK_STATUS,
        state: 'disabled',
        message: '无法读取隧道状态',
        error: err?.message || String(err),
        source: 'tauri',
      })
    }
  }
  try {
    const res = await fetch('/__tunnel/status', { cache: 'no-store' })
    if (!res.ok) {
      return normalizeStatus({ ...FALLBACK_STATUS, message: `状态接口返回 ${res.status}` })
    }
    return normalizeStatus(await res.json())
  } catch (err) {
    return normalizeStatus({
      ...FALLBACK_STATUS,
      message: '无法连接到隧道状态服务',
      error: err?.message || String(err),
    })
  }
}

export async function requestStartTunnel() {
  if (isTauriEnv()) {
    const raw = await tauriInvoke('tunnel_start')
    return normalizeStatus(raw)
  }
  // 网页模式：tunnel 由 dev 启动脚本自动拉起，前端无法主动启动
  return getTunnelStatus()
}

export async function requestStopTunnel() {
  if (isTauriEnv()) {
    const raw = await tauriInvoke('tunnel_stop')
    return normalizeStatus(raw)
  }
  return getTunnelStatus()
}

function pickInterval(state) {
  if (state === 'ready') return READY_INTERVAL_MS
  if (state === 'downloading' || state === 'starting' || state === 'preparing') return DOWNLOADING_INTERVAL_MS
  return DEFAULT_INTERVAL_MS
}

export function watchTunnelStatus(onUpdate) {
  let stopped = false
  let timer = null
  let lastSerialized = ''

  const tick = async () => {
    if (stopped) return
    let status
    try {
      status = await getTunnelStatus()
    } catch (err) {
      status = normalizeStatus({
        ...FALLBACK_STATUS,
        message: '获取状态失败',
        error: err?.message || String(err),
      })
    }
    if (stopped) return
    const serialized = JSON.stringify(status)
    if (serialized !== lastSerialized) {
      lastSerialized = serialized
      try {
        onUpdate(status)
      } catch (err) {
        console.error('[tunnelService] 状态回调异常:', err)
      }
    }
    timer = setTimeout(tick, pickInterval(status.state))
  }

  tick()
  return () => {
    stopped = true
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
  }
}
