import { normalizeOptionalLanguageCode } from '../../config/languageOptions.js'
import { isVoiceRuntimeSource } from './trackSourceAssignment.js'

export function requiresVoiceLanguageSelection(track) {
  if (!isVoiceRuntimeSource(track?.playbackState?.assignedSourceId)) return false
  return !normalizeOptionalLanguageCode(track?.languageCode)
}

export function hasTracksRequiringVoiceLanguageSelection(tracks) {
  return (tracks || []).some((track) => requiresVoiceLanguageSelection(track))
}
