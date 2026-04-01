# Reverb 模块接口契约（类型、前后置条件、错误码）

## 0. 文档定位
本文件定义施工期“模块间协作协议”，用于避免：
- 模块职责漂移。
- 跨模块隐式依赖。
- 重构后行为不一致。

适用范围：`src/host/audio/reverb/**`、`src/host/project/**`、`src/host/ui/reverb/**`、`src/host/transport/**`。

---

## 1. 通用约束

### 1.1 类型与数据约束
- 所有 `config` 数值字段必须是有限数（`Number.isFinite`）。
- 所有 patch 必须是“部分更新”语义，不允许把未提供字段视为 `null` 覆盖。
- 所有 normalize 函数必须是纯函数，不读写全局状态。

### 1.2 错误处理约束
- 模块内部错误必须封装为可诊断错误对象：
  - `code`
  - `message`
  - `context`
- 不允许“吞异常且无日志”。

### 1.3 性能约束
- `applyPatch` 必须是增量路径。
- 非必要不得触发 IR 重建。

---

## 2. 核心领域类型（建议）

```ts
export type ReverbEngineId = 'convolver-legacy' | 'algorithmic-plate' | string

export type ReverbPresetId = string

export type ReverbParamKey =
  | 'decaySec'
  | 'decayCurve'
  | 'preDelaySec'
  | 'lowCutHz'
  | 'highCutHz'
  | 'returnGain'
  | string

export interface ReverbConfig {
  [key: ReverbParamKey]: number
}

export interface TrackReverbState {
  engineId: ReverbEngineId
  presetId: ReverbPresetId
  send: number
  enabled: boolean
  config: ReverbConfig
}

export interface ReverbPatchMeta {
  commit?: boolean
  source?: 'ui-input' | 'ui-commit' | 'preset-change' | 'migration' | 'restore'
  traceId?: string
}

export interface ReverbPatch {
  engineId?: ReverbEngineId
  presetId?: ReverbPresetId
  send?: number
  enabled?: boolean
  config?: Partial<ReverbConfig>
}
```

---

## 3. 错误码约定

| code | 含义 | 常见来源 |
|---|---|---|
| `REVERB_INVALID_PATCH` | patch 字段非法 | Validator |
| `REVERB_ENGINE_NOT_FOUND` | engineId 未注册 | Registry |
| `REVERB_SCHEMA_MISMATCH` | 参数不在 schema 或越界 | Validator/UI |
| `REVERB_ATTACH_FAILED` | 引擎节点图挂接失败 | Engine |
| `REVERB_MIGRATION_FAILED` | 旧状态迁移失败 | Migration |
| `REVERB_STATE_INCONSISTENT` | store/audioGraph 状态不一致 | Controller |

错误对象示例：
```ts
{
  code: 'REVERB_INVALID_PATCH',
  message: 'config.decaySec is out of range',
  context: { trackId, patch, schemaRange }
}
```

---

## 4. 接口契约

## 4.1 `ReverbEngineRegistry`
文件：`src/host/audio/reverb/ReverbEngineRegistry.js`

接口：
```ts
register(engineId: ReverbEngineId, factory: EngineFactory): void
create(engineId: ReverbEngineId, ctx: AudioContext, opts?: object): IReverbEngine
has(engineId: ReverbEngineId): boolean
list(): ReverbEngineId[]
```

前置条件：
- `engineId` 非空。
- `factory` 是函数。

后置条件：
- `create()` 返回实现 `IReverbEngine` 的对象。

失败语义：
- 未注册时抛 `REVERB_ENGINE_NOT_FOUND`。

---

## 4.2 `IReverbEngine`
文件：`src/host/audio/reverb/IReverbEngine.js`

接口：
```ts
interface IReverbEngine {
  readonly engineId: ReverbEngineId
  attach(nodes: { inputNode: AudioNode; outputNode: AudioNode }): boolean
  applyPatch(patch: Partial<ReverbConfig>, meta?: ReverbPatchMeta): boolean
  getParameterSchema(): ReverbParameterDef[]
  dispose(): void
}
```

前置条件：
- `attach` 必须先于 `applyPatch`。

后置条件：
- `dispose` 后再次 `applyPatch` 必须安全返回 `false` 或抛可诊断错误。

---

## 4.3 `ReverbParameterSchema`
文件：`src/host/audio/reverb/ReverbParameterSchema.js`

接口：
```ts
getSchema(engineId: ReverbEngineId): ReverbParameterDef[]
hasParam(engineId: ReverbEngineId, key: string): boolean
```

`ReverbParameterDef` 建议：
```ts
{
  key: string,
  label: string,
  min: number,
  max: number,
  step: number,
  unit?: 'sec' | 'hz' | 'ratio' | 'db' | '%',
  defaultValue: number,
  realtimeSafe: boolean,
  needsImpulseRebuild?: boolean,
  format?: (value:number)=>string,
  parse?: (raw:number)=>number
}
```

约束：
- schema 是唯一参数真源，UI 不得绕过 schema 直接写范围。

