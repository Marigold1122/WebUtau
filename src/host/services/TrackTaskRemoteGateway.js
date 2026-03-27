import renderApi from '../../api/RenderApi.js'

export class TrackTaskRemoteGateway {
  async cancelJob(jobId) {
    if (!jobId) return
    await renderApi.deleteJob(jobId)
  }

  async prioritizePhrase(jobId, phraseIndex) {
    if (!jobId || !Number.isInteger(phraseIndex)) return
    await renderApi.setPriority(jobId, phraseIndex)
  }
}
