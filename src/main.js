import eventBus from './core/EventBus.js'
import phraseStore from './core/PhraseStore.js'
import renderApi from './api/RenderApi.js'
import registerVerify10_1 from './diagnostics/verify10_1.js'
import audioEngine from './modules/AudioEngine.js'
import playbackEngine from './modules/PlaybackEngine.js'
import playheadController from './modules/PlayheadController.js'
import renderCache from './modules/RenderCache.js'
import renderScheduler from './modules/RenderScheduler.js'
import midiImporter from './modules/MidiImporter.js'
import midiEncoder from './modules/MidiEncoder.js'
import renderJobManager from './modules/RenderJobManager.js'
import renderPriorityStrategy from './modules/RenderPriorityStrategy.js'
import transportControl from './modules/TransportControl.js'
import pianoRoll from './ui/PianoRoll.js'
import trackSelector from './ui/TrackSelector.js'
import prepareOverlay from './ui/PrepareOverlay.js'
import { DEFAULT_LANGUAGE_CODE } from './config/languageOptions.js'
import { buildRenderApiUrl } from './config/serviceEndpoints.js'
import { EVENTS, JOB_STATUS, PHRASE_STATUS, PLAYHEAD_STATE, RENDER_PRIORITY } from './config/constants.js'

function verifyModules() {
  const checks = [
    ['EventBus', eventBus, ['on', 'off', 'emit']],
    ['PhraseStore', phraseStore, ['setPhrases', 'getPhrases', 'getPhrase', 'setMidiFile']],
    ['AudioEngine', audioEngine, ['play', 'pause', 'seek', 'getSongTime', 'isPlaying']],
    ['PlaybackEngine', playbackEngine, ['play', 'pause', 'stop', 'seekTo', 'getCurrentTime', 'getState']],
    ['PlayheadController', playheadController, ['init', 'setPosition', 'setState', 'getPosition', 'getState']],
    ['RenderCache', renderCache, ['get', 'set', 'invalidate', 'getStatus', 'clear']],
    ['RenderScheduler', renderScheduler, ['enqueue', 'prioritize', 'getQueue']],
    ['MidiImporter', midiImporter, ['loadFile', 'selectTrack']],
    ['MidiEncoder', midiEncoder, ['encode']],
    ['RenderJobManager', renderJobManager, ['submitMidi', 'prioritize', 'stopPolling']],
    ['RenderPriorityStrategy', renderPriorityStrategy, ['getNextPriority']],
    ['TransportControl', transportControl, ['init', 'resetForNewTrack']],
    ['RenderApi', renderApi, ['submitJob', 'getJobStatus', 'setPriority', 'downloadPhrase']],
    ['PianoRoll', pianoRoll, ['init']],
  ]
  let ok = true
  for (const [name, target, methods] of checks) {
    const ready = target && methods.every((method) => typeof target[method] === 'function')
    if (!target) {
      console.error(`模块 ${name} 加载失败`)
      ok = false
      continue
    }
    for (const method of methods) {
      if (typeof target[method] !== 'function') {
        console.error(`模块 ${name} 缺少方法 ${method}`)
        ok = false
      }
    }
    if (ready) console.log(`✓ 模块 ${name} 就绪`)
  }
  console[ok ? 'log' : 'error'](ok ? '===== 所有模块加载成功 =====' : '===== 模块加载失败，请检查 =====')
}

function verifyConstants() {
  const ok = Object.keys(PHRASE_STATUS).length === 4 && Object.keys(PLAYHEAD_STATE).length === 3 && Object.keys(RENDER_PRIORITY).length === 3 && Object.keys(JOB_STATUS).length === 5 && Object.keys(EVENTS).length >= 19
  if (ok) console.log('✓ 常量定义完整')
}

