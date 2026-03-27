export const TRACK_ROLE_OPTIONS = [
  { value: 'vocal', label: '人声' },
  { value: 'instrument', label: '乐器' },
  { value: 'drum', label: '鼓' },
  { value: 'audio', label: '音频' },
  { value: 'unassigned', label: '未分配' },
]

export function isVocalRole(role) {
  return role === 'vocal'
}

export function getTrackRoleLabel(role) {
  return TRACK_ROLE_OPTIONS.find((option) => option.value === role)?.label || '未分配'
}

export function suggestTrackRole(trackSummary) {
  if (trackSummary?.hasLyrics) return 'vocal'
  return 'instrument'
}
