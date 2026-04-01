import midiImporter from '../../modules/MidiImporter.js'
import midiEncoder from '../../modules/MidiEncoder.js'
import trackSelector from '../../ui/TrackSelector.js'
import { DEFAULT_LANGUAGE_CODE } from '../../config/languageOptions.js'
import { fetchVoicebanks, getDefaultSingerId } from '../../api/VoicebankApi.js'
import { cloneSnapshot } from './runtimeSnapshot.js'

export async function resolveSingerId() {
  const voicebanks = await fetchVoicebanks()
  const singerId = getDefaultSingerId(voicebanks)
  if (!singerId) throw new Error('声库缺少 id')
  return singerId
}

export async function selectRuntimeSnapshotFromImport(file) {
  const tracks = await midiImporter.loadFile(file)
  if (tracks.length === 0) return null

  const result = await trackSelector.show(tracks, file.name, {
    ...midiImporter.tempoData,
    hasTempoInfo: (midiImporter.midiData?.header?.tempos || []).length > 0,
    hasTimeSignatureInfo: (midiImporter.midiData?.header?.timeSignatures || []).length > 0,
  })

  if (!result.syncTempo) midiImporter.tempoData = null
  const phrases = midiImporter.selectTrack(result.trackIndex)
  const tempoData = cloneSnapshot(midiImporter.tempoData)
  const bpm = tempoData?.tempos?.[0]?.bpm || 120
  const timeSignature = tempoData?.timeSignatures?.[0]?.timeSignature || [4, 4]

  return {
    trackId: `standalone-${result.trackIndex}`,
    trackIndex: result.trackIndex,
    trackName: tracks.find((track) => track.index === result.trackIndex)?.name || `轨道 ${result.trackIndex + 1}`,
    languageCode: result.languageCode || DEFAULT_LANGUAGE_CODE,
    tempoData,
    bpm,
    phrases,
    pitchData: null,
    encodedMidi: midiEncoder.encode(phrases, bpm, timeSignature),
  }
}
