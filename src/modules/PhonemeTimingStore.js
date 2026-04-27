class PhonemeTimingStore {
  constructor() {
    this._snapshot = null
    this._items = []
    this._hover = null
    this._preview = null
    this._listeners = new Set()
  }

  setSnapshot(snapshot) {
    const nextSnapshot = normalizeSnapshot(snapshot)
    this._snapshot = nextSnapshot
    this._items = nextSnapshot.items
    this._notify()
    return this.getSnapshot()
  }

  clear() {
    const hadState = this._snapshot || this._items.length > 0 || this._hover || this._preview
    this._snapshot = null
    this._items = []
    this._hover = null
    this._preview = null
    if (hadState) this._notify()
  }

  hasSnapshot() {
    return Boolean(this._snapshot)
  }

  getSnapshot() {
    if (!this._snapshot) return null
    return {
      ...this._snapshot,
      items: this.getItems(),
    }
  }

  getItems() {
    return this._items.map(cloneItem)
  }

  getHover() {
    return this._hover ? { ...this._hover } : null
  }

  setHover(hover) {
    this._hover = hover ? { ...hover } : null
    this._notify()
  }

  getPreview() {
    return this._preview ? clonePreview(this._preview) : null
  }

  setPreview(preview) {
    this._preview = preview ? clonePreview(preview) : null
    this._notify()
  }

  subscribe(listener) {
    if (typeof listener !== 'function') return () => {}
    this._listeners.add(listener)
    return () => this._listeners.delete(listener)
  }

  _notify() {
    for (const listener of [...this._listeners]) listener(this.getSnapshot())
  }
}

function normalizeSnapshot(snapshot = {}) {
  const items = Array.isArray(snapshot?.items)
    ? snapshot.items.map(normalizeItem).filter(Boolean)
    : []
  return {
    jobId: asString(snapshot?.jobId),
    midiPpq: asInteger(snapshot?.midiPpq, 480),
    revision: asString(snapshot?.revision),
    items,
  }
}

function normalizeItem(item) {
  if (!item || typeof item !== 'object') return null
  return {
    phraseIndex: asInteger(item.phraseIndex, -1),
    partIndex: asInteger(item.partIndex, -1),
    noteKey: asString(item.noteKey),
    phonemeIndex: asInteger(item.phonemeIndex, -1),
    label: asString(item.label),
    rawLabel: asString(item.rawLabel),
    positionTick: asInteger(item.positionTick, 0),
    endTick: asInteger(item.endTick, 0),
    positionMs: asNumber(item.positionMs, null),
    endMs: asNumber(item.endMs, null),
    preutterMs: asNumber(item.preutterMs, 0),
    overlapMs: asNumber(item.overlapMs, 0),
    autoPreutterMs: asNumber(item.autoPreutterMs, 0),
    autoOverlapMs: asNumber(item.autoOverlapMs, 0),
    offsetTick: asNullableNumber(item.offsetTick),
    preutterDeltaMs: asNullableNumber(item.preutterDeltaMs),
    overlapDeltaMs: asNullableNumber(item.overlapDeltaMs),
    hasOffsetOverride: Boolean(item.hasOffsetOverride),
    hasPreutterOverride: Boolean(item.hasPreutterOverride),
    hasOverlapOverride: Boolean(item.hasOverlapOverride),
    envelopePoints: Array.isArray(item.envelopePoints)
      ? item.envelopePoints.map(normalizeEnvelopePoint).filter(Boolean)
      : [],
    error: asNullableString(item.error),
    hiddenReason: asNullableString(item.hiddenReason),
  }
}

function normalizeEnvelopePoint(point) {
  const xMs = asNumber(point?.xMs, null)
  const yPercent = asNumber(point?.yPercent, null)
  if (xMs == null || yPercent == null) return null
  return { xMs, yPercent }
}

function cloneItem(item) {
  return {
    ...item,
    envelopePoints: item.envelopePoints.map((point) => ({ ...point })),
  }
}

function clonePreview(preview) {
  const items = Array.isArray(preview.items)
    ? preview.items.map(cloneItem)
    : undefined
  return {
    ...preview,
    item: preview.item ? cloneItem(preview.item) : null,
    ...(items ? { items } : {}),
  }
}

function asString(value) {
  return typeof value === 'string' ? value : ''
}

function asNullableString(value) {
  return typeof value === 'string' && value.length > 0 ? value : null
}

function asNumber(value, fallback) {
  const number = Number(value)
  return Number.isFinite(number) ? number : fallback
}

function asNullableNumber(value) {
  return value == null ? null : asNumber(value, null)
}

function asInteger(value, fallback) {
  const number = asNumber(value, null)
  return number == null ? fallback : Math.round(number)
}

export { PhonemeTimingStore }
export default new PhonemeTimingStore()
