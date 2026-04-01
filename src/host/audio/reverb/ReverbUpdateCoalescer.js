function scheduleNextFrame(callback) {
  if (typeof requestAnimationFrame === 'function') {
    return {
      kind: 'raf',
      id: requestAnimationFrame(callback),
    }
  }
  return {
    kind: 'timeout',
    id: setTimeout(callback, 16),
  }
}

function cancelScheduled(handle) {
  if (!handle) return
  if (handle.kind === 'raf' && typeof cancelAnimationFrame === 'function') {
    cancelAnimationFrame(handle.id)
    return
  }
  clearTimeout(handle.id)
}

export class ReverbUpdateCoalescer {
  constructor({ onFlush = null } = {}) {
    this.onFlush = onFlush
    this.pendingByTrackId = new Map()
    this.flushHandle = null
  }

  enqueue(trackId, patch = {}) {
    if (!trackId || !patch || typeof patch !== 'object') return false
    const previousPatch = this.pendingByTrackId.get(trackId) || {}
    this.pendingByTrackId.set(trackId, {
      ...previousPatch,
      ...patch,
    })
    this._scheduleFlush()
    return true
  }

  takePending(trackId) {
    if (!trackId) return null
    const pendingPatch = this.pendingByTrackId.get(trackId) || null
    this.pendingByTrackId.delete(trackId)
    if (this.pendingByTrackId.size === 0) {
      this._cancelFlush()
    }
    return pendingPatch
  }

  clear(trackId = null) {
    if (trackId) {
      this.pendingByTrackId.delete(trackId)
    } else {
      this.pendingByTrackId.clear()
    }
    if (this.pendingByTrackId.size === 0) {
      this._cancelFlush()
    }
  }

  dispose() {
    this.clear()
    this.onFlush = null
  }

  _scheduleFlush() {
    if (this.flushHandle || this.pendingByTrackId.size === 0) return
    this.flushHandle = scheduleNextFrame(() => {
      this.flushHandle = null
      if (this.pendingByTrackId.size === 0) return
      const entries = [...this.pendingByTrackId.entries()]
      this.pendingByTrackId.clear()
      entries.forEach(([trackId, patch]) => {
        this.onFlush?.(trackId, patch)
      })
    })
  }

  _cancelFlush() {
    if (!this.flushHandle) return
    cancelScheduled(this.flushHandle)
    this.flushHandle = null
  }
}
