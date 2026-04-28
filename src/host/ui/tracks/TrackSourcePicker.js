import {
  TRACK_SOURCE_OPTIONS,
  getEffectiveSourceLabel,
} from '../../project/trackSourceAssignment.js'
import { isAudioTrack } from '../../project/trackContentType.js'
import { createTrackSourceIcon } from './TrackSourceIcon.js'
import { t } from '../../../i18n/index.js'

function getMenuOptions() {
  return [
    { id: null, label: t('trackSource.default_piano') },
    ...TRACK_SOURCE_OPTIONS,
  ]
}

function buildOptionButton(track, option, handlers) {
  const button = document.createElement('button')
  button.type = 'button'
  button.className = `track-source-option${track.playbackState?.assignedSourceId === option.id ? ' active' : ''}`
  button.setAttribute('role', 'menuitemradio')
  button.setAttribute('aria-checked', String(track.playbackState?.assignedSourceId === option.id))
  button.appendChild(createTrackSourceIcon(option.id, option.label))

  const label = document.createElement('span')
  label.className = 'track-source-option-label'
  label.textContent = option.label
  button.appendChild(label)

  button.addEventListener('click', (event) => {
    event.preventDefault()
    event.stopPropagation()
    handlers.onAssignSource?.(track.id, option.id)
  })
  return button
}

function appendTriggerContent(button, sourceId, labelText = '') {
  button.appendChild(createTrackSourceIcon(sourceId, labelText))
}

export function createTrackSourcePicker(track, options = {}) {
  const { isOpen = false, onToggle = null, onAssignSource = null } = options
  const picker = document.createElement('div')
  if (isAudioTrack(track)) {
    picker.className = 'track-source-picker is-assigned is-audio'
    const trigger = document.createElement('button')
    trigger.type = 'button'
    trigger.className = 'track-source-trigger'
    trigger.title = t('trackSource.audio_track')
    trigger.disabled = true
    trigger.setAttribute('aria-label', t('trackSource.audio_track'))
    appendTriggerContent(trigger, 'audio', t('trackSource.audio_track'))
    picker.appendChild(trigger)
    return picker
  }

  picker.className = `track-source-picker${track.playbackState?.assignedSourceId ? ' is-assigned' : ''}${isOpen ? ' open' : ''}`
  const hasAssignedSource = Boolean(track.playbackState?.assignedSourceId)
  const currentLabel = getEffectiveSourceLabel(track.playbackState?.assignedSourceId)

  const trigger = document.createElement('button')
  trigger.type = 'button'
  trigger.className = 'track-source-trigger'
  const titleHead = hasAssignedSource ? t('trackSource.change') : t('trackSource.pick_for_track')
  trigger.title = `${titleHead}（${t('trackSource.current_prefix', { label: currentLabel })}）`
  trigger.setAttribute('aria-label', `${titleHead} · ${t('trackSource.current_prefix', { label: currentLabel })}`)
  trigger.setAttribute('aria-haspopup', 'menu')
  trigger.setAttribute('aria-expanded', String(isOpen))
  appendTriggerContent(
    trigger,
    hasAssignedSource ? track.playbackState.assignedSourceId : null,
    hasAssignedSource ? currentLabel : t('trackSource.add_or_change'),
  )
  trigger.addEventListener('click', (event) => {
    event.preventDefault()
    event.stopPropagation()
    onToggle?.(track.id)
  })
  picker.appendChild(trigger)

  if (isOpen) {
    const menu = document.createElement('div')
    menu.className = 'track-source-menu'
    menu.setAttribute('role', 'menu')
    getMenuOptions().forEach((option) => {
      menu.appendChild(buildOptionButton(track, option, { onAssignSource }))
    })
    picker.appendChild(menu)
  }

  picker.addEventListener('click', (event) => event.stopPropagation())
  return picker
}
