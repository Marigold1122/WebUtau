// 客户端每日配额显示——只用来给用户看"今天用了几次 / 剩几次"，不是真正的限速。
// 真正的限速在后端按 IP 算（用户清缓存 / 换浏览器都绕不过）。
//
// 数据结构：localStorage['webutau:ai-lyric-quota'] = { date: 'YYYY-MM-DD', used: N }
// 跨日自动重置

const STORAGE_KEY = 'webutau:ai-lyric-quota'
export const DAILY_LIMIT_DEFAULT = 5

function todayKey() {
  // 用本地时区——日期跟用户的"今天"一致；后端按 UTC 算的话有微小差异，但这只是显示
  const now = new Date()
  const y = now.getFullYear()
  const m = String(now.getMonth() + 1).padStart(2, '0')
  const d = String(now.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

function safeRead() {
  try {
    const raw = globalThis.localStorage?.getItem?.(STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw)
    return (parsed && typeof parsed === 'object') ? parsed : null
  } catch (_e) { return null }
}

function safeWrite(value) {
  try { globalThis.localStorage?.setItem?.(STORAGE_KEY, JSON.stringify(value || {})) }
  catch (_e) {}
}

export function getQuotaSnapshot({ limit = DAILY_LIMIT_DEFAULT } = {}) {
  const stored = safeRead()
  const today = todayKey()
  if (!stored || stored.date !== today) {
    return { used: 0, remaining: limit, limit, date: today }
  }
  const used = Number.isFinite(stored.used) ? Math.max(0, stored.used) : 0
  return {
    used,
    remaining: Math.max(0, limit - used),
    limit,
    date: today,
  }
}

// 后端响应里如果带回真实剩余量，用这一份覆盖客户端缓存——以后端为准
export function setQuotaFromServer({ used, remaining, limit }) {
  const today = todayKey()
  const safeLimit = Number.isFinite(limit) && limit > 0 ? limit : DAILY_LIMIT_DEFAULT
  let safeUsed
  if (Number.isFinite(used)) {
    safeUsed = Math.max(0, used)
  } else if (Number.isFinite(remaining)) {
    safeUsed = Math.max(0, safeLimit - remaining)
  } else {
    safeUsed = 0
  }
  safeWrite({ date: today, used: safeUsed })
  return getQuotaSnapshot({ limit: safeLimit })
}

// 没拿到后端响应时（网络错误等）给客户端做个保底自增——不影响真实限速
export function bumpQuotaOptimistically({ limit = DAILY_LIMIT_DEFAULT } = {}) {
  const cur = getQuotaSnapshot({ limit })
  safeWrite({ date: cur.date, used: cur.used + 1 })
  return getQuotaSnapshot({ limit })
}

export function resetQuota() {
  try { globalThis.localStorage?.removeItem?.(STORAGE_KEY) } catch (_e) {}
}
