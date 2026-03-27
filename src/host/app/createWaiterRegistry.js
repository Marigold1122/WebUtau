export function createWaiterRegistry() {
  const pending = new Map()

  return {
    wait(key) {
      return new Promise((resolve) => {
        pending.set(key, resolve)
      })
    },
    resolve(key, result) {
      const resolve = pending.get(key)
      if (!resolve) return
      pending.delete(key)
      resolve(result)
    },
  }
}
