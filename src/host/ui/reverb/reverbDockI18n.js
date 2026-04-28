// 混响 dock 标签：每个 ID/英文名都映射到 i18n key，按当前语言展示。
// 中文里依然以"英文 (中文)"双语显示，习惯保留；其他语言只显示译名。
import { getLocale, t } from '../../../i18n/index.js'

function lookup(key) {
  const v = t(key)
  return v === key ? '' : v
}

function normalizeLabel(value, fallback = '') {
  if (typeof value === 'string' && value.trim()) return value.trim()
  return fallback
}

function toBilingualLabel(english, localized) {
  const e = normalizeLabel(english)
  const l = normalizeLabel(localized)
  if (!e) return l
  if (!l) return e
  if (e === l) return e
  if (getLocale() === 'zh') {
    if (e.includes(`(${l})`)) return e
    return `${e} (${l})`
  }
  // 英语下：英文 ID 已经是英文标签——直接用 localized（与 e 等同时上面已经 return）
  return l
}

export function formatReverbStyleOption(styleId, styleName) {
  const english = normalizeLabel(styleName, normalizeLabel(styleId))
  return toBilingualLabel(english, lookup(`reverb.style.${styleId}`))
}

export function formatReverbPresetOption(presetId, presetName) {
  const english = normalizeLabel(presetName, normalizeLabel(presetId))
  return toBilingualLabel(english, lookup(`reverb.preset.${presetId}`))
}

export function formatReverbKnobLabel(englishLabel) {
  const english = normalizeLabel(englishLabel)
  return toBilingualLabel(english, lookup(`reverb.knob.${english}`))
}

export function formatReverbSelectLabel(englishLabel) {
  const english = normalizeLabel(englishLabel)
  return toBilingualLabel(english, lookup(`reverb.select.${english}`))
}