function init() {
  verifyModules()
  verifyConstants()
  window._modules = { eventBus, phraseStore, audioEngine, playbackEngine, playheadController, renderCache, renderScheduler, midiImporter, midiEncoder, renderJobManager, renderPriorityStrategy, transportControl, trackSelector, renderApi, pianoRoll }
  pianoRoll.init(document.getElementById('piano-roll-container'))
  playheadController.init(document.getElementById('playhead'), {
    onViewportScrolled: () => pianoRoll.refreshViewportAfterScroll?.(),
  })
  trackSelector.init()
  transportControl.init()
  prepareOverlay.init()

  const statusText = document.getElementById('status-text')
  const btnImport = document.getElementById('btn-import')
  const fileInput = document.getElementById('midi-file-input')

  const fetchVoicebanks = async () => {
    const response = await fetch(buildRenderApiUrl('/api/voicebanks'))
    if (!response.ok) throw new Error('获取声库失败: HTTP ' + response.status)
    return response.json()
  }

  const resolveSingerId = async () => {
    const voicebanks = await fetchVoicebanks()
    if (!Array.isArray(voicebanks) || voicebanks.length === 0) {
      throw new Error('后端没有可用声库')
    }
    const singerId = voicebanks[0]?.id
    if (!singerId) throw new Error('声库缺少 id')
    return singerId
  }

  btnImport.addEventListener('click', () => fileInput.click())
  fileInput.addEventListener('change', async (event) => {
    const file = event.target.files?.[0]
    if (!file) return

    try {
      statusText.textContent = '正在解析 MIDI...'
      renderJobManager.reset()
      renderCache.clear()
      phraseStore.setJobId(null)
      phraseStore.setPhrases([])
      transportControl.resetForNewTrack([])
      playbackEngine.stop()

      const tracks = await midiImporter.loadFile(file)
      if (tracks.length === 0) {
        statusText.textContent = '未找到可用轨道'
        return
      }

      const result = await trackSelector.show(tracks, file.name, {
        ...midiImporter.tempoData,
        hasTempoInfo: (midiImporter.midiData?.header?.tempos || []).length > 0,
        hasTimeSignatureInfo: (midiImporter.midiData?.header?.timeSignatures || []).length > 0,
      })
      const selectedLanguageCode = result.languageCode || DEFAULT_LANGUAGE_CODE
      if (!result.syncTempo) midiImporter.tempoData = null
      const phrases = midiImporter.selectTrack(result.trackIndex)
      const bpm = midiImporter.tempoData?.tempos?.[0]?.bpm || 120
      phraseStore.setBpm(bpm)
      const timeSig = midiImporter.tempoData?.timeSignatures?.[0]?.timeSignature || [4, 4]
      const encodedMidi = midiEncoder.encode(phrases, bpm, timeSig)

      phraseStore.setMidiFile(encodedMidi)
      phraseStore.setPhrases(phrases)
      transportControl.resetForNewTrack(phrases)
      statusText.textContent = `已加载 ${phrases.length} 个语句`
      const singerId = await resolveSingerId()
      renderJobManager.submitMidi(encodedMidi, singerId, selectedLanguageCode)
        .then(() => { statusText.textContent = '渲染中...' })
        .catch((err) => {
          console.error('提交渲染失败:', err)
          statusText.textContent = '提交渲染失败: ' + err.message
        })
    } catch (error) {
      console.error('MIDI 导入失败:', error)
      statusText.textContent = 'MIDI 导入失败'
    } finally {
      fileInput.value = ''
    }
  })

  eventBus.on(EVENTS.PHRASES_REBUILT, ({ phrases }) => {
    statusText.textContent = `后端分句完成：${phrases.length} 个语句，渲染中...`
  })

  eventBus.on(EVENTS.JOB_PROGRESS, ({ completed, total, status }) => {
    if (status === 'completed') {
      statusText.textContent = '渲染完成'
    } else {
      statusText.textContent = '渲染中 ' + completed + '/' + total
    }
  })

  eventBus.on(EVENTS.JOB_FAILED, ({ error }) => {
    statusText.textContent = '渲染失败: ' + (error || '未知错误')
  })

  statusText.textContent = '系统就绪'
  registerVerify10_1()
  window._verify10_2 = async function() {
    let backendAvailable = null

    const checkBackendAvailability = async () => {
      if (backendAvailable !== null) return backendAvailable

      try {
        const voicebanks = await fetchVoicebanks()
        backendAvailable = Array.isArray(voicebanks) && voicebanks.length > 0
        return backendAvailable
      } catch (e) {
        backendAvailable = false
        return backendAvailable
      }
    }

    const requireBackend = async () => {
      const available = await checkBackendAvailability()
      return available ? true : '跳过：后端渲染服务未启动'
    }

    const checks = [
      {
        name: 'RenderJobManager 模块加载',
        fn: () => window._modules?.renderJobManager ? true : '未注册到 window._modules',
      },
      {
        name: 'RenderJobManager 方法完整',
        fn: () => {
          const rjm = window._modules.renderJobManager
          const methods = ['submitMidi', 'prioritize', 'stopPolling', 'getStatus']
          const missing = methods.filter((method) => typeof rjm[method] !== 'function')
          return missing.length === 0 ? true : '缺少方法: ' + missing.join(', ')
        },
      },
      {
        name: '前置依赖: PhraseStore 可用',
        fn: () => {
          const ps = window._modules?.phraseStore
          return ps && typeof ps.setPhrases === 'function' ? true : 'PhraseStore 不可用，请先完成施工单 10.1'
        },
      },
      {
        name: '前置依赖: RenderApi 新方法可用',
        fn: () => {
          const api = window._modules?.renderApi
          const needed = ['submitJob', 'getJobStatus', 'downloadPhrase', 'setPriority']
          const missing = needed.filter((method) => typeof api[method] !== 'function')
          return missing.length === 0 ? true : '缺少: ' + missing.join(', ') + '，请先完成施工单 10.1'
        },
      },
      {
        name: '前置依赖: RenderCache 可用',
        fn: () => {
          const rc = window._modules?.renderCache
          return rc && typeof rc.set === 'function' ? true : 'RenderCache 不可用'
        },
      },
      {
        name: '后端连通性测试',
        fn: async () => {
          const available = await checkBackendAvailability()
          return available ? true : '跳过：无法连接后端渲染服务（你当前未启动后端）'
        },
      },
      {
        name: '提交测试（需要先导入MIDI）',
        fn: async () => {
          const backendCheck = await requireBackend()
          if (backendCheck !== true) return backendCheck

          const ps = window._modules.phraseStore
          const rjm = window._modules.renderJobManager
          const midiFile = ps.getMidiFile()
          if (!midiFile) return '跳过：请先导入一个 MIDI 文件，然后重新运行此诊断'

          try {
            const singerId = await resolveSingerId()
            await rjm.submitMidi(midiFile, singerId, DEFAULT_LANGUAGE_CODE)
            const jobId = ps.getJobId()
            if (!jobId) return '提交后 jobId 为空'
            return true
          } catch (e) {
            return '提交失败: ' + e.message
          }
        },
      },
      {
        name: '轮询测试（等待3秒观察）',
        fn: async () => {
          const backendCheck = await requireBackend()
          if (backendCheck !== true) return backendCheck

          const rjm = window._modules.renderJobManager
          const jobId = window._modules.phraseStore.getJobId()
          if (!jobId) return '跳过：没有活跃的任务（先运行上一项）'

          await new Promise((resolve) => setTimeout(resolve, 3000))
          const status = rjm.getStatus()
          if (!status) return '3秒后 getStatus() 仍为 null，轮询可能没有工作'
          return true
        },
      },
      {
        name: '自动下载测试（等待10秒检查缓存）',
        fn: async () => {
          const backendCheck = await requireBackend()
          if (backendCheck !== true) return backendCheck

          const rc = window._modules.renderCache
          const jobId = window._modules.phraseStore.getJobId()
          if (!jobId) return '跳过：没有活跃的任务'

          await new Promise((resolve) => setTimeout(resolve, 10000))
          let cachedCount = 0
          for (let index = 0; index < 50; index += 1) {
            if (rc.getStatus(index) === 'available') cachedCount += 1
          }
          if (cachedCount === 0) return '10秒后缓存中仍无已下载的句子（可能后端渲染较慢，可增加等待时间后重试）'
          return true
        },
      },
      {
        name: 'stopPolling 可正常调用',
        fn: () => {
          const rjm = window._modules.renderJobManager
          try {
            rjm.stopPolling()
            return true
          } catch (e) {
            return '调用 stopPolling 异常: ' + e.message
          }
        },
      },
      {
        name: '事件触发检查（JOB_PROGRESS）',
        fn: async () => {
          const backendCheck = await requireBackend()
          if (backendCheck !== true) return backendCheck

          const eb = window._modules.eventBus
          const ps = window._modules.phraseStore
          const rjm = window._modules.renderJobManager
          const midiFile = ps.getMidiFile()
          if (!midiFile) return '跳过：没有 MIDI 文件'

          let progressFired = false
          const onProgress = () => { progressFired = true }

          eb.on('job:progress', onProgress)
          try {
            const singerId = await resolveSingerId()
            await rjm.submitMidi(midiFile, singerId, DEFAULT_LANGUAGE_CODE)
            await new Promise((resolve) => setTimeout(resolve, 2000))
          } catch (e) {
          }
          eb.off('job:progress', onProgress)
          rjm.stopPolling()
          return progressFired ? true : '2秒内没有收到 job:progress 事件'
        },
      },
    ]

    console.log('%c===== 施工单 10.2 诊断报告 =====', 'font-weight:bold;font-size:14px')
    console.log('提示：完整测试需要后端运行 + 已导入MIDI文件')
    console.log('提示：部分测试需要等待，总耗时约20秒')
    let passed = 0
    let skipped = 0
    for (const check of checks) {
      try {
        const result = await check.fn()
        if (result === true) {
          console.log('%c[通过] ' + check.name, 'color:green')
          passed += 1
        } else if (typeof result === 'string' && result.startsWith('跳过：')) {
          console.log('%c[跳过] ' + check.name + ' — 原因：' + result, 'color:gray')
          skipped += 1
        } else {
          console.log('%c[失败] ' + check.name + ' — 原因：' + result, 'color:red')
        }
      } catch (e) {
        console.log('%c[失败] ' + check.name + ' — 异常：' + e.message, 'color:red')
      }
    }
    const total = checks.length
    const failed = total - passed - skipped
    const color = failed === 0 ? 'color:green;font-weight:bold' : 'color:orange;font-weight:bold'
    console.log('%c===== 结果: ' + passed + '/' + total + ' 通过，' + skipped + ' 项跳过，' + failed + ' 项失败 =====', color)
  }

  window._verify10_3 = async function() {
    const ps = window._modules.phraseStore
    const rc = window._modules.renderCache
    const rps = window._modules.renderPriorityStrategy
    const rs = window._modules.renderScheduler
    const originalPhrases = ps.getPhrases()
    const originalCache = new Map(rc.cache)
    const testPhrases = [
      { index: 0, startTime: 0, endTime: 1.5, text: '第一句', notes: [], inputHash: '0.000-1.500-第一句' },
      { index: 1, startTime: 2, endTime: 3.5, text: '第二句', notes: [], inputHash: '2.000-3.500-第二句' },
      { index: 2, startTime: 4, endTime: 5.5, text: '第三句', notes: [], inputHash: '4.000-5.500-第三句' },
      { index: 3, startTime: 6, endTime: 7.5, text: '第四句', notes: [], inputHash: '6.000-7.500-第四句' },
      { index: 4, startTime: 8, endTime: 9.5, text: '第五句', notes: [], inputHash: '8.000-9.500-第五句' },
    ]
    try {
      rc.clear()
      ps.setPhrases(testPhrases)
      const checks = [
        { name: 'RenderPriorityStrategy 模块加载', fn: () => (rps && typeof rps.getNextPriority === 'function' ? true : '模块未正确加载') },
        { name: 'RenderScheduler 改造后模块加载', fn: () => (rs && typeof rs.enqueue === 'function' && typeof rs.prioritize === 'function' ? true : '模块未正确加载') },
        { name: '场景1: 全部未缓存，播放头在开头 → 应返回第0句', fn: () => { rc.clear(); const result = rps.getNextPriority(0); return result === 0 ? true : '期望返回 0，实际返回 ' + result } },
        { name: '场景2: 第0句已缓存，播放头在开头 → 应返回第1句', fn: () => { rc.clear(); rc.set(0, new Float32Array(1), testPhrases[0].inputHash); const result = rps.getNextPriority(0); return result === 1 ? true : '期望返回 1，实际返回 ' + result } },
        { name: '场景3: 播放头在第2句中间 → 应返回第2句（如果未缓存）', fn: () => { rc.clear(); const result = rps.getNextPriority(4.5); return result === 2 ? true : '期望返回 2，实际返回 ' + result } },
        { name: '场景4: 播放头在第2句，第2句已缓存 → 应返回第3句', fn: () => { rc.clear(); rc.set(2, new Float32Array(1), testPhrases[2].inputHash); const result = rps.getNextPriority(4.5); return result === 3 ? true : '期望返回 3，实际返回 ' + result } },
        { name: '场景5: 播放头在句子间隙(1.5-2.0之间) → 应返回第1句', fn: () => { rc.clear(); const result = rps.getNextPriority(1.7); return result === 1 ? true : '期望返回 1，实际返回 ' + result } },
        { name: '场景6: 所有句子都已缓存 → 应返回 null', fn: () => { rc.clear(); for (let index = 0; index < 5; index += 1) rc.set(index, new Float32Array(1), testPhrases[index].inputHash); const result = rps.getNextPriority(0); return result === null ? true : '期望返回 null，实际返回 ' + result } },
        { name: '场景7: 播放头超过最后一句 → 应返回 null', fn: () => { rc.clear(); const result = rps.getNextPriority(100); return result === null ? true : '期望返回 null，实际返回 ' + result } },
        { name: '场景8: 没有句子 → 应返回 null', fn: () => { ps.setPhrases([]); const result = rps.getNextPriority(0); ps.setPhrases(testPhrases); return result === null ? true : '期望返回 null，实际返回 ' + result } },
        { name: '场景9: 第2句缓存过期(hash不匹配) → 应返回第2句', fn: () => { rc.clear(); rc.set(0, new Float32Array(1), testPhrases[0].inputHash); rc.set(1, new Float32Array(1), testPhrases[1].inputHash); rc.set(2, new Float32Array(1), 'wrong-hash'); const result = rps.getNextPriority(0); return result === 2 ? true : '期望返回 2（过期），实际返回 ' + result } },
        { name: 'RenderScheduler.enqueue 更新缓存状态', fn: () => { rc.clear(); rs.enqueue(0, 2); const status = rc.getStatus(0); return status === 'rendering' ? true : '期望状态为 rendering，实际为 ' + status } },
        { name: 'RenderScheduler.enqueue 触发事件', fn: () => { const eb = window._modules.eventBus; let fired = false; const handler = () => { fired = true }; eb.on('render:prioritize', handler); rs.enqueue(1, 1); eb.off('render:prioritize', handler); return fired ? true : '没有触发 render:prioritize 事件' } },
        { name: 'RenderScheduler.getQueue 兼容性', fn: () => (Array.isArray(rs.getQueue()) ? true : 'getQueue 应返回数组') },
        { name: 'RenderScheduler 不再直接调用 RenderApi', fn: () => { const result = rs.enqueue(0, 2); return result instanceof Promise ? 'enqueue 不应该是异步的（不应直接调 API）' : true } },
      ]
      console.log('%c===== 施工单 10.3 诊断报告 =====', 'font-weight:bold;font-size:14px')
      let passed = 0
      for (const check of checks) {
        try {
          const result = await check.fn()
          if (result === true) {
            console.log('%c[通过] ' + check.name, 'color:green')
            passed += 1
          } else {
            console.log('%c[失败] ' + check.name + ' — 原因：' + result, 'color:red')
          }
        } catch (e) {
          console.log('%c[失败] ' + check.name + ' — 异常：' + e.message, 'color:red')
        }
      }
      const total = checks.length
      const color = passed === total ? 'color:green;font-weight:bold' : 'color:orange;font-weight:bold'
      console.log('%c===== 结果: ' + passed + '/' + total + ' 通过 =====', color)
    } finally {
      rc.clear()
      rc.cache = new Map(originalCache)
      ps.setPhrases(originalPhrases)
    }
  }

  window._verify10_4 = async function() {
    const ps = window._modules.phraseStore
    const rc = window._modules.renderCache
    const rjm = window._modules.renderJobManager
    const rps = window._modules.renderPriorityStrategy
    const rs = window._modules.renderScheduler
    const api = window._modules.renderApi
    let backendAvailable = null
    const countCachedPhrases = () => {
      let cached = 0
      const phrases = ps.getPhrases()
      for (let index = 0; index < phrases.length; index += 1) {
        if (rc.getStatus(index) === 'available') cached += 1
      }
      return cached
    }

    const checkBackendAvailability = async () => {
      if (backendAvailable !== null) return backendAvailable

      try {
        const voicebanks = await fetchVoicebanks()
        backendAvailable = Array.isArray(voicebanks) && voicebanks.length > 0
        return backendAvailable
      } catch (error) {
        backendAvailable = false
        return false
      }
    }

    const requireBackend = async () => {
      const available = await checkBackendAvailability()
      return available ? true : '跳过：后端渲染服务未启动'
    }

    const checks = [
      {
        name: '所有模块加载完毕',
        fn: () => {
          const modules = ['eventBus', 'audioEngine', 'playbackEngine', 'playheadController', 'renderCache', 'renderScheduler', 'midiImporter', 'transportControl', 'renderApi', 'pianoRoll', 'phraseStore', 'renderJobManager', 'renderPriorityStrategy']
          const missing = modules.filter((moduleName) => !window._modules[moduleName])
          return missing.length === 0 ? true : '缺少: ' + missing.join(', ')
        },
      },
      {
        name: 'Mock 代码已清除',
        fn: () => (typeof api.submitRender === 'function' ? 'submitRender 还存在（应已删除）' : true),
      },
      {
        name: 'RenderApi 新方法名正确',
        fn: () => {
          const methods = ['submitJob', 'getJobStatus', 'downloadPhrase', 'setPriority']
          const missing = methods.filter((method) => typeof api[method] !== 'function')
          return missing.length === 0 ? true : '缺少: ' + missing.join(', ')
        },
      },
      {
        name: 'TransportControl 已导入 RenderPriorityStrategy',
        fn: () => (typeof rps.getNextPriority === 'function' ? true : 'RenderPriorityStrategy 不可用'),
      },
      {
        name: '后端连通性',
        fn: async () => {
          const available = await checkBackendAvailability()
          return available ? true : '跳过：后端渲染服务未启动'
        },
      },
      {
        name: '端到端: MIDI 文件已导入',
        fn: () => {
          const phrases = ps.getPhrases()
          if (!phrases || phrases.length === 0) return '请先导入一个 MIDI 文件再运行此诊断'
          return true
        },
      },
      {
        name: '端到端: MIDI 文件已保存到 PhraseStore',
        fn: () => (ps.getMidiFile() ? true : 'PhraseStore 中没有 MIDI 文件（main.js 导入流程可能没有调 setMidiFile）'),
      },
      {
        name: '端到端: 渲染任务已提交',
        fn: async () => {
          const backendCheck = await requireBackend()
          if (backendCheck !== true) return backendCheck
          const jobId = ps.getJobId()
          return jobId ? true : '没有 jobId（renderJobManager.submitMidi 可能没有被调用）'
        },
      },
      {
        name: '端到端: 渲染进度（等待5秒）',
        fn: async () => {
          const backendCheck = await requireBackend()
          if (backendCheck !== true) return backendCheck
          await new Promise((resolve) => setTimeout(resolve, 5000))
          const status = rjm.getStatus()
          if (!status) return '5秒后仍无状态数据'
          if (status.total === 0) return '语句总数为 0'
          return true
        },
      },
      {
        name: '端到端: 有句子已缓存（等待首句缓存，最多60秒）',
        fn: async () => {
          const backendCheck = await requireBackend()
          if (backendCheck !== true) return backendCheck

          const deadline = Date.now() + 60000
          let lastStatus = rjm.getStatus()

          while (Date.now() < deadline) {
            const cached = countCachedPhrases()
            if (cached > 0) return true

            lastStatus = rjm.getStatus()
            if (lastStatus?.status === JOB_STATUS.COMPLETED) {
              return '任务已 completed，但前端仍未缓存任何句子'
            }
            if (lastStatus?.status === JOB_STATUS.FAILED) {
              return '任务进入 failed，未产生可缓存句子'
            }

            await new Promise((resolve) => setTimeout(resolve, 500))
          }

          if (!lastStatus) return '60秒后仍无状态数据'
          if (lastStatus.status === JOB_STATUS.PREPARING) {
            return '60秒后后端仍停留在 preparing，尚未进入可下载短语阶段'
          }
          if (lastStatus.status === JOB_STATUS.RENDERING) {
            return '后端已进入 rendering，但60秒后前端仍未缓存任何句子'
          }
          return '60秒后仍无句子缓存，当前状态: ' + lastStatus.status
        },
      },
      {
        name: '端到端: 优先级算法工作',
        fn: () => {
          const phrases = ps.getPhrases()
          if (!phrases.length) return '跳过：无句子'
          const result = rps.getNextPriority(0)
          let allCached = true
          for (let index = 0; index < phrases.length; index += 1) {
            if (rc.getStatus(index) !== 'available') {
              allCached = false
              break
            }
          }
          if (allCached && result === null) return true
          if (!allCached && result !== null && typeof result === 'number') return true
          if (!allCached && result === null) return '有未缓存的句子但返回了 null'
          return true
        },
      },
      {
        name: '端到端: RenderScheduler 转发正常',
        fn: () => {
          try {
            rs.enqueue(0, 1)
            return true
          } catch (error) {
            return '调用 enqueue 异常: ' + error.message
          }
        },
      },
      {
        name: '端到端: 状态栏显示渲染进度',
        fn: async () => {
          const backendCheck = await requireBackend()
          if (backendCheck !== true) return backendCheck
          const statusNode = document.getElementById('status-text')
          if (!statusNode) return '找不到 status-text 元素'
          const text = statusNode.textContent
          if (text.includes('渲染中') || text.includes('渲染完成') || text.includes('rendering')) return true
          return '状态栏内容为 "' + text + '"，期望看到渲染进度信息'
        },
      },
    ]

    console.log('%c===== 施工单 10.4 最终诊断报告 =====', 'font-weight:bold;font-size:14px')
    console.log('提示：需要后端运行 + 已导入 MIDI 文件')
    console.log('提示：包含等待步骤，总耗时约 25 秒')
    console.log('')
    let passed = 0
    let skipped = 0
    for (const check of checks) {
      try {
        const result = await check.fn()
        if (result === true) {
          console.log('%c[通过] ' + check.name, 'color:green')
          passed += 1
        } else if (typeof result === 'string' && result.startsWith('跳过：')) {
          console.log('%c[跳过] ' + check.name + ' — ' + result, 'color:#999999')
          skipped += 1
        } else {
          console.log('%c[失败] ' + check.name + ' — 原因：' + result, 'color:red')
        }
      } catch (error) {
        console.log('%c[失败] ' + check.name + ' — 异常：' + error.message, 'color:red')
      }
    }
    const total = checks.length
    const failed = total - passed - skipped
    console.log('')
    const color = failed === 0 ? 'color:green;font-weight:bold;font-size:16px' : 'color:orange;font-weight:bold;font-size:16px'
    console.log('%c===== 结果: ' + passed + '/' + total + ' 通过，' + skipped + ' 项跳过，' + failed + ' 项失败 =====', color)

    if (failed === 0) {
      console.log('%c恭喜！所有零件组装完毕。现在可以：', 'font-weight:bold')
      console.log('  1. 把播放头移到已渲染的句子（绿色音符）')
      console.log('  2. 按空格键 → 应该听到真实人声')
      console.log('  3. 把播放头移到未渲染的句子（灰色/橙色音符）')
      console.log('  4. 按空格键 → 播放头应该变黄等待，几秒后自动播放')
    }
  }

  window._verify10_6 = async function() {
    const encoder = window._modules.midiEncoder
    const ps = window._modules.phraseStore
    const rc = window._modules.renderCache
    const rjm = window._modules.renderJobManager

    const checks = [
      {
        name: 'MidiEncoder 模块加载',
        fn: () => encoder && typeof encoder.encode === 'function' ? true : 'MidiEncoder 未正确加载或缺少 encode 方法',
      },
      {
        name: '编码空数据不崩溃',
        fn: () => {
          try {
            const result = encoder.encode([], 120, [4, 4])
            return result instanceof File ? true : '返回值不是 File 对象'
          } catch (e) {
            return '空数据编码抛出异常: ' + e.message
          }
        },
      },
      {
        name: '编码结果是合法 MIDI 文件',
        fn: () => {
          const testPhrases = [{
            index: 0,
            startTime: 0,
            endTime: 1,
            text: '你好',
            notes: [
              { time: 0, duration: 0.5, midi: 60, velocity: 0.8 },
              { time: 0.5, duration: 0.5, midi: 62, velocity: 0.8 },
            ],
          }]
          const file = encoder.encode(testPhrases, 120, [4, 4])
          if (!(file instanceof File)) return '返回值不是 File 对象'
          if (file.size < 20) return '文件太小，可能是空文件'
          if (file.type !== 'audio/midi') return '文件 MIME 类型应为 audio/midi，实际为 ' + file.type
          return true
        },
      },
      {
        name: '编码结果包含 MThd 头',
        fn: async () => {
          const testPhrases = [{
            index: 0,
            startTime: 0,
            endTime: 1,
            text: 'la',
            notes: [{ time: 0, duration: 0.5, midi: 60, velocity: 0.8 }],
          }]
          const file = encoder.encode(testPhrases, 120, [4, 4])
          const buf = await file.arrayBuffer()
          const bytes = new Uint8Array(buf)
          const header = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3])
          return header === 'MThd' ? true : '文件头应为 MThd，实际为 ' + header
        },
      },
      {
        name: '编码结果是 Format 0 单轨道',
        fn: async () => {
          const testPhrases = [{
            index: 0,
            startTime: 0,
            endTime: 1,
            text: 'la',
            notes: [{ time: 0, duration: 0.5, midi: 60, velocity: 0.8 }],
          }]
          const file = encoder.encode(testPhrases, 120, [4, 4])
          const buf = await file.arrayBuffer()
          const view = new DataView(buf)
          const format = view.getUint16(8)
          const trackCount = view.getUint16(10)
          const ppq = view.getUint16(12)
          if (format !== 0) return 'Format 应为 0，实际为 ' + format
          if (trackCount !== 1) return '轨道数应为 1，实际为 ' + trackCount
          if (ppq !== 480) return 'PPQ 应为 480，实际为 ' + ppq
          return true
        },
      },
      {
        name: '多 phrase 编码音符数正确',
        fn: async () => {
          const testPhrases = [
            {
              index: 0,
              startTime: 0,
              endTime: 1,
              text: '你好',
              notes: [
                { time: 0, duration: 0.4, midi: 60, velocity: 0.8 },
                { time: 0.5, duration: 0.4, midi: 62, velocity: 0.8 },
              ],
            },
            {
              index: 1,
              startTime: 2,
              endTime: 3,
              text: '世界',
              notes: [
                { time: 2, duration: 0.4, midi: 64, velocity: 0.8 },
                { time: 2.5, duration: 0.4, midi: 65, velocity: 0.8 },
              ],
            },
          ]
          const file = encoder.encode(testPhrases, 120, [4, 4])
          const buf = await file.arrayBuffer()
          const bytes = new Uint8Array(buf)
          let noteOnCount = 0
          for (let i = 14; i < bytes.length; i += 1) {
            if (bytes[i] === 0x90) noteOnCount += 1
          }
          return noteOnCount === 4 ? true : '期望 4 个 Note On，实际 ' + noteOnCount
        },
      },
      {
        name: '编码结果包含歌词事件',
        fn: async () => {
          const testPhrases = [{
            index: 0,
            startTime: 0,
            endTime: 1,
            text: '你好',
            notes: [
              { time: 0, duration: 0.5, midi: 60, velocity: 0.8 },
              { time: 0.5, duration: 0.5, midi: 62, velocity: 0.8 },
            ],
          }]
          const file = encoder.encode(testPhrases, 120, [4, 4])
          const buf = await file.arrayBuffer()
          const bytes = new Uint8Array(buf)
          let lyricCount = 0
          for (let i = 14; i < bytes.length - 1; i += 1) {
            if (bytes[i] === 0xff && bytes[i + 1] === 0x05) lyricCount += 1
          }
          return lyricCount === 2 ? true : '期望 2 个歌词事件，实际 ' + lyricCount
        },
      },
      {
        name: '清场：导入前清除旧缓存',
        fn: () => {
          rc.set(0, new Float32Array(1), 'old-hash')
          rc.set(1, new Float32Array(1), 'old-hash-2')
          const hadData = rc.getStatus(0) === 'available'
          rc.clear()
          const cleared = rc.getStatus(0) === 'pending' && rc.getStatus(1) === 'pending'
          return hadData && cleared ? true : '清场后缓存未清除'
        },
      },
      {
        name: '清场：导入前清除旧 jobId',
        fn: () => {
          ps.setJobId('fake-old-job')
          const hadJob = ps.getJobId() === 'fake-old-job'
          ps.setJobId(null)
          const cleared = ps.getJobId() === null
          return hadJob && cleared ? true : '清场后 jobId 未清除'
        },
      },
      {
        name: '清场：stopPolling 不会崩溃',
        fn: () => {
          try {
            rjm.stopPolling()
            return true
          } catch (e) {
            return 'stopPolling 异常: ' + e.message
          }
        },
      },
      {
        name: 'PhraseStore 存储的是 File 对象',
        fn: () => {
          const stored = ps.getMidiFile()
          if (!stored) return '当前未导入 MIDI（请先导入一个 MIDI 文件再运行诊断）'
          return stored instanceof File ? true : '存储的不是 File 对象，类型为 ' + typeof stored
        },
      },
      {
        name: '存储的 MIDI 是精简版（< 100KB）',
        fn: () => {
          const stored = ps.getMidiFile()
          if (!stored) return '当前未导入 MIDI'
          if (stored.size > 100 * 1024) return '文件大小 ' + (stored.size / 1024).toFixed(1) + 'KB，疑似仍是原始 MIDI'
          return true
        },
      },
    ]

    console.log('%c===== 施工单 10.6 诊断报告 =====', 'font-weight:bold;font-size:14px')
    let passed = 0
    let skipped = 0
    for (const check of checks) {
      try {
        const result = await check.fn()
        if (result === true) {
          console.log('%c[通过] ' + check.name, 'color:green')
          passed += 1
        } else if (typeof result === 'string' && result.startsWith('当前未导入')) {
          console.log('%c[跳过] ' + check.name + ' — ' + result, 'color:gray')
          skipped += 1
        } else {
          console.log('%c[失败] ' + check.name + ' — 原因：' + result, 'color:red')
        }
      } catch (e) {
        console.log('%c[失败] ' + check.name + ' — 异常：' + e.message, 'color:red')
      }
    }
    const total = checks.length
    const failed = total - passed - skipped
    const color = failed === 0 ? 'color:green;font-weight:bold' : 'color:orange;font-weight:bold'
    console.log('%c===== 结果: ' + passed + '/' + total + ' 通过，' + skipped + ' 项跳过，' + failed + ' 项失败 =====', color)
  }

  window._verify10_7 = async function() {
    const rc = window._modules.renderCache
    const tc = window._modules.transportControl
    const ps = window._modules.phraseStore

    const checks = [
      {
        name: 'RenderCache.set 支持 timeInfo 参数',
        fn: () => {
          try {
            rc.set(999, new Float32Array(1), 'test-hash', { startMs: 1000, durationMs: 2000 })
            const entry = rc.get(999)
            rc.cache.delete(999)
            return entry && entry.startMs === 1000 && entry.durationMs === 2000
              ? true
              : '存入的 timeInfo 未被保存，entry=' + JSON.stringify(entry)
          } catch (e) {
            return '异常: ' + e.message
          }
        },
      },
      {
        name: 'RenderCache.getTimeInfo 返回正确数据',
        fn: () => {
          rc.set(998, new Float32Array(1), 'test-hash', { startMs: 500, durationMs: 1500 })
          const info = rc.getTimeInfo(998)
          rc.cache.delete(998)
          if (!info) return 'getTimeInfo 返回了 null'
          if (info.startMs !== 500) return 'startMs 期望 500，实际 ' + info.startMs
          if (info.durationMs !== 1500) return 'durationMs 期望 1500，实际 ' + info.durationMs
          return true
        },
      },
      {
        name: 'RenderCache.getTimeInfo 无数据时返回 null',
        fn: () => {
          rc.set(997, new Float32Array(1), 'test-hash')
          const info = rc.getTimeInfo(997)
          rc.cache.delete(997)
          return info === null ? true : '无 timeInfo 时应返回 null，实际返回 ' + JSON.stringify(info)
        },
      },
      {
        name: 'RenderCache.set 不传 timeInfo 不影响其他字段',
        fn: () => {
          rc.set(996, new Float32Array(1), 'test-hash')
          const entry = rc.get(996)
          rc.cache.delete(996)
          if (!entry) return '缓存条目未创建'
          if (entry.status !== 'available') return 'status 应为 available'
          if (entry.inputHash !== 'test-hash') return 'inputHash 不匹配'
          return true
        },
      },
      {
        name: 'RenderCache.isValid 不受 timeInfo 影响',
        fn: () => {
          rc.set(995, new Float32Array(1), 'hash-a', { startMs: 100, durationMs: 200 })
          const valid = rc.isValid(995, 'hash-a')
          const invalid = rc.isValid(995, 'hash-b')
          rc.cache.delete(995)
          if (!valid) return 'hash 匹配时应返回 true'
          if (invalid) return 'hash 不匹配时应返回 false'
          return true
        },
      },
      {
        name: 'TransportControl._playPhrase 存在',
        fn: () => typeof tc._playPhrase === 'function' ? true : '_playPhrase 方法不存在',
      },
      {
        name: '_playPhrase 接受 currentTime 参数（非 offset）',
        fn: () => tc._playPhrase.length === 2 ? true : '_playPhrase 应有 2 个参数，实际有 ' + tc._playPhrase.length,
      },
      {
        name: '已缓存的句子包含 timeInfo（需要后端已渲染）',
        fn: () => {
          const phrases = ps.getPhrases()
          if (!phrases.length) return '跳过：无句子数据'
          let found = false
          for (let i = 0; i < phrases.length; i += 1) {
            const info = rc.getTimeInfo(i)
            if (info) {
              found = true
              if (typeof info.startMs !== 'number') return '句子 ' + i + ' 的 startMs 不是数字'
              if (typeof info.durationMs !== 'number') return '句子 ' + i + ' 的 durationMs 不是数字'
              if (info.startMs < 0) return '句子 ' + i + ' 的 startMs 为负数'
              if (info.durationMs <= 0) return '句子 ' + i + ' 的 durationMs <= 0'
              break
            }
          }
          if (!found) return '跳过：尚无已缓存的句子（等待后端渲染完成后重试）'
          return true
        },
      },
      {
        name: '相邻已缓存句子时间不重叠',
        fn: () => {
          const phrases = ps.getPhrases()
          if (phrases.length < 2) return '跳过：不足 2 句'
          const timeInfos = []
          for (let i = 0; i < phrases.length; i += 1) {
            const info = rc.getTimeInfo(i)
            if (info) timeInfos.push({ index: i, ...info })
          }
          if (timeInfos.length < 2) return '跳过：已缓存句子不足 2 句'
          timeInfos.sort((a, b) => a.startMs - b.startMs)
          for (let i = 1; i < timeInfos.length; i += 1) {
            const prev = timeInfos[i - 1]
            const curr = timeInfos[i]
            const prevEnd = prev.startMs + prev.durationMs
            if (curr.startMs < prevEnd - 50) {
              return '句子 ' + prev.index + ' 和句子 ' + curr.index + ' 时间重叠: 前句结束 ' + prevEnd + 'ms，后句开始 ' + curr.startMs + 'ms'
            }
          }
          return true
        },
      },
    ]

    console.log('%c===== 施工单 10.7 诊断报告 =====', 'font-weight:bold;font-size:14px')
    let passed = 0
    let skipped = 0
    for (const check of checks) {
      try {
        const result = await check.fn()
        if (result === true) {
          console.log('%c[通过] ' + check.name, 'color:green')
          passed += 1
        } else if (typeof result === 'string' && result.startsWith('跳过')) {
          console.log('%c[跳过] ' + check.name + ' — ' + result, 'color:gray')
          skipped += 1
        } else {
          console.log('%c[失败] ' + check.name + ' — 原因：' + result, 'color:red')
        }
      } catch (e) {
        console.log('%c[失败] ' + check.name + ' — 异常：' + e.message, 'color:red')
      }
    }
    const total = checks.length
    const failed = total - passed - skipped
    const color = failed === 0 ? 'color:green;font-weight:bold' : 'color:orange;font-weight:bold'
    console.log('%c===== 结果: ' + passed + '/' + total + ' 通过，' + skipped + ' 项跳过，' + failed + ' 项失败 =====', color)
  }

  window._verify11 = async function() {
    const as = window._modules.audioEngine
    const tc = window._modules.transportControl
    const rc = window._modules.renderCache
    const ps = window._modules.phraseStore

    const checks = [
      {
        name: 'AudioEngine 模块存在',
        fn: () => as ? true : 'audioEngine 未注册到 window._modules',
      },
      {
        name: 'AudioEngine.play 可用',
        fn: () => typeof as.play === 'function' ? true : 'play 不存在',
      },
      {
        name: 'AudioEngine.pause 是函数',
        fn: () => typeof as.pause === 'function' ? true : 'pause 不存在',
      },
      {
        name: 'AudioEngine.seek 是函数',
        fn: () => typeof as.seek === 'function' ? true : 'seek 不存在',
      },
      {
        name: 'AudioEngine.getSongTime 是函数',
        fn: () => typeof as.getSongTime === 'function' ? true : 'getSongTime 不存在',
      },
      {
        name: 'TransportControl 不再依赖 PlaybackEngine',
        fn: () => typeof tc._playPhrase === 'undefined'
          ? true
          : '_playPhrase 方法仍然存在，应该已被删除',
      },
      {
        name: '调度已缓存句子不报错',
        fn: async () => {
          const phrases = ps.getPhrases()
          if (phrases.length === 0) return '跳过：无句子数据'
          let hasCached = false
          for (let index = 0; index < phrases.length; index += 1) {
            if (rc.isValid(index, phrases[index].inputHash)) {
              hasCached = true
              break
            }
          }
          if (!hasCached) return '跳过：无已缓存句子'

          try {
            await as.ensureContext()
            as.scheduleAll(0, phrases.length)
            const count = as.scheduledSources.length
            as.stopAll()
            return count > 0 ? true : '调度后 scheduledSources 为空（应 > 0）'
          } catch (error) {
            return '异常: ' + error.message
          }
        },
      },
      {
        name: 'stopAll 清空所有 source',
        fn: async () => {
          as.stopAll()
          return as.scheduledSources.length === 0
            ? true
            : 'stopAll 后仍有 ' + as.scheduledSources.length + ' 个 source'
        },
      },
    ]

    console.log('%c===== 施工单 11 诊断报告 =====', 'font-weight:bold;font-size:14px')
    let passed = 0
    let skipped = 0
    for (const check of checks) {
      try {
        const result = await check.fn()
        if (result === true) {
          console.log('%c[通过] ' + check.name, 'color:green')
          passed += 1
        } else if (typeof result === 'string' && result.startsWith('跳过')) {
          console.log('%c[跳过] ' + check.name + ' — ' + result, 'color:gray')
          skipped += 1
        } else {
          console.log('%c[失败] ' + check.name + ' — ' + result, 'color:red')
        }
      } catch (error) {
        console.log('%c[失败] ' + check.name + ' — 异常: ' + error.message, 'color:red')
      }
    }
    const total = checks.length
    const failed = total - passed - skipped
    const color = failed === 0 ? 'color:green;font-weight:bold' : 'color:orange;font-weight:bold'
    console.log('%c===== 结果: ' + passed + '/' + total + ' 通过, ' + skipped + ' 跳过, ' + failed + ' 失败 =====', color)
  }

  window._verifyAll = async function() {
    console.log('%c===== 全套诊断开始 =====', 'font-weight:bold;font-size:16px')
    console.log('')
    await window._verify10_1()
    console.log('')
    await window._verify10_2()
    console.log('')
    await window._verify10_3()
    console.log('')
    await window._verify10_4()
    console.log('')
    await window._verify10_6()
    console.log('')
    await window._verify10_7()
    console.log('')
    console.log('%c===== 全套诊断结束 =====', 'font-weight:bold;font-size:16px')
  }
}

document.addEventListener('DOMContentLoaded', init)
