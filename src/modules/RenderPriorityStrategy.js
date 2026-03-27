import phraseStore from '../core/PhraseStore.js'
import renderCache from './RenderCache.js'

const renderPriorityStrategy = {
  getNextPriority(currentTime) {
    const phrases = phraseStore.getPhrases()
    if (phrases.length === 0) return null

    let currentIndex = -1
    for (let index = 0; index < phrases.length; index += 1) {
      // 找到当前播放头所在或之后最近的语句。
      if (currentTime < phrases[index].endTime) {
        currentIndex = index
        break
      }
    }

    if (currentIndex === -1) return null

    for (let index = currentIndex; index < phrases.length; index += 1) {
      const phrase = phrases[index]
      // 只要缓存无效，就把该语句作为下一个优先渲染目标。
      if (!renderCache.isValid(index, phrase.inputHash)) return index
    }

    return null
  },
}

export default renderPriorityStrategy
