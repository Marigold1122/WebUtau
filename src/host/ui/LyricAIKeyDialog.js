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

const PROVIDER_PRESETS = [
  {
    id: 'deepseek',
    name: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/v1',
    model: 'deepseek-chat',
  },
  {
    id: 'qwen',
    name: '通义 (DashScope)',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    model: 'qwen-plus',
  },
  {
    id: 'glm',
    name: '智谱 GLM',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    model: 'glm-4-flash',
  },
  {
    id: 'kimi',
    name: '月之暗面 Kimi',
    baseUrl: 'https://api.moonshot.cn/v1',
    model: 'moonshot-v1-8k',
  },
]

function buildSecurityNotice(isDesktop) {
  if (isDesktop) {
    return [
      '✓ 你的 key 存在系统级密钥库（macOS Keychain / Windows Credential Manager / Linux Secret Service）',
      '✓ 浏览器引擎、网页 JS、流氓浏览器扩展都无法读到——OS 进程外隔离存储',
      '✓ 调用时桌面应用直接发到 LLM 厂商服务器，绝不经过 WebUtau 服务器',
      '⚠ 仍无法防御本机被植入恶意 root 级软件——任何安全方案都防不住',
    ]
  }
  return [
    '✓ 你的 key 只保存在本浏览器（已 AES-GCM 加密）',
    '✓ 调用时浏览器直接发到 LLM 厂商，绝不经过 WebUtau 服务器',
    '⚠ 浏览器侧加密只防 F12 一眼看明文，不防本机木马 / XSS / 流氓扩展',
    '· 需要绝对安全请用桌面版（系统钥匙库存储）',
  ]
}

export function openLyricAIKeyDialog({ initial = {}, isDesktop = false } = {}) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div')
    overlay.className = 'lyric-ai-key-overlay'

    const dialog = document.createElement('div')
    dialog.className = 'lyric-ai-key-dialog'
    dialog.setAttribute('role', 'dialog')
    dialog.setAttribute('aria-label', 'AI 协作填词配置')

    // 标题
    const title = document.createElement('h2')
    title.className = 'lyric-ai-key-title'
    title.textContent = isDesktop ? 'AI 写词配置（桌面版）' : 'AI 写词配置（网页版）'
    dialog.appendChild(title)

    // 安全告知 panel
    const noticeWrap = document.createElement('div')
    noticeWrap.className = 'lyric-ai-key-notice'
    const noticeTitle = document.createElement('div')
    noticeTitle.className = 'lyric-ai-key-notice-title'
    noticeTitle.textContent = '关于你的 API key 安全'
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
    presetLabel.textContent = '厂商预设：'
    presetRow.appendChild(presetLabel)
    PROVIDER_PRESETS.forEach((preset) => {
      const chip = document.createElement('button')
      chip.type = 'button'
      chip.className = 'lyric-ai-key-preset-chip'
      chip.textContent = preset.name
      chip.addEventListener('click', () => {
        baseUrlInput.value = preset.baseUrl
        modelInput.value = preset.model
        keyInput.focus() // 聚焦 key 框等待填入
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

    const keyField = createField('API Key', 'password', initial.apiKey || '', '请粘贴 LLM 厂商提供的 key')
    const keyInput = keyField.input

    const baseUrlField = createField(
      'Base URL（OpenAI 兼容路径）',
      'text',
      initial.baseUrl || '',
      '点上方厂商预设自动填，或手动填写',
    )
    const baseUrlInput = baseUrlField.input

    const modelField = createField(
      '模型名',
      'text',
      initial.model || '',
      '例：deepseek-chat / qwen-plus / glm-4-flash',
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
    btnCancel.textContent = '取消'
    btnCancel.addEventListener('click', () => closeWith({ action: 'cancel' }))

    const btnClear = document.createElement('button')
    btnClear.type = 'button'
    btnClear.className = 'lyric-ai-key-btn lyric-ai-key-btn--danger'
    btnClear.textContent = '清除已保存的 key'
    btnClear.disabled = !initial.apiKey
    btnClear.addEventListener('click', () => {
      if (!window.confirm) {
        // 极端情况兜底——直接清
        closeWith({ action: 'clear' })
        return
      }
      // 用户已经在自定义模态里了，再来一层 confirm 容易卡死，改用模态自己的提示
      errorEl.hidden = false
      errorEl.dataset.tone = 'warn'
      errorEl.textContent = '再次点击"清除已保存的 key"以确认清除'
      btnClear.dataset.confirming = '1'
      btnClear.textContent = '确认清除？'
      btnClear.addEventListener('click', () => closeWith({ action: 'clear' }), { once: true })
    })

    const btnSave = document.createElement('button')
    btnSave.type = 'button'
    btnSave.className = 'lyric-ai-key-btn lyric-ai-key-btn--primary'
    btnSave.textContent = '保存'
    btnSave.addEventListener('click', handleSave)

    actions.append(btnCancel, btnClear, btnSave)
    dialog.appendChild(actions)

    overlay.appendChild(dialog)
    document.body.appendChild(overlay)

    // 入场聚焦：有 initial 时聚焦 key 框，否则聚焦第一个 chip 让用户先选厂商
    requestAnimationFrame(() => {
      if (initial.apiKey) keyInput.focus()
      else keyInput.focus()
    })

    // ESC 关闭
    const escHandler = (e) => {
      if (e.key === 'Escape') closeWith({ action: 'cancel' })
    }
    document.addEventListener('keydown', escHandler)

    // 点 overlay 空白处关闭（dialog 里的点击不冒泡到这里）
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) closeWith({ action: 'cancel' })
    })
    dialog.addEventListener('click', (e) => e.stopPropagation())

    function handleSave() {
      const apiKey = keyInput.value.trim()
      const baseUrl = baseUrlInput.value.trim()
      const model = modelInput.value.trim()

      if (!apiKey) {
        showError('请填 API key（或点"取消"放弃）')
        keyInput.focus()
        return
      }
      if (!baseUrl) {
        showError('请填 Base URL（点上方厂商预设自动填）')
        baseUrlInput.focus()
        return
      }
      if (!model) {
        showError('请填模型名（点上方厂商预设自动填）')
        modelInput.focus()
        return
      }
      // 简单校验 URL 格式——必须以 http(s):// 开头
      if (!/^https?:\/\//i.test(baseUrl)) {
        showError('Base URL 必须以 http:// 或 https:// 开头')
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
