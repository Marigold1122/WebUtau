# Reverb 文档索引（施工版）

## 主文档
- 性能与 Debug：`docs/reverb/reverb-performance-debug-architecture.md`
- 能力升级路线：`docs/reverb/reverb-capability-architecture-roadmap.md`

## 施工附件
- PR 分解计划：`docs/reverb/reverb-construction-pr-plan.md`
- 接口契约：`docs/reverb/reverb-interface-contracts.md`
- 迁移/测试/灰度手册：`docs/reverb/reverb-migration-test-rollout-runbook.md`

## 推荐阅读顺序
1. 先读性能主文档（确认现状根因与止血方案）。
2. 再读能力主文档（确认中长期目标架构）。
3. 再读 PR 计划（决定执行顺序与分工）。
4. 再读接口契约（统一实现边界）。
5. 最后读 runbook（确保可迁移、可发布、可回滚）。

## 关键约束总览
- 生产代码文件必须 `<300` 行。
- 禁止上帝函数与跨层混写。
- 每个阶段都必须有可量化验收指标。
- 任何上线步骤都必须保留回滚开关。
