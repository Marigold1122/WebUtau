export const RENDER_API_BASE_URL = 'http://localhost:5000'

let _audioCtx = null

function _getAudioContext() {
  if (!_audioCtx) _audioCtx = new (window.AudioContext || window.webkitAudioContext)()
  return _audioCtx
}

const renderApi = {
  async submitJob(midiFile, singerId, language) {
    const formData = new FormData()
    formData.append('midi', midiFile)
    formData.append('singerId', singerId)
    formData.append('defaultLanguageCode', language)

    const response = await fetch(`${RENDER_API_BASE_URL}/api/synthesize`, {
      method: 'POST',
      body: formData,
    })
    return response.json()
  },
  async getJobStatus(jobId) {
    const response = await fetch(`${RENDER_API_BASE_URL}/api/jobs/${jobId}`)
    return response.json()
  },
  async downloadPhrase(jobId, phraseIndex) {
    const response = await fetch(`${RENDER_API_BASE_URL}/api/jobs/${jobId}/phrases/${phraseIndex}`)
    const arrayBuffer = await response.arrayBuffer()
    const audioContext = _getAudioContext()
    return audioContext.decodeAudioData(arrayBuffer)
  },
  async downloadJob(jobId) {
    const response = await fetch(`${RENDER_API_BASE_URL}/api/jobs/${jobId}/download`)
    if (!response.ok) throw new Error(`downloadJob failed: ${response.status}`)
    return response.blob()
  },
  async setPriority(jobId, phraseIndex) {
    await fetch(`${RENDER_API_BASE_URL}/api/jobs/${jobId}/priority`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phraseIndex }),
    })
  },
  async getPitch(jobId) {
    const response = await fetch(`${RENDER_API_BASE_URL}/api/jobs/${jobId}/pitch`)
    if (!response.ok) throw new Error(`getPitch failed: ${response.status}`)
    return response.json()
  },
  async deleteJob(jobId) {
    const response = await fetch(`${RENDER_API_BASE_URL}/api/jobs/${jobId}`, {
      method: 'DELETE',
    })
    if (!response.ok && response.status !== 404) {
      throw new Error(`deleteJob failed: ${response.status}`)
    }
  },
  async editNotes(jobId, edits) {
    const response = await fetch(`${RENDER_API_BASE_URL}/api/jobs/${jobId}/edit-notes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ edits }),
    })
    const data = await response.json().catch(() => null)
    if (!response.ok) {
      throw new Error(data?.error || `edit-notes failed: ${response.status}`)
    }
    return data
  },
}

export default renderApi
