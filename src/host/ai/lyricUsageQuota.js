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

// 后端响应里如果带回真实剩余量，用这一份**只增不减**地同步客户端缓存。
// 为什么不允许向下同步：后端的限速器是纯内存的，重启 / 多副本部署会丢失计数；
// 这种情况下后端报的 used 可能反而比客户端缓存还小（比如客户端记着 used=2，
// 重启后第一个请求触发 TryConsume + Refund 后服务端报 used=0）——
// 直接覆盖会让用户看见"凭空多出来"几次额度，体验和真实限速都对不上。
// 只允许向上：多设备 / 多浏览器场景下，别的会话消耗的配额能正常反映过来
export function setQuotaFromServer({ used, remaining, limit }) {
  const today = todayKey()
  const safeLimit = Number.isFinite(limit) && limit > 0 ? limit : DAILY_LIMIT_DEFAULT
  let serverUsed
  if (Number.isFinite(used)) {
    serverUsed = Math.max(0, used)
  } else if (Number.isFinite(remaining)) {
    serverUsed = Math.max(0, safeLimit - remaining)
  } else {
    // 服务端没给数 → 啥也不动
    return getQuotaSnapshot({ limit: safeLimit })
  }
  const local = getQuotaSnapshot({ limit: safeLimit })
  const safeUsed = Math.max(local.used, serverUsed)
  safeWrite({ date: today, used: safeUsed })
  return getQuotaSnapshot({ limit: safeLimit })
}

// 发请求前先乐观自增一次（用户视觉上立刻看到剩余数 -1）。
// 真实限速仍以服务端为准——这只是 UI 占位，避免依赖响应往返才更新显示
export function bumpQuotaOptimistically({ limit = DAILY_LIMIT_DEFAULT } = {}) {
  const cur = getQuotaSnapshot({ limit })
  safeWrite({ date: cur.date, used: cur.used + 1 })
  return getQuotaSnapshot({ limit })
}

// 撤销乐观自增：用于请求失败、被拒（429）、上游错误等"实际没消耗"的情形。
// 与 bump 严格成对调用，否则计数会漂
export function unbumpQuotaOptimistically({ limit = DAILY_LIMIT_DEFAULT } = {}) {
  const cur = getQuotaSnapshot({ limit })
  safeWrite({ date: cur.date, used: Math.max(0, cur.used - 1) })
  return getQuotaSnapshot({ limit })
}

export function resetQuota() {
  try { globalThis.localStorage?.removeItem?.(STORAGE_KEY) } catch (_e) {}
}
