# Reverb 施工计划（PR 分解 + 依赖图 + 可回滚）

## 0. 文档定位
本文件是“可直接施工”的执行计划，目标是把 Reverb 性能修复 + 能力升级拆为多个小 PR，确保：
- 每个生产代码文件 `<300` 行。
- 不出现上帝函数。
- 每一步都可验证、可回滚。

关联文档：
- `docs/reverb/reverb-performance-debug-architecture.md`
- `docs/reverb/reverb-capability-architecture-roadmap.md`

---

## 1. 全局约束与门禁

### 1.1 代码规模门禁
- 任一生产代码文件必须 `<300` 行。
- 任一函数建议 `<60` 行，超过必须拆分并写注释解释分层理由。
- 任一 PR 新增文件数建议 `<=10`，避免审查失焦。

### 1.2 质量门禁
- 每个 PR 至少包含：
  - 单元测试（若引入纯函数模块）。
  - 回归验证步骤。
  - 风险与回滚说明。
- 涉及音频行为变化的 PR 必须带前后对比指标。

### 1.3 性能门禁
- 拖动 `send/preDelay` 不允许触发 IR 重建。
- 播放中拖动 `decay` 时 IR 重建频率必须低于基线。
- INP p95 不得劣化。

---

## 2. 分支与合并策略

### 2.1 分支命名
- `feature/reverb-pr00-baseline-probe`
- `feature/reverb-pr01-config-diff`
- `feature/reverb-pr02-audiograph-patch`
- ...

### 2.2 合并策略
- 严禁“超大 PR 一次合并”。
- 采用线性 PR 序列，前置 PR 通过后再开后续 PR。
- 每个 PR 必须可以独立回滚。

### 2.3 代码所有权建议
- 音频核心：`src/host/audio/**`
- 状态与迁移：`src/host/project/**`
- 控制器编排：`src/host/app/**`
- UI 参数渲染：`src/host/ui/reverb/**`

---

## 3. 依赖图（先后关系）

P0 基线探针
-> P1 参数差分
-> P2 AudioGraph 增量 patch
-> P3 分发路由去广播
-> P4 Coalescer + Cache
-> P5 Legacy 引擎封装
-> P6 Schema 驱动 UI
-> P7 Preset Catalog
-> P8 Track Reverb 新状态 + 迁移
-> P9 第二引擎（Plate）
-> P10 灰度/监控/收口

说明：
- P0~P4 是性能止血主线。
- P5~P9 是能力升级主线。
- P8 要在 P5/P7 后执行，避免迁移目标不稳定。

---

## 4. PR 详细拆分

## PR-00 基线探针（不改行为）
目标：建立可复现、可量化基线。

建议新增文件（目标行数）：
- `src/host/audio/reverb/ReverbDebugProbe.js`（<180）
- `src/host/audio/reverb/ReverbDebugCounters.js`（<180）

修改文件：
- `ConvolverReverbBackend.js`（插桩）
- `ProjectAudioGraph.js`（插桩）
- `ReverbDockView.js` 或 controller（插桩）

验收：
- 输出 `knobInputEvents/impulseRebuildCalls` 等指标。
- 能稳定复现当前高成本链路。

回滚：
- 可通过 `ENABLE_REVERB_PROBE=false` 关停。

风险：
- 日志过多影响性能观测。
缓解：
- 限频与采样（例如每 250ms 聚合一次）。

---

## PR-01 参数差分 + 同值短路
目标：构建“是否需要 IR 重建”的决策层。

建议新增文件：
- `src/host/audio/reverb/ReverbConfigDiff.js`（<160）
- `src/host/audio/reverb/ReverbEpsilon.js`（<90）

修改文件：
- `TrackReverbBus.js`
- `ProjectAudioGraph.js`

验收：
- 同值 patch 不触发 backend 更新。
- `send` 更新不再触发 IR 重建。

回滚：
- 保留旧 `setConfig` 路径开关 `USE_REVERB_DIFF=false`。

---

## PR-02 AudioGraph 增量 patch 接口
目标：由全量同步改为增量同步。

建议新增文件：
- `src/host/audio/graph/TrackStateStore.js`（<220）
- `src/host/audio/graph/TrackChannelPatchApplier.js`（<220）

修改文件：
- `ProjectAudioGraph.js`（降为门面层）

验收：
- `syncTrackState` 可接受 patch，不必全量配置。
- 轨道 volume/send/reverb 分路径更新。

风险：
- patch 丢字段引发状态漂移。
缓解：
- Store 层做归一化与默认值补全。

---

## PR-03 分发路由（去掉 4 路广播重复）
目标：按 track type 定向更新 scheduler。

建议新增文件：
- `src/host/transport/TrackFxDispatchRouter.js`（<220）
- `src/host/transport/TrackTypeResolver.js`（<140）

修改文件：
- `ProjectTransportCoordinator.js`

验收：
- 单次轨道 reverb patch 只触达相关 scheduler。
- 重复调用次数显著下降。

---

## PR-04 Coalescer + IR Cache
目标：控制高频输入；复用 IR，降低构建成本。

建议新增文件：
- `src/host/audio/reverb/ReverbUpdateCoalescer.js`（<220）
- `src/host/audio/reverb/ConvolverImpulseCache.js`（<220）
- `src/host/audio/reverb/ImpulseResponseBuilder.js`（<220）

修改文件：
- `ConvolverReverbBackend.js`
- `ReverbDockView.js` 或 controller 输入路径

验收：
- `decay` 拖动 IR 重建次数下降。
- `send/preDelay` 拖动无 IR 重建。

