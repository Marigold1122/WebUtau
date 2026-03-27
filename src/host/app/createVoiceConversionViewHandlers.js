export function createVoiceConversionViewHandlers({ store, view, controller }) {
  function getSelectedTrack() {
    return store.getSelectedTrack()
  }

  return {
    onVoiceConversionReferenceSelected(file) {
      const track = getSelectedTrack()
      if (!track) return
      controller.setReferenceFile(track.id, file)
      view.setStatus(file ? `已为 ${track.name} 选择参考音频` : `已清除 ${track.name} 的参考音频`)
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
        view.setStatus(`正在为 ${track.name} 进行音色转换...`)
        await controller.startConversion(track.id)
        view.setStatus(`已生成 ${track.name} 的音色转换结果`)
      } catch (error) {
        if (error?.name === 'VoiceConversionCancelledError') {
          view.setStatus(`已取消 ${track.name} 的音色转换`)
          return
        }
        console.error('Voice conversion failed:', error)
        view.setStatus(`音色转换失败: ${track.name} | ${error?.message || '未知错误'}`)
      }
    },
    async onVoiceConversionCancel() {
      const track = getSelectedTrack()
      if (!track) return
      const cancelled = await controller.cancelConversion(track.id)
      if (cancelled) {
        view.setStatus(`已取消 ${track.name} 的音色转换`)
      }
    },
    async onVoiceConversionApply() {
      const track = getSelectedTrack()
      if (!track) return
      try {
        await controller.applyConvertedVariant(track.id)
        view.setStatus(`已将 ${track.name} 切换为转换后人声`)
      } catch (error) {
        console.error('Apply converted voice failed:', error)
        view.setStatus(`应用转换结果失败: ${track.name} | ${error?.message || '未知错误'}`)
      }
    },
    async onVoiceConversionRestore() {
      const track = getSelectedTrack()
      if (!track) return
      await controller.restoreOriginalVariant(track.id)
      view.setStatus(`已恢复 ${track.name} 的原始人声`)
    },
    async onVoiceConversionClear() {
      const track = getSelectedTrack()
      if (!track) return
      await controller.clearConversion(track.id)
      view.setStatus(`已清除 ${track.name} 的音色转换结果`)
    },
  }
}
