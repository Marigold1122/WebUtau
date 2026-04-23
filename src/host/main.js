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
