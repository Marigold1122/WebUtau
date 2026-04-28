// 把"工程文件 = .webutau JSON 文本"写到磁盘 / 从磁盘读回来。
// 两层策略：
//   1) 现代浏览器（Chromium 系）：File System Access API
//      - showSaveFilePicker / showOpenFilePicker 直接返回文件句柄，可以重复覆盖同一文件
//      - 用户体验最接近桌面应用（Pr / Logic / VSCode）
//   2) 老/严苛浏览器（Firefox / Safari）：Blob 下载 + <input type="file"> 上传
//      - 每次"保存"会触发一次浏览器下载、文件落到下载文件夹
//      - 不能覆盖原文件，但保证全平台可用

import { WEBUTAU_PROJECT_EXTENSION, WEBUTAU_PROJECT_MIME_TYPE } from './projectFile.js'
import { t } from '../../i18n/index.js'

function getFsaPickerType() {
  return {
    description: 'WebUtau project',
    accept: { [WEBUTAU_PROJECT_MIME_TYPE]: [WEBUTAU_PROJECT_EXTENSION] },
  }
}

export function supportsFileSystemAccessApi() {
  if (typeof window === 'undefined') return false
  return typeof window.showSaveFilePicker === 'function'
    && typeof window.showOpenFilePicker === 'function'
}

// 用户取消文件对话框时，FSA 抛 AbortError——把它转成统一的 sentinel，
// 调用方据此判断"是用户主动取消、不是真的出错"
export class UserCancelledError extends Error {
  constructor() {
    super(t('hostStatus.user_cancelled'))
    this.name = 'UserCancelledError'
  }
}

function wrapAbort(error) {
  if (error?.name === 'AbortError') return new UserCancelledError()
  return error
}

// ===== File System Access API 路径 =====

export async function pickSaveFileHandle({ suggestedName = `untitled${WEBUTAU_PROJECT_EXTENSION}` } = {}) {
  if (!supportsFileSystemAccessApi()) throw new Error(t('hostStatus.fs_unsupported'))
  try {
    return await window.showSaveFilePicker({
      suggestedName,
      types: [getFsaPickerType()],
    })
  } catch (error) {
    throw wrapAbort(error)
  }
}

export async function pickOpenFileHandle() {
  if (!supportsFileSystemAccessApi()) throw new Error(t('hostStatus.fs_unsupported'))
  try {
    const [handle] = await window.showOpenFilePicker({
      multiple: false,
      types: [getFsaPickerType()],
    })
    return handle || null
  } catch (error) {
    throw wrapAbort(error)
  }
}

export async function writeJsonToHandle(handle, jsonString) {
  if (!handle?.createWritable) throw new Error(t('hostStatus.fs_no_write'))
  // 写入前再确认一次权限（句柄可能在长时间持有后失效）
  if (typeof handle.queryPermission === 'function') {
    const permission = await handle.queryPermission({ mode: 'readwrite' })
    if (permission !== 'granted') {
      const requested = await handle.requestPermission?.({ mode: 'readwrite' })
      if (requested !== 'granted') throw new UserCancelledError()
    }
  }
  const writable = await handle.createWritable()
  try {
    await writable.write(jsonString)
  } finally {
    await writable.close()
  }
}

export async function readJsonFromHandle(handle) {
  if (!handle?.getFile) throw new Error(t('hostStatus.fs_no_read'))
  const file = await handle.getFile()
  return file.text()
}

export function getHandleName(handle) {
  return typeof handle?.name === 'string' ? handle.name : null
}

// ===== Blob 下载 / file input 上传 兜底路径 =====

export function downloadBlobFile({ jsonString, suggestedName }) {
  const blob = new Blob([jsonString], { type: `${WEBUTAU_PROJECT_MIME_TYPE};charset=utf-8` })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = ensureExtension(suggestedName || `untitled${WEBUTAU_PROJECT_EXTENSION}`)
  anchor.style.display = 'none'
  document.body.appendChild(anchor)
  anchor.click()
  // setTimeout 让浏览器有机会拉起下载，再清理引用
  setTimeout(() => {
    anchor.remove()
    URL.revokeObjectURL(url)
  }, 0)
}

// 兜底"打开"——当浏览器不支持 FSA 时，弹一个临时的 <input type="file"> 让用户挑。
// 返回一个 Promise，用户选完之后 resolve 文件、用户取消时 reject(UserCancelledError)
export function pickFileViaInput() {
  return new Promise((resolve, reject) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = `${WEBUTAU_PROJECT_EXTENSION},${WEBUTAU_PROJECT_MIME_TYPE},application/json`
    input.style.display = 'none'
    document.body.appendChild(input)

    let settled = false
    const cleanup = () => {
      input.removeEventListener('change', onChange)
      window.removeEventListener('focus', onFocus)
      input.remove()
    }
    const onChange = () => {
      settled = true
      const file = input.files?.[0] || null
      cleanup()
      if (file) resolve(file)
      else reject(new UserCancelledError())
    }
    // 用户在 OS 文件对话框里点取消时不会触发 change；窗口重新获得焦点是唯一信号。
    // 略加延迟避免 change 事件还没来就被当作取消
    const onFocus = () => {
      setTimeout(() => {
        if (!settled) {
          cleanup()
          reject(new UserCancelledError())
        }
      }, 250)
    }
    input.addEventListener('change', onChange)
    window.addEventListener('focus', onFocus, { once: true })
    input.click()
  })
}

export async function readJsonFromFile(file) {
  if (!file) throw new Error(t('hostStatus.fs_no_file'))
  return file.text()
}

function ensureExtension(name) {
  return name.toLowerCase().endsWith(WEBUTAU_PROJECT_EXTENSION) ? name : `${name}${WEBUTAU_PROJECT_EXTENSION}`
}
