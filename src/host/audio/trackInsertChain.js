// 多段 insert 的连接逻辑：input → effect1 → effect2 → ... → postInsert
//
// 抽到独立文件是因为 ProjectAudioGraph 已经超过 max-lines baseline，
// 多段链路逻辑放进去会让它继续膨胀；同时这个 helper 适合独立 review

function disconnectNode(node) {
  try { node?.disconnect?.() } catch (_error) {}
}

function isUsableEffect(effect) {
  return Boolean(effect?.input && effect?.output)
}

// 把 input 节点和 postInsert 之间按 effects 顺序串起来。
// 调用前必须已 disconnect 过 input + 所有 effect 的 output；
// helper 不负责 disconnect，因为各 effect 的 dispose 时机由调用方掌握。
//
// 空 effects 列表 = input 直连 postInsert。
export function connectInsertChain(input, postInsert, effects = []) {
  if (!input || !postInsert) return false
  const validEffects = effects.filter(isUsableEffect)

  let head = input
  for (const effect of validEffects) {
    head.connect(effect.input)
    head = effect.output
  }
  head.connect(postInsert)
  return true
}

// 给 channel 调用前断开旧连接的便捷封装。effects 数组里 null 项会被忽略。
export function disconnectInsertChain(input, effects = []) {
  disconnectNode(input)
  for (const effect of effects) {
    if (!effect) continue
    disconnectNode(effect.output)
  }
}
