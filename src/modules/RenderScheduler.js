import eventBus from '../core/EventBus.js'
import { EVENTS, PHRASE_STATUS, RENDER_PRIORITY } from '../config/constants.js'
import renderCache from './RenderCache.js'
import renderJobManager from './RenderJobManager.js'

class RenderScheduler {
  enqueue(phraseIndex, priority) {
    const priorityName = priority === RENDER_PRIORITY.URGENT ? '紧急' : priority === RENDER_PRIORITY.VISIBLE ? '可见' : '后台'
    console.log(`[渲染调度] 入队 | 句子=第${phraseIndex}句, 优先级=${priorityName}, 当前缓存状态=${renderCache.getStatus(phraseIndex)}`)
    renderCache.setStatus(phraseIndex, PHRASE_STATUS.RENDERING)

    if (priority === RENDER_PRIORITY.URGENT) renderJobManager.prioritize(phraseIndex)

    eventBus.emit(EVENTS.RENDER_PRIORITIZE, { phraseIndex })
  }

  prioritize(phraseIndex) {
    // 手动提权时同样只做转发，不再自己持有队列。
    renderJobManager.prioritize(phraseIndex)
    eventBus.emit(EVENTS.RENDER_PRIORITIZE, { phraseIndex })
  }

  getQueue() {
    return []
  }
}

export default new RenderScheduler()
