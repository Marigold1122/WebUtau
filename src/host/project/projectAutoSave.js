// 后台自动保存：每隔一段时间把当前 store 的 project 序列化后写进 IndexedDB，
// 这样即使用户没主动保存、浏览器异常关闭也能恢复"上一刻"的状态。
//
// 跟 .webutau 文件保存的关系：
//   - 文件保存：用户主动行为，落到磁盘真实文件，可分享、可备份
//   - 自动保存：后台静默行为，写到浏览器内置 IndexedDB（用户不感知），仅作"防丢"保险栓
// 启动时检查 IndexedDB 里有没有比"上次正常退出"更新的快照——有就提示用户是否恢复

import { serializeProject } from './projectFile.js'

const DB_NAME = 'webutau'
const DB_VERSION = 1
const STORE_NAME = 'project-autosave'
const SNAPSHOT_KEY = 'latest'
const DEFAULT_INTERVAL_MS = 30000
const DEFAULT_DEBOUNCE_MS = 1000

let dbPromise = null

function openDatabase() {
  if (dbPromise) return dbPromise
  if (typeof indexedDB === 'undefined') {
    dbPromise = Promise.resolve(null)
    return dbPromise
  }
  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION)
    request.onupgradeneeded = (event) => {
      const db = event.target.result
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME)
      }
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error || new Error('IndexedDB 打开失败'))
    request.onblocked = () => reject(new Error('IndexedDB 被其他标签页占用'))
  })
  return dbPromise
}

async function withStore(mode, op) {
  const db = await openDatabase()
  if (!db) return null
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, mode)
    const store = tx.objectStore(STORE_NAME)
    const result = op(store)
    tx.oncomplete = () => resolve(result?.result ?? result)
    tx.onerror = () => reject(tx.error || new Error('IndexedDB 事务失败'))
    tx.onabort = () => reject(tx.error || new Error('IndexedDB 事务被中止'))
  })
}

async function putSnapshot(record) {
  return withStore('readwrite', (store) => store.put(record, SNAPSHOT_KEY))
}

async function getSnapshot() {
  return withStore('readonly', (store) => {
    const request = store.get(SNAPSHOT_KEY)
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result || null)
      request.onerror = () => reject(request.error)
    })
  })
}

async function deleteSnapshot() {
  return withStore('readwrite', (store) => store.delete(SNAPSHOT_KEY))
}

// IndexedDB 写入前做一次 fingerprint：避免没改动时反复刷盘 + 让 UI 能判断"是否真的有新内容"
function fingerprint(jsonString) {
  let h = 0
  for (let i = 0; i < jsonString.length; i++) {
    h = (h * 31 + jsonString.charCodeAt(i)) | 0
  }
  return h
}

export class ProjectAutoSave {
  constructor({
    store,
    getProjectName = () => null,
    getAudioAssets = () => [],
    isDirty = null,
    intervalMs = DEFAULT_INTERVAL_MS,
    debounceMs = DEFAULT_DEBOUNCE_MS,
    logger = null,
  } = {}) {
    this.store = store
    this.getProjectName = getProjectName
    this.getAudioAssets = getAudioAssets
    this.isDirty = isDirty
    this.intervalMs = intervalMs
    this.debounceMs = debounceMs
    this.logger = logger
    this.timer = null
    this.debounceTimer = null
    this.lastFingerprint = null
    this._hasPendingSnapshot = false
    this._handleVisibilityChange = () => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
        // 切 tab / 关 tab 之前抢一笔——浏览器在这之后可能立刻 kill 异步任务
        void this.saveNow()
      }
    }
  }

  hasPendingSnapshot() {
    return this._hasPendingSnapshot
  }

  start() {
    if (this.timer) return
    // 兜底定时器：30s 周期，防止用户长时间不动也有定期备份
    this.timer = setInterval(() => this.saveNow(), this.intervalMs)
    // 主动事件：tab 离开可见态时立刻保存——抓住"关 tab / 关浏览器" 的边沿
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', this._handleVisibilityChange)
    }
    if (typeof console !== 'undefined') {
      console.info('[webutau-autosave] started', { intervalMs: this.intervalMs, debounceMs: this.debounceMs })
    }
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer)
      this.debounceTimer = null
    }
    if (typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', this._handleVisibilityChange)
    }
  }

  // 给 onAfterRender 调用：每次有新 render 都重置 debounce 计时器，
  // 1 秒钟没有新动作就触发一次 saveNow——即使用户 5 秒内就关 tab 也能存到快照
  scheduleSave() {
    if (this.debounceTimer) clearTimeout(this.debounceTimer)
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null
      void this.saveNow()
    }, this.debounceMs)
  }

  // 不抛错——自动保存是"最佳努力"，失败时只记日志、不打扰用户。
  // 不依赖 isDirty——dirty 跟踪是给红点 / beforeunload 用的，autosave 必须独立运行
  // 才能保证"哪怕 dirty 检测漏掉某次改动也能恢复"。fingerprint 去重已经够防止无意义刷盘。
  async saveNow() {
    try {
      const project = this.store?.getProject?.()
      if (!project || !Array.isArray(project.tracks) || project.tracks.length === 0) {
        if (typeof console !== 'undefined') console.info('[webutau-autosave] skip: no tracks')
        return
      }
      const jsonString = serializeProject({
        project,
        projectName: this.getProjectName?.() ?? null,
        audioAssets: this.getAudioAssets?.() ?? [],
      })
      const fp = fingerprint(jsonString)
      if (fp === this.lastFingerprint) {
        if (typeof console !== 'undefined') console.info('[webutau-autosave] skip: dedup', { fp })
        return
      }
      await putSnapshot({
        json: jsonString,
        savedAt: Date.now(),
        projectName: this.getProjectName?.() ?? null,
      })
      this.lastFingerprint = fp
      this._hasPendingSnapshot = true
      if (typeof console !== 'undefined') {
        console.info('[webutau-autosave] wrote snapshot', { bytes: jsonString.length, tracks: project.tracks.length })
      }
      this.logger?.debug?.('Project autosaved to IndexedDB', { length: jsonString.length })
    } catch (error) {
      // 用 console.warn 让用户在 DevTools 里能直接看到失败原因——这个失败不能静默
      if (typeof console !== 'undefined') {
        console.warn('[webutau-autosave] failed', error?.message || error, error?.stack)
      }
      this.logger?.warn?.('Project autosave failed', { error: error?.message || String(error) })
    }
  }

  async loadLastSnapshot() {
    try {
      return await getSnapshot()
    } catch (error) {
      this.logger?.warn?.('Project autosave load failed', { error: error?.message || String(error) })
      return null
    }
  }

  async clearSnapshot() {
    try {
      await deleteSnapshot()
      this.lastFingerprint = null
      this._hasPendingSnapshot = false
    } catch (error) {
      this.logger?.warn?.('Project autosave clear failed', { error: error?.message || String(error) })
    }
  }
}
