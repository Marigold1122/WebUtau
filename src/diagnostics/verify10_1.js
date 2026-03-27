import { EVENTS, JOB_STATUS } from '../config/constants.js'

function findMissingKeys(source, keys) {
  return keys.filter((key) => !source[key])
}

function findMissingMethods(source, methods) {
  return methods.filter((method) => typeof source?.[method] !== 'function')
}

export default function registerVerify10_1() {
  window._verify10_1 = async function() {
    const phraseStore = window._modules.phraseStore
    const originalPhrases = phraseStore.getPhrases()
    const originalMidiFile = phraseStore.getMidiFile()
    const originalJobId = phraseStore.getJobId()
    const checks = [
      {
        name: '新增事件常量完整',
        fn: () => {
          const missing = findMissingKeys(EVENTS, ['PHRASES_UPDATED', 'PHRASE_MODIFIED', 'JOB_SUBMITTED', 'JOB_PROGRESS', 'JOB_FAILED'])
          return missing.length === 0 ? true : '缺少: ' + missing.join(', ')
        },
      },
      {
        name: 'JOB_STATUS 常量完整',
        fn: () => {
          const missing = findMissingKeys(JOB_STATUS, ['QUEUED', 'PREPARING', 'RENDERING', 'COMPLETED', 'FAILED'])
          return missing.length === 0 ? true : '缺少: ' + missing.join(', ')
        },
      },
      { name: 'PhraseStore 模块加载', fn: () => (window._modules?.phraseStore ? true : 'phraseStore 未注册到 window._modules') },
      {
        name: 'PhraseStore.setPhrases + getPhrases',
        fn: () => {
          const ps = window._modules.phraseStore
          ps.setPhrases([{ index: 0, startTime: 0, endTime: 1.5, text: '你好', notes: [], inputHash: '' }, { index: 1, startTime: 2, endTime: 3.5, text: '世界', notes: [], inputHash: '' }])
          const result = ps.getPhrases()
          if (!result || result.length !== 2) return '设置后获取数据长度不对，期望 2 got ' + result?.length
          if (result[0].text !== '你好') return '第0句 text 不对'
          return result[1].text === '世界' ? true : '第1句 text 不对'
        },
      },
      {
        name: 'PhraseStore.getPhrase(index)',
        fn: () => {
          const ps = window._modules.phraseStore
          const p0 = ps.getPhrase(0)
          const p1 = ps.getPhrase(1)
          const pNull = ps.getPhrase(99)
          if (!p0 || p0.text !== '你好') return '获取第0句失败'
          if (!p1 || p1.text !== '世界') return '获取第1句失败'
          return pNull === null || pNull === undefined ? true : '获取不存在的句子应返回 null'
        },
      },
      {
        name: 'PhraseStore.setMidiFile + getMidiFile',
        fn: () => {
          const ps = window._modules.phraseStore
          ps.setMidiFile(new File(['test'], 'test.mid'))
          return ps.getMidiFile()?.name === 'test.mid' ? true : '文件存取失败'
        },
      },
      {
        name: 'PhraseStore.setJobId + getJobId',
        fn: () => {
          const ps = window._modules.phraseStore
          ps.setJobId('test-job-123')
          if (ps.getJobId() !== 'test-job-123') return 'jobId 存取失败'
          ps.setJobId(null)
          return true
        },
      },
      {
        name: 'PhraseStore.updatePhrase 重算 hash',
        fn: () => {
          const ps = window._modules.phraseStore
          ps.setPhrases([{ index: 0, startTime: 1, endTime: 2, text: '原歌词', notes: [], inputHash: '' }])
          const oldHash = ps.getPhrase(0).inputHash
          ps.updatePhrase(0, { text: '新歌词' })
          const newHash = ps.getPhrase(0).inputHash
          if (ps.getPhrase(0).text !== '新歌词') return 'text 没有更新'
          if (oldHash === newHash) return 'hash 没有重算（修改歌词后 hash 应变化）'
          return newHash === '1.000-2.000-新歌词' ? true : 'hash 格式不对，期望 "1.000-2.000-新歌词"'
        },
      },
      {
        name: 'PhraseStore 事件触发',
        fn: () => {
          const ps = window._modules.phraseStore
          const eb = window._modules.eventBus
          let updatedFired = false
          let modifiedFired = false
          const onUpdated = () => { updatedFired = true }
          const onModified = () => { modifiedFired = true }
          eb.on('phrases:updated', onUpdated)
          eb.on('phrase:modified', onModified)
          ps.setPhrases([{ index: 0, startTime: 0, endTime: 1, text: 'test', notes: [], inputHash: '' }])
          ps.updatePhrase(0, { text: 'changed' })
          eb.off('phrases:updated', onUpdated)
          eb.off('phrase:modified', onModified)
          if (!updatedFired) return 'setPhrases 后没有触发 phrases:updated 事件'
          return modifiedFired ? true : 'updatePhrase 后没有触发 phrase:modified 事件'
        },
      },
      {
        name: 'RenderApi 核心方法存在',
        fn: () => {
          const missing = findMissingMethods(window._modules.renderApi, ['submitJob', 'getJobStatus', 'downloadPhrase', 'setPriority'])
          return missing.length === 0 ? true : '缺少方法: ' + missing.join(', ')
        },
      },
      {
        name: 'RenderApi 已切换到真实接口命名',
        fn: () => (typeof window._modules.renderApi.submitRender === 'function' ? 'submitRender 仍存在（应在施工单 10.4 删除）' : true),
      },
      {
        name: 'RenderApi.submitJob 连接测试（需要后端运行）',
        fn: async () => {
          try {
            const resp = await fetch('http://localhost:5000/api/voicebanks')
            return resp.ok ? true : '后端返回 ' + resp.status + '（但至少连通了）'
          } catch (error) {
            return '跳过：无法连接后端 http://localhost:5000'
          }
        },
      },
      { name: 'Mock 兼容接口已移除', fn: () => (typeof window._modules.renderApi.submitRender === 'function' ? 'submitRender 仍存在' : true) },
    ]
    try {
      console.log('%c===== 施工单 10.1 诊断报告 =====', 'font-weight:bold;font-size:14px')
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
      const failed = checks.length - passed - skipped
      const color = failed === 0 ? 'color:green;font-weight:bold' : 'color:orange;font-weight:bold'
      console.log('%c===== 结果: ' + passed + '/' + checks.length + ' 通过，' + skipped + ' 项跳过，' + failed + ' 项失败 =====', color)
    } finally {
      phraseStore.setPhrases(originalPhrases)
      phraseStore.setMidiFile(originalMidiFile)
      phraseStore.setJobId(originalJobId)
    }
  }
}
