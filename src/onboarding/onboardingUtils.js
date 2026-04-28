import { BRANCH_CONFIG } from './onboardingSteps.js'

const STORAGE_KEY = 'webutau_onboarding_v1'
const STORAGE_VALUE_DONE = 'done'

export function hasCompleted() {
  try {
    return globalThis.localStorage?.getItem(STORAGE_KEY) === STORAGE_VALUE_DONE
  } catch {
    return false
  }
}

export function markCompleted() {
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, STORAGE_VALUE_DONE)
  } catch {
    // localStorage 不可用（隐私模式等）时静默失败，下次仍会弹出教程
  }
}

function normalizeName(text) {
  return (text || '').replace(/\s+/g, '').toLowerCase()
}

export function findTrackRowByBranch(branch) {
  const rows = document.querySelectorAll('.track-shell-row')
  if (!rows.length) return null
  const candidates = (BRANCH_CONFIG[branch]?.vocalTrackCandidates || []).map(normalizeName)
  if (candidates.length === 0) return rows[0] || null
  for (const row of rows) {
    const nameEl = row.querySelector('.track-name')
    if (!nameEl) continue
    const normalized = normalizeName(nameEl.textContent)
    if (!normalized) continue
    if (candidates.some((c) => normalized === c || normalized.includes(c))) return row
  }
  return rows[0] || null
}

export function resolveBody(body, branch) {
  if (!body) return ''
  if (typeof body === 'function') return body(branch) || ''
  if (typeof body === 'string') return body
  if (typeof body === 'object') {
    return body[branch] || body.default || Object.values(body)[0] || ''
  }
  return ''
}
