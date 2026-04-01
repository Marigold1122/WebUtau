# Reverb 能力升级专项文档（复杂度不足 + 架构路线 + 代码文件行数约束版）

## 0. 约束声明（本版新增）
你要求的“单文件不超过 300 行”约束作用于**实际代码文件**。

本路线图默认采用以下硬门禁：
- 约束 C0-1：任一生产代码文件 `<300` 行。
- 约束 C0-2：任一核心函数建议 `<60` 行。
- 约束 C0-3：模块单一职责，不允许 UI/状态/DSP 混写。
- 约束 C0-4：新增能力必须可回滚、可兼容旧项目。

---

## 1. 文档目标
- 解释当前方案为什么“可用但不够丰富”。
- 回答“能否达到教堂/浴室/板式等 DAW 常见效果”。
- 设计可扩展架构：模块、数据流、协作边界。
- 明确这样改是否合理，是否会引入新 bug。

---

## 2. 当前能力基线（代码事实）

### 2.1 引擎层现状
当前混响路径固定：
`preDelay -> highPass -> lowPass -> convolver -> returnGain`

关键文件：
- `src/host/audio/TrackReverbBus.js`
- `src/host/audio/reverb/ConvolverReverbBackend.js`

结论：
- 当前是单引擎方案，不支持“按引擎类型切换”。

### 2.2 参数层现状
底层字段：
- `decaySec`
- `decayCurve`
- `preDelaySec`
- `lowCutHz`
- `highCutHz`
- `returnGain`

轨道 UI 实际暴露：
- `reverbSend`
- `decaySec`
- `preDelaySec`
- `dampRatio(映射 highCutHz)`
- `returnGain`

缺失暴露：
- `lowCutHz`
- `decayCurve`

关键文件：
- `src/host/project/reverbConfigState.js`
- `src/host/ui/reverb/reverbDockDefinitions.js`

### 2.3 预设层现状
- 预设仅 1 个：`zita-vocal-default`。
- 无分类型 preset catalog（church/room/plate/spring/bathroom 等）。

### 2.4 语义层现状
- 项目级 reverb 更像“默认模板”（新轨道继承），不是全局总线效果器。
- 用户常见 DAW 心智模型是“bus 插件影响整路”，两者语义不同。

---

## 3. 与 DAW 期望能力的差距矩阵

| 维度 | 你当前项目 | DAW 常见能力 | 差距等级 |
|---|---|---|---|
| 引擎数量 | 单引擎 | 多引擎（Hall/Room/Plate/Spring/Convolution） | 高 |
| 预设体系 | 单预设 | 分类预设库 + tag + 搜索 | 高 |
| 参数模型 | 固定少量字段 | 引擎特定 schema + 高级参数 | 高 |
| UI 渲染 | 写死控件 | schema-driven 动态渲染 | 中高 |
| 兼容迁移 | legacy 结构 | 版本化 schema + migration | 中 |
| 可扩展性 | 改核心文件 | 注册式扩展 | 高 |

结论：
- 复杂度不足不是“参数没调好”，而是“可扩展架构未建立”。

---

## 4. 能力目标（非一口吃完）

### 4.1 近期目标（可交付）
- 支持 8~12 个有明显听感差异的 preset。
- 参数面板补齐核心字段（至少 lowCut/decayCurve）。
- UI 从“写死参数”转为“schema 驱动”。

### 4.2 中期目标
- 支持至少 2 个 engine（如 legacy + plate）。
- 支持 preset 分类：`hall/room/plate/bathroom/church/vocal`。

### 4.3 长期目标
- 多引擎注册生态。
- 总线/轨道双层 reverb routing。
- 自动化与调制（可选）。

---

## 5. 目标架构（满足 `<300 行/文件`）

### 5.1 模块与文件预算（本版新增）

| 分层 | 建议文件 | 目标行数 |
|---|---|---:|
| 引擎注册 | `src/host/audio/reverb/ReverbEngineRegistry.js` | 180 |
| 引擎接口契约 | `src/host/audio/reverb/IReverbEngine.js` | 80 |
| legacy 引擎包装 | `src/host/audio/reverb/engines/LegacyConvolverEngine.js` | 220 |
| plate 引擎（后续） | `src/host/audio/reverb/engines/PlateEngine.js` | 260 |
| 参数 schema 仓库 | `src/host/audio/reverb/ReverbParameterSchema.js` | 220 |
| patch 校验 | `src/host/audio/reverb/ReverbPatchValidator.js` | 170 |
| preset catalog | `src/host/project/ReverbPresetCatalog.js` | 220 |
| preset 归一化 | `src/host/project/ReverbPresetState.js` | 170 |
| track reverb 状态 | `src/host/project/trackReverbState.js` | 240 |
| migration | `src/host/project/migrations/reverbStateMigration.js` | 180 |
| dock 渲染器 | `src/host/ui/reverb/ReverbDockRenderer.js` | 260 |
| dock 控件工厂 | `src/host/ui/reverb/ReverbControlFactory.js` | 240 |
| reverb controller | `src/host/app/controllers/ReverbController.js` | 260 |
| audio graph 门面 | `src/host/audio/ProjectAudioGraph.js` | 220 |

注意：
- 若某文件接近 260 行，必须提前拆，不要等超 300 再补救。

### 5.2 模块职责边界
- Registry 层：只管“有哪些 engine”与“如何实例化”。
- Engine 层：只管 DSP 节点图和 patch 应用。
- Schema 层：只管参数定义，不管 UI/状态。
- Catalog 层：只管预设定义与检索。
- State 层：只管持久化结构、归一化、迁移。
- UI 层：只按 schema 渲染，不写死业务逻辑。
- Controller 层：协调 UI-state-audio，做最小编排。

---

## 6. 关键接口建议

