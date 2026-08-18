# Echo

Echo 是一个面向组织持续运行的 AI-native Business Runtime。

它把长期认知与可操作的业务状态分开：Object、Assertion 和 Evidence 负责表达“这个组织知道什么”，View 负责表达“这个业务正如何运行”。AI、人类 UI、Skill 和 API 通过同一套 Domain Command 读写正式业务状态。

> 项目正在活跃开发。仓库内的代码、Prisma Schema 和本 README 共同描述当前架构。

## 核心模型

```text
Evidence
   │  原始依据
   ▼
Object ── Assertion
   │          │
   └─ Higher Memory ──快速进入稳定对象与近期事项

Object / Assertion / Higher Memory
              │
              ▼
        View Runtime
   Card Graph + Domain Commands
              │
      ┌────────┼────────┐
      ▼        ▼        ▼
 Presentation  Skill / AI  Command API
```

### Cognitive Runtime

Cognitive Runtime 管理组织认知：

- `Evidence`：原始文件、对话原话和可追溯摘录。
- `Object`：稳定的人、组织、活动、场地或其他认知对象。
- `Assertion`：带有来源和时间背景的事实性叙述。
- `Higher Memory`：帮助 AI 快速定向的高层认知，不代替精确业务状态。
- Retrieval 与 Object Resolution：负责查找、追踪和校正组织认知。

### View Runtime

View 是可操作的业务运行视角。每个 View Module 声明：

- Card Types；
- Typed Dimensions；
- View-local Slots；
- Related Object Policy；
- Domain Commands；
- Invariants；
- Domain Events。

View 不拥有私有的基础 API。所有 View 共享统一的 Card Graph、`ViewReadPort`、Command Bus、Proposal 和 Event Runtime，差异只存在于各自声明的业务 Schema 与 Commands。

Card 与认知底座的连接只使用 Related Objects。Card 之间的业务关系由 Slot 表达，事实语义由 Assertion 表达。

### Extension Host

Echo 把物理分发单元称为 Plugin，把可独立注册和启停的能力称为 Extension。一个 Plugin 可以贡献：

- `ViewModule`：业务 Card Schema 与运行规则；
- `PresentationExtension`：针对某个 View 的专属 UI；
- `SkillExtension`：针对某个 View 的 AI 工作方式；
- `ToolProviderExtension`：对 Echo Tool Capability Contract 的具体实现。

View Core 可以在没有专属 Presentation、Skill 或 Tool Provider 的情况下独立运行。当前 Extension Host 使用进程内静态注册，由 Shell 作为 Composition Root。

## 强制边界

- Generic View/Card Inspector 完全只读。
- 正式 View State 只能经由 Domain Command 改变。
- AI 不能调用原始 Card、Dimension 或 Slot mutation。
- Slot 只能连接同一 View 内的 Card；Runtime 与数据库都会校验。
- A View 可以通过 `ViewReadPort` 阅读 B View，但不会形成跨 View Slot。
- Related Object 只保存 Card 与 Object 的关联，不定义 role 或 relation type。
- View Module 不依赖 Prisma、Next Route、Shell 或其他 View 实现。
- UI、AI、Skill 和 API 共享同一 Command Bus 与 State Version 并发控制。
- AI 写入策略属于 Installed View，当前支持 `approval_required` 和 `auto_execute`。

## Tool Capability

Tool Capability Contract 由 Echo 定义，包含稳定的 key、version、input schema、output schema 和语义合同。Gmail、Outlook 或其他 Provider 只声明实现某个 Contract 并提供 `execute`。

Skill 依赖 Capability Contract，不依赖 Provider 品牌或 Provider 自定义的同名 Schema。Tool Runtime 在执行前后统一校验输入、输出、权限和 dry-run 能力。

## 内置 View

### `society_information`

表达社团身份、人物、学年职位、长期活动与平台入口。当前 Domain Commands：

- `society.ensure_person`
- `society.create_society`
- `society.update_profile`

### `activity_operations`

表达真实 Activity 的运行，包括活动、工作包、任务、分工、预算、采购、报销、材料、审批、结果与复盘等 Card Type。当前 Domain Commands：

