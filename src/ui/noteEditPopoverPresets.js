// NoteEditPopover 用的预设 / 字段描述，抽出来避免主文件超过 300 行。

import { PITCH_BOUNDARY_MODES } from '../modules/PitchEditor.js'

export const PORTAMENTO_PRESETS = Object.freeze([
  { id: 'standard', label: 'Standard', start: -40, length: 80 },
  { id: 'fast', label: 'Fast', start: -25, length: 50 },
  { id: 'slow', label: 'Slow', start: -60, length: 120 },
  { id: 'snap', label: 'Snap', start: -1, length: 2 },
])

export const VIBRATO_PRESETS = Object.freeze([
  { id: 'standard', label: 'Standard', values: { length: 75, period: 175, depth: 25, in: 10, out: 10, shift: 0, drift: 0, volLink: 0 } },
  { id: 'utau-default', label: 'UTAU Default', values: { length: 65, period: 180, depth: 35, in: 20, out: 20, shift: 0, drift: 0, volLink: 0 } },
  { id: 'utau-strong', label: 'UTAU Strong', values: { length: 65, period: 210, depth: 55, in: 25, out: 25, shift: 0, drift: 0, volLink: 0 } },
  { id: 'utau-weak', label: 'UTAU Weak', values: { length: 65, period: 165, depth: 20, in: 25, out: 25, shift: 0, drift: 0, volLink: 0 } },
])

export const BOUNDARY_META = Object.freeze([
  { mode: PITCH_BOUNDARY_MODES.SNAP, label: '吸附' },
  { mode: PITCH_BOUNDARY_MODES.GLIDE, label: '滑入' },
  { mode: PITCH_BOUNDARY_MODES.HOLD, label: '保持' },
])

export const PORTAMENTO_FIELDS = Object.freeze([
  { field: 'start', label: '起点', min: -200, max: 200 },
  { field: 'length', label: '时长', min: 2, max: 320 },
])

export const TUNING_FIELD = Object.freeze({ label: '音准', min: -100, max: 100 })

export const VIBRATO_BASIC_FIELDS = Object.freeze([
  { field: 'length', label: '时长', min: 0, max: 100 },
  { field: 'period', label: '周期', min: 5, max: 500 },
  { field: 'depth', label: '深度', min: 5, max: 200 },
])

export const VIBRATO_ADVANCED_FIELDS = Object.freeze([
  { field: 'in', label: '淡入', min: 0, max: 100 },
  { field: 'out', label: '淡出', min: 0, max: 100 },
  { field: 'shift', label: '相位', min: 0, max: 100 },
  { field: 'drift', label: '漂移', min: -100, max: 100 },
  { field: 'volLink', label: '音量联动', min: -100, max: 100 },
])

export function resolveSharedPresetId(presets, values = {}, fields = []) {
  if (fields.some((field) => values?.[field] == null)) return ''
  const preset = presets.find((candidate) => fields.every((field) => {
    const source = candidate?.values?.[field] ?? candidate?.[field]
    return Number(source) === Number(values?.[field])
  }))
  return preset?.id || ''
}
