# 贡献指南

感谢你帮助完善 Echo。本项目希望同时保持两件事：业务表达可以继续生长，Runtime 的基础边界依然简单。

请先阅读 [README](README.md) 和 [Echo Runtime 架构](docs/architecture/Echo-Runtime架构.md)。

## 开发流程

1. 从最新的 `main` 创建一个单一目的的工作分支。
2. 在尽可能小的模块边界内完成改动。
3. 为新的合同、命令、校验规则和回归问题添加测试。
4. 运行与改动风险匹配的检查。
5. 在 PR 中说明业务影响、架构边界、数据库影响和验证结果。

建议的分支名：

```text
feat/view-activity-calendar
fix/command-state-conflict
refactor/tool-runtime
docs/runtime-contracts
```

## 必须保持的架构边界

### Contracts

`src/contracts/` 只描述 Echo Runtime 的稳定协议。

- 不能包含 `activity_operations`、`society_information` 或具体 Card Type 判断。
- 不能导入 Plugin、Shell、Prisma 或 Next.js。
- 新增合同前先确认它是否真的需要被所有 View 共享。

### View Module

View Module 的本体是 Card Schema 与业务运行规则。

- View Module 可以定义 Card Types、Typed Dimensions、View-local Slots、Related Object Policy、Commands、Invariants 和 Events。
- View Module 不得导入 Prisma、`src/db`、Next Route、`view-runtime` 实现或其他 Plugin 实现。
- Command Handler 只能通过 `ViewTransaction` 读写自己的 Card Graph。
- 不得为一个 View 创建私有的 Card API 或绕过统一 Command Bus。
- 不得创建跨 View Slot。跨 View 协作使用 `ViewReadPort` 阅读，需要写入时分别调用各 View 的 Command。

### Dimensions、Slots 与 Related Objects

- 结构化业务值使用 Typed Dimension。
- Card → Card 的业务关系使用 Slot。
- Card → 稳定认知 Object 的关联使用 Related Objects。
- 事实、依据和时间背景留在 Assertion / Evidence 体系中。
- Related Objects 不增加 role、relation type 或 Assertion support。

### Presentation

- Generic Inspector 始终只读。
- 专属 Presentation 可以提供业务操作 UI，但只能调用 Domain Command。
- Presentation 不得直接写数据库、Card Graph 或构造 Raw Graph Mutation。
- Presentation 通过目标 `ViewManifest.version` 表达它所面向的 View Module 合同。

### Skill 与 AI

- Skill 通过 `ViewReadPort` 读取快照，通过 Command Bus 改变状态。
- AI 在写入前必须读取 View 并提供 `expectedStateVersion`。
- AI 和 Skill 必须遵守 Installed View 的 `aiWritePolicy`。
- Skill 依赖 Tool Capability Contract，不依赖 Gmail、Outlook 等具体 Provider。

### Tool Provider

- Capability Contract 由 Echo 定义 key、version、input/output schema、语义和权限。
- Provider 只提供 `execute` 实现，不得重新声明同名 Contract Schema。
- Tool Provider 不得直接修改 View State。Tool 结果需要进入业务状态时，应再调用 Domain Command。

### Composition Root

`src/shell/` 是唯一可以同时看到具体 Plugin 和 Runtime 实现的地方。Core 不能反向导入 Shell。

## 新增 View Module

1. 在 `src/plugins/<plugin-id>/view/` 定义 Schema、Commands 和 Events。
2. 为 Card Type 选择稳定 key，并明确每个 Dimension、Slot 与 Related Object Policy。
3. 只暴露业务语义的 Domain Commands，不暴露 `createCard` / `setSlot` 等原语。
4. 通过 `EchoPluginManifest` 贡献 View。
5. 为 Plugin 添加 `echo.plugin.json`，运行 `pnpm echo:plugin install <目录>` 生成静态注册表。
6. 添加 Registry、Command、Invariant 和架构边界测试。

View Core 必须能在没有专属 Presentation 和 Skill 的情况下通过 Generic Inspector 与 Command API 独立运行。

## 可发布 Plugin

仓库外 Plugin 应依赖 `@echo/plugin-sdk`，并在 npm 包中包含编译后的 `dist/`、
`echo.plugin.json` 和 `package.json#echoPlugin`。不要让 Echo 安装时再编译源码；React 专属 UI
和服务端 Manifest 都应在 `prepack` 前构建完成。

`packages/example-plugin` 是可复制的最小完整示例。发布前应改用自己拥有的 npm scope，
先发布 SDK，再发布 Plugin，并用 tarball 做一次不依赖 registry 的发布前测试：

```bash
pnpm plugins:build
pnpm --filter @echo/example-plugin pack
pnpm echo:plugin install ./echo-example-plugin-0.1.0.tgz
pnpm build
pnpm echo:plugin remove echo.example-notes --purge
```

第一版只接受可信 Plugin，不支持升级、迁移和回滚；修改已发布行为时使用新的包版本。

## 数据库改动

- `prisma/schema.prisma` 是当前持久化结构的唯一模型来源。
- Schema 改动必须附带 Prisma migration，并运行 `pnpm prisma validate` 与 `pnpm prisma:generate`。
- Card Graph 的通用约束应由 Runtime 和数据库共同保护；具体业务约束应放在 View Schema、Command 或 Invariant。
- 不在具体 Plugin 中直接使用 Prisma。
- PR 必须说明数据库结构影响以及实际执行过的验证。

## 本地命令

```bash
pnpm install
cp .env.example .env
pnpm prisma:dev
pnpm prisma:deploy
pnpm prisma:generate
pnpm dev
```

提交前的完整检查：

```bash
pnpm lint
pnpm test
pnpm exec tsc --noEmit
pnpm prisma validate
pnpm build
```

纯文档改动可以不运行应用构建，但要检查链接、命令、路径和文档中描述的能力是否存在。

## 安全与数据

不要提交：

- `.env`、API Key、密码、Token 或数据库连接信息；
- 未脱敏的成员信息、组织内部材料、财务记录或私人对话；
- `.next/`、`node_modules/`、`.echo-debug/`、`.echo-library/` 等本地产物；
- 与当前 PR 无关的批量格式化或生成文件。

## PR 要求

PR 需要清楚回答：

- 改了什么，为什么；
- 影响哪些 Contracts、View、Commands、API 或认知链路；
- 是否改变 Prisma Schema、权限或外部副作用；
- 运行了哪些自动检查和人工验证；
- 还有哪些未完成或无法验证的部分。
