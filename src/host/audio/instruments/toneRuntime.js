let toneModulePromise = null

export function loadToneRuntime() {
  if (!toneModulePromise) {
    toneModulePromise = import('tone')
  }
  return toneModulePromise
}

export async function getToneRawContext() {
  const Tone = await loadToneRuntime()
  return Tone.getContext().rawContext
}

export async function startToneAudio() {
  const Tone = await loadToneRuntime()
  await Tone.start()
  return Tone.getContext().rawContext
}
