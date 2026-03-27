import renderApi from '../../api/RenderApi.js'
import { RENDER_API_BASE_URL } from '../../api/RenderApi.js'
import { getToneRawContext } from '../audio/instruments/toneRuntime.js'

export class RenderOutputGateway {
  resolveJobDownloadUrl(jobId) {
    if (!jobId) throw new Error('缺少完整轨 jobId')
    return `${RENDER_API_BASE_URL}/api/jobs/${jobId}/download`
  }

  async downloadJobBlob(jobId) {
    this.resolveJobDownloadUrl(jobId)
    return renderApi.downloadJob(jobId)
  }

  async decodeJobBuffer(jobId) {
    const blob = await this.downloadJobBlob(jobId)
    const arrayBuffer = await blob.arrayBuffer()
    const rawContext = await getToneRawContext()
    return rawContext.decodeAudioData(arrayBuffer)
  }
}
