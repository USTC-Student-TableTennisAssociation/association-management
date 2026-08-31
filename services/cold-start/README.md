# Cold-start Worker

Cold-start Worker 将来源文档编译为可发布到 Sydaris Shared Brain 的 Object–Assertion–Evidence 结构，并提供线上检索共用的 BGE-M3 embedding 服务。

## 输出边界

```text
source document
  → parser artifacts
  → stable Source Blocks
  → continuous Source Regions
  → Object Fragments + Assertions + Evidence
  → Global Object Resolution
  → Global Assertions
  → Shared Brain publication
```

Worker 只编译认知：

- Object 提供稳定身份；
- Assertion 保留事实性叙述和时间语境；
- Evidence 连接回原始 Source Block；
- Global Resolution 负责把各 Source Region 中的 Object Fragment 归并为稳定 Object。

Worker 不直接写入 View Card Graph。业务状态需要通过目标 View 声明的 Domain Command 建立或更新。

## 环境

要求：

- Python 3.11 或 3.12
- [uv](https://docs.astral.sh/uv/)
- MinerU 运行所需的 CPU / GPU 和模型权重
- BGE-M3 模型（Global Resolution 与 embedding server 使用）

安装：

```bash
cd services/cold-start
uv sync --python 3.11
```

验证：

```bash
uv run ruff check .
uv run pytest
uv run cold-start --help
```

CLI 会从当前目录向上查找 `.env`，也可通过 `--env-file` 显式指定。

## 主要命令

```text
explore              单文档全局勘探与连续区域树
parse-document       只执行来源解析并写入可复用缓存
compile-source       编译单个 Source Region
compile-sources      并行编译全部 Source Region
resolve-objects      归并 Global Object
finalize-assertions  物化只引用 Global Object 的 Assertion
serve-embeddings     启动 BGE-M3 HTTP 服务
```

## 1. 解析文档

对资料库中没有扩展名的内容寻址文件：

```bash
uv run cold-start parse-document \
  --source "/absolute/path/to/content-object" \
  --source-suffix pdf \
  --output "/absolute/path/to/parser-output"
```

`--source-suffix` 支持 `pdf`、`docx`、`pptx` 和 `xlsx`。

对单份文档生成勘探运行目录：

```bash
uv run cold-start explore \
  --source "/absolute/path/to/manual.pdf" \
  --output "/absolute/path/to/runs"
```

勘探产物包括稳定原文块、文档背景、连续 Source Region Tree 和可视化报告。区域树只表达编译顺序和上下文边界，不是知识分类。

## 2. 编译 Source Semantics

编译全部内容来源：

```bash
uv run cold-start compile-sources \
  --run "/absolute/path/to/exploration-run"
```

调试单个来源：

```bash
uv run cold-start compile-source \
  --run "/absolute/path/to/exploration-run" \
  --source-id region-0063
```

并行编译期间会按来源和阶段写入 checkpoint。继续已有任务：

```bash
uv run cold-start compile-sources \
  --run "/absolute/path/to/exploration-run" \
  --resume "/absolute/path/to/source-semantics-run"
```

`--resolve-progressively` 可在稳定顺序中的首个来源完成后开始 Global Object Resolution：

```bash
uv run cold-start compile-sources \
  --run "/absolute/path/to/exploration-run" \
  --resolve-progressively
```

每个 Assertion 使用 `{{object:<fragment-id>}}` 引用局部 Object Fragment。Evidence 使用原文块边界，不允许模型把无法定位的概括当作原文依据。

## 3. Global Object Resolution

```bash
uv run cold-start resolve-objects \
  --compilation "/absolute/path/to/source-semantics-full"
```

Global Resolver 按 Source Region 处理 Object Fragment，使用词面和 BGE-M3 候选召回，再由模型判断 identity。不使用 BGE-M3 时可显式传入 `--no-bge`。

继续已有 Global Resolution：

```bash
uv run cold-start resolve-objects \
  --compilation "/absolute/path/to/source-semantics-full" \
  --resume "/absolute/path/to/global-resolution-run"
```

物化 Global Assertions：

```bash
uv run cold-start finalize-assertions \
  --resolution "/absolute/path/to/global-resolution-run"
```

最终 Assertion 使用 Global Object ID 作为模板引用，因此 Object 规范名称的更正不需要改写所有 Assertion 正文。

## 4. 发布到 Shared Brain

正式入口是 Sydaris Library。Runtime 会为来源创建处理记录、调用本 Worker 完成
Source Semantics 与 Global Object Resolution，再由 Shared Brain publisher 原子发布结果。

Worker 不提供另一条直接写数据库的 importer，也不把认知结果投影成任何具体 Business View。
View 需要的业务状态只能通过该 View 声明的正式 Command 建立或更新。

## 5. BGE-M3 服务

在仓库根目录启动：

```bash
pnpm memory:serve-embeddings
```

或在服务目录直接启动：

```bash
uv run cold-start serve-embeddings \
  --host 127.0.0.1 \
  --port 8765
```

健康检查：

```bash
curl http://127.0.0.1:8765/health
```

数据库中的 Assertion embedding index 和线上查询必须使用相同的模型名、revision 和向量维度。

## 环境参数

主要参数位于仓库根目录 `.env`：

```text
AI_API_KEY
AI_API_BASE_URL
AI_MODEL
COLD_START_MINERU_BACKEND
COLD_START_MINERU_EFFORT
COLD_START_MINERU_METHOD
COLD_START_MINERU_IMAGE_ANALYSIS
COLD_START_EMBEDDING_MODEL
COLD_START_EMBEDDING_MODEL_REVISION
COLD_START_EMBEDDING_DEVICE
COLD_START_MAX_PARALLEL_COMPILATIONS
COLD_START_MAX_PARALLEL_REGIONS
COLD_START_MODEL_MAX_IN_FLIGHT
```

以 `.env.example` 为实际配置入口。命令行参数优先于环境参数。
