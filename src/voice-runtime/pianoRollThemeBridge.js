// 钢琴卷帘 canvas 颜色的主题切换：核心问题是 9 个文件 88 处直接 `PIANO_ROLL.XXX_COLOR`
// 读取这些常量。如果只在切主题时一次性"重写常量值 + 触发重绘"，会有各种时序竞态：
//   - 模块导入次序导致初始 draw 用的是浅色
//   - 后续 resize / scroll / 其他事件触发的 draw 也得保证拿到正确值
//
// 用 Object.defineProperty 把 PIANO_ROLL 的每个颜色字段换成 getter——每次 canvas 代码
// 读 PIANO_ROLL.WHITE_KEY_COLOR，getter 立即根据当前 document.documentElement.dataset.theme
// 返回对应色值。canvas 代码不用动一行，时序也不会再错。
//
// 切主题时只需 1) 改 documentElement.dataset.theme，2) 调一次 redraw 就行
import { PIANO_ROLL } from '../config/constants.js'
import grid from '../ui/PianoRollGrid.js'
import notes from '../ui/PianoRollNotes.js'

const DARK_COLORS = {
  WHITE_KEY_COLOR: '#2A2C30',
  BLACK_KEY_COLOR: '#1F2024',
  GRID_LINE_COLOR: 'rgba(232, 228, 220, 0.06)',
  BAR_LINE_COLOR: '#5A5D63',
  KEY_LABEL_COLOR: '#A09A8E',
  KEY_BORDER_COLOR: '#383A3F',
  NOTE_COLOR_PENDING: '#7A766F',
  NOTE_COLOR_RENDERING: '#D49B3F',
  NOTE_COLOR_AVAILABLE: '#4FB1AE',
  NOTE_COLOR_EXPIRED: '#5F4F4A',
  PITCH_LINE_COLOR: 'rgba(221, 92, 78, 0.85)',
  PITCH_BASE_LINE_COLOR: 'rgba(160, 154, 142, 0.35)',
  PITCH_POINT_COLOR: '#C0BBB0',
  PITCH_POINT_ACTIVE_COLOR: '#DD5C4E',
  TIME_RULER_BG: '#1F2024',
  TIME_RULER_TEXT_COLOR: '#A09A8E',
  TIME_RULER_TICK_COLOR: '#5A5D63',
}

// 每个颜色字段的"原始浅色值"快照，先存好——getter 在 light 模式下返回这一份
const LIGHT_COLORS = {}
for (const key of Object.keys(DARK_COLORS)) {
  LIGHT_COLORS[key] = PIANO_ROLL[key]
}

// PHONEME_TIMING 是嵌套对象，单独处理：把它每个字段也换成 getter
const DARK_PHONEME_TIMING = {
  BG: '#1A1B1E',
  PANEL_BG: '#232529',
  BORDER: '#4E5158',
  GRID_LIGHT: '#2A2C30',
  GRID_DARK: '#383A3F',
  FILL: 'rgba(79, 177, 174, 0.42)',
  STROKE: '#4FB1AE',
  ATTACK: '#DD5C4E',
  TEXT: '#E8E4DC',
  MUTED: '#A09A8E',
}
const LIGHT_PHONEME_TIMING = { ...PIANO_ROLL.PHONEME_TIMING }

function isDark() {
  try { return document.documentElement.dataset.theme === 'dark' }
  catch (_e) { return false }
}

// 把每个 PIANO_ROLL 颜色字段换成 getter——每次访问都返回当前主题对应色值
function installColorGetters() {
  for (const key of Object.keys(DARK_COLORS)) {
    Object.defineProperty(PIANO_ROLL, key, {
      configurable: true,
      enumerable: true,
      get() { return isDark() ? DARK_COLORS[key] : LIGHT_COLORS[key] },
    })
  }
  // PHONEME_TIMING 整体也用 getter 切换：返回的对象本身在 dark/light 模式下不同
  const phonemeTimingGetter = () => isDark() ? DARK_PHONEME_TIMING : LIGHT_PHONEME_TIMING
  Object.defineProperty(PIANO_ROLL, 'PHONEME_TIMING', {
    configurable: true,
    enumerable: true,
    get: phonemeTimingGetter,
  })
}

// 模块加载时立即装上 getter——之后任何代码读 PIANO_ROLL.XXX_COLOR 都走 getter
installColorGetters()

// 切换主题后调用：刷一次 grid + notes，让 canvas 用新色重绘。
// 不传参——getter 直接读 documentElement，所以参数对结果没影响
export function applyPianoRollTheme(_theme) {
  // 只用刷 canvas，颜色自动跟当前 data-theme
  try { grid.draw?.() } catch (_e) {}
  try { notes.requestDraw?.() } catch (_e) {}
  // phonemeTiming 也得刷——但它没暴露 draw() 方法，靠下次 notes 触发
}
