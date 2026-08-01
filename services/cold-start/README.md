# 冷启动 Worker

冷启动 Worker 目前负责把单份协会手册 PDF 解析为稳定原文块和连续原文区域树，并在此
基础上开发新的“对象—陈述—关系—依据”记忆编译器。

旧的固定卡片编译、父节点卡片整合和数据库导入流程已经移除，不保留兼容入口。这样可以
先用真实叶子验证新语义协议，再决定数据库结构，而不会让旧卡片字段继续影响模型判断。

## 整体方向

```text
单份 PDF
  → Docling 解析
  → 带页码的稳定原文块
  ├→ 顺序阅读，形成简短文档背景
  └→ 递归切分，形成连续原文区域树
       → 叶子局部编译
            → Object：可持续指认的对象
            → Assertion：来源对对象作出的记录或观点
            → Relation：对象间有来源依据的连接
            → Evidence：上述判断对应的原文位置
            → Unresolved：留给父节点继续判断的问题
       → 父节点使用相同协议自底向上整合
       → 根节点形成文档内归一化记忆包
       → 数据库对齐与导入（后续阶段）
```

区域树是编译顺序和上下文边界，不是知识分类。对象类型在叶子阶段只是候选；事实允许
不完整，观点保留持有者和权威状态，关系也保留来源、时间和不确定性。父节点可以合并、
拆分或重定向对象，而不用把原文强行补写成一张字段完整的卡片。

当前分支已完成新中间协议、引用完整性校验、对象合并后的确定性引用重映射，以及指定
单个叶子的真实模型编译。父节点递归整合和数据库结构会在验证局部输出后继续实现。

## 安装

要求 Python 3.11–3.13 和 [uv](https://docs.astral.sh/uv/)：

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

## 运行全局勘探

从 `services/cold-start` 目录运行：

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

主要产物包括：

```text
model-streams/             完整提示词、原始 SSE、正文和思考
global-exploration.json    全局勘探主快照
document-context.md        后续模型使用的简短文档背景
region-tree.json           完整区域树数据
region-tree.md             供人工查看的区域树
region-tree-checks.json    结构校准结果和来源解析警告
parsed-document.md         Docling 解析出的全文
parsed-pages.json          分页原文
parsed-blocks.json         带稳定 ID 的原文块
```

## 编译一个叶子

先从 `region-tree.md` 中选定一个 `content_source` 叶子，再运行：

```bash
uv run cold-start compile-leaf \
  --run "../../.cold-start/runs/20260729T100753Z-107ebc775f" \
  --leaf-id "region-0063"
```

模型会收到文档背景、从根节点到该叶子的简短介绍，以及该叶子的完整带编号原文。模型
必须通过 `submit_memory_package` 工具提交结果；程序会验证所有对象和依据引用，以及
依据是否落在当前叶子范围内。首次提交无效时只允许一次定向修复。

每次运行创建独立产物目录：

```text
object-compilations/<UTC 时间>-<叶子 ID>/
  model-streams/             模型请求、原始流、正文和思考
  region-compilation.json    完整结构化记忆包
  region-compilation.md      供人工检查的对象、陈述、关系与依据
```

## 当前边界

当前只处理一份 PDF，并先验证《乒协生存手册》的局部记忆提取质量。暂不处理：

- 多文件组织、跨文件消歧和版本关系；
- 原始文件层映射；
- 数据库写入、SearchCard、向量索引、人工审核界面和自动发布。

## 验证

```bash
uv run ruff check .
uv run pytest
```
