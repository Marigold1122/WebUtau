# Reverb 性能问题专项文档（Debug + 架构修复 + 代码文件行数约束版）

## 0. 先澄清约束（本版新增）
你提出的“单文件不超过 300 行”指的是**实际生产代码文件**，不是文档文件。

本文件在所有方案中默认带上以下硬约束：
- 约束 C0-1：新增或重构后的每个生产代码文件必须 `< 300` 行。
- 约束 C0-2：禁止上帝函数（单函数不建议超过 60 行，复杂函数必须拆分）。
- 约束 C0-3：禁止“单模块吃掉多层职责”（UI + 状态 + 音频更新混写）。
- 约束 C0-4：性能优化优先走“数据流去重 + 增量更新 + 缓存”，避免堆复杂 if。

---

## 1. 文档目标
- 明确“播放中调节混响卡顿”的真实根因（含代码证据）。
- 给出可重复、可量化、可回归的 Debug 方案。
- 提供满足 `<300 行/文件` 的重构蓝图。
- 评估修复是否合理，以及会不会引入新 bug。

---

## 2. 问题现象与症状
你反馈的核心症状：
- 播放中调混响明显卡顿。
- 拖动控件时交互延迟明显（INP 变差）。
- 体感上像主线程被阻塞或事件排队。

已有现场线索：
- 多个 pointer interaction 在 100ms~400ms 区间。
- 这类数据通常指向“高频输入事件触发重计算”或“重复渲染 + 重算”。

---

## 3. 代码证据与根因排序

### 3.1 Root Cause A（置信度 0.98）
**每次 reverb 配置更新都会重建卷积 IR。**

证据：
- `src/host/audio/reverb/ConvolverReverbBackend.js`
  - `setConfig()` 调用 `buildImpulseResponse()`。
  - `buildImpulseResponse()` 对每帧样本写入，计算量随 `sampleRate * decaySec` 增长。

影响：
- 高频拖动时，主线程被反复拉高 CPU 使用。
- 交互输入（pointer/input）与音频参数更新竞争主线程。

### 3.2 Root Cause B（置信度 0.97）
**无差别同步导致“改 send/volume 也触发 IR 重建”。**

证据：
- `src/host/audio/ProjectAudioGraph.js`
  - `_syncTrackChannel()` 总是调用 `reverbBus.setConfig(nextState.reverbConfig)`。

影响：
- 与 IR 无关的参数变更也支付 IR 重建成本。

### 3.3 Root Cause C（置信度 0.95）
**一次轨道更新被 4 套 scheduler 广播分发，重复调用。**

证据：
- `src/host/transport/ProjectTransportCoordinator.js`
  - `setTrackReverbConfig()` 广播到 instrument/imported/vocal/converted。
- 各 scheduler 最终多会再调用 `audioGraph.setTrackReverbConfig()`。

影响：
- 同值更新被重复执行。
- A/B 问题被乘法放大。

### 3.4 Root Cause D（置信度 0.94）
**UI input 事件无节流，拖动时高频同步。**

证据：
- `src/host/ui/reverb/reverbDockDom.js`
  - `input` 事件直接触发 `onInput(nextValue)`。
- `src/host/ui/ReverbDockView.js`
  - `onInput` 直达 controller 更新。

影响：
- 高频输入 = 高频业务更新 = 高频图更新 = 高频 backend 更新。

### 3.5 Root Cause E（置信度 0.90）
**“关闭混响”仅把 returnGain 置零，不旁路。**

证据：
- `src/host/app/createHostReverbController.js`
  - toggle 逻辑主要通过 `returnGain: 0`。
- `src/host/audio/TrackReverbBus.js`
  - 链路仍存在。

影响：
- 用户感觉关了，但引擎仍可能做不必要工作。

---

## 4. 当前问题数据流（原始版本）
`UI knob input`
-> `ReverbDockView.onTrackReverbConfigChanged(commit:false)`
-> `TrackMonitorController.setTrackReverbConfig`
-> `ProjectTransportCoordinator.setTrackReverbConfig`
-> 4 scheduler 广播
-> `ProjectAudioGraph.syncTrackState`
-> `_syncTrackChannel`
-> `TrackReverbBus.setConfig`
-> `ConvolverReverbBackend.setConfig`
-> `buildImpulseResponse`

关键缺陷：
- 无参数分类（什么更新需要 IR 重建）。
- 无事件合并（高频输入全量直通）。
- 无同值短路（重复调用大量存在）。
- 无分发路由（无脑广播 4 路）。

