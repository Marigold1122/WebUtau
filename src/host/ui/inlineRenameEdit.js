/**
 * 把任意展示文本的元素临时改造为 inline 编辑框（contenteditable）。
 *
 * 行为：
 *   Enter / 失焦 → 提交（去首尾空白）
 *   Escape       → 取消并还原原值
 *   空字符串     → 视为取消
 *
 * 不会移动 DOM 节点，避免触发外层重排或 layout shift；
 * onCommit 内部如果触发了渲染重建（替换了元素），不会爆炸——
 * 此时 cleanup 已经发生在替换前，监听器随旧节点回收即可。
 */
export function startInlineRenameEdit(el, initialValue, { onCommit, onCancel } = {}) {
  if (!el) return
  // 防止双开
  if (el.dataset.editing === '1') return
  el.dataset.editing = '1'
  el.contentEditable = 'plaintext-only'
  el.spellcheck = false
  el.classList.add('is-editing')
  el.textContent = initialValue ?? ''
  // 全选当前内容，方便用户直接键入替换
  const range = document.createRange()
  range.selectNodeContents(el)
  const sel = window.getSelection?.()
  if (sel) {
    sel.removeAllRanges()
    sel.addRange(range)
  }
  el.focus()

  let done = false
  const finish = (shouldCommit) => {
    if (done) return
    done = true
    el.removeEventListener('keydown', onKeydown)
    el.removeEventListener('blur', onBlur)
    el.contentEditable = 'false'
    el.classList.remove('is-editing')
    delete el.dataset.editing
    if (shouldCommit) {
      const value = (el.textContent || '').trim()
      if (value && value !== initialValue) {
        onCommit?.(value)
        return
      }
    }
    // 取消或没改动：还原显示
    el.textContent = initialValue
    onCancel?.()
  }

  function onKeydown(event) {
    if (event.key === 'Enter') {
      event.preventDefault()
      event.stopPropagation()
      finish(true)
    } else if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      finish(false)
    } else if (event.key !== 'Tab') {
      // 其它按键不冒泡，避免触发钢琴卷帘 / 工具切换等全局快捷键
      event.stopPropagation()
    }
  }
  function onBlur() { finish(true) }

  el.addEventListener('keydown', onKeydown)
  el.addEventListener('blur', onBlur)
}
