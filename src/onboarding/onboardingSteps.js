/**
 * 新手引导分步数据。
 *
 * 每个 screen 是一个气泡屏，对外通过 stepNum 聚合成 6 大步用于进度点显示。
 * - anchor: 气泡定位策略
 *     { type: 'above', selector }  在 selector 上方
 *     { type: 'below-top', selector }  在 selector 下方（贴近其下沿）
 *     { type: 'near-bottom' }  视口下半中部（无锚点）
 *     { type: 'center' }  视口正中
 * - highlight: 聚光灯策略
 *     null                     无高亮
 *     'self'                   仅气泡自带发光边
 *     { selector }             为匹配元素做聚光灯
 *     { byTrackName: [...] }   按轨道名匹配 .track-shell-row（分支相关时在字符串里用 {vocalTrack}）
 * - advanceOn: 自动推进触发
 *     null / 缺省              只能手动
 *     { type: 'dom-click', selector, captureBranchAttr? }
 *     { type: 'dom-dblclick-track' }
 *     { type: 'eventbus', event }
 * - body: 字符串 HTML 片段；若为函数 { (branch) => string } 则按分支动态生成
 *
 * i18n：所有文案现在都从 ../i18n 拉取，运行时动态生成。
 */

import { t } from '../i18n/index.js'

const BRAND_GREEN = '#3ddc84'

// 分支元数据 —— vocalTrackLabel / languageLabel 现在按 locale 计算
export const BRANCH_CONFIG = {
  'God Knows': {
    vocalTrackCandidates: ['轨道10', '轨道 10', 'Track 10', 'vocal', '人声'],
    get vocalTrackLabel() { return 'Track 10' },
    get languageLabel() { return t('language.ja') },
  },
  '海阔天空': {
    vocalTrackCandidates: ['主弦律1', '主弦律 1', '主弦律', 'vocal', '人声'],
    get vocalTrackLabel() { return 'Lead 1' },
    get languageLabel() { return t('language.zh') },
  },
}

export const TOTAL_STEPS = 6

const tp = (key, vars) => `<p>${t(key, vars)}</p>`

const welcomeBody = () => `
  ${tp('onboarding.welcome.p1')}
  ${tp('onboarding.welcome.p2')}
`

const importDemoBody = () => `
  ${tp('onboarding.importDemo.p1')}
  ${tp('onboarding.importDemo.p2', { accent: BRAND_GREEN })}
`

const syncImportBody = () => tp('onboarding.syncImport')
const playBody = () => tp('onboarding.play')

const dblclickTrackBody = (branch) => {
  if (branch === '海阔天空') return tp('onboarding.dblclickTrack_alt')
  return tp('onboarding.dblclickTrack')
}

const renderVoiceBody = (branch) => {
  if (branch === '海阔天空') return tp('onboarding.renderVoice_alt')
  return tp('onboarding.renderVoice')
}

const chooseLanguageBody = (branch) => {
  if (branch === '海阔天空') {
    return `${tp('onboarding.chooseLanguage.p1_alt')}${tp('onboarding.chooseLanguage.p2_alt')}`
  }
  return `${tp('onboarding.chooseLanguage.p1')}${tp('onboarding.chooseLanguage.p2')}`
}

const waitPredictionBody = () => `
  ${tp('onboarding.waitPrediction.p1')}
  ${tp('onboarding.waitPrediction.p2')}
`

const quickLyricOpenBody = () => `
  ${tp('onboarding.quickLyricOpen.p1')}
  ${tp('onboarding.quickLyricOpen.p2')}
`

const quickLyricPanelBody = () => tp('onboarding.quickLyricPanel')

const miscBody = () => `
  ${tp('onboarding.misc.p1')}
  ${tp('onboarding.misc.p2')}
  ${tp('onboarding.misc.p3')}
`

const finishBody = () => `
  ${tp('onboarding.finish.p1')}
  ${tp('onboarding.finish.p2')}
`

export const ONBOARDING_SCREENS = [
  {
    id: 'welcome',
    stepNum: 1,
    anchor: { type: 'above', selector: '[data-tour="empty-hint-primary"]' },
    highlight: 'self',
    body: welcomeBody,
  },
  {
    id: 'import-demo',
    stepNum: 2,
    anchor: { type: 'above', selector: '[data-tour="empty-hint-primary"]' },
    highlight: { selector: '[data-tour="demo-row"]' },
    body: importDemoBody,
    advanceOn: {
      type: 'dom-click',
      selector: '[data-tour="demo-btn"]',
      captureBranchAttr: 'tourDemo',
    },
  },
  {
    id: 'try-sync-import',
    stepNum: 3,
    anchor: { type: 'near-bottom' },
    highlight: { selector: '#project-timing-import-modal .modal-dialog' },
    body: syncImportBody,
    advanceOn: { type: 'dom-click', selector: '#btn-project-timing-sync' },
  },
  {
    id: 'try-play',
    stepNum: 3,
    anchor: { type: 'near-bottom' },
    highlight: { selector: '#btn-top-play' },
    body: playBody,
    advanceOn: { type: 'eventbus', event: 'transport:play' },
  },
  {
    id: 'try-dblclick-track',
    stepNum: 3,
    anchor: { type: 'near-bottom' },
    highlight: { byTrackName: true },
    body: dblclickTrackBody,
    advanceOn: { type: 'dom-dblclick-track' },
  },
  {
    id: 'try-render-voice',
    stepNum: 3,
    anchor: { type: 'near-top' },
    highlight: { selector: '[data-tour="render-as-voice"]' },
    body: renderVoiceBody,
    advanceOn: { type: 'dom-click', selector: '[data-tour="render-as-voice"]' },
  },
  {
    id: 'try-choose-language',
    stepNum: 3,
    anchor: { type: 'near-top' },
    highlight: { selector: '#track-language-modal .modal-dialog' },
    body: chooseLanguageBody,
    advanceOn: { type: 'dom-click', selector: '#btn-track-language-confirm' },
  },
  {
    id: 'wait-prediction',
    stepNum: 3,
    anchor: { type: 'center' },
    highlight: null,
    body: waitPredictionBody,
    advanceOn: { type: 'eventbus', event: 'prediction:ready' },
  },
  {
    id: 'lyric-open',
    stepNum: 4,
    anchor: { type: 'near-top' },
    highlight: { selector: '[data-tour="quick-lyric-open"]' },
    body: quickLyricOpenBody,
    advanceOn: { type: 'dom-click', selector: '[data-tour="quick-lyric-open"]' },
  },
  {
    id: 'lyric-panel',
    stepNum: 4,
    anchor: { type: 'near-top' },
    highlight: { selector: '[data-tour="quick-lyric-panel"]' },
    body: quickLyricPanelBody,
    advanceOn: { type: 'dom-click', selector: '[data-tour="quick-lyric-save"]' },
  },
  {
    id: 'misc',
    stepNum: 5,
    anchor: { type: 'center' },
    highlight: null,
    body: miscBody,
  },
  {
    id: 'finish',
    stepNum: 6,
    anchor: { type: 'center' },
    highlight: null,
    body: finishBody,
    isLast: true,
  },
]
