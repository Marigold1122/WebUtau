import { createProjectMixState } from './projectMixState.js'
import { isAudioTrack } from './trackContentType.js'
import { createTrackPlaybackState, mergeTrackPlaybackState } from './trackPlaybackState.js'

const DEFAULT_STORAGE_KEY = 'melody-host-project-audio-mix-v1'
const MAX_SNAPSHOT_COUNT = 12

function normalizeFileName(value) {
  return typeof value === 'string' ? value.trim() : ''
}

function buildTrackFingerprint(track = {}, index = 0) {
  if (isAudioTrack(track)) {
    return {
      index,
      id: track?.id || null,
      midiTrackIndex: Number.isFinite(track?.midiTrackIndex) ? Math.round(track.midiTrackIndex) : null,
      contentType: 'audio',
      assetName: track?.audioClip?.fileName || null,
      durationTicks: Number.isFinite(track?.durationTicks) ? Math.round(track.durationTicks) : 0,
    }
  }

  return {
    index,
    id: track?.id || null,
    midiTrackIndex: Number.isFinite(track?.midiTrackIndex) ? Math.round(track.midiTrackIndex) : null,
    contentType: track?.contentType || 'instrument',
    noteCount: Number.isFinite(track?.noteCount) ? Math.round(track.noteCount) : 0,
    durationTicks: Number.isFinite(track?.durationTicks) ? Math.round(track.durationTicks) : 0,
  }
}

function buildProjectFingerprint(project = {}) {
  const tracks = Array.isArray(project?.tracks)
    ? project.tracks.map((track, index) => buildTrackFingerprint(track, index))
    : []
  return JSON.stringify({
    fileName: normalizeFileName(project?.fileName),
    ppq: Number.isFinite(project?.ppq) && project.ppq > 0 ? Math.round(project.ppq) : 480,
    tracks,
  })
}

function readStorageBucket(storage, storageKey) {
  if (!storage?.getItem) return {}
  try {
    const raw = storage.getItem(storageKey)
    if (!raw) return {}
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch (_error) {
    return {}
  }
}

function writeStorageBucket(storage, storageKey, bucket) {
  if (!storage?.setItem) return false
  storage.setItem(storageKey, JSON.stringify(bucket))
  return true
}

function pruneSnapshots(bucket = {}) {
  const entries = Object.entries(bucket)
    .sort((left, right) => {
      const leftTime = Date.parse(left[1]?.savedAt || '') || 0
      const rightTime = Date.parse(right[1]?.savedAt || '') || 0
      return rightTime - leftTime
    })
    .slice(0, MAX_SNAPSHOT_COUNT)
  return Object.fromEntries(entries)
}

export class ProjectAudioMixPersistence {
  constructor({ storage = globalThis.localStorage, storageKey = DEFAULT_STORAGE_KEY, logger = null } = {}) {
    this.storage = storage
    this.storageKey = storageKey
    this.logger = logger
  }

  isAvailable() {
    return Boolean(this.storage?.getItem && this.storage?.setItem)
  }

  buildSnapshot(project = null) {
    if (!project || !Array.isArray(project?.tracks)) return null
    const mixState = createProjectMixState(project.mixState)
    const defaultConfig = mixState?.reverb || null
    const playbackDefaults = {
      reverbPresetId: mixState.reverbPresetId,
      reverbConfig: defaultConfig,
      reverb: {
        presetId: mixState.reverbPresetId,
        send: 0,
        enabled: Number(defaultConfig?.returnGain || 0) > 0.0001,
        config: defaultConfig,
      },
    }
    return {
      fingerprint: buildProjectFingerprint(project),
      savedAt: new Date().toISOString(),
      mixState,
      tracks: project.tracks.map((track) => {
        const playbackState = createTrackPlaybackState(track?.playbackState, playbackDefaults)
        return {
          id: track?.id || null,
          reverb: playbackState.reverb,
          reverbSend: playbackState.reverbSend,
          reverbPresetId: playbackState.reverbPresetId,
          reverbConfig: playbackState.reverbConfig,
          guitarTone: playbackState.guitarTone,
        }
      }),
    }
  }

  loadSnapshot(project = null) {
    if (!this.isAvailable() || !project) return null
    const fingerprint = buildProjectFingerprint(project)
    return readStorageBucket(this.storage, this.storageKey)[fingerprint] || null
  }

  saveProject(project = null) {
    const snapshot = this.buildSnapshot(project)
    if (!snapshot || !this.isAvailable()) return null

    try {
      const bucket = readStorageBucket(this.storage, this.storageKey)
      bucket[snapshot.fingerprint] = snapshot
      writeStorageBucket(this.storage, this.storageKey, pruneSnapshots(bucket))
      this.logger?.info?.('Project audio mix snapshot persisted', {
        fileName: project?.fileName || null,
        trackCount: project?.tracks?.length || 0,
        reverbPresetId: snapshot.mixState?.reverbPresetId || null,
      })
      return snapshot
    } catch (error) {
      this.logger?.warn?.('Project audio mix snapshot persist failed', {
        error: error?.message || String(error),
      })
      return null
    }
  }

  restoreProject(project = null) {
    const snapshot = this.loadSnapshot(project)
    if (!snapshot) return project
    const mixState = createProjectMixState(snapshot.mixState || project?.mixState)
    const defaultConfig = mixState?.reverb || null
    const playbackDefaults = {
      reverbPresetId: mixState.reverbPresetId,
      reverbConfig: defaultConfig,
      reverb: {
        presetId: mixState.reverbPresetId,
        send: 0,
        enabled: Number(defaultConfig?.returnGain || 0) > 0.0001,
        config: defaultConfig,
      },
    }
    const playbackByTrackId = new Map(
      (Array.isArray(snapshot?.tracks) ? snapshot.tracks : []).map((track) => [track?.id || null, {
        reverb: track?.reverb,
        reverbSend: track?.reverbSend,
        reverbPresetId: track?.reverbPresetId,
        reverbConfig: track?.reverbConfig,
        guitarTone: track?.guitarTone,
      }]),
    )

    return {
      ...project,
      mixState,
      tracks: (Array.isArray(project?.tracks) ? project.tracks : []).map((track) => {
        const savedPlaybackState = playbackByTrackId.get(track?.id || null)
        if (!savedPlaybackState) return track
        return {
          ...track,
          playbackState: mergeTrackPlaybackState(track?.playbackState, {
            reverb: savedPlaybackState.reverb,
            reverbSend: savedPlaybackState.reverbSend,
            reverbPresetId: savedPlaybackState.reverbPresetId,
            reverbConfig: savedPlaybackState.reverbConfig,
            guitarTone: savedPlaybackState.guitarTone,
          }, playbackDefaults),
        }
      }),
    }
  }

  clearProject(project = null) {
    if (!this.isAvailable() || !project) return false
    try {
      const fingerprint = buildProjectFingerprint(project)
      const bucket = readStorageBucket(this.storage, this.storageKey)
      if (!Object.prototype.hasOwnProperty.call(bucket, fingerprint)) return false
      delete bucket[fingerprint]
      writeStorageBucket(this.storage, this.storageKey, bucket)
      return true
    } catch (_error) {
      return false
    }
  }
}
