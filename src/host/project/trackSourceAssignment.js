export const TRACK_SOURCE_OPTIONS = [
  { id: 'piano', label: '钢琴' },
  { id: 'violin', label: '小提琴' },
  { id: 'guitar', label: '吉他' },
  { id: 'bass', label: '贝斯' },
  { id: 'drums', label: '鼓' },
  { id: 'vocal', label: '人声' },
]

const VALID_SOURCE_IDS = new Set(TRACK_SOURCE_OPTIONS.map((option) => option.id))

export function normalizeAssignedSourceId(sourceId) {
  if (sourceId == null || sourceId === '') return null
  return VALID_SOURCE_IDS.has(sourceId) ? sourceId : null
}

export function getEffectiveSourceId(sourceId) {
  return normalizeAssignedSourceId(sourceId) || 'piano'
}

export function getAssignedSourceLabel(sourceId) {
  const normalized = normalizeAssignedSourceId(sourceId)
  if (!normalized) return '未指定'
  return TRACK_SOURCE_OPTIONS.find((option) => option.id === normalized)?.label || '未指定'
}

export function getEffectiveSourceLabel(sourceId) {
  const effectiveId = getEffectiveSourceId(sourceId)
  return TRACK_SOURCE_OPTIONS.find((option) => option.id === effectiveId)?.label || '钢琴'
}

export function getTrackSourceInspectorText(sourceId) {
  const normalized = normalizeAssignedSourceId(sourceId)
  if (!normalized) return '未指定（播放按钢琴）'
  return getAssignedSourceLabel(normalized)
}

export function getRoleForAssignedSource(sourceId) {
  const normalized = normalizeAssignedSourceId(sourceId)
  if (normalized === 'vocal') return 'vocal'
  if (normalized === 'drums') return 'drum'
  if (normalized === 'piano' || normalized === 'violin' || normalized === 'guitar' || normalized === 'bass') return 'instrument'
  return 'unassigned'
}

export function isVoiceRuntimeSource(sourceId) {
  return normalizeAssignedSourceId(sourceId) === 'vocal'
}