---

## 5. Debug 实操方案（详细）

### 5.1 复现前准备
1. 使用包含多轨（建议 >=8 轨）的工程，至少混合两类 source。
2. 打开 Reverb Dock，并确保至少 1 条轨有可听内容。
3. 关闭非必要控制台日志，避免观测噪声。

### 5.2 复现场景矩阵
- S1：播放中拖 `SEND` 15 秒。
- S2：播放中拖 `PRE-DLY` 15 秒。
- S3：播放中拖 `DECAY` 15 秒。
- S4：暂停状态拖 `DECAY` 15 秒。
- S5：播放中反复开关轨道混响。

每个场景记录：
- Input 事件总数。
- `setTrackReverbConfig` 调用次数。
- `reverbBus.setConfig` 调用次数。
- IR 重建次数与总耗时。
- 主线程 long task（>50ms）数量。
- INP p75/p95。

### 5.3 浏览器采样步骤（Chrome）
1. 打开 DevTools -> Performance。
2. 勾选 Screenshots、Web Vitals。
3. 开始录制后执行场景动作。
4. 停止录制，重点看：
- Main thread flamechart。
- `Event: input`、`Event: pointermove`。
- JS call stack 是否进入 `buildImpulseResponse` 热区。
- 长任务是否与控件拖动时间段对齐。

### 5.4 代码级临时探针（Debug 分支）
建议新增 `src/host/audio/reverb/ReverbDebugProbe.js`（仅 debug 构建可启用）：
- `markKnobInput(trackId, key)`
- `markTrackConfigDispatch(trackId)`
- `markAudioGraphSync(trackId)`
- `markReverbBusSetConfig(trackId)`
- `markImpulseBuild(trackId, msCost, frameCount)`
- `flushSummary()`

日志字段建议：
- `trackId`
- `sourceType`
- `changedKeys`
- `needsImpulseRebuild`
- `costMs`
- `timestamp`

### 5.5 判定阈值（修复目标）
- G1：拖 `send` 时 `impulseRebuildCalls == 0`。
- G2：拖 `preDelay/highCut/lowCut/return` 时 `impulseRebuildCalls == 0`。
- G3：拖 `decay` 时 IR 重建频率显著下降（受限于 coalescer）。
- G4：INP p95 明显下降，long task 数量下降。

---

## 6. 重构蓝图（满足 `<300 行/文件`）

### 6.1 拆分目标总览（本版新增）
以下是建议的文件拆分与行数预算（目标值，不是硬编码）：

| 模块 | 建议文件 | 目标行数 |
|---|---|---:|
| 参数差分 | `src/host/audio/reverb/ReverbConfigDiff.js` | 120 |
| 参数分类 | `src/host/audio/reverb/ReverbUpdateClassifier.js` | 140 |
| 输入合并 | `src/host/audio/reverb/ReverbUpdateCoalescer.js` | 180 |
| IR 缓存 | `src/host/audio/reverb/ConvolverImpulseCache.js` | 190 |
| IR 生成 | `src/host/audio/reverb/ImpulseResponseBuilder.js` | 180 |
| Convolver backend | `src/host/audio/reverb/ConvolverReverbBackend.js` | 220 |
| Track reverb bus | `src/host/audio/TrackReverbBus.js` | 240 |
| Track FX 路由 | `src/host/transport/TrackFxDispatchRouter.js` | 180 |
| AudioGraph 状态合并 | `src/host/audio/graph/TrackStateStore.js` | 180 |
| AudioGraph 通道同步 | `src/host/audio/graph/TrackChannelSync.js` | 200 |
| AudioGraph 门面 | `src/host/audio/ProjectAudioGraph.js` | 220 |

约束：
- 每个文件 `<300` 行。
- 任何函数超过 60 行必须拆。
- 每个模块只解决一类问题。

### 6.2 分层职责
- UI 层：只产生“用户意图 patch”。
- Controller 层：做最小验证与状态提交，不做重计算。
- Transport 路由层：把 patch 定向到正确 scheduler，而非广播。
- AudioGraph 层：只做轨道状态应用与节点同步。
- Reverb backend 层：只做 DSP 相关更新，支持增量。

### 6.3 关键接口（建议）

`ReverbConfigDiff.diff(prevConfig, nextPatch) -> { changedKeys, nextConfig, needsImpulseRebuild }`

`ReverbUpdateClassifier.classify(changedKeys) -> { level, allowRealtime, needsImpulse }`

