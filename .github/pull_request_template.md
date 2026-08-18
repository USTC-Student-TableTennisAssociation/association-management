## 目标

这个 PR 解决什么问题？为什么需要现在做？

关联 Issue / 任务：

## 改动

- （请填写）
- （请填写）

## 架构影响

请选择所有适用项，并在下方说明。

- [ ] Cognitive Runtime（Object / Assertion / Evidence / Higher Memory）
- [ ] Runtime Contract 或 Extension Registry
- [ ] View Schema / Card Type / Typed Dimension / Slot
- [ ] Domain Command / Invariant / Event / Proposal
- [ ] Presentation / Generic Inspector
- [ ] Skill / Agent Runtime
- [ ] Tool Capability Contract / Tool Provider
- [ ] Auth / Permission
- [ ] Prisma Schema / Database
- [ ] API / Deployment / Environment
- [ ] 无架构影响

说明：

## Runtime 边界检查

- [ ] Generic Inspector 仍然只读
- [ ] 所有 View 写入仍然通过 Domain Command
- [ ] 没有引入跨 View Slot
- [ ] Related Objects 仍然只表达 Card → Object 关联
- [ ] View Module 没有导入 Prisma、Shell 或 Runtime 实现
- [ ] Skill 依赖 Capability Contract，而不是具体 Tool Provider
- [ ] 不适用，原因：

## 数据库与权限

说明 Prisma Schema、migration、State Version、权限或外部副作用的影响。没有则填“无”。

## 验证

- [ ] `pnpm lint`
- [ ] `pnpm test`
- [ ] `pnpm exec tsc --noEmit`
- [ ] `pnpm prisma validate`
- [ ] `pnpm build`
- [ ] 已手工验证相关 UI / API / AI 链路
- [ ] 仅文档改动

具体结果：

## 截图或运行记录

有 UI、模型行为或运行链路变化时提供。

## 未完成事项

列出本 PR 中不包含、没有验证或需要后续处理的内容。

## 提交前确认

- [ ] 没有提交 `.env`、密钥、真实私密数据或数据库连接信息
- [ ] 没有提交 `.next/`、`node_modules/` 等本地产物
- [ ] 改动范围与 PR 目标一致
- [ ] 文档与代码保持同步
