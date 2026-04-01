const STYLE_LABEL_CN_BY_ID = Object.freeze({
  all: '全部风格',
  vocal: '人声',
  hall: '大厅',
  room: '房间',
  plate: '板式',
  church: '教堂',
  bathroom: '浴室',
  spring: '弹簧',
  drum: '鼓组',
  dark: '暗色',
  color: '染色',
})

const PRESET_LABEL_CN_BY_ID = Object.freeze({
  'zita-vocal-default': '人声默认',
  'zita-room-tight': '紧凑房间',
  'zita-plate-bright': '明亮板式',
  'zita-hall-airy': '通透大厅',
  'zita-church-wide': '宽阔教堂',
  'zita-bathroom-short': '短浴室',
  'zita-vocal-dark': '暗色人声',
  'zita-drum-room-punch': '冲击鼓房',
  'zita-spring-color': '染色弹簧',
})

const KNOB_LABEL_CN_BY_EN = Object.freeze({
  Send: '发送',
  Decay: '衰减',
  Curve: '曲线',
  'Pre-Delay': '预延迟',
  'Low-Cut': '低切',
  Damp: '阻尼',
  Return: '返回',
  'Dry/Wet Return': '干湿返回',
})

const SELECT_LABEL_CN_BY_EN = Object.freeze({
  Style: '风格',
  Preset: '预设',
})

function normalizeLabel(value, fallback = '') {
  if (typeof value === 'string' && value.trim()) return value.trim()
  return fallback
}

function toBilingualLabel(english, chinese) {
  const normalizedEnglish = normalizeLabel(english)
  const normalizedChinese = normalizeLabel(chinese)
  if (!normalizedEnglish) return normalizedChinese
  if (!normalizedChinese) return normalizedEnglish
  if (normalizedEnglish.includes(`(${normalizedChinese})`)) return normalizedEnglish
  return `${normalizedEnglish} (${normalizedChinese})`
}

export function formatReverbStyleOption(styleId, styleName) {
  const english = normalizeLabel(styleName, normalizeLabel(styleId))
  return toBilingualLabel(english, STYLE_LABEL_CN_BY_ID[styleId] || '')
}

export function formatReverbPresetOption(presetId, presetName) {
  const english = normalizeLabel(presetName, normalizeLabel(presetId))
  return toBilingualLabel(english, PRESET_LABEL_CN_BY_ID[presetId] || '')
}

export function formatReverbKnobLabel(englishLabel) {
  const english = normalizeLabel(englishLabel)
  return toBilingualLabel(english, KNOB_LABEL_CN_BY_EN[english] || '')
}

export function formatReverbSelectLabel(englishLabel) {
  const english = normalizeLabel(englishLabel)
  return toBilingualLabel(english, SELECT_LABEL_CN_BY_EN[english] || '')
}
