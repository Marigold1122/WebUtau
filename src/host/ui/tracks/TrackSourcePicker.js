import {
  TRACK_SOURCE_OPTIONS,
  getEffectiveSourceLabel,
} from '../../project/trackSourceAssignment.js'
import { isAudioTrack } from '../../project/trackContentType.js'
import { createTrackSourceIcon } from './TrackSourceIcon.js'

const MENU_OPTIONS = [
  { id: null, label: '默认钢琴' },
  ...TRACK_SOURCE_OPTIONS,
]

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
    trigger.title = '音频轨'
    trigger.disabled = true
    trigger.setAttribute('aria-label', '音频轨')
    appendTriggerContent(trigger, 'audio', '音频轨')
    picker.appendChild(trigger)
    return picker
  }

  picker.className = `track-source-picker${track.playbackState?.assignedSourceId ? ' is-assigned' : ''}${isOpen ? ' open' : ''}`
  const hasAssignedSource = Boolean(track.playbackState?.assignedSourceId)
  const currentLabel = getEffectiveSourceLabel(track.playbackState?.assignedSourceId)

  const trigger = document.createElement('button')
  trigger.type = 'button'
  trigger.className = 'track-source-trigger'
  trigger.title = `${hasAssignedSource ? '更换轨道声源' : '为轨道选择声源'}（当前：${currentLabel}）`
  trigger.setAttribute('aria-label', `轨道声源按钮，当前${currentLabel}`)
  trigger.setAttribute('aria-haspopup', 'menu')
  trigger.setAttribute('aria-expanded', String(isOpen))
  appendTriggerContent(
    trigger,
    hasAssignedSource ? track.playbackState.assignedSourceId : null,
    hasAssignedSource ? currentLabel : '添加或更换声源',
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
    MENU_OPTIONS.forEach((option) => {
      menu.appendChild(buildOptionButton(track, option, { onAssignSource }))
    })
    picker.appendChild(menu)
  }

  picker.addEventListener('click', (event) => event.stopPropagation())
  return picker
}