`ReverbUpdateCoalescer.enqueue(trackId, patch, meta)`
`ReverbUpdateCoalescer.flush(trackId?)`

`TrackFxDispatchRouter.dispatchTrackReverbPatch(trackId, patch, meta)`

`TrackReverbBus.applyPatch(patch, meta)`
- `applyRealtimePatch`：delay/filter/gain
- `applyImpulsePatch`：仅 decay 类

### 6.4 目标数据流（优化后）
`UI input`
-> `Coalescer.enqueue`
-> flush 时 `Diff + Classify`
-> `Router.dispatch`
-> `AudioGraph.applyTrackPatch`
-> `TrackReverbBus.applyPatch`
-> 仅必要时 `backend.updateImpulse`

核心变化：
- 从“全量 setConfig”变为“增量 patch”。
- 从“广播 4 路”变为“按 track type 定向”。
- 从“每次都重建 IR”变为“仅 decay 变化 + 缓存复用”。

---

## 7. 这样改是否合理

### 7.1 合理性
- 合理点 A：按参数类型分级，直接切断不必要 IR 重建。
- 合理点 B：路由去广播，削减重复调用。
- 合理点 C：coalescer 降低高频 input 压力，改善交互。
- 合理点 D：模块拆分满足维护性与 `<300 行/文件` 约束。

### 7.2 成本
- 会增加模块数量与协作复杂度。
- 需要补足测试体系，否则容易在模块边界处出错。

综合判断：
- 成本可控，收益高，适合立即推进。

---

## 8. 潜在新 bug 与防护

### R1：差分错误导致参数未生效
- 防护：`ReverbConfigDiff` 全键单测，覆盖每个参数键。

### R2：实时合并导致听感“阶梯化”
- 防护：`commit:false` 使用 30Hz；`commit:true` 强制立即 flush。

### R3：IR 缓存 key 不完整导致音色串用
- 防护：key 必须包含 `sampleRate/decaySec/decayCurve/seed`。

### R4：引擎旁路切换出现 click/pop
- 防护：gain 采用 5~15ms ramp，避免硬切。

### R5：路由定向后 source 切换瞬间丢更新
- 防护：source 切换后触发一次“全量状态重同步”。

---

## 9. 测试设计（详细）

### 9.1 单元测试
- `ReverbConfigDiff.spec.js`
  - 每个参数独立变更。
  - 多参数组合变更。
  - 浮点 epsilon 比较边界。

- `ReverbUpdateClassifier.spec.js`
  - Level 分类准确。
  - `needsImpulseRebuild` 判定准确。

- `ConvolverImpulseCache.spec.js`
  - 命中/淘汰/LRU 行为。
  - 高并发读取一致性。

### 9.2 集成测试
- 播放中拖 `send`：IR 重建必须为 0。
- 播放中拖 `preDelay`：IR 重建必须为 0。
- 播放中拖 `decay`：IR 重建明显下降且听感连续。
- 切 source 后继续调参：参数生效无丢失。

### 9.3 性能回归测试
固定同一项目、同一操作脚本，比较前后：
- `INP p75/p95`
- long task 数量
- `impulseRebuildCalls`
- `impulseRebuildCostMsTotal`
- GC 次数与最大停顿

---

## 10. 迭代实施计划（按风险从低到高）
- M1：加 debug probe（不改行为）。
- M2：加入差分 + 同值短路（低风险高收益）。
- M3：引入参数分类与增量 patch。
- M4：加入路由层，去 4 路广播。
- M5：加入 IR 缓存与 coalescer。
- M6：旁路与 click/pop 打磨。

每个里程碑验收都必须通过：
- 功能回归。
- 性能门禁。
- 文件行数门禁（每文件 `<300`）。

---

## 11. 代码评审清单（可直接用）
- 是否有任何新文件超过 300 行。
- 是否有函数超过 60 行且未拆分。
- 是否仍存在“send/volume 导致 IR 重建”的路径。
- 是否仍存在 coordinator 广播 4 路重复调用。
- 是否保证 commit:true 不丢最终值。
- 是否新增了兼容层日志字段（便于定位）。

---

## 12. 完成定义（DoD）
- 用户主观体感：播放中拖混响明显更流畅。
- 关键指标：`send/preDelay` 调整不触发 IR 重建。
- 工程规范：所有新增/重构生产代码文件 `<300` 行。
- 可维护性：无上帝函数，无跨层混杂，数据流清晰可追踪。
