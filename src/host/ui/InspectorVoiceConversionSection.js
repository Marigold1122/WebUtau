function query(root, name) {
  return root?.querySelector(`[data-vc-ref="${name}"]`) || null
}

function setText(node, text) {
  if (node) node.textContent = text || ''
}

function formatValue(key, value) {
  if (key === 'lengthAdjust' || key === 'cfgRate') return Number(value || 0).toFixed(2)
  return String(value ?? '')
}

function toParamValue(input, key) {
  if (input.type === 'checkbox') return Boolean(input.checked)
  if (key === 'diffusionSteps' || key === 'pitchShift') return Math.round(Number(input.value || 0))
  return Number(input.value || 0)
}

export class InspectorVoiceConversionSection {
  constructor(root, handlers = {}) {
    this.root = root
    this.handlers = handlers
    this.refs = {
      message: query(root, 'message'),
      status: query(root, 'status'),
      draft: query(root, 'draft'),
      body: query(root, 'body'),
      referenceButton: query(root, 'reference-button'),
      referenceInput: query(root, 'reference-input'),
      referenceName: query(root, 'reference-name'),
      startButton: query(root, 'start-button'),
      cancelButton: query(root, 'cancel-button'),
      applyButton: query(root, 'apply-button'),
      restoreButton: query(root, 'restore-button'),
      clearButton: query(root, 'clear-button'),
    }
    this.paramInputs = [...(root?.querySelectorAll('[data-vc-param]') || [])]
    this.valueLabels = new Map(
      [...(root?.querySelectorAll('[data-vc-value]') || [])].map((node) => [node.dataset.vcValue, node]),
    )
  }

  setHandlers(handlers = {}) {
    this.handlers = handlers
  }

  init() {
    if (!this.root) return
    this.refs.referenceButton?.addEventListener('click', () => this.refs.referenceInput?.click())
    this.refs.referenceInput?.addEventListener('change', (event) => {
      const file = event.target.files?.[0] || null
      this.handlers.onVoiceConversionReferenceSelected?.(file)
      event.target.value = ''
    })
    this.refs.startButton?.addEventListener('click', () => this.handlers.onVoiceConversionStart?.())
    this.refs.cancelButton?.addEventListener('click', () => this.handlers.onVoiceConversionCancel?.())
    this.refs.applyButton?.addEventListener('click', () => this.handlers.onVoiceConversionApply?.())
    this.refs.restoreButton?.addEventListener('click', () => this.handlers.onVoiceConversionRestore?.())
    this.refs.clearButton?.addEventListener('click', () => this.handlers.onVoiceConversionClear?.())
    this.paramInputs.forEach((input) => {
      const eventName = input.type === 'checkbox' ? 'change' : 'input'
      input.addEventListener(eventName, () => {
        this.handlers.onVoiceConversionParamChanged?.(input.dataset.vcParam, toParamValue(input, input.dataset.vcParam))
      })
    })
    this.render({ visible: false })
  }

  render(state = {}) {
    if (!this.root) return
    this.root.hidden = !state.visible
    if (!state.visible) return

    const disabled = state.uiState === 'disabled-wait-render'
    setText(this.refs.message, disabled ? state.disabledText : '')
    if (this.refs.message) this.refs.message.dataset.tone = state.messageTone || 'blocked'
    this.refs.message.hidden = !disabled
    this.refs.body.hidden = disabled
    if (disabled) return

    setText(this.refs.status, state.statusText)
    if (this.refs.status) this.refs.status.dataset.tone = state.statusTone || 'idle'
    setText(this.refs.draft, state.draftText)
    if (this.refs.draft) this.refs.draft.dataset.tone = state.draftTone || 'hint'
    this.refs.draft.hidden = !state.draftText
    setText(this.refs.referenceName, state.referenceLabel)

    this.paramInputs.forEach((input) => {
      const value = state.params?.[input.dataset.vcParam]
      if (input.type === 'checkbox') {
        input.checked = Boolean(value)
      } else {
        input.value = value ?? input.value
      }
      const label = this.valueLabels.get(input.dataset.vcParam)
      if (label) setText(label, formatValue(input.dataset.vcParam, value))
    })

    this.refs.referenceButton.disabled = Boolean(state.busy)
    this.refs.startButton.disabled = !state.canStart
    this.refs.cancelButton.disabled = !state.canCancel
    this.refs.applyButton.disabled = !state.canApply
    this.refs.restoreButton.disabled = !state.canRestore
    this.refs.clearButton.disabled = !state.canClear
  }
}
