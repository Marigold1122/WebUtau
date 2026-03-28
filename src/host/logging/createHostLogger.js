function writeLog(method, message, payload = null) {
  if (payload == null) {
    console[method](message)
    return
  }
  console[method](message, payload)
}

const DEBUG_STORAGE_KEY = 'melody-host-debug'
const DEBUG_QUERY_KEY = 'hostDebug'

function normalizeDebugTokens(rawValue) {
  if (rawValue == null || rawValue === false) return []
  if (rawValue === true) return ['*']
  if (Array.isArray(rawValue)) return rawValue.flatMap((value) => normalizeDebugTokens(value))
  if (typeof rawValue !== 'string') return []

  return rawValue
    .split(/[,\s]+/)
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean)
    .map((value) => {
      if (value === '1' || value === 'true' || value === 'on' || value === 'all') return '*'
      return value
    })
}

function readStorageDebugValue() {
  try {
    return globalThis.localStorage?.getItem(DEBUG_STORAGE_KEY) || null
  } catch {
    return null
  }
}

function readQueryDebugValue() {
  try {
    const search = globalThis.location?.search
    if (!search) return null
    return new URLSearchParams(search).get(DEBUG_QUERY_KEY)
  } catch {
    return null
  }
}

function readDebugCategories() {
  const categories = new Set()
  ;[
    globalThis.__HOST_DEBUG__,
    readStorageDebugValue(),
    readQueryDebugValue(),
  ].forEach((value) => {
    normalizeDebugTokens(value).forEach((token) => categories.add(token))
  })
  return categories
}

function isDebugEnabled(category = '') {
  const categories = readDebugCategories()
  if (categories.has('*')) return true
  const normalizedCategory = typeof category === 'string' ? category.trim().toLowerCase() : ''
  return normalizedCategory ? categories.has(normalizedCategory) : false
}

function buildTrackPayload(trackOrTrackId) {
  if (!trackOrTrackId) return null
  if (typeof trackOrTrackId === 'string') return { trackId: trackOrTrackId }
  return {
    trackId: trackOrTrackId.id,
    trackName: trackOrTrackId.name,
  }
}

export function createHostLogger(scope = 'HostShell') {
  const prefix = `[${scope}]`

  return {
    info(message, payload = null) {
      writeLog('log', `${prefix} ${message}`, payload)
    },
    warn(message, payload = null) {
      writeLog('warn', `${prefix} ${message}`, payload)
    },
    error(message, payload = null) {
      writeLog('error', `${prefix} ${message}`, payload)
    },
    debug(category, message, payload = null) {
      if (!isDebugEnabled(category)) return
      writeLog('log', `${prefix} ${message}`, payload)
    },
    isDebugEnabled(category) {
      return isDebugEnabled(category)
    },
    render(reason, payload = null) {
      if (!isDebugEnabled('render')) return
      writeLog('log', `${prefix} 渲染 | 原因=${reason}`, payload)
    },
    sourcePickerToggled(track, isOpen) {
      writeLog('log', `${prefix} 轨道声源菜单${isOpen ? '打开' : '关闭'}`, buildTrackPayload(track))
    },
    sourcePickerClosed(track, reason) {
      writeLog('log', `${prefix} 轨道声源菜单关闭 | 原因=${reason}`, buildTrackPayload(track))
    },
    sourceAssigned(track, assignedSourceId, effectiveSourceLabel) {
      writeLog('log', `${prefix} 轨道声源已更新`, {
        ...buildTrackPayload(track),
        assignedSourceId: assignedSourceId || null,
        effectiveSourceLabel,
      })
    },
    focusSolo(action, trackId) {
      writeLog('log', `${prefix} FocusSolo | ${action}`, buildTrackPayload(trackId))
    },
  }
}
