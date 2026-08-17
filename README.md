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
AI_VISION_MODEL=
# 视觉模型使用不同服务时再填写；留空则继承上面的 API 地址与 Key。
AI_VISION_API_KEY=
AI_VISION_API_BASE_URL=
```

启动开发服务器：

```bash
pnpm dev
```

首次打开时，Echo 会进入 `/setup` 创建第一个管理员。创建登录账号时会同时建立
`MemoryActor` 并关联当前 Shared Brain 中的 Person Object / PersonCard；因此首次配置前需要
已存在一个完成导入的 Memory Compilation。管理员可在“账号管理”中创建成员、重置密码、
切换角色和停用账号。

每个登录成员可以创建多条私有 AI 对话。完整对话列表和消息按 Actor 隔离；经记忆维护形成的
Ambient Higher Memory、Assertion 和经人确认的 Business View 仍属于共享组织认知。

当前聊天入口使用 OpenAI-compatible 的 `/chat/completions` 接口和 AI SDK 流式 tool loop。
模型会自行判断是否需要调用 `searchMemory`，并可继续用 `followObject` 沿已经发现的
GlobalObject 探索 Assertion；问候、改写等不需要组织知识的请求不会强制搜索。前端聊天记录会按
登录 Actor 和 Conversation 持久化到 PostgreSQL，刷新或切换对话时从服务端恢复。

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

## 资料库（V1）

资料库用虚拟文件树保留日常资料，导入时不移动或删除源文件。文件内容按
SHA-256 去重存储，同时保留每个文件的虚拟位置和原始相对路径。新导入文件默认是
`catalog`（仅归档），不解析、不生成 Assertion。

先部署数据库迁移并启动项目：

```bash
pnpm prisma:deploy
pnpm dev
```

资料库页面可直接选择多个文件或整个文件夹导入，导入时保留目录层级并按 SHA-256 去重。终端的 `pnpm library:import -- <path>` 仍可用于特大批量或需要保留空文件夹的导入。

页面中可以新建文件夹、重命名、移动、永久删除、设置
`catalog / coarse / deep` 档位，并预览图片、PDF 和纯文本。“基础编译”工作台会按
SHA-256 唯一内容列出文件，默认只勾选深度与粗编译项，并支持搜索、逐项勾选、全选和批量改档位；
只有本次明确勾选的内容才会进入 `deep → coarse → catalog` 可恢复任务。深度文件优先复用已完成的
cold-start Compilation，粗编译按原文大主题产生 Reference、可选 grounded Assertion 和关联 Object，仅归档只生成轻量 Reference–Object 结果或明确记录未形成知识结果。模型只选择编号证据块并标注 Object 名称，服务端生成精确原文摘录和 Object 闭环。图片先由 `AI_VISION_MODEL` 生成 OCR、画面观察和不确定性记录，再由
`AI_MODEL` 把这些文字编译成相同的草稿候选；普通模型不会接收原图。所有文件草稿和跨文件 Global Object 归并成功后，新结果才原子发布到 Shared Brain；失败不会替换旧结果。详细边界见
[`docs/architecture/07-资料库与分层处理第一版.md`](docs/architecture/07-资料库与分层处理第一版.md)。
