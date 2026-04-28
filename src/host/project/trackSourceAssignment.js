import { t } from '../../i18n/index.js'

// 轨道 source ID 列表常量；显示标签由 i18n 在使用点解析
const TRACK_SOURCE_IDS = ['piano', 'violin', 'guitar', 'bass', 'drums', 'vocal']

// 通过 getter 提供随 locale 实时变化的 label
export const TRACK_SOURCE_OPTIONS = TRACK_SOURCE_IDS.map((id) => ({
  id,
  get label() { return t(`trackSource.name.${id}`) },
}))

const VALID_SOURCE_IDS = new Set(TRACK_SOURCE_IDS)

export function normalizeAssignedSourceId(sourceId) {
  if (sourceId == null || sourceId === '') return null
  return VALID_SOURCE_IDS.has(sourceId) ? sourceId : null
}

export function getEffectiveSourceId(sourceId) {
  return normalizeAssignedSourceId(sourceId) || 'piano'
}

export function getAssignedSourceLabel(sourceId) {
  const normalized = normalizeAssignedSourceId(sourceId)
  if (!normalized) return t('trackSource.unassigned')
  return t(`trackSource.name.${normalized}`)
}

export function getEffectiveSourceLabel(sourceId) {
  const effectiveId = getEffectiveSourceId(sourceId)
  return t(`trackSource.name.${effectiveId}`)
}

export function getTrackSourceInspectorText(sourceId) {
  const normalized = normalizeAssignedSourceId(sourceId)
  if (!normalized) return t('trackSource.unassigned_piano')
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