风险：
- 合并延迟导致听感阶梯。
缓解：
- `commit:true` 强制即时 flush。

---

## PR-05 Legacy Engine 抽象化
目标：把现有卷积实现封装到统一 engine 接口。

建议新增文件：
- `src/host/audio/reverb/IReverbEngine.js`（<100）
- `src/host/audio/reverb/ReverbEngineRegistry.js`（<220）
- `src/host/audio/reverb/engines/LegacyConvolverEngine.js`（<260）

修改文件：
- `TrackReverbBus.js`（改为依赖 engine）

验收：
- Legacy 行为不变。
- 可通过 `engineId` 创建引擎。

---

## PR-06 Schema 驱动参数渲染
目标：摆脱写死参数列表，支持按 engine 动态 UI。

建议新增文件：
- `src/host/audio/reverb/ReverbParameterSchema.js`（<240）
- `src/host/ui/reverb/ReverbControlFactory.js`（<260）
- `src/host/ui/reverb/ReverbDockRenderer.js`（<260）

修改文件：
- `ReverbDockView.js`（薄化为组合器）

验收：
- 参数控件由 schema 生成。
- 可完整暴露 `lowCutHz`、`decayCurve`。

---

## PR-07 Preset Catalog 与标签体系
目标：支持多风格预设与分类。

建议新增文件：
- `src/host/project/ReverbPresetCatalog.js`（<260）
- `src/host/project/ReverbPresetTags.js`（<120）
- `src/host/project/ReverbPresetState.js`（<200）

修改文件：
- `reverbConfigState.js`（降级或适配）

验收：
- 至少 8~12 个 preset。
- 支持按 tag 过滤（hall/room/plate/bathroom/church/vocal）。

---

## PR-08 Track Reverb 状态重构 + 迁移
目标：引入 `reverb: { engineId,presetId,send,config }`。

建议新增文件：
- `src/host/project/trackReverbState.js`（<260）
- `src/host/project/migrations/reverbStateMigration.js`（<220）
- `src/host/project/migrations/reverbStateMigration.spec.js`（<260）

修改文件：
- `trackPlaybackState.js`
- `ProjectDocumentStore.js`
- `ProjectAudioMixPersistence.js`

验收：
- 旧项目可无损迁移。
- 新旧字段兼容读取通过。

风险：
- 数据丢失或默认值偏移。
缓解：
- 迁移前后快照对比测试。

---

## PR-09 第二引擎（Plate）
目标：验证多引擎架构价值，不追求一次全家桶。

建议新增文件：
- `src/host/audio/reverb/engines/PlateEngine.js`（<280）
- `src/host/audio/reverb/engines/PlateDiffusion.js`（<220）
- `src/host/audio/reverb/engines/PlateDamping.js`（<200）

验收：
- 可切换 legacy/plate。
- plate 至少有独立参数 2~3 个。

---

## PR-10 灰度、监控与收口
目标：稳定发布与可回滚。

建议新增文件：
- `src/host/config/reverbFeatureFlags.js`（<140）
- `src/host/monitor/ReverbMetricsReporter.js`（<220）
- `docs/reverb/reverb-release-checklist.md`（文档）

验收：
- 支持按 flag 回退到 legacy 全旧路径。
- 指标看板可识别性能/异常回归。

---

## 5. CI 与自动门禁建议

### 5.1 文件行数检查
新增脚本：`scripts/check-max-lines.mjs`
- 扫描 `src/**`。
- 排除 `*.spec.*` 可配置。
- 超过 300 行则 CI 失败。

### 5.2 函数体长度检查
可选：ESLint 自定义规则或 `max-lines-per-function`。
- 建议阈值 60。

### 5.3 性能回归检查
建议固定“Reverb 拖动场景”脚本化（Playwright 或手工基准），比较：
- IR 重建次数
- INP p95
- long task 数量

---

## 6. 每个 PR 的提交模板

标题：`reverb: <PR编号> <目标>`

正文必须包含：
1. 变更摘要。
2. 影响文件与行数（标注是否都 `<300`）。
3. 风险点与回滚开关。
4. 验证结果（功能 + 性能）。

---

## 7. 每周施工节奏建议

- 周一：实现 + 自测。
- 周二：性能回归与缺陷修复。
- 周三：PR 审查与合并。
- 周四：灰度验证 + 反馈。
- 周五：文档与债务清理。

---

## 8. 交付里程碑与退出标准

### 里程碑 A（性能止血）
完成 PR-00 ~ PR-04。
退出标准：
- 播放中调参卡顿明显下降。
- `send/preDelay` 不触发 IR 重建。

### 里程碑 B（结构升级）
完成 PR-05 ~ PR-08。
退出标准：
- engine/schema/catalog/state/migration 结构稳定。
- 旧项目兼容通过。

### 里程碑 C（能力验证）
完成 PR-09 ~ PR-10。
退出标准：
- 至少两引擎可切换。
- 预设分类可用。
- 有灰度与回滚能力。

---

## 9. 施工常见反模式（禁止）
- 一次 PR 同时改 UI + 状态 + 音频内核且无分层。
- 把差分、缓存、路由硬塞进 `ProjectAudioGraph.js`。
- 通过新增 if 链“暂时修复”而不抽离模块。
- 引入大文件（>300 行）后再说“下个 PR 再拆”。

---

## 10. 最终结论
当前方案已经足够支撑施工，但必须按本计划拆小步执行。关键成功因素：
- 坚守 `<300 行/生产文件`。
- 每步有门禁、可回滚、可量化。
- 先止血性能，再扩展复杂度，最后再做风格丰富化。
