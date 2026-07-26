# 冷启动 Worker

该服务当前负责对单份协会手册 PDF 做第一轮全局勘探，为后续局部阅读和记忆编译
准备两个低权威中间产物：

- 一段告诉后续 AI“这是什么文档”的简短文档上下文；
- 一份决定后续如何按页深入阅读的宏观分区；

它不提取具体记忆，不生成记忆卡片或图关系，也不写入记忆层数据库。

## 当前流程

Docling 将 PDF 解析为带页码的 Markdown 后，两条线路同时启动：

1. 文档上下文线路按文档顺序阅读，每次重写一段 300～500 字的完整背景；
2. 宏观切分线路一次读取带页码的完整文档，只输出连续宏观区域；

当前没有实现：

- 概念发现、概念笔记本和原生模型工具调用；
- 基于 BGE-M3 的概念检索；
- 递归局部阅读和记忆编译；
- 记忆卡片及图关系生成；
- 写入 Prisma/PostgreSQL；
- 多文件合并和跨文件消歧。

## 为什么是独立 Python Worker

PDF 布局解析、OCR、LangGraph 编排和后续本地 embedding 都属于长耗时、模型依赖较重
的任务。它们不进入 Next.js 请求生命周期，而作为可单独部署和扩容的批处理 worker
运行。Web 应用后续只负责提交任务、展示状态和审核结果。

## 安装

要求 Python 3.11–3.13 和 [uv](https://docs.astral.sh/uv/)。

```bash
cd services/cold-start
uv sync
```

模型通过 OpenAI 兼容的 `chat/completions` 接口调用：

```bash
export AI_API_BASE_URL="https://example.com/v1"
export AI_API_KEY="..."
export AI_MODEL="..."
export AI_READ_TIMEOUT_SECONDS="600"
export AI_MAX_RETRIES="2"
export AI_STREAM_PROGRESS_INTERVAL_SECONDS="5"
```

`AI_API_KEY` 对不要求鉴权的本地接口可以省略。

模型请求固定使用 `stream: true`。Worker 只接受 SSE `data:` 事件，并要求流以
`[DONE]` 正常结束。Markdown 结果直接使用完整正文，JSON 结果在流结束后执行 Schema
和业务校验。

`AI_READ_TIMEOUT_SECONDS` 表示连续多久没有收到新的流式数据才超时，不是整个请求的
总时限。默认 600 秒。CLI 会从当前目录和服务代码位置向上查找第一个 `.env`，系统
环境变量不会被 `.env` 覆盖，命令行参数优先级最高。

## 运行

```bash
uv run cold-start explore \
  --pdf "/data/乒协生存手册.pdf" \
  --output "/data/cold-start-runs"
```

需要同时在终端查看正文与思考时：

```bash
uv run cold-start explore \
  --show-model-stream \
  --pdf "/data/乒协生存手册.pdf" \
  --output "/data/cold-start-runs"
```

每次运行创建不可覆盖的独立目录：

```text
<时间>-<PDF哈希>/
├── model-streams/             # 完整提示词、原始 SSE、正文和思考记录
├── global-exploration.json    # 两条线路汇合后的主快照
├── global-exploration.md      # 人工阅读报告
├── document-context.md        # 简短文档上下文
├── macro-sections.json        # 宏观连续阅读分区
├── parsed-document.md         # Docling 全文
└── parsed-pages.json          # 带页码的解析结果
```

每次逻辑调用都会在 `model-streams/` 保存一份不含 API Key 的完整请求 JSON；
原始 SSE、已生成正文和接口返回的思考内容会在调用期间持续写入，即使请求失败也会
保留。

## 验证

```bash
uv run ruff check .
uv run pytest
```

单元测试使用假模型，不产生外部模型调用。第一次真实解析 PDF 时，Docling 可能下载
版面分析或 OCR 模型；生产环境应在镜像构建阶段预下载并固定模型缓存。
