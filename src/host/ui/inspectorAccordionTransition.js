/**
 * 给侧边栏的 <details class="inspector-section"> 加平滑展开/折叠动画。
 *
 * 原生 <details> 的 open/close 是瞬时的——切换的一刻 body 从 display:none 直接跳出来。
 * 这里拦截 <summary> 的点击，用 Web Animations API 对 body 做 height + opacity 过渡，
 * 之后再同步 open 属性，保留 <details> 的语义、键盘访问性与嵌套状态。
 *
 * 240ms + material-standard easing 是主观感受上"丝滑而不拖沓"的甜点区。
 */

const DURATION_MS = 240
const EASING = 'cubic-bezier(0.4, 0, 0.2, 1)'

export function installInspectorAccordionTransition(root = document) {
  root.querySelectorAll('details.inspector-section').forEach(enhance)
}

function enhance(details) {
  const summary = details.querySelector(':scope > summary')
  const body = details.querySelector(':scope > .inspector-section-body')
  if (!summary || !body) return
  // 连点时前一段动画需要被取消，避免状态打架
  let activeAnim = null

  summary.addEventListener('click', (event) => {
    event.preventDefault()
    if (activeAnim) { activeAnim.cancel(); activeAnim = null }

    if (details.open) {
      const fromHeight = body.offsetHeight
      const anim = body.animate(
        [
          { height: `${fromHeight}px`, opacity: 1 },
          { height: '0px', opacity: 0 },
        ],
        { duration: DURATION_MS, easing: EASING },
      )
      activeAnim = anim
      anim.finished.then(() => {
        details.removeAttribute('open')
        if (activeAnim === anim) activeAnim = null
      }).catch(() => {
        details.removeAttribute('open')
        if (activeAnim === anim) activeAnim = null
      })
    } else {
      details.setAttribute('open', '')
      const targetHeight = body.offsetHeight
      const anim = body.animate(
        [
          { height: '0px', opacity: 0 },
          { height: `${targetHeight}px`, opacity: 1 },
        ],
        { duration: DURATION_MS, easing: EASING },
      )
      activeAnim = anim
      anim.finished.then(() => {
        if (activeAnim === anim) activeAnim = null
      }).catch(() => {
        if (activeAnim === anim) activeAnim = null
      })
    }
  })
}
