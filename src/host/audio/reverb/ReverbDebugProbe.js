const DEBUG_STORAGE_KEY = 'melody:debug:reverb'
const FLUSH_INTERVAL_MS = 1000

const counters = {
  knobInputEvents: 0,
  trackReverbConfigCalls: 0,
  reverbBusSetConfigCalls: 0,
  impulseRebuildCalls: 0,
  impulseRebuildCostMsTotal: 0,
  wetRouteConnectCalls: 0,
  wetRouteDisconnectCalls: 0,
}

let lastFlushAtMs = 0

function nowMs() {
  if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
    return performance.now()
  }
  return Date.now()
}

export function isReverbProbeEnabled() {
  if (globalThis?.__MELODY_REVERB_DEBUG__ === true) return true
  try {
    return globalThis?.localStorage?.getItem(DEBUG_STORAGE_KEY) === '1'
  } catch (_error) {
    return false
  }
}

function maybeFlush() {
  if (!isReverbProbeEnabled()) return
  const now = nowMs()
  if (now - lastFlushAtMs < FLUSH_INTERVAL_MS) return
  lastFlushAtMs = now
  console.debug('[ReverbProbe]', {
    ...counters,
  })
}

export function markReverbProbe(metric, delta = 1) {
  if (!isReverbProbeEnabled()) return
  if (!Object.prototype.hasOwnProperty.call(counters, metric)) {
    counters[metric] = 0
  }
  counters[metric] += Number.isFinite(delta) ? delta : 0
  maybeFlush()
}

export function markImpulseRebuildCost(costMs = 0) {
  if (!isReverbProbeEnabled()) return
  counters.impulseRebuildCalls += 1
  counters.impulseRebuildCostMsTotal += Number.isFinite(costMs) ? Math.max(0, costMs) : 0
  maybeFlush()
}

export function getReverbProbeSnapshot() {
  return {
    ...counters,
  }
}
