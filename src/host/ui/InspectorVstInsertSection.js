// Inspector 内的 VST 区段。仿照 InspectorVoiceConversionSection 的形态：
//   - 通过 data-vst-ref 标记的 DOM 节点拿引用
//   - 处理用户交互，转给 handlers 回调
//   - render(state) 同步外部状态到 DOM
//
// state 形态（由 createHostApp / VoiceConversionViewModel 风格的 viewModel 提供）：
//   {
//     visible: boolean,
//     hostAvailable: boolean,
//     vstInsert: { instanceId, displayName, bypass } | null,
//     status: 'idle' | 'loading' | 'ready' | 'error' | 'unavailable',
//     errorMessage: string,
//   }

function query(root, name) {
  return root?.querySelector(`[data-vst-ref="${name}"]`) || null
}

function setText(node, text) {
  if (node) node.textContent = text || ''
}

function setHidden(node, hidden) {
  if (node) node.hidden = Boolean(hidden)
}

const STATUS_TEXT_KEY = {
  loading: 'inspector.vst.status_loading',
  ready: 'inspector.vst.status_ready',
  error: 'inspector.vst.status_error',
  unavailable: 'inspector.vst.status_unavailable',
}

export class InspectorVstInsertSection {
  constructor(root, handlers = {}, { translate } = {}) {
    this.root = root
    this.handlers = handlers
    this.translate = typeof translate === 'function' ? translate : (key) => key
    this.refs = {
      empty: query(root, 'empty'),
      loaded: query(root, 'loaded'),
      loadButton: query(root, 'load-button'),
      unavailable: query(root, 'unavailable'),
      displayName: query(root, 'display-name'),
      status: query(root, 'status'),
      openEditor: query(root, 'open-editor'),
      bypassToggle: query(root, 'bypass-toggle'),
      replace: query(root, 'replace'),
      remove: query(root, 'remove'),
      error: query(root, 'error'),
    }
  }

  setHandlers(handlers = {}) {
    this.handlers = handlers
  }

  init() {
    if (!this.root) return
    this.refs.loadButton?.addEventListener('click', () => this.handlers.onVstLoadRequested?.())
    this.refs.replace?.addEventListener('click', () => this.handlers.onVstLoadRequested?.({ replace: true }))
    this.refs.remove?.addEventListener('click', () => this.handlers.onVstRemoveRequested?.())
    this.refs.openEditor?.addEventListener('click', () => this.handlers.onVstOpenEditor?.())
    this.refs.bypassToggle?.addEventListener('change', (event) => {
      this.handlers.onVstBypassChanged?.(Boolean(event.target?.checked))
    })
    this.render({ visible: false })
  }

  render(state = {}) {
    if (!this.root) return
    const visible = Boolean(state.visible)
    const hostAvailable = Boolean(state.hostAvailable)
    const insert = state.vstInsert || null
    const status = state.status || (insert ? 'idle' : 'idle')

    if (!visible) {
      // 整个 section 由外层 details 控制 hidden；这里只把内容清掉防止残影
      setHidden(this.refs.empty, true)
      setHidden(this.refs.loaded, true)
      return
    }

    const hasInsert = Boolean(insert)
    setHidden(this.refs.empty, hasInsert)
    setHidden(this.refs.loaded, !hasInsert)

    // empty 态：根据 host 是否可用切换文案与按钮
    if (!hasInsert) {
      const buttonDisabled = !hostAvailable
      if (this.refs.loadButton) {
        this.refs.loadButton.disabled = buttonDisabled
        this.refs.loadButton.classList.toggle('panel-action-btn--disabled', buttonDisabled)
      }
      setHidden(this.refs.unavailable, hostAvailable)
      return
    }

    // loaded 态：渲染插件信息 + 状态 + 错误
    setText(this.refs.displayName, insert.displayName || insert.pluginPath || this.translate('inspector.vst.unknown_plugin'))
    if (this.refs.bypassToggle) this.refs.bypassToggle.checked = Boolean(insert.bypass)

    const statusKey = STATUS_TEXT_KEY[status]
    setText(this.refs.status, statusKey ? this.translate(statusKey) : '')
    if (this.refs.status) {
      this.refs.status.dataset.tone = status === 'error' ? 'error'
        : status === 'loading' ? 'pending'
        : status === 'unavailable' ? 'blocked'
        : 'ok'
    }

    const errorMessage = state.errorMessage || ''
    setHidden(this.refs.error, !errorMessage)
    setText(this.refs.error, errorMessage)

    const editorEnabled = status === 'ready'
    if (this.refs.openEditor) {
      this.refs.openEditor.disabled = !editorEnabled
      this.refs.openEditor.classList.toggle('panel-action-btn--disabled', !editorEnabled)
    }
  }
}
