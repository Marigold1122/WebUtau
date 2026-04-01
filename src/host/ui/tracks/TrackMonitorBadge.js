function createBadgeButton(label, title, { active = false, enabled = false } = {}, onClick) {
  const button = document.createElement('button')
  button.type = 'button'
  const roleClass = label === 'M'
    ? 'm'
    : (label === 'S' ? 's' : 'fx')
  button.className = `t-btn ${roleClass}${active ? ' active' : ''}${enabled ? ' is-enabled' : ''}`
  button.title = title
  button.setAttribute('aria-pressed', String(active))
  if (enabled) {
    button.setAttribute('data-enabled', 'true')
  }
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
  root.appendChild(createBadgeButton('M', '静音 Mute', { active: playbackState.mute }, () => handlers.onToggleMute?.(track.id)))
  root.appendChild(createBadgeButton('S', '独奏 Solo', { active: playbackState.solo }, () => handlers.onToggleSolo?.(track.id)))
  root.appendChild(createBadgeButton(
    'FX',
    '打开或关闭混响模块 / Open or close the reverb module',
    {
      active: Boolean(handlers.fxOpen),
      enabled: Boolean(handlers.fxEnabled),
    },
    () => handlers.onToggleFx?.(track.id),
  ))
  root.addEventListener('click', (event) => event.stopPropagation())
  return root
}