### 6.1 `IReverbEngine`
```ts
interface IReverbEngine {
  readonly engineId: string
  attach(nodes: { inputNode: AudioNode; outputNode: AudioNode }): boolean
  applyPatch(patch: Record<string, number>, meta?: { commit?: boolean }): boolean
  getParameterSchema(): ReverbParamDef[]
  dispose(): void
}
```

### 6.2 `ReverbEngineRegistry`
- `register(engineId, factory)`
- `create(engineId, ctx, options)`
- `has(engineId)`
- `list()`

### 6.3 `ReverbPresetCatalog`
- `getPreset(presetId)`
- `listByTag(tag)`
- `listByEngine(engineId)`
- `normalizePresetId(presetId, fallbackEngineId)`

### 6.4 `trackReverbState`
- `normalizeTrackReverbState(raw, defaults)`
- `mergeTrackReverbState(current, patch)`
- `migrateLegacyReverbState(trackPlaybackState)`

---

## 7. 数据模型设计

### 7.1 Track 级
```json
{
  "reverb": {
    "engineId": "convolver-legacy",
    "presetId": "vocal-default",
    "send": 0.22,
    "enabled": true,
    "config": {
      "decaySec": 2.4,
      "decayCurve": 2.2,
      "preDelaySec": 0.028,
      "lowCutHz": 180,
      "highCutHz": 7200,
      "returnGain": 0.9
    }
  }
}
```

### 7.2 Project 默认模板
```json
{
  "mixState": {
    "reverbDefault": {
      "engineId": "convolver-legacy",
      "presetId": "vocal-default",
      "config": { "...": "..." }
    }
  }
}
```

### 7.3 兼容策略
- 旧字段 `reverbSend/reverbConfig/reverbPresetId` 读取时迁移到新 `reverb` 结构。
- 保存时可保留兼容快照窗口（可选，过渡期使用）。

---

## 8. 协作数据流（升级后）

### 8.1 调参数
UI 控件（schema 生成）
-> `ReverbController.onParamInput(trackId, key, value, commit)`
-> `ReverbPatchValidator.validate(engineId, patch)`
-> `store.updateTrackReverbState`
-> `audioGraph.applyTrackReverbPatch`
-> `engine.applyPatch`

### 8.2 切预设
UI
-> controller
-> `catalog.getPreset(presetId)`
-> 更新 `engineId + config + presetId`
-> audioGraph 复用或切换 engine 实例
-> applyPatch

### 8.3 切引擎
UI
-> controller
-> 更新 `engineId`
-> registry create/reuse 新 engine
-> schema 驱动 UI 重渲
-> config fallback 到新 engine 默认

---

## 9. Debug 步骤（能力升级专项）

### 9.1 功能一致性检查
1. 同一 track 切 preset，UI 值与音色变化一致。
2. 切 engine 后旧 engine 私有参数不残留。
3. 关开 enabled 不破坏 send 值与 presetId。

### 9.2 状态一致性检查
1. `store`、`view`、`audioGraph` 三方值一致。
2. 项目保存/重开后，`engineId/presetId/config` 一致恢复。

### 9.3 迁移检查
1. 用旧项目样本导入，迁移后声音不应明显异常。
2. 迁移日志需能追踪每条 track 的映射结果。

### 9.4 性能协同检查
- 增加能力后不能恶化“播放中拖参”的性能基线。
- 新引擎加入必须走性能门禁（与性能文档协同）。

---

## 10. 这样改是否合理

### 10.1 合理性
- 合理点 A：先建扩展点，再扩预设/引擎，避免后期返工。
- 合理点 B：schema-driven UI 能系统性解决“参数漏暴露”。
- 合理点 C：registry 模式避免修改核心巨文件。
- 合理点 D：通过文件 budget 强制可维护性。

### 10.2 可能新风险
- R1：模块增多，调用链更长。
- R2：迁移逻辑有概率引发兼容问题。
- R3：多引擎切换时出现状态不同步。

### 10.3 缓解方案
- M1：统一日志上下文：`trackId/engineId/presetId/revision`。
- M2：migration 单测 + 真实项目样本回归。
- M3：controller 保持薄层，复杂逻辑下沉至纯函数模块。

---

## 11. 迭代实施计划（分阶段）

### Phase 1：打地基（低风险）
- 新增 `engineId`、`catalog`、`schema`，先只接 legacy engine。
- 保持旧 UI 可用，新增路径灰度启用。

### Phase 2：补齐参数暴露与预设库
- 先补 `lowCutHz`、`decayCurve`。
- 增加 8~12 个 preset（按 tag 分类）。

### Phase 3：引入第 2 引擎
- 建议先 `plate`，因为感知差异明显，便于验证架构价值。

### Phase 4：扩展风格族
- room/hall/plate/spring/bathroom/church 至少各 1 套可用方案。

### Phase 5：稳定化
- 完成迁移收敛、回归套件、性能门禁、文档完善。

---

## 12. 评审与验收清单
- 是否存在任何新增生产文件超过 300 行。
- 是否仍存在写死控件参数定义。
- 是否支持按 `engineId` 动态参数渲染。
- 旧工程是否无损迁移。
- 增加能力后性能是否保持或提升。

---

## 13. 与性能文档的协作关系
- 本文解决“能力边界不足”的结构问题。
- 性能文档解决“交互卡顿”的实时问题。
- 两者必须并行验收：
  - 能力升级不能牺牲性能。
  - 性能优化不能锁死架构扩展。

---

## 14. 完成定义（DoD）
- 用户可直接选择多类风格 preset（含 church/bathroom/plate）。
- 轨道参数面板由 schema 驱动，避免遗漏参数。
- 工程满足 `<300 行/生产文件` 约束。
- 旧项目迁移可靠，播放中调参性能不退化。
