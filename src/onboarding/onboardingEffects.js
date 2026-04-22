/**
 * 切步时重播气泡内部的入场动画：
 *   - 正文：从下浮起 + 淡入 + 回弹
 *   - 发箍：轻微摆动一下
 *
 * 用 "清除 animation → 强制 reflow → 恢复 animation" 的老招，
 * 确保同一段 CSS @keyframes 每次进入新一小步都能被再次触发。
 */
export function replayEntryAnimations(root, bodyEl) {
  if (bodyEl) {
    bodyEl.style.animation = 'none'
    void bodyEl.offsetWidth
    bodyEl.style.animation = ''
  }
  const bow = root?.querySelector('.wu-onboarding__bow')
  if (bow) {
    bow.classList.remove('wu-onboarding__bow--swing')
    void bow.offsetWidth
    bow.classList.add('wu-onboarding__bow--swing')
  }
}