---

## 4.4 `ReverbPatchValidator`
文件：`src/host/audio/reverb/ReverbPatchValidator.js`

接口：
```ts
validate(engineId: ReverbEngineId, patch: ReverbPatch): { ok: true, value: ReverbPatch }
validateOrThrow(engineId: ReverbEngineId, patch: ReverbPatch): ReverbPatch
```

语义：
- 自动 clamp 数值到 schema 范围。
- 移除 schema 不识别字段并记录 warning（或按严格模式抛错）。

---

## 4.5 `ReverbConfigDiff`
文件：`src/host/audio/reverb/ReverbConfigDiff.js`

接口：
```ts
diff(prev: ReverbConfig, patch: Partial<ReverbConfig>, schema: ReverbParameterDef[]): {
  next: ReverbConfig,
  changedKeys: string[],
  needsImpulseRebuild: boolean,
  realtimeKeys: string[]
}
```

约束：
- 同值（epsilon 内）不计为 change。
- `needsImpulseRebuild` 由 schema 字段声明，不硬编码在调用方。

---

## 4.6 `ReverbUpdateCoalescer`
文件：`src/host/audio/reverb/ReverbUpdateCoalescer.js`

接口：
```ts
enqueue(trackId: string, patch: ReverbPatch, meta?: ReverbPatchMeta): void
flush(trackId?: string): void
setFrameBudget(ms: number): void
```

语义：
- 仅对 `commit:false` 合并。
- `commit:true` 必须立即 flush。

并发约束：
- 同一 `trackId` 的 patch 合并遵循最后写入优先（LWW）。

---

## 4.7 `TrackFxDispatchRouter`
文件：`src/host/transport/TrackFxDispatchRouter.js`

接口：
```ts
dispatchTrackReverbPatch(trackId: string, patch: ReverbPatch, meta?: ReverbPatchMeta): boolean
```

语义：
- 仅分发给“拥有该 track 实际播放权”的 scheduler。
- source 切换后强制刷新路由缓存。

---

## 4.8 `trackReverbState`
文件：`src/host/project/trackReverbState.js`

接口：
```ts
normalizeTrackReverbState(raw: any, defaults?: Partial<TrackReverbState>): TrackReverbState
mergeTrackReverbState(current: TrackReverbState, patch: ReverbPatch): TrackReverbState
```

语义：
- 所有持久化前必须 normalize。
- merge 必须保证不可变更新（返回新对象）。

---

## 4.9 `reverbStateMigration`
文件：`src/host/project/migrations/reverbStateMigration.js`

接口：
```ts
migrateProjectReverbState(project: any): { project: any, changed: boolean, warnings: string[] }
```

语义：
- 输入旧项目结构，输出新结构。
- 不应直接修改入参（除非明确声明可变策略）。

---

## 5. 模块协作序列（规范）

### 5.1 参数输入序列
1. UI 生成 patch。
2. Controller 调用 Validator。
3. state 层 merge 并写入 store。
4. router 定向派发。
5. engine applyPatch。
6. metrics 记录。

### 5.2 preset 切换序列
1. controller 获取 preset（含 engineId + config）。
2. 若 engine 变化，先切 engine 后 apply config。
3. 更新 store（保证 UI 回显一致）。

### 5.3 engine 切换序列
1. detach 旧 engine。
2. attach 新 engine。
3. 使用 schema 默认值 + preset 覆盖值构建 config。
4. applyPatch(commit:true)。

---

## 6. 一致性不变量（必须长期成立）
- Invariant I1：`store.track.reverb.engineId` 与 `activeEngine.engineId` 一致。
- Invariant I2：`enabled=false` 不应丢失 send/config。
- Invariant I3：`commit:true` 后 UI、store、audioGraph 最终一致。
- Invariant I4：schema 不识别字段不可进入 engine 层。
- Invariant I5：source 切换后 reverb patch 不丢失。

---

## 7. 回归测试最小集合（按契约）
- T1：Validator clamp 与 strict 模式。
- T2：Diff epsilon 行为。
- T3：Coalescer LWW + commit flush。
- T4：Router 定向分发正确性。
- T5：Migration 旧数据兼容。
- T6：Engine 切换后参数一致性。

---

## 8. 审查清单（Code Review）
- 是否新增隐式耦合（例如 UI 直接访问 engine internals）。
- 是否违反不可变状态策略。
- 是否出现未定义错误码。
- 是否有任何生产文件超过 300 行。
- 是否有函数超过 60 行且无拆分理由。

---

## 9. 常见违规示例（避免）
- 在 `ReverbDockView` 中直接做 audioGraph 调用。
- 在 `ProjectAudioGraph` 中同时做 schema 验证和 preset 选择。
- 在 migration 里直接调用 UI 代码。
- 在 engine 里读取 store。

---

## 10. 结语
接口契约的作用是把“可维护性”前置，不让复杂度后期爆炸。施工期间如要改契约，必须同步更新：
- 本文档。
- 对应测试。
- 调用方适配说明。
