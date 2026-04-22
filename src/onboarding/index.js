import './onboarding.css'
import { OnboardingController } from './OnboardingController.js'

let singleton = null

export function initOnboarding() {
  if (singleton) return singleton
  singleton = new OnboardingController()
  singleton.autoStart()
  return singleton
}

export function getOnboardingController() {
  return singleton
}
