const TRACK_COLORS = ['#3b8b88', '#c94234', '#d4a035', '#66a06f', '#c05640', '#4b6a88']
const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/

function isValidHex(value) {
  return typeof value === 'string' && HEX_COLOR_RE.test(value)
}

export function getTrackColor(index = 0) {
  const safeIndex = Number.isFinite(index) ? Math.max(0, Math.round(index)) : 0
  return TRACK_COLORS[safeIndex % TRACK_COLORS.length]
}

// 用户给单条轨道自定义的颜色优先；没有自定义时回落到按 index 取的默认调色板。
export function resolveTrackColor(track, index = 0) {
  if (track && isValidHex(track.color)) return track.color
  return getTrackColor(index)
}

export function getTrackColorById(trackId, tracks = []) {
  const list = Array.isArray(tracks) ? tracks : []
  const trackIndex = list.findIndex((track) => track?.id === trackId)
  if (trackIndex < 0) return getTrackColor(0)
  return resolveTrackColor(list[trackIndex], trackIndex)
}
