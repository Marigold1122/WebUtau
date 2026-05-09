// 官方歌词弹窗——AI 写词前必填。
// 用户把这首歌真实的歌词粘贴进来（每行一句），AI 据此知道"该写多少句、每句多少字"，
// 不会被后端 phrase 切分（按音符间隔）的怪异分段误导。
//
// 数据流：
//   - 输入：savedLines（来自 track.officialLyrics）—— 用户上次填的官方歌词
//   - 输出：onConfirm(lines: string[]) —— 用户保存的新歌词（按 \n 拆好的行）
// 状态：纯模态，确认 / 取消两条出口

import { t } from '../../i18n/index.js'

export function openOfficialLyricsDialog({ initialLines = [], onConfirm = null, onCancel = null } = {}) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div')
    overlay.className = 'official-lyrics-overlay'
    overlay.addEventListener('mousedown', (e) => {
      if (e.target === overlay) handleCancel()
    })

    const panel = document.createElement('div')
    panel.className = 'official-lyrics-panel'
    panel.addEventListener('mousedown', (e) => e.stopPropagation())

    // 标题区
    const header = document.createElement('div')
    header.className = 'official-lyrics-header'
    const title = document.createElement('div')
    title.className = 'official-lyrics-title'
    title.textContent = t('officialLyrics.title')
    const closeBtn = document.createElement('button')
    closeBtn.type = 'button'
    closeBtn.className = 'official-lyrics-close'
    closeBtn.textContent = '×'
    closeBtn.title = t('officialLyrics.cancel')
    closeBtn.addEventListener('click', () => handleCancel())
    header.append(title, closeBtn)

    // 提示
    const hint = document.createElement('div')
    hint.className = 'official-lyrics-hint'
    hint.innerHTML = `
      <span class="official-lyrics-hint-icon" aria-hidden="true">💡</span>
      <span>${t('officialLyrics.hint')}</span>
    `

    // textarea
    const textarea = document.createElement('textarea')
    textarea.className = 'official-lyrics-textarea'
    textarea.spellcheck = false
    textarea.placeholder = t('officialLyrics.placeholder')
    textarea.value = (Array.isArray(initialLines) ? initialLines : []).join('\n')
    textarea.addEventListener('keydown', (e) => e.stopPropagation())

    // 按钮
    const actions = document.createElement('div')
    actions.className = 'official-lyrics-actions'
    const btnCancel = document.createElement('button')
    btnCancel.type = 'button'
    btnCancel.className = 'modal-btn secondary'
    btnCancel.textContent = t('officialLyrics.cancel')
    btnCancel.addEventListener('click', () => handleCancel())
    const btnSave = document.createElement('button')
    btnSave.type = 'button'
    btnSave.className = 'modal-btn primary'
    btnSave.textContent = t('officialLyrics.save')
    btnSave.title = `${t('officialLyrics.save')} (Cmd+Enter)`
    btnSave.addEventListener('click', () => handleSave())
    actions.append(btnCancel, btnSave)

    panel.append(header, hint, textarea, actions)
    overlay.appendChild(panel)
    document.body.appendChild(overlay)

    requestAnimationFrame(() => {
      overlay.classList.add('is-visible')
      textarea.focus()
      textarea.select()
    })

    // 键盘
    function onKeyDown(event) {
      const meta = event.metaKey || event.ctrlKey
      if (event.key === 'Escape') {
        handleCancel()
        event.preventDefault()
      } else if (event.key === 'Enter' && meta) {
        handleSave()
        event.preventDefault()
      }
    }
    document.addEventListener('keydown', onKeyDown, true)

    function cleanup() {
      document.removeEventListener('keydown', onKeyDown, true)
      overlay.classList.remove('is-visible')
      // 给 fade-out 一个短暂窗口再 remove
      setTimeout(() => overlay.remove(), 180)
    }

    function handleSave() {
      // 按 \n 拆行——每行可能有空白，调用方按需 trim
      const lines = textarea.value.split('\n')
      cleanup()
      onConfirm?.(lines)
      resolve({ action: 'save', lines })
    }

    function handleCancel() {
      cleanup()
      onCancel?.()
      resolve({ action: 'cancel' })
    }
  })
}
