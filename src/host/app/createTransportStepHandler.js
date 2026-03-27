const DEFAULT_TIME_SIGNATURE = [4, 4]

function resolveBarStepSeconds(project) {
  const bpm = project?.tempoData?.tempos?.[0]?.bpm || 120
  const signature = project?.tempoData?.timeSignatures?.[0]?.timeSignature || DEFAULT_TIME_SIGNATURE
  const numerator = Number.isFinite(signature?.[0]) && signature[0] > 0 ? signature[0] : 4
  const denominator = Number.isFinite(signature?.[1]) && signature[1] > 0 ? signature[1] : 4
  const beatsPerBar = numerator * (4 / denominator)
  return (60 / bpm) * beatsPerBar
}

export function createTransportStepHandler({
  store,
  transportCoordinator,
  view,
  logger = null,
}) {
  return async (direction = 1) => {
    logger?.info?.('宿主小节步进请求', {
      direction: direction < 0 ? 'backward' : 'forward',
      snapshot: transportCoordinator?.getSnapshot?.() || null,
    })
    const project = store.getProject()
    if (!project) {
      view.setStatus('请先导入 MIDI')
      return false
    }

    const currentTime = transportCoordinator.getSnapshot().currentTime || 0
    const stepSeconds = resolveBarStepSeconds(project)
    const nextTime = currentTime + (direction < 0 ? -stepSeconds : stepSeconds)
    const ok = await transportCoordinator.seekToTime(nextTime)
    if (!ok) return false

    logger?.info?.('宿主小节步进', {
      direction: direction < 0 ? 'backward' : 'forward',
      currentTime,
      nextTime,
      stepSeconds,
    })
    return true
  }
}
