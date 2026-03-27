function createBadgeButton(label, title, active, onClick) {
  const button = document.createElement('button')
  button.type = 'button'
  button.className = `t-btn ${label === 'M' ? 'm' : 's'}${active ? ' active' : ''}`
  button.title = title
  button.setAttribute('aria-pressed', String(active))
  button.textContent = label
  button.addEventListener('click', (event) => {
    event.preventDefault()
    event.stopPropagation()
    onClick?.()
  })
  return button
}

export function createTrackMonitorBadge(track, handlers = {}) {
  const playbackState = track.playbackState || {}
  const root = document.createElement('div')
  root.className = 'th-controls track-monitor-badge'
  root.appendChild(createBadgeButton('M', '静音该轨', playbackState.mute, () => handlers.onToggleMute?.(track.id)))
  root.appendChild(createBadgeButton('S', '独奏该轨', playbackState.solo, () => handlers.onToggleSolo?.(track.id)))
  root.addEventListener('click', (event) => event.stopPropagation())
  return root
}
