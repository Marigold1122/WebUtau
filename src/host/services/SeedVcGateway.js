const DEFAULT_SEEDVC_BASE_URL = 'http://localhost:5001'

function appendParam(formData, key, value) {
  if (typeof value === 'boolean') {
    formData.append(key, value ? 'true' : 'false')
    return
  }
  formData.append(key, String(value))
}

export class SeedVcGateway {
  constructor(baseUrl = DEFAULT_SEEDVC_BASE_URL) {
    this.baseUrl = baseUrl.replace(/\/+$/, '')
  }

  async convert({ sourceBlob = null, sourceUrl = '', referenceFile, params = {}, signal = undefined } = {}) {
    if (!(sourceBlob instanceof Blob) && typeof sourceUrl !== 'string') {
      throw new Error('缺少原始人声音频')
    }
    if (!(referenceFile instanceof File)) throw new Error('缺少参考音频')

    const formData = new FormData()
    if (sourceBlob instanceof Blob) {
      formData.append('source', sourceBlob, 'source.wav')
    } else if (sourceUrl.trim()) {
      formData.append('sourceUrl', sourceUrl.trim())
    } else {
      throw new Error('缺少原始人声音频')
    }
    formData.append('reference', referenceFile, referenceFile.name || 'reference.wav')
    appendParam(formData, 'diffusionSteps', params.diffusionSteps ?? 20)
    appendParam(formData, 'lengthAdjust', params.lengthAdjust ?? 1.0)
    appendParam(formData, 'cfgRate', params.cfgRate ?? 0.7)
    appendParam(formData, 'f0Condition', params.f0Condition ?? true)
    appendParam(formData, 'autoF0Adjust', params.autoF0Adjust ?? false)
    appendParam(formData, 'pitchShift', params.pitchShift ?? 0)

    const response = await fetch(`${this.baseUrl}/api/voice-conversion`, {
      method: 'POST',
      body: formData,
      signal,
    })
    const data = await response.json().catch(() => null)
    if (!response.ok) {
      throw new Error(data?.detail || data?.error || `SeedVC 调用失败: ${response.status}`)
    }
    return data
  }
}
