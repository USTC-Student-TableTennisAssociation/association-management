# Echo

> **Echo is a runtime for software where humans and AI work together.**
> **Organizational state and knowledge persist across people, agents, and time.**

Echo 是面向人类与 AI 协同工作的软件 Runtime。

组织的业务状态与长期认知独立于具体成员、Agent 和会话持续存在。

> Echo is under active development.

## Architecture

```text
┌───────────────────────────────────────────────┐
│ Cognitive Runtime                             │
│                                               │
│ Object · Assertion · Evidence · Higher Memory │
│ Retrieval                                     │
└──────────────────────┬────────────────────────┘
                       │ context
                       ▼
┌───────────────────────────────────────────────┐
│ View Runtime                                  │
│                                               │
│ Card Graph · Commands · Invariants            │
│ Proposal · State Version · Events             │
└──────────────────────┬────────────────────────┘
                       │ runtime contracts
                       ▼
┌───────────────────────────────────────────────┐
│ Extensions                                    │
│                                               │
│ View · Presentation · Skill · Tool Provider   │
└───────────────────────────────────────────────┘
```

### Cognitive Runtime

Cognitive Runtime 保存组织长期认知：

* `Evidence`：原始来源与可追溯内容
* `Object`：人、组织、活动、场地等稳定对象
* `Assertion`：带来源与时间背景的事实
* `Higher Memory`：面向 AI 的高层认知入口

这些认知为 AI 理解当前业务提供长期上下文。

### View Runtime

View 定义一个业务领域的状态与操作：

* Card Types 与 Typed Dimensions
* Slots 与 Related Objects
* Domain Commands
* Business Invariants
* Domain Events

View Runtime 提供持久化、读取、Schema 校验、权限、Proposal、并发控制与 Events。

所有业务写入通过 Domain Command 执行。

```text
Human ──────────────┐
AI ─────────────────┤
Skill ──────────────┼──► Domain Command ──► View State
Presentation ───────┤                         │
API / External ─────┘                         ▼
                                             Events
```

人、AI、Skill、Presentation 和外部系统使用相同的 Runtime Contracts。

AI 写入由 View 的策略控制：

```text
approval_required → Proposal → Approval → Execute
auto_execute      → Execute
```

`stateVersion` 提供并发控制。Domain Events 描述命令产生的业务结果。

## Plugins

Plugin 是 Echo 的业务扩展单元。

| Extension               | 定义                              |
| ----------------------- | ------------------------------- |
| `ViewModule`            | 业务状态、Commands、Invariants、Events |
| `PresentationExtension` | 专属 UI 与交互                       |
| `SkillExtension`        | AI 的业务处理能力                      |
| `ToolProviderExtension` | 外部 Capability 的实现               |

一个最小 Plugin 只包含 View：

```text
src/plugins/project-operations/
├── manifest.ts
└── view/
    ├── schema.ts
    ├── commands.ts
    └── events.ts
```

例如：

```text
Project
├── name
├── status
├── owner
├── tasks
└── budget

Commands
├── project.create
├── task.assign
├── budget.approve
└── project.close
```

注册后的 View 使用 Echo 提供的持久化、读取、权限、Proposal、并发控制、Events、Generic Inspector 与 AI Tools。

Presentation、Skill 和 Tool Provider 通过独立 Extension 提供。

## Tool Capabilities

外部工具通过 Capability Contract 接入 Echo。

```text
Skill
  │
  ▼
Capability Contract
  │
  ├── Gmail Provider
  ├── Outlook Provider
  └── ...
```

Capability Contract 定义 capability key、version、input schema、output schema 与执行语义。

Skill 声明 Capability 依赖。Tool Provider 实现对应的 Capability Contract。Runtime 负责 Provider 解析、Schema 校验与权限检查。

## Built-in Plugins

`echo.society-information`
组织身份、人物、学年职位、长期活动与平台入口。

`echo.activity-operations`
Activity 的任务、分工、预算、采购、报销、材料、审批、结果与复盘。

## Repository

```text
src/
├── contracts/        Runtime Contracts
├── runtime/          Extension Host / Tool Runtime
├── view-runtime/     View Runtime
├── agent-runtime/    AI Runtime
├── plugins/          First-party Plugins
├── shell/            Composition Root
├── memory/           Cognitive Runtime
├── library/          Evidence / Knowledge
├── app/              Next.js Application
└── auth/             Identity / Session

prisma/               Database Schema

services/
├── cold-start/       Cognitive cold start / BGE-M3
└── mineru-parser/    Document parsing
```

## Development

Requirements:

* Node.js 20+
* pnpm
* PostgreSQL
* Python 3.11 / 3.12 与 `uv`（认知服务）

```bash
pnpm install
cp .env.example .env

pnpm prisma:dev
pnpm prisma:deploy
pnpm prisma:generate

pnpm dev
```

```env
DATABASE_URL=postgresql://postgres:postgres@localhost:51214/template1
SHADOW_DATABASE_URL=postgresql://postgres:postgres@localhost:51215/template1

AI_API_KEY=
AI_API_BASE_URL=https://api.openai.com/v1
AI_MODEL=

ORGANIZATION_TIMEZONE=Asia/Shanghai
```

首次运行通过 `/setup` 创建管理员。

## Validation

```bash
pnpm lint
pnpm test
pnpm exec tsc --noEmit
pnpm prisma validate
pnpm build
```

