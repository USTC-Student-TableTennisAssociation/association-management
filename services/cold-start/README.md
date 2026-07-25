# 冷启动 Worker

该服务负责把单份协会手册 PDF 编译为“全局勘探初步快照”。它是后续局部编译、记忆卡片构造和图连线的前置阶段，不直接写入记忆层数据库。

## 当前边界

已实现：

- 使用 Docling 解析单个 PDF，保留页码、阅读顺序、表格和扫描页文本；
- 三条相互独立的增量阅读路径：
  - 全局总结；
  - 自由 Markdown 形式的文档结构说明；
  - 从第一页开始累积的全局信号、候选概念和粗关系；
- 三路结果交叉校验；
- 根据校验问题定向回看指定页和指定阅读路径；
- 达到回看上限后显式携带未解决问题冻结；
- 同时输出机器可读 JSON、人工可读 Markdown 和 PDF 解析中间产物。

尚未实现：

- 递归局部编译；
- 记忆卡片与图关系生成；
- 写入 Prisma/PostgreSQL；
- BGE-M3 embedding；
- 多文件合并和跨文件消歧。

## 为什么是独立 Python Worker

PDF 布局解析、OCR、LangGraph 编排和后续本地 embedding 都属于长耗时、模型依赖较重的任务。它们不进入 Next.js 请求生命周期，而作为可单独部署和扩容的批处理 worker 运行。Web 应用后续只负责提交任务、展示状态和审核结果。

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
`[DONE]` 正常结束；不会回退到普通 JSON 响应。流式片段会先完整累积，Markdown
直接使用完整文本，JSON 则在流结束后执行 Schema 校验。

`AI_READ_TIMEOUT_SECONDS` 表示连续多久没有收到新的流式数据才超时，不是整个请求的
总时限。默认 600 秒。`AI_STREAM_PROGRESS_INTERVAL_SECONDS` 控制终端报告已接收字符数
的频率，默认 5 秒。

CLI 会从当前目录和服务代码位置向上查找第一个 `.env`，因此从仓库或
`services/cold-start` 目录运行时会自动复用仓库根目录的 `.env`。系统环境变量不会
被 `.env` 覆盖，命令行参数的优先级最高。也可以显式指定：

```bash
uv run cold-start explore --env-file ../../.env --pdf "/data/手册.pdf"
```

## 运行

```bash
uv run cold-start explore \
  --pdf "/data/乒协生存手册.pdf" \
  --output "/data/cold-start-runs"
```

每次运行创建不可覆盖的独立目录：

```text
<时间>-<PDF哈希>/
├── global-exploration.json   # 后续流程读取的低权威快照
├── global-exploration.md     # 人工检查报告
├── parsed-document.md        # Docling 全文
└── parsed-pages.json         # 带页码的解析结果
```

运行期间会输出相对耗时和语义进度，包括 PDF 解析、三条阅读路径各自的单元进度、
流式首片等待时间、已接收字符数、交叉校验轮次、定向回看的路径与页码、模型重试
以及最终产物目录。三条阅读路径并行运行，因此终端中的总结、结构和概念进度可能
交错出现。

## 验证

```bash
uv run ruff check .
uv run pytest
```

单元测试使用假模型，不会产生外部模型调用。第一次真实解析 PDF 时，Docling 可能下载版面分析或 OCR 模型；生产环境应在镜像构建阶段预下载并固定模型缓存。
