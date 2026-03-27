function createDefaultState() {
  return {
    driver: 'idle',
    playing: false,
    currentTime: 0,
    duration: 0,
  }
}

export class ProjectTransportStore {
  constructor() {
    this.state = createDefaultState()
  }

  getSnapshot() {
    return { ...this.state }
  }

  replace(nextState = {}) {
    this.state = {
      ...createDefaultState(),
      ...nextState,
    }
    return this.getSnapshot()
  }

  patch(changes = {}) {
    this.state = {
      ...this.state,
      ...changes,
    }
    return this.getSnapshot()
  }

  reset() {
    this.state = createDefaultState()
    return this.getSnapshot()
  }
}
