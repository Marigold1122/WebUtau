import { createHostApp } from './app/createHostApp.js'
import { initOnboarding } from '../onboarding/index.js'
import { installVoiceRuntimePanBridge } from './transport/voiceRuntimePanBridge.js'

const hostApp = createHostApp()
hostApp.init()

window.hostApp = hostApp
const onboarding = initOnboarding()
window.webutauOnboarding = onboarding
installVoiceRuntimePanBridge()

const replayBtn = document.getElementById('btn-onboarding-replay')
if (replayBtn) {
  replayBtn.addEventListener('click', () => onboarding.start({ force: true }))
}

// 关于浮卡：点击底部"关于"按钮展开/收起；点卡外区域关闭
const aboutToggleBtn = document.getElementById('btn-about-toggle')
const aboutPopover = document.getElementById('inspector-tab-about')
if (aboutToggleBtn && aboutPopover) {
  const closeAbout = () => {
    aboutPopover.hidden = true
    aboutToggleBtn.setAttribute('aria-expanded', 'false')
  }
  aboutToggleBtn.addEventListener('click', (event) => {
    event.stopPropagation()
    const isOpen = !aboutPopover.hidden
    if (isOpen) { closeAbout(); return }
    aboutPopover.hidden = false
    aboutToggleBtn.setAttribute('aria-expanded', 'true')
  })
  document.addEventListener('click', (event) => {
    if (aboutPopover.hidden) return
    if (aboutPopover.contains(event.target) || event.target === aboutToggleBtn) return
    closeAbout()
  })
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !aboutPopover.hidden) closeAbout()
  })
}
