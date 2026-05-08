import { createAmpSim3TrackInsert } from './AmpSim3TrackInsert.js'
import { createNamBassTrackInsert } from './NamBassTrackInsert.js'
import { createVstTrackInsert } from './vst/VstTrackInsert.js'
import { buildTrackInsertProfile } from './trackInsertCatalog.js'
import { normalizeVstInsertState } from './vst/vstInsertState.js'

// 工厂入口。两种调用形态：
//   1. 内置 insert：传 insertId，从 trackInsertCatalog 构出 profile
//   2. VST insert：传 vstInsert 状态（normalize 后），engine 强制为 'vst'
// ProjectAudioGraph 会同时持有"内置 insert"与"VST insert"两个独立 effect，串成 chain
export function createTrackInsertEffect({
  rawContext,
  insertId = null,
  guitarToneConfig = null,
  vstInsert = null,
  logger = null,
} = {}) {
  if (!rawContext) return null

  if (vstInsert) {
    const normalized = normalizeVstInsertState(vstInsert)
    if (!normalized) return null
    return createVstTrackInsert({
      rawContext,
      profile: { engine: 'vst', vstInsert: normalized },
      logger,
    })
  }

  if (insertId) {
    const profile = buildTrackInsertProfile(insertId, { guitarToneConfig })
    if (!profile) return null
    if (profile.engine === 'amp-sim3') {
      return createAmpSim3TrackInsert({ rawContext, profile, logger })
    }
    if (profile.engine === 'nam-bass') {
      return createNamBassTrackInsert({ rawContext, profile, logger })
    }
  }

  return null
}
