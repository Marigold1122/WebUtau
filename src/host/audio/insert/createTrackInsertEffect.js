import { createAmpSim3TrackInsert } from './AmpSim3TrackInsert.js'
import { createNamBassTrackInsert } from './NamBassTrackInsert.js'
import { buildTrackInsertProfile } from './trackInsertCatalog.js'

export function createTrackInsertEffect({ rawContext, insertId, guitarToneConfig = null, logger = null } = {}) {
  const profile = buildTrackInsertProfile(insertId, { guitarToneConfig })
  if (!rawContext || !profile) return null

  if (profile.engine === 'amp-sim3') {
    return createAmpSim3TrackInsert({ rawContext, profile, logger })
  }
  if (profile.engine === 'nam-bass') {
    return createNamBassTrackInsert({ rawContext, profile, logger })
  }
  return null
}
