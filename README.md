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

Plugin 是 Sydaris 的业务扩展单元。

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

注册后的 View 使用 Sydaris 提供的持久化、读取、权限、Proposal、并发控制、Events、Generic Inspector 与 AI Tools。

Presentation、Skill 和 Tool Provider 通过独立 Extension 提供。

### Plugin 安装

Plugin 使用静态注册和正常的 Next.js 编译，不在运行中的服务内执行刚下载的远程代码。
根目录的 `sydaris.plugins.json` 是已安装清单；`src/generated/installed-plugins.ts` 和
`src/generated/installed-presentations.tsx` 由 CLI 生成，不能手工修改。

每个 Plugin 需要提供 `sydaris.plugin.json`，其中声明服务端 Manifest export、所拥有的
View keys，以及可选的专属 React Presentation。CLI 支持仓库内目录、本地 `.tgz` 和 npm
包名；npm 安装会禁用包的 install scripts。安装后重新启动 Sydaris 即可生效：

```bash
pnpm sydaris:plugin install src/plugins/activity-operations
pnpm sydaris:plugin install ./my-sydaris-plugin-1.0.0.tgz
pnpm sydaris:plugin install @your-scope/my-sydaris-plugin@1.0.0
pnpm sydaris:plugin list
pnpm sydaris:plugin generate --check
```

删除是不可恢复操作，必须显式使用 `--purge`。CLI 会先在一个数据库事务中删除该 Plugin
所有 View 的 Cards、Dimensions、Slots、Proposal、Execution、Event、Higher Memory 和
Installed View 状态，成功后才从安装清单移除 Plugin：

```bash
pnpm sydaris:plugin remove sydaris.activity-operations --purge
```

当前版本只面向可信包，不提供代码沙箱、签名校验、升级、迁移或回滚。在线安装实际是
`pnpm add` 下载到 `node_modules`，随后读取包内描述文件并生成静态 Registry；专属 UI 因此
可以使用普通 React/TypeScript，在 Sydaris 下次启动或构建时一起编译。

### 开发与发布 Plugin

`packages/plugin-sdk` 提供可发布 Plugin 使用的公共合同、`sydaris.plugin.json`
描述文件 Schema 和 React hooks；
`packages/example-plugin` 是包含 View、Command、Skill、专属 UI 和全局只读 Tool Provider
的最小完整示例。现有的 `src/plugins/society-information` 也已经是可发布 workspace 包，
它的 tarball 包含真实 Card Schema、Commands、Events、沉浸式 UI、CSS 和全部图片资源：

```bash
pnpm plugins:build
pnpm plugins:pack:sdk
pnpm --filter @sydaris/example-plugin pack
mkdir -p artifacts
pnpm plugins:pack:society --pack-destination ./artifacts
```

`@sydaris/society-information-plugin` 通过 `@sydaris/plugin-sdk` peer dependency 使用宿主合同，
不包含 Sydaris 数据库实现或 `@/` 内部路径。

发布到 npm 时先发布 SDK，再发布 Plugin。当前 SDK 为 alpha 预发布版，
`publishConfig` 会默认发到 `next` tag：

```bash
pnpm --filter @sydaris/plugin-sdk publish
pnpm --filter @sydaris/example-plugin publish --tag next --access public
```

每个 Plugin 必须通过 `engines.sydaris` 声明兼容的 Sydaris 版本，不匹配时 CLI 会拒绝安装。
实际发布需要 `@sydaris` npm scope 权限；本仓库不会保存发布凭据。
当前可发布的 SDK 与 Plugin 包使用 Apache-2.0 许可证。

可复用 Tool Provider 应独立成 Plugin；只读 Provider 会注册成所有 AI 聊天均可使用的全局
Tool，具有外部副作用的 Tool 在增加人工审批 UI 前不会暴露给模型。

## Tool Capabilities

外部工具通过 Capability Contract 接入 Sydaris。

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

`sydaris.society-information`
组织身份、人物、学年职位、长期活动与平台入口。

`sydaris.activity-operations`
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

ENVIRONMENT_TIMEZONE=Asia/Shanghai
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
