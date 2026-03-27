class EventBus {
  constructor() {
    this.listeners = new Map()
  }

  on(eventName, callback) {
    const validEvent = typeof eventName === 'string' && eventName.trim()
    if (!validEvent || typeof callback !== 'function') {
      console.warn('EventBus.on 参数无效', { eventName, callback })
      return
    }
    if (!this.listeners.has(eventName)) this.listeners.set(eventName, [])
    this.listeners.get(eventName).push(callback)
  }

  off(eventName, callback) {
    const callbacks = this.listeners.get(eventName)
    if (!callbacks) return
    const index = callbacks.indexOf(callback)
    if (index === -1) return
    callbacks.splice(index, 1)
    if (callbacks.length === 0) this.listeners.delete(eventName)
  }

  emit(eventName, data) {
    const callbacks = this.listeners.get(eventName)
    if (!callbacks) return
    for (const callback of [...callbacks]) {
      try {
        callback(data)
      } catch (error) {
        console.error(`EventBus emit error: ${eventName}`, error)
      }
    }
  }
}

const eventBus = new EventBus()

export default eventBus
