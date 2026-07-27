# 冷启动 Worker

冷启动 Worker 负责把单份协会手册 PDF 逐步编译为可进入长期记忆层的候选知识。

当前已经完成第一阶段“全局勘探”：解析《乒协生存手册》，形成简短的文档背景和一棵
可追溯到原文块的递归区域树。区域树用于给后续知识卡片提取提供语义完整、粒度基本
稳定的处理范围。

当前不会生成知识卡片、图关系，也不会写入数据库。下一阶段将在现有区域树上设计和
验证知识卡片提取。

## 当前处理流程

```text
单份 PDF
  → Docling 解析
  → 带页码的稳定原文块
  ├→ 顺序阅读，形成简短文档背景
  └→ 递归切分，形成区域树
       → 全树结构校准
       → 全局勘探产物
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

要求 Python 3.11–3.13 和 [uv](https://docs.astral.sh/uv/)。

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

AI_READ_TIMEOUT_SECONDS=600
AI_MAX_RETRIES=2
AI_STREAM_PROGRESS_INTERVAL_SECONDS=5

COLD_START_EMBEDDING_MODEL=BAAI/bge-m3
COLD_START_EMBEDDING_DEVICE=
COLD_START_EMBEDDING_BATCH_SIZE=8
COLD_START_MAX_PARALLEL_REGIONS=6
```

完整示例见仓库根目录的 `.env.example`。本地接口不要求鉴权时可以不设置
`AI_API_KEY`。`COLD_START_EMBEDDING_DEVICE` 留空时依次尝试 CUDA、MPS 和 CPU。

模型请求固定使用 SSE 流式响应。运行期间，模型输入、正文、思考和原始流会持续写入
本次运行目录；即使调用失败，已收到的内容也会保留。

## 运行

从 `services/cold-start` 目录运行《乒协生存手册》：

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

知识提取阶段应以 `region-tree.json` 和 `parsed-blocks.json` 为主要输入，并通过原文块
ID 保存每张知识卡片的来源证据。

## 当前边界与下一阶段

当前实现只处理一份 PDF，目标是先验证《乒协生存手册》的端到端效果。暂不处理：

- 多文件组织、跨文件消歧和版本关系；
- 知识卡片及卡片间关系生成；
- 原始文件层映射；
- Prisma/PostgreSQL 写入和人工审核界面。

下一阶段将重点讨论知识卡片的含义、提取边界、来源证据和卡片间关系，再决定具体
Schema 与工作流，不直接把区域树节点等同于知识卡片。

## 验证

```bash
uv run ruff check .
uv run pytest
```

单元测试使用假模型，不会产生外部模型调用。
