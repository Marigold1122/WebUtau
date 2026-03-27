import { HOST_SHORTCUT_INTENTS, getHostShortcutIntent } from '../../shared/hostShortcutIntents.js'

export class HostShortcutRouter {
  constructor(handlers = {}) {
    this.handlers = handlers
    this._handleKeydown = this._handleKeydown.bind(this)
  }

  init() {
    document.addEventListener('keydown', this._handleKeydown)
  }

  handleIntent(intent) {
    switch (intent) {
      case HOST_SHORTCUT_INTENTS.TOGGLE_PLAYBACK:
        this.handlers.onTogglePlayback?.()
        return true
      case HOST_SHORTCUT_INTENTS.TOGGLE_SOLO:
        this.handlers.onToggleSolo?.()
        return true
      case HOST_SHORTCUT_INTENTS.TOGGLE_MUTE:
        this.handlers.onToggleMute?.()
        return true
      default:
        return false
    }
  }

  _handleKeydown(event) {
    const intent = getHostShortcutIntent(event)
    if (!intent) return
    event.preventDefault()
    this.handleIntent(intent)
  }
}
