# 冷启动 Worker

冷启动 Worker 负责把单份协会手册 PDF 逐步编译为可进入长期记忆层的候选知识。

当前实现覆盖四个阶段：全局勘探先形成简短的文档背景和可追溯到原文块的递归区域树；
内容叶子分别生成带来源依据的局部候选子图；父节点从最深层开始逐层对齐语义、合并
重复卡片并补充跨孩子连线；最后把完整根图写入记忆层数据库。

完整流程会把根节点候选图作为 `draft` 写入记忆层数据库；当前不生成 SearchCard，也不
自动发布记忆。

## 当前处理流程

```text
单份 PDF
  → Docling 解析
  → 带页码的稳定原文块
  ├→ 顺序阅读，形成简短文档背景
  └→ 递归切分，形成区域树
       → 全树结构校准
       → 全局勘探产物
       → 内容叶子并行局部编译
            → 卡片候选
            → 局部连线候选
            → 来源依据
            → 未编译说明
       → 父节点自底向上整合
            → 紧凑目录路由
            → 候选卡片与证据展开
            → 合并、修正和跨孩子连线
            → 根节点候选记忆图
       → 单事务写入记忆层数据库草稿
            → 记忆节点与类型详情
            → 记忆关系
            → 原文来源锚点
            → 候选 ID 与数据库 UUID 映射报告
```

文档背景和区域树根节点并行生成。根节点确定第一层切分后，程序继续递归判断各区域
是否需要拆分；多个区域可以并行处理。模型在局部上下文不足时可以调用
`search_document`，使用 BGE-M3 检索其他原文。

区域树中的父节点可以保留未分配给子节点的自有原文：

- `content_source`：自身包含后续知识提取需要读取的内容；
- `structural_context`：只用于解释标题、章节关系或文档结构。

最终校准只检查区域树的结构问题。PDF 编号、跨页残片等解析异常单独记录为
`source_issues`，不会被误当成区域树切分错误。

## 安装

