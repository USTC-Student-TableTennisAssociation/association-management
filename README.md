# Club Management

高校社团多周期智能管理系统。

本项目面向高校社团管理协作场景，旨在实现一个以 AI 聊天为入口的社团管理系统，重点支持状态管理、长期记忆管理与知识迁移。系统希望通过自然语言交互降低社团成员记录信息、整理经验、复用历史资料和完成换届交接的成本。

项目核心关注三个方向：

1. **状态管理**
   围绕活动、任务、资料、经费、物资和成员反馈，记录社团运行过程中的关键状态，使社团工作不只停留在群聊和临时文档中。

2. **长期记忆管理**
   将活动策划、执行记录、复盘反馈、历史资料和经验条目沉淀为可检索、可复用的组织知识，支持后续活动继续调用。

3. **知识迁移**
   面向活动负责人更替、成员培养和换届交接，将历史经验、未结事项、关键材料和注意事项整理为可传递的知识资产。

AI 在系统中主要承担交互入口和知识处理辅助的角色。用户可以通过聊天方式输入想法、问题、反馈或复盘内容，系统再将这些内容关联到具体活动、任务、资料和知识条目中，形成可继续管理和复用的数据。

## 技术栈

* Next.js
* TypeScript
* Tailwind CSS
* Vercel AI SDK
* PostgreSQL + Prisma
* 本地 BGE-M3

## 本地开发

安装依赖：

```bash
pnpm install
```

配置环境变量：

```bash
cp .env.example .env
```

在 `.env` 中填写：

```env
AI_API_KEY=
AI_API_BASE_URL=https://api.openai.com/v1
AI_MODEL=
```

启动开发服务器：

```bash
pnpm dev
```

当前聊天入口使用 OpenAI-compatible 的 `/chat/completions` 接口和 AI SDK 流式 tool loop。
模型会自行判断是否需要调用 `searchMemory`，并可继续用 `followObject` 沿已经发现的
GlobalObject 探索 Assertion；问候、改写等不需要组织知识的请求不会强制搜索。前端聊天记录
暂存在浏览器页面状态中，刷新后不会保留。

## Object–Assertion 搜索

搜索层只把 `MemoryGlobalObject` 视为 Object。`MemorySourceObjectFragment`、Fragment
Reference 和 Resolution 只负责底层来源解析，不进入 AI 的主要概念。Assertion 命中后会按
最终 Global Assertion 渲染，并连接到所有已解析的 GlobalObject（包括 literal reference
atom）。SourceBlock 原文不进入默认回答上下文，只在回答完成后按实际使用的 `[A#]` 引用
回查，用于来源展示。

数据库已导入完成的 Global Resolution 后，启动本地 BGE-M3 服务并建立 Assertion 派生索引：

```bash
pnpm memory:serve-embeddings
# 另一个终端；首次或 Global Resolution 重新导入后运行
pnpm memory:index-assertions
pnpm dev
```

`memory:serve-embeddings` 会在本机加载 `COLD_START_EMBEDDING_MODEL`，默认监听
`127.0.0.1:8765`。模型名为 `BAAI/bge-m3` 时会优先使用本机 Hugging Face 缓存，首次缺少
权重时才需要下载；也可以把该环境变量设为已下载模型的绝对路径。可用
`curl http://127.0.0.1:8765/health` 检查服务。查询与索引必须使用相同的模型、修订标识和
1024 维度。

冷启动模块的安装、运行和产物说明见
[`services/cold-start/README.md`](services/cold-start/README.md)。
