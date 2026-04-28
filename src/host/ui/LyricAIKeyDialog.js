// 用户填 LLM API key 的自定义模态弹窗。
//
// 为什么不用 window.confirm / window.prompt：Tauri webview（macOS WKWebView /
// Linux WebKitGTK）会静默拦截这些原生弹窗——返回 false / null 不显示任何 UI，
// 桌面版用户点配置按钮"什么都没发生"。改成自定义模态后两端表现一致。
//
// 同时升级 UX：单弹窗一次性收集 key + baseUrl + model（之前是三连 prompt），
// 加 DeepSeek / 通义 / GLM 厂商预设 chip 自动填 baseUrl + model
//
// 用法：
//   const result = await openLyricAIKeyDialog({
//     initial: { apiKey, baseUrl, model },
//     isDesktop: true,
//   })
//   if (result.action === 'save')  → result.config: { apiKey, baseUrl, model }
//   if (result.action === 'clear') → 用户点了清除已保存
//   if (result.action === 'cancel') → 用户取消，无副作用

import { t } from '../../i18n/index.js'

function getProviderPresets() {
  return [
    { id: 'deepseek', name: t('lyricKey.vendor.deepseek'), baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
    { id: 'qwen', name: t('lyricKey.vendor.dashscope'), baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus' },
    { id: 'glm', name: t('lyricKey.vendor.glm'), baseUrl: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4-flash' },
    { id: 'kimi', name: t('lyricKey.vendor.kimi'), baseUrl: 'https://api.moonshot.cn/v1', model: 'moonshot-v1-8k' },
  ]
}

function buildSecurityNotice(isDesktop) {
  if (isDesktop) {
    return [
      t('lyricKey.safety.desktop_1'),
      t('lyricKey.safety.desktop_2'),
      t('lyricKey.safety.desktop_3'),
      t('lyricKey.safety.desktop_4'),
    ]
  }
  return [
    t('lyricKey.safety.browser_1'),
    t('lyricKey.safety.browser_2'),
    t('lyricKey.safety.browser_3'),
    t('lyricKey.safety.browser_4'),
  ]
}

export function openLyricAIKeyDialog({ initial = {}, isDesktop = false } = {}) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div')
    overlay.className = 'lyric-ai-key-overlay'

    const dialog = document.createElement('div')
    dialog.className = 'lyric-ai-key-dialog'
    dialog.setAttribute('role', 'dialog')
    dialog.setAttribute('aria-label', t('lyricKey.dialog_aria'))

    // 标题
    const title = document.createElement('h2')
    title.className = 'lyric-ai-key-title'
    title.textContent = isDesktop ? t('lyricKey.dialog_title_desktop') : t('lyricKey.dialog_title_browser')
    dialog.appendChild(title)

    // 安全告知 panel
    const noticeWrap = document.createElement('div')
    noticeWrap.className = 'lyric-ai-key-notice'
    const noticeTitle = document.createElement('div')
    noticeTitle.className = 'lyric-ai-key-notice-title'
    noticeTitle.textContent = t('lyricKey.title')
    noticeWrap.appendChild(noticeTitle)
    buildSecurityNotice(isDesktop).forEach((line) => {
      const p = document.createElement('div')
      p.className = 'lyric-ai-key-notice-line'
      p.textContent = line
      noticeWrap.appendChild(p)
    })
    dialog.appendChild(noticeWrap)

    // 厂商预设 chip
    const presetRow = document.createElement('div')
    presetRow.className = 'lyric-ai-key-presets'
    const presetLabel = document.createElement('span')
    presetLabel.className = 'lyric-ai-key-presets-label'
    presetLabel.textContent = t('lyricKey.vendors_label')
    presetRow.appendChild(presetLabel)
    getProviderPresets().forEach((preset) => {
      const chip = document.createElement('button')
      chip.type = 'button'
      chip.className = 'lyric-ai-key-preset-chip'
      chip.textContent = preset.name
      chip.addEventListener('click', () => {
        baseUrlInput.value = preset.baseUrl
        modelInput.value = preset.model
        keyInput.focus()
      })
      presetRow.appendChild(chip)
    })
    dialog.appendChild(presetRow)

    // 表单字段
    const form = document.createElement('form')
    form.className = 'lyric-ai-key-form'
    form.addEventListener('submit', (e) => {
      e.preventDefault()
      handleSave()
    })

    const keyField = createField(t('lyricKey.api_key_label'), 'password', initial.apiKey || '', t('lyricKey.api_key_placeholder'))
    const keyInput = keyField.input

    const baseUrlField = createField(
      t('lyricKey.base_url_label'),
      'text',
      initial.baseUrl || '',
      t('lyricKey.base_url_placeholder'),
    )
    const baseUrlInput = baseUrlField.input

    const modelField = createField(
      t('lyricKey.model_label'),
      'text',
      initial.model || '',
      t('lyricKey.model_placeholder'),
    )
    const modelInput = modelField.input

    form.append(keyField.wrap, baseUrlField.wrap, modelField.wrap)
    dialog.appendChild(form)

    // 错误提示行
    const errorEl = document.createElement('div')
    errorEl.className = 'lyric-ai-key-error'
    errorEl.hidden = true
    dialog.appendChild(errorEl)

    // 按钮组
    const actions = document.createElement('div')
    actions.className = 'lyric-ai-key-actions'

    const btnCancel = document.createElement('button')
    btnCancel.type = 'button'
    btnCancel.className = 'lyric-ai-key-btn lyric-ai-key-btn--ghost'
    btnCancel.textContent = t('lyricKey.cancel')
    btnCancel.addEventListener('click', () => closeWith({ action: 'cancel' }))

    const btnClear = document.createElement('button')
    btnClear.type = 'button'
    btnClear.className = 'lyric-ai-key-btn lyric-ai-key-btn--danger'
    btnClear.textContent = t('lyricKey.clear')
    btnClear.disabled = !initial.apiKey
    btnClear.addEventListener('click', () => {
      if (!window.confirm) {
        closeWith({ action: 'clear' })
        return
      }
      errorEl.hidden = false
      errorEl.dataset.tone = 'warn'
      errorEl.textContent = t('lyricKey.err_confirm_clear')
      btnClear.dataset.confirming = '1'
      btnClear.textContent = t('lyricKey.confirm_clear')
      btnClear.addEventListener('click', () => closeWith({ action: 'clear' }), { once: true })
    })

    const btnSave = document.createElement('button')
    btnSave.type = 'button'
    btnSave.className = 'lyric-ai-key-btn lyric-ai-key-btn--primary'
    btnSave.textContent = t('lyricKey.save')
    btnSave.addEventListener('click', handleSave)

    actions.append(btnCancel, btnClear, btnSave)
    dialog.appendChild(actions)

    overlay.appendChild(dialog)
    document.body.appendChild(overlay)

    requestAnimationFrame(() => {
      keyInput.focus()
    })

    const escHandler = (e) => {
      if (e.key === 'Escape') closeWith({ action: 'cancel' })
    }
    document.addEventListener('keydown', escHandler)

    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) closeWith({ action: 'cancel' })
    })
    dialog.addEventListener('click', (e) => e.stopPropagation())

    function handleSave() {
      const apiKey = keyInput.value.trim()
      const baseUrl = baseUrlInput.value.trim()
      const model = modelInput.value.trim()

      if (!apiKey) {
        showError(t('lyricKey.err_need_key'))
        keyInput.focus()
        return
      }
      if (!baseUrl) {
        showError(t('lyricKey.err_need_baseurl'))
        baseUrlInput.focus()
        return
      }
      if (!model) {
        showError(t('lyricKey.err_need_model'))
        modelInput.focus()
        return
      }
      if (!/^https?:\/\//i.test(baseUrl)) {
        showError(t('lyricKey.err_baseurl_format'))
        baseUrlInput.focus()
        return
      }

      closeWith({ action: 'save', config: { apiKey, baseUrl, model } })
    }

    function showError(msg) {
      errorEl.hidden = false
      errorEl.dataset.tone = 'error'
      errorEl.textContent = msg
    }

    function closeWith(result) {
      document.removeEventListener('keydown', escHandler)
      overlay.remove()
      resolve(result)
    }
  })
}

function createField(label, type, value, placeholder) {
  const wrap = document.createElement('label')
  wrap.className = 'lyric-ai-key-field'
  const labelEl = document.createElement('span')
  labelEl.className = 'lyric-ai-key-field-label'
  labelEl.textContent = label
  const input = document.createElement('input')
  input.type = type
  input.className = 'lyric-ai-key-field-input'
  input.value = value
  input.placeholder = placeholder || ''
  input.spellcheck = false
  input.autocomplete = type === 'password' ? 'new-password' : 'off'
  // 屏蔽全局快捷键拦截（空格 / S 等会被 host 抢去做播放控制）
  input.addEventListener('keydown', (e) => e.stopPropagation())
  wrap.append(labelEl, input)
  return { wrap, input }
}
