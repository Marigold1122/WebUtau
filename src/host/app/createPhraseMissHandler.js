const PHRASE_MISS_TOAST =
  '人声轨道当前语句还没合成完毕咕，已自动静音该句子~'

export function createPhraseMissHandler({
  playbackMode,
  transportCoordinator,
  runtimeTransportSync,
  taskRemoteGateway,
  view,
  logger = null,
}) {
  return (entry) => {
    const phraseIndex = entry?.phraseIndex ?? null
    const jobId = entry?.jobId || null

    logger?.info?.('Host vocal phrase missing during playback', {
      trackId: entry?.trackId || null,
      phraseIndex,
      jobId,
      mode: playbackMode.getMode(),
    })

    const decision = playbackMode.handlePhraseMiss(entry?.trackId || null, phraseIndex, jobId)

    if (decision.action === 'buffer') {
      // EDIT 模式：暂停等待，播放头变黄
      transportCoordinator.pause()
      runtimeTransportSync?.syncWaiting?.(transportCoordinator.getSnapshot())
      view?.setStatus?.('等待语句渲染完成...')
    } else if (decision.action === 'skip') {
      // PREVIEW 模式：静音跳过 + toast
      view?.showPlaybackToast?.(PHRASE_MISS_TOAST)
    }
    // already-buffering: 不做额外操作

    // 两种模式都向后端请求优先渲染
    taskRemoteGateway
      ?.prioritizePhrase(jobId, phraseIndex)
      ?.catch?.((error) => {
        console.error('Host vocal prioritize failed:', error)
      })
  }
}
