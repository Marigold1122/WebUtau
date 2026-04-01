# Reverb 迁移、测试与灰度运行手册（Runbook）

## 0. 文档定位
本文件用于确保重构与能力升级可以“安全落地”：
- 迁移不丢数据。
- 测试覆盖关键场景。
- 灰度可监控、可回退。

适用阶段：PR-08 之后（进入新状态结构与多引擎阶段）。

---

## 1. 迁移策略

### 1.1 迁移目标
从旧结构：
- `track.playbackState.reverbSend`
- `track.playbackState.reverbPresetId`
- `track.playbackState.reverbConfig`

迁移到新结构：
- `track.playbackState.reverb = { engineId, presetId, send, enabled, config }`

### 1.2 迁移原则
- M-1：不覆盖用户已有有效参数。
- M-2：旧字段可保留一个过渡版本窗口（兼容读取，不再作为主写入）。
- M-3：迁移失败可回退到 legacy 路径。

### 1.3 版本化建议
在项目根状态中增加：
- `project.schemaVersion = 'reverb-v2'`

迁移触发：
- 若 `schemaVersion < reverb-v2` 则执行迁移。

### 1.4 迁移伪流程
1. 读取项目。
2. 检查 schemaVersion。
3. 对每个 track 执行 `migrateTrackReverbState(track)`。
4. 对 `mixState` 执行默认模板迁移。
5. 写回新结构并记录 warnings。
6. 更新 schemaVersion。

---

## 2. 迁移边界条件

### 2.1 空字段
- `reverbSend` 缺失 -> 默认 `0`。
- `reverbPresetId` 缺失 -> 默认 `vocal-default`（或 catalog fallback）。
- `reverbConfig` 缺失 -> 按 preset 默认 config。

### 2.2 非法值
- 任何非数值参数 -> 走 normalize + clamp。
- 参数越界 -> clamp 并写 warning。

### 2.3 preset 不存在
- fallback 到同 engine 默认 preset。
- 若 engine 也不存在 -> fallback `convolver-legacy`。

### 2.4 enabled 推断
- 若 `returnGain <= 0.0001` 可推断 `enabled=false`。
- 否则 `enabled=true`。

---

## 3. 迁移验证清单

每个项目迁移后必须验证：
1. track 数量不变。
2. 每轨 `send` 与旧值一致（epsilon 内）。
3. 每轨关键 config（decay/preDelay/highCut/return）一致。
4. 迁移前后播放可正常启动。
5. 保存并重开后状态一致。

推荐输出对比摘要：
- `migratedTrackCount`
- `warningCount`
- `fallbackPresetCount`
- `clampedValueCount`

---

## 4. 测试矩阵（功能）

## 4.1 基础功能矩阵

| 场景 | 输入 | 期望 |
|---|---|---|
| F1 | 拖 send | 听感湿度变化，无 IR 重建 |
| F2 | 拖 preDelay | 前后感变化，无 IR 重建 |
| F3 | 拖 decay | 尾音长度变化，IR 重建受控 |
| F4 | 切 preset | 参数与听感同步更新 |
| F5 | 切 engine | UI schema 切换正确，音频不断流 |
| F6 | enabled 开关 | 状态切换正确，不丢 send/config |
| F7 | source 切换 | reverb 状态保留且继续生效 |

## 4.2 兼容矩阵

| 场景 | 输入项目 | 期望 |
|---|---|---|
| C1 | 纯旧结构项目 | 自动迁移成功 |
| C2 | 部分字段缺失项目 | fallback 正常 |
| C3 | 非法数值项目 | clamp + warning |
| C4 | preset 丢失项目 | fallback preset |
| C5 | 大项目（多轨） | 迁移耗时可接受 |

## 4.3 回归矩阵

| 场景 | 关注点 | 期望 |
|---|---|---|
| R1 | 播放控制 | play/pause/seek 正常 |
| R2 | 导入导出 | 项目保存与恢复一致 |
| R3 | 编辑器模式切换 | 不影响 reverb 状态 |
| R4 | 音频轨/人声轨 | 路由正确 |
| R5 | 多轨同时播放 | 无异常爆音/掉音 |

---

## 5. 测试矩阵（性能）

## 5.1 指标定义
- `IRRebuildCount`：IR 重建次数。
- `IRBuildCostTotalMs`：IR 构建累计耗时。
- `InputEventCostP95Ms`：输入事件 p95 耗时。
- `INP_P95`：交互延迟指标。
- `LongTaskCount`：>50ms 任务数量。