- `activity.create_activity`
- `activity.update_activity`
- `activity.add_work_package`
- `activity.add_task`
- `activity.assign_owner`

`AssignmentCard` 通过 Related Object 关联稳定人物 Object，再通过本 View 内 Slot 连接 Activity 或 Work Package。

## 界面与 API

Generic Inspector 用于查看：

- Card 与 Card Type；
- Typed Dimensions；
- Slots；
- Related Objects；
- View Schema；
- Module Version、Schema Version 与 State Version。

统一 View API：

```text
GET   /api/views
GET   /api/views/:viewKey
POST  /api/views/:viewKey/commands/:commandKey
PATCH /api/views/:viewKey/settings
PATCH /api/view-proposals/:proposalId
```

Chat Agent 使用 `readView` 读取快照，使用 `runViewCommand` 运行领域命令。AI 在调用 Command 前必须先读取 View，并带上已观测的 `stateVersion`。

## 仓库结构

```text
src/
├── contracts/        稳定 Runtime 合同
├── runtime/          Extension Host 与 Tool Runtime
├── view-runtime/     Card Graph、Read Port、Command Bus、Inspector
├── agent-runtime/    AI 的 View 定向、读取与 Command 工具
├── plugins/          第一方 Plugin 与 View Module
├── shell/            Composition Root
├── memory/           Object、Assertion、Retrieval、Higher Memory
├── library/          资料库与认知发布
├── app/              Next.js Shell、页面与 API
└── auth/             账号、Session 与 Actor
prisma/               Schema、数据库变更与认知导入脚本
services/
├── cold-start/       PDF 认知编译与 BGE-M3 服务
└── mineru-parser/    MinerU 独立解析基准
docs/                 当前架构与开发规则
```

## 本地开发

### 要求

- Node.js 20+
- pnpm
- PostgreSQL，或使用仓库内置的 Prisma 开发数据库命令
- Python 3.11 或 3.12 与 `uv`（只在运行冷启动服务时需要）

### 启动

```bash
pnpm install
cp .env.example .env
pnpm prisma:dev
pnpm prisma:deploy
pnpm prisma:generate
pnpm dev
```

`.env` 至少需要：

```env
DATABASE_URL=postgresql://postgres:postgres@localhost:51214/template1
SHADOW_DATABASE_URL=postgresql://postgres:postgres@localhost:51215/template1
AI_API_KEY=
AI_API_BASE_URL=https://api.openai.com/v1
AI_MODEL=
ORGANIZATION_TIMEZONE=Asia/Shanghai
```

首次打开应用时使用 `/setup` 建立管理员。账号会绑定 `MemoryActor` 和已识别的 Person Object，因此正式组织环境应先完成一次 Cognitive Compilation。

## 认知检索

Object–Assertion 检索使用本地 BGE-M3 派生索引。完成 Cognitive Compilation 并导入数据库后：

```bash
pnpm memory:serve-embeddings
# 在另一个终端建立 Assertion 索引
pnpm memory:index-assertions
pnpm dev
```

冷启动细节见 [services/cold-start/README.md](services/cold-start/README.md)；MinerU 独立解析基准见 [services/mineru-parser/README.md](services/mineru-parser/README.md)。

## 质量检查

提交前运行：

```bash
pnpm lint
pnpm test
pnpm exec tsc --noEmit
pnpm prisma validate
pnpm build
```

Runtime 边界由 `src/runtime/architecture-boundaries.test.ts` 回归检查，包括 Core 不导入具体 Plugin、View Module 不导入 Prisma/Runtime 实现、Generic Inspector 只读，以及 Related Objects 保持极简结构。

## 文档

- [Echo Runtime 架构](docs/architecture/Echo-Runtime架构.md)
- [认知与 Higher Memory](docs/architecture/认知与Higher-Memory.md)
- [资料库与认知编译](docs/architecture/资料库与认知编译.md)
- [贡献指南](CONTRIBUTING.md)

## 技术栈

- Next.js 16 / React 19
- TypeScript / Zod
- Tailwind CSS
- Vercel AI SDK
- PostgreSQL / Prisma
- Vitest
- Python / BGE-M3 / MinerU
