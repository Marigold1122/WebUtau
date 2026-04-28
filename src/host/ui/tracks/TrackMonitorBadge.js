import { t } from '../../../i18n/index.js'

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
  root.appendChild(createBadgeButton('M', t('trackBadge.mute_tip'), { active: playbackState.mute }, () => handlers.onToggleMute?.(track.id)))
  root.appendChild(createBadgeButton('S', t('trackBadge.solo_tip'), { active: playbackState.solo }, () => handlers.onToggleSolo?.(track.id)))
  root.appendChild(createBadgeButton(
    'FX',
    t('trackBadge.fx_tip'),
    {
      active: Boolean(handlers.fxOpen),
      enabled: Boolean(handlers.fxEnabled),
    },
    () => handlers.onToggleFx?.(track.id),
  ))
  root.addEventListener('click', (event) => event.stopPropagation())
  return root
}