## 5.2 基准场景
- P1：播放中拖 send 15 秒。
- P2：播放中拖 preDelay 15 秒。
- P3：播放中拖 decay 15 秒。
- P4：连续切换 preset 30 次。
- P5：切换 engine 20 次。

## 5.3 通过阈值建议
- P1/P2：`IRRebuildCount == 0`。
- P3：`IRRebuildCount` 相比基线下降 >= 60%。
- `INP_P95` 不高于基线（建议下降 >= 20%）。
- `LongTaskCount` 明显下降。

---

## 6. 灰度发布方案

### 6.1 Feature Flag 设计
建议 flags：
- `reverb_v2_engine_registry`
- `reverb_v2_schema_ui`
- `reverb_v2_state_migration`
- `reverb_v2_plate_engine`

策略：
- 先开 registry + diff + coalescer（低风险）。
- 再开 schema UI。
- 再开 state migration。
- 最后开第二引擎。

### 6.2 灰度比例建议
- G0：开发环境 100%。
- G1：内部测试 10%。
- G2：灰度用户 25%。
- G3：灰度用户 50%。
- G4：全量 100%。

每个阶段至少观察 24h（或固定样本周期）。

### 6.3 观测面板建议
关键图表：
- IR 重建次数趋势。
- INP p95 趋势。
- REVERB_* 错误码趋势。
- migration warning 计数。
- reverb enabled 使用率、preset 使用分布。

---

## 7. 回滚策略

### 7.1 快速回滚
触发条件（任一满足）：
- INP p95 劣化 > 25%。
- 新错误码激增（如 `REVERB_STATE_INCONSISTENT`）。
- 播放稳定性异常（崩溃、明显爆音）。

回滚动作：
1. 关闭 `reverb_v2_*` flags。
2. 保留数据但走 legacy 播放路径。
3. 记录故障窗口与用户样本。

### 7.2 数据回退
- 不删除新字段。
- 读取逻辑优先旧字段（临时），写入可双写一段时间。
- 故障修复后再恢复新路径优先。

---

## 8. Incident 处理手册

### 8.1 常见事故 A：切换引擎后无声
排查步骤：
1. 检查 `engineId` 是否已注册。
2. 检查 `attach()` 是否返回 true。
3. 检查 input/output node 是否连通。
4. 检查 `enabled` 和 `returnGain`。
5. 回放 probe 日志看 patch 是否进入 engine。

### 8.2 常见事故 B：参数回显正确但听感不变
排查步骤：
1. 检查 Validator 是否 clamp 到边界。
2. 检查 Diff 是否错误判定为“无变化”。
3. 检查 Coalescer 是否未 flush。
4. 检查实际命中 track 是否正确（router）。

### 8.3 常见事故 C：迁移后 preset 丢失
排查步骤：
1. 检查 catalog 是否包含 presetId。
2. 检查 fallback 逻辑。
3. 检查 schemaVersion 与迁移执行顺序。

---

## 9. 发布前清单（Release Checklist）

- [ ] 所有新增生产文件 `<300` 行。
- [ ] 关键函数无超长（>60 行）未拆分情况。
- [ ] 迁移单测通过。
- [ ] 功能矩阵通过（F1~F7）。
- [ ] 兼容矩阵通过（C1~C5）。
- [ ] 性能矩阵达标（P1~P5）。
- [ ] Feature flag 可独立开关。
- [ ] 回滚路径演练完成。

---

## 10. 发布后 72 小时观察清单

### 10.1 每日固定巡检
- 第 1 天：每 4 小时看一次关键指标。
- 第 2 天：每 8 小时巡检。
- 第 3 天：每日 2 次巡检。

### 10.2 必看指标
- INP p95
- Long task count
- REVERB_* 错误码
- migration warning
- 用户反馈关键词（卡顿、无声、爆音、参数无效）

### 10.3 结束条件
- 72h 内指标稳定且无高优先级事故。
- 可以进入“全量 + 文档收口”。

---

## 11. 结论
这份 runbook 的价值是把“复杂重构”变成“可控工程”：
- 可迁移。
- 可观测。
- 可回滚。
- 可持续迭代。

与前两份文档配合后，已经具备从架构设计到工程落地的完整闭环。
