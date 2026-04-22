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
 * - body: 字符串 HTML 片段；若为对象 { 'God Knows': html, '海阔天空': html, default: html } 则按分支取
 */

const BRAND_GREEN = '#3ddc84'

/** 分支元数据（Step 2 被点击后设置 state.branch 为对应 key） */
export const BRANCH_CONFIG = {
  'God Knows': {
    vocalTrackCandidates: ['轨道10', '轨道 10', 'Track 10', 'vocal', '人声'],
    vocalTrackLabel: '轨道 10',
    languageLabel: '日语',
  },
  '海阔天空': {
    vocalTrackCandidates: ['主旋律1', '主旋律 1', '主旋律', 'vocal', '人声'],
    vocalTrackLabel: '主旋律 1',
    languageLabel: '中文',
  },
}

export const TOTAL_STEPS = 6

const welcomeBody = `
  <p>欢迎来到 WebUtau～</p>
  <p>这是一站式虚拟歌姬工作站，区别于简单的变声处理，您可以使用 WebUtau 来让虚拟歌姬唱出您想要的<b>歌词</b>和<b>旋律</b>。</p>
`

const importDemoBody = `
  <p>您可以导入 MIDI 文件来使 WebUtau 获取自定义乐谱，但请先等等。</p>
  <p>如果您没有使用类似工具的经验，我们<b style="color:${BRAND_GREEN}">强烈建议</b>您点击下方的「God Knows」或「海阔天空」，来通过示例快速体验 WebUtau！</p>
`

const syncImportBody = `
  <p>加载示例后会弹出「导入时序信息」窗口，点击<b>同步应用</b>按钮以套用示例的节拍与速度。</p>
`

const playBody = `
  <p>所有轨道的乐器默认都为钢琴，您可以先不急着调整乐器，先点击最上方的播放键来<b>试听</b>一下效果。</p>
`

const dblclickTrackBody = {
  'God Knows': `
    <p>God Knows 的人声轨道是「轨道 10」，您可以通过<b>双击</b>轨道 10 来编辑它。</p>
  `,
  '海阔天空': `
    <p>海阔天空的人声轨道是「主旋律 1」，您可以通过<b>双击</b>主旋律 1 来编辑它。</p>
  `,
}

const renderVoiceBody = {
  'God Knows': `
    <p>然后点击「将该轨道渲染为人声」按钮，来使轨道 10 由钢琴渲染为人声。「歌曲语言」推荐您选择<b>日语</b>，如果您没有自己的声库，则暂时只能使用 WebUtau 内置的 yousa 声库。</p>
    <p>当渲染结束后，再次播放，轨道 10 就会变为人声啦～</p>
  `,
  '海阔天空': `
    <p>然后点击「将该轨道渲染为人声」按钮，来使主旋律 1 由钢琴渲染为人声。「歌曲语言」推荐您选择<b>中文</b>，如果您没有自己的声库，则暂时只能使用 WebUtau 内置的 yousa 声库。</p>
    <p>当渲染结束后，再次播放，主旋律 1 就会变为人声啦～</p>
  `,
}

const quickLyricOpenBody = `
  <p>您会发现，人声并没有唱出歌词，而是使用「a」来代替每一个<b>音</b>。</p>
  <p>点击「快速填词」按钮，将「a」改为自定义歌词，每个「a」对应一个<b>音/字</b>。</p>
`

const quickLyricPanelBody = `
  <p>修改完毕后点击「解析」按钮，如果字数与句数无误，则解析成功。点击「保存」按钮。然后再次播放，虚拟歌姬就会将您的歌词唱出来啦！</p>
`

const miscBody = `
  <p>如需调整音轨的乐器，您可以点击音轨最左侧的<b>虚线圆</b>，来为该音轨选择任意一种乐器。</p>
  <p>您也可以单击音轨名下方的「M」来<b>静音</b>该音轨，单击「S」来<b>独奏</b>该音轨，单击「FX」来对该音轨进行<b>混响</b>编辑。</p>
  <p>您还可以在右侧分享链接面板中生成公网链接，转发给朋友，直接通过浏览器打开体验您的作品！</p>
`

const finishBody = `
  <p>当一切编辑结束，点击最上方「文件」，即可选择导出 MIDI 文件或是音频。</p>
  <p>更多高级功能，相信您会在实际使用中慢慢解锁。最后祝您创作出属于您自己的，独一无二的音乐！(*´∀\`)~♥</p>
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
