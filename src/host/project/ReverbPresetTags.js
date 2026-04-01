export const DEFAULT_REVERB_PRESET_TAG = 'all'

const REVERB_PRESET_TAG_ORDER = Object.freeze([
  DEFAULT_REVERB_PRESET_TAG,
  'vocal',
  'hall',
  'room',
  'plate',
  'church',
  'bathroom',
  'spring',
  'drum',
  'dark',
  'color',
])

const REVERB_PRESET_TAG_LABELS = Object.freeze({
  all: 'All Styles',
  vocal: 'Vocal',
  hall: 'Hall',
  room: 'Room',
  plate: 'Plate',
  church: 'Church',
  bathroom: 'Bathroom',
  spring: 'Spring',
  drum: 'Drum',
  dark: 'Dark',
  color: 'Color',
})

export function normalizeReverbPresetTag(tag, fallback = DEFAULT_REVERB_PRESET_TAG) {
  const resolvedTag = typeof tag === 'string' ? tag.trim().toLowerCase() : ''
  if (REVERB_PRESET_TAG_ORDER.includes(resolvedTag)) return resolvedTag
  return REVERB_PRESET_TAG_ORDER.includes(fallback) ? fallback : DEFAULT_REVERB_PRESET_TAG
}

export function hasReverbPresetTag(preset = null, tag = DEFAULT_REVERB_PRESET_TAG) {
  const normalizedTag = normalizeReverbPresetTag(tag)
  if (normalizedTag === DEFAULT_REVERB_PRESET_TAG) return true
  const presetTags = Array.isArray(preset?.tags) ? preset.tags : []
  return presetTags.includes(normalizedTag)
}

export function listReverbPresetTagOptions(presets = []) {
  const availableTags = new Set([DEFAULT_REVERB_PRESET_TAG])
  ;(Array.isArray(presets) ? presets : []).forEach((preset) => {
    const tags = Array.isArray(preset?.tags) ? preset.tags : []
    tags.forEach((tag) => {
      const normalizedTag = normalizeReverbPresetTag(tag, '')
      if (normalizedTag) availableTags.add(normalizedTag)
    })
  })
  return REVERB_PRESET_TAG_ORDER
    .filter((tag) => availableTags.has(tag))
    .map((tag) => ({
      id: tag,
      name: REVERB_PRESET_TAG_LABELS[tag] || tag,
    }))
}