勘探与编译阶段要求 Python 3.11–3.13 和 [uv](https://docs.astral.sh/uv/)；完整流程还要求
Node.js、pnpm 和可连接的 PostgreSQL。

首次安装时先在仓库根目录安装 Node.js 依赖：

```bash
pnpm install
pnpm prisma:generate
```

再安装冷启动 Worker 的 Python 环境：

```bash
cd services/cold-start
uv sync --python 3.11
```

Windows 可以先安装 uv：

```powershell
winget install --id=astral-sh.uv -e
```

安装后重新打开终端，再用 `uv --version` 确认命令可用。第一次运行时，Docling 和
BGE-M3 可能下载模型；生产环境应在镜像构建阶段预下载并固定缓存。

## 环境配置

在仓库根目录的 `.env` 中配置：

```dotenv
AI_API_BASE_URL=https://example.com/v1
AI_API_KEY=...
AI_MODEL=...

DATABASE_URL=postgresql://...
SHADOW_DATABASE_URL=postgresql://...

AI_READ_TIMEOUT_SECONDS=600
AI_MAX_RETRIES=2
AI_STREAM_PROGRESS_INTERVAL_SECONDS=5

COLD_START_EMBEDDING_MODEL=BAAI/bge-m3
COLD_START_EMBEDDING_DEVICE=
COLD_START_EMBEDDING_BATCH_SIZE=8
COLD_START_MAX_PARALLEL_REGIONS=6
COLD_START_MAX_PARALLEL_COMPILATIONS=6
COLD_START_MAX_PARALLEL_PARENT_INTEGRATIONS=6
```

完整示例见仓库根目录的 `.env.example`。本地接口不要求鉴权时可以不设置
`AI_API_KEY`。`COLD_START_EMBEDDING_DEVICE` 留空时依次尝试 CUDA、MPS 和 CPU。

模型请求固定使用 SSE 流式响应。运行期间，模型输入、正文、思考和原始流会持续写入
本次运行目录；即使调用失败，已收到的内容也会保留。

首次使用空数据库时，先从仓库根目录应用已经提交的 Prisma migration：

```bash
pnpm prisma:deploy
```

可以先用 `pnpm exec prisma migrate status --schema prisma/schema.prisma` 检查状态。数据库表未
完成迁移时，候选图生成不受影响，但最后的数据库导入会失败。

## 运行

从 `services/cold-start` 目录运行完整流程：

```bash
uv run cold-start run \
  --pdf "../../docs/architecture/USTC_TTA_乒协生存手册.pdf" \
  --output "../../.cold-start/runs"
```

该命令会依次执行全局勘探、内容叶子编译、父节点逐层整合和数据库导入。终端会显示
每个阶段的独立耗时，最后显示从 PDF 解析开始计算的总耗时和
`database-import.json` 所在目录。若区域树未冻结、叶子编译或父节点整合未全部成功，
流程会在对应阶段停止并保留产物。

如需覆盖叶子和父节点并发数：

```bash
uv run cold-start run \
  --max-parallel-leaves 6 \
  --max-parallel-parents 6 \
  --pdf "../../docs/architecture/USTC_TTA_乒协生存手册.pdf" \
  --output "../../.cold-start/runs"
```

以下命令仍可用于只运行和调试全局勘探：

```bash
uv run cold-start explore \
  --pdf "../../docs/architecture/USTC_TTA_乒协生存手册.pdf" \
  --output "../../.cold-start/runs"
```

如需同时在终端查看模型正文和思考：

```bash
uv run cold-start explore \
  --show-model-stream \
  --pdf "../../docs/architecture/USTC_TTA_乒协生存手册.pdf" \
  --output "../../.cold-start/runs"
```

完成勘探后，使用具体运行目录编译其中的内容叶子：

```bash
uv run cold-start compile-leaves \
  --run "../../.cold-start/runs/20260729T100753Z-107ebc775f"
```

如需调整同时发出的叶子模型请求数量：

```bash
uv run cold-start compile-leaves \
  --max-parallel-leaves 6 \
  --run "../../.cold-start/runs/20260729T100753Z-107ebc775f"
```

叶子编译全部成功后，从叶子向根节点逐层整合。`--compilation` 指向包含
`leaf-compilation.json` 的具体目录：

```bash
uv run cold-start integrate-parents \
  --compilation "../../.cold-start/runs/20260729T100753Z-107ebc775f/leaf-compilations/<UTC 时间>"
```

如需调整同一深度父节点的并发数：

```bash
uv run cold-start integrate-parents \
  --max-parallel-parents 6 \
  --compilation "../../.cold-start/runs/20260729T100753Z-107ebc775f/leaf-compilations/<UTC 时间>"
```

已有完整父节点整合结果时，也可以单独写入数据库：

```bash
uv run cold-start import-db \
  --integration "../../.cold-start/runs/<运行目录>/leaf-compilations/<编译目录>/parent-integrations/<整合目录>"
```

数据库导入要求根图状态为 `complete`，并读取 `DATABASE_URL`。所有节点和边以 `draft`
状态写入；卡片、类型详情、关系、来源锚点及其引用在同一个事务中提交，任一步失败都会
整体回滚。当前导入器按一次性冷启动设计，不会对重复运行做幂等更新；不要把同一份整合
结果重复导入同一个数据库。

## 运行产物

每次运行会创建不可覆盖的 `<UTC 时间>-<PDF 哈希>/` 目录：

```text
model-streams/             完整提示词、原始 SSE、正文和思考
global-exploration.json    全局勘探主快照
global-exploration.md      供人工快速检查的概览
document-context.md        后续模型使用的简短文档背景
region-tree.json           完整区域树数据
region-tree.md             供人工查看的区域树
region-tree-checks.json    结构校准结果和来源解析警告
region-tree-working.json   运行中的区域树检查点
parsed-document.md         Docling 解析出的全文
parsed-pages.json          分页原文
parsed-blocks.json         带稳定 ID 的原文块
```

每次叶子编译会在勘探运行目录下新建独立目录：

```text
leaf-compilations/<UTC 时间>/
  model-streams/                  叶子编译模型请求与流式响应
  leaf-compilation-working.json   每完成一个叶子更新的检查点
  leaf-compilation.json           完整结构化候选子图
  leaf-compilation.md             供人工检查的可读报告
  parent-integrations/<UTC 时间>/
    model-streams/                    父节点路由和裁决的模型流
    parent-integration-working.json   逐层整合检查点
    parent-integration.json           根节点候选图和所有增量裁决
    parent-integration.md             供人工检查的整合报告
    database-import.json              数据库导入成功后生成的 ID 映射与提交结果
```

程序要求每个叶子的所有原文块至少被一项来源依据或未编译说明覆盖。单个叶子失败不会
中断其他叶子，最终状态会标记为 `partial`，成功结果和失败原因都会保留。

## 当前边界

当前实现只处理一份 PDF，目标是先验证《乒协生存手册》的端到端编译与入库效果。暂不处理：

- 多文件组织、跨文件消歧和版本关系；
- 原始文件层映射；
- SearchCard、向量索引、人工审核界面和自动发布。

叶子编译明确不把区域树节点等同于知识卡片。一张较粗的叶子可以生成多张原子卡片，
也可以在没有长期记忆时只返回未编译说明。父节点整合采用“全量紧凑目录、候选局部
展开”：路由调用只确定需要检查的范围，裁决调用只输出必要的增量操作，未提及的卡片
和边由程序继承。数据库导入只接收状态为 `complete` 的根图，并保留候选 ID 到数据库
UUID 的映射，方便回查编译结果。

## 验证

```bash
uv run ruff check .
uv run pytest
```

单元测试使用假模型，不会产生外部模型调用。
