import { t } from '../../i18n/index.js'

export function createVoiceConversionViewHandlers({ store, view, controller }) {
  function getSelectedTrack() {
    return store.getSelectedTrack()
  }

  return {
    onVoiceConversionReferenceSelected(file) {
      const track = getSelectedTrack()
      if (!track) return
      controller.setReferenceFile(track.id, file)
      view.setStatus(file
        ? t('voiceConversion.selected_reference', { name: track.name })
        : t('voiceConversion.cleared_reference', { name: track.name }))
    },
    onVoiceConversionParamChanged(key, value) {
      const track = getSelectedTrack()
      if (!track || !key) return
      controller.updateParams(track.id, { [key]: value })
    },
    async onVoiceConversionStart() {
      const track = getSelectedTrack()
      if (!track) return
      try {
        view.setStatus(t('voiceConversion.converting_track', { name: track.name }))
        await controller.startConversion(track.id)
        view.setStatus(t('voiceConversion.done_track', { name: track.name }))
      } catch (error) {
        if (error?.name === 'VoiceConversionCancelledError') {
          view.setStatus(t('voiceConversion.canceled_track', { name: track.name }))
          return
        }
        console.error('Voice conversion failed:', error)
        view.setStatus(t('voiceConversion.failed_track', {
          name: track.name,
          message: error?.message || t('hostStatus.unknown_error'),
        }))
      }
    },
    async onVoiceConversionCancel() {
      const track = getSelectedTrack()
      if (!track) return
      const cancelled = await controller.cancelConversion(track.id)
      if (cancelled) {
        view.setStatus(t('voiceConversion.canceled_track', { name: track.name }))
      }
    },
    async onVoiceConversionApply() {
      const track = getSelectedTrack()
      if (!track) return
      try {
        await controller.applyConvertedVariant(track.id)
        view.setStatus(t('voiceConversion.apply_done', { name: track.name }))
      } catch (error) {
        console.error('Apply converted voice failed:', error)
        view.setStatus(t('voiceConversion.apply_failed', {
          name: track.name,
          message: error?.message || t('hostStatus.unknown_error'),
        }))
      }
    },
    async onVoiceConversionRestore() {
      const track = getSelectedTrack()
      if (!track) return
      await controller.restoreOriginalVariant(track.id)
      view.setStatus(t('voiceConversion.restore_done', { name: track.name }))
    },
    async onVoiceConversionClear() {
      const track = getSelectedTrack()
      if (!track) return
      await controller.clearConversion(track.id)
      view.setStatus(t('voiceConversion.cleared_result', { name: track.name }))
    },
  }
}
